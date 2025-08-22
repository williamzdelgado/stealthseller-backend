import { fetchKeepaData, insertProducts, type KeepaProduct } from './keepa.ts';
import { WebhookNotifier } from './discord.ts';

// Batch size constants - single source of truth
export const KEEPA_API_BATCH_SIZE = 10;        // ASINs per Keepa API request
export const EDGE_FUNCTION_LIMIT = 50;         // Max products for edge function  
export const MAX_BATCH_SIZE = 100;             // Maximum batch size limit
export const ROUTING_THRESHOLD = 50;           // Route to queue if > this

// Extended result interface that includes batch tracking
export interface BatchProcessingResult {
  success: boolean;
  processedCount: number;
  failedCount: number;
  errors: string[];
  processingTime: number;
  batchId: string;
  errorType?: 'TRANSIENT' | 'HARD';
  canFallbackToQueue: boolean;
  batchStatus: 'COMPLETED' | 'FAILED' | 'PARTIAL';
}

/**
 * Shared product batch processor used by both Edge Functions and Trigger.dev
 * Handles the complete flow: batch tracking → Keepa fetch → database insert → status updates
 * 
 * @param sellerUuid - Seller UUID for database operations
 * @param asins - Array of ASINs to process (max varies by source: edge=50, trigger=100)
 * @param domain - Keepa domain ID
 * @param keepaSellerId - Keepa seller ID
 * @param supabase - Supabase client
 * @param options - Processing options and metadata
 */
export async function processProductBatch(
  sellerUuid: string,
  asins: string[],
  domain: number,
  keepaSellerId: string,
  supabase: any,
  options?: {
    batchId?: string;
    userId?: string;
    source?: 'EDGE' | 'TRIGGER_DEV';
    createBatch?: boolean;
  }
): Promise<BatchProcessingResult> {
  const startTime = Date.now();
  const opts = {
    createBatch: false,
    source: 'EDGE' as const,
    ...options
  };

  // Input validation
  if (!asins || asins.length === 0) {
    return {
      success: false,
      processedCount: 0,
      failedCount: 0,
      errors: ['No ASINs provided for processing'],
      processingTime: Date.now() - startTime,
      batchId: opts.batchId || '',
      errorType: 'HARD',
      canFallbackToQueue: false,
      batchStatus: 'FAILED'
    };
  }

  // Environment-aware batch size limits
  const maxProducts = opts.source === 'EDGE' ? EDGE_FUNCTION_LIMIT : MAX_BATCH_SIZE;
  if (asins.length > maxProducts) {
    return {
      success: false,
      processedCount: 0,
      failedCount: 0,
      errors: [`Batch size ${asins.length} exceeds ${opts.source} limit of ${maxProducts} products`],
      processingTime: Date.now() - startTime,
      batchId: opts.batchId || '',
      errorType: 'HARD',
      canFallbackToQueue: opts.source === 'EDGE', // Only edge functions can fallback to queue
      batchStatus: 'FAILED'
    };
  }

  let batchId = opts.batchId || '';

  try {
    // Step 1: Create batch record if needed
    if (opts.createBatch) {
      const batchResult = await supabase
        .from('product_batches')
        .insert({
          seller_id: sellerUuid,
          user_id: opts.userId || null,
          product_count: asins.length,
          new_asins: asins,
          status: 'PENDING',
          processing_by: opts.source,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select('id')
        .single();

      if (batchResult.error) {
        return {
          success: false,
          processedCount: 0,
          failedCount: asins.length,
          errors: [`Failed to create batch record: ${batchResult.error.message}`],
          processingTime: Date.now() - startTime,
          batchId: '',
          errorType: 'HARD',
          canFallbackToQueue: false,
          batchStatus: 'FAILED'
        };
      }

      batchId = batchResult.data.id;
    }

    // Step 2: Update batch to PROCESSING status
    const processingUpdate = await supabase
      .from('product_batches')
      .update({
        status: 'PROCESSING',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', batchId);

    if (processingUpdate.error) {
      console.warn(`⚠️ Failed to update batch status to PROCESSING: ${processingUpdate.error.message}`);
    }

    // Step 3: Fetch product data from Keepa API
    let products: KeepaProduct[];
    try {
      products = await fetchKeepaData(asins, domain, keepaSellerId, process.env.KEEPA_API_KEY!, false);
    } catch (keepaError) {
      console.error(`KEEPA: API failed asins=${asins.length} error="${keepaError instanceof Error ? keepaError.message : String(keepaError)}"`);
      // Classify Keepa API errors
      const errorMessage = keepaError instanceof Error ? keepaError.message : String(keepaError);
      const isTransientError = errorMessage.includes('timeout') || 
                              errorMessage.includes('network') || 
                              errorMessage.includes('rate limit') ||
                              errorMessage.includes('503') || 
                              errorMessage.includes('502');

      // Update batch to FAILED status
      await supabase
        .from('product_batches')
        .update({
          status: 'FAILED',
          updated_at: new Date().toISOString(),
          error_message: `Keepa API error: ${errorMessage}`
        })
        .eq('id', batchId);

      return {
        success: false,
        processedCount: 0,
        failedCount: asins.length,
        errors: [`Keepa API error: ${errorMessage}`],
        processingTime: Date.now() - startTime,
        batchId,
        errorType: isTransientError ? 'TRANSIENT' : 'HARD',
        canFallbackToQueue: isTransientError && opts.source === 'EDGE',
        batchStatus: 'FAILED'
      };
    }

    // Step 4: Insert products into database
    let insertResult;
    try {
      insertResult = await insertProducts(
        sellerUuid,
        products,
        domain,
        keepaSellerId,
        supabase,
        false, // isDev
        opts.source
      );
    } catch (insertError) {
      const errorMessage = insertError instanceof Error ? insertError.message : String(insertError);
      
      // Update batch to FAILED status
      await supabase
        .from('product_batches')
        .update({
          status: 'FAILED',
          updated_at: new Date().toISOString(),
          error_message: `Database insert error: ${errorMessage}`
        })
        .eq('id', batchId);

      return {
        success: false,
        processedCount: 0,
        failedCount: asins.length,
        errors: [`Database insert error: ${errorMessage}`],
        processingTime: Date.now() - startTime,
        batchId,
        errorType: 'HARD',
        canFallbackToQueue: false,
        batchStatus: 'FAILED'
      };
    }

    // Step 5: Determine final batch status
    const finalStatus = insertResult.success > 0 ? 
      (insertResult.failed > 0 ? 'PARTIAL' : 'COMPLETED') : 
      'FAILED';

    // Step 6: Update batch to final status
    await supabase
      .from('product_batches')
      .update({
        status: finalStatus === 'PARTIAL' ? 'COMPLETED' : finalStatus,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        actual_tokens_used: insertResult.success * 7, // Estimate 7 tokens per product
        error_message: insertResult.failed > 0 ? `${insertResult.failed} products failed to insert` : null
      })
      .eq('id', batchId);

    // Step 7: Update seller timestamp if successful
    if (insertResult.success > 0) {
      await supabase
        .from('sellers')
        .update({ 
          last_checked_at: new Date().toISOString()
        })
        .eq('id', sellerUuid);
    }

    const processingTime = Date.now() - startTime;

    return {
      success: insertResult.success > 0,
      processedCount: insertResult.success,
      failedCount: insertResult.failed,
      errors: insertResult.failed > 0 ? [`${insertResult.failed} products failed to process`] : [],
      processingTime,
      batchId,
      canFallbackToQueue: false,
      batchStatus: finalStatus
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Try to update batch to FAILED if we have a batchId
    if (batchId) {
      await supabase
        .from('product_batches')
        .update({
          status: 'FAILED',
          updated_at: new Date().toISOString(),
          error_message: `Processing error: ${errorMessage}`
        })
        .eq('id', batchId)
; // Ignore update errors during error handling
    }

    return {
      success: false,
      processedCount: 0,
      failedCount: asins.length,
      errors: [`Processing error: ${errorMessage}`],
      processingTime: Date.now() - startTime,
      batchId,
      errorType: 'HARD',
      canFallbackToQueue: false,
      batchStatus: 'FAILED'
    };
  }
} 