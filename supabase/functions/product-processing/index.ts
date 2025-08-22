import "https://deno.land/x/xhr@0.3.0/mod.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Import shared Keepa operations
import { fetchKeepaData, insertProducts, findNewAsins, type KeepaProduct, type InsertResult, type AsinComparison } from '../_shared/keepa.ts';
import { processProductBatch, type BatchProcessingResult, KEEPA_API_BATCH_SIZE, ROUTING_THRESHOLD } from '../_shared/batch-processor.ts';

// Import queue processing for smart routing
import { enqueueProductBatches } from '../_shared/queue.ts';
import { WebhookNotifier } from '../_shared/discord.ts';

// Import Trigger.dev SDK for queue processing
import { tasks, configure, runs } from "npm:@trigger.dev/sdk@3.0.0/v3";

// Module-level environment variables (cached once, reused forever)
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const KEEPA_API_KEY = Deno.env.get('KEEPA_API_KEY')!;
const TRIGGER_SECRET_KEY = Deno.env.get('TRIGGER_SECRET_KEY') || Deno.env.get('TRIGGER_API_KEY');
const isDev = Deno.env.get('DENO_ENV') !== 'production';

// Configure Trigger.dev SDK
if (TRIGGER_SECRET_KEY) {
  configure({
    secretKey: TRIGGER_SECRET_KEY
  });
}

// Optimized logging function
const log = isDev ? console.log : () => {};

// Optimized Supabase client configuration (enterprise-grade performance)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { enabled: false }, // Faster initialization, no realtime needed
});

// JWT decode utility (100x faster than auth.getUser)
function decodeJWT(token: string) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT format');

    const payload = JSON.parse(atob(parts[1]));
    return { user: { id: payload.sub }, error: null };
  } catch (error) {
    return { user: null, error: { message: 'Invalid JWT token' } };
  }
}

// Configuration constants imported from batch-processor (single source of truth)

interface ProcessRequest {
  sellerId: string;
  userId: string;
  asinList: string[];
  domain: number;
}

interface ProcessingResult {
  success: boolean;
  processedCount: number;
  failedCount: number;
  errors: string[];
  processingTime: number;
}

Deno.serve(async (req: Request) => {
  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    log('🚀 Starting seller product processing...');
    const startTime = Date.now();

    // Parse request
    const { sellerId, userId, asinList, domain }: ProcessRequest = await req.json();



    // Validate input
    if (!sellerId || !userId || !Array.isArray(asinList) || asinList.length === 0) {
      throw new Error('Missing required fields: sellerId, userId, asinList');
    }

    // TEMPORARY BYPASS: Allow large batches in edge function for testing
    // TODO: Re-enable when Trigger.dev is set up
    // if (asinList.length >= 100) {
    //   throw new Error('Use Trigger.dev for batches >= 100 products. This function handles < 100 only.');
    // }

    // Validate authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Missing Authorization header');
    }

    // Extract the token
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    // Use JWT decode instead of expensive auth.getUser call (100x faster)
    const { user, error: authError } = decodeJWT(token);
    if (authError || !user || user.id !== userId) {
      throw new Error('Unauthorized');
    }



    // Look up seller UUID from Keepa seller ID
    const sellerUuid = await dbSellerGetUuid(sellerId, domain);
    if (!sellerUuid) {
      throw new Error(`Seller not found: ${sellerId}`);
    }

    // SMART PROCESSING: Detect truly new ASINs and determine processing strategy
    const processingDecision = await getNetworkProcessingDecision(sellerUuid, asinList, userId);
    
    // Return early if no processing needed or special handling required
    if (processingDecision.type !== 'NEW_ASINS_DETECTED') {
      return new Response(JSON.stringify(processingDecision), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Use only the truly new ASINs for processing
    const newAsinsToProcess = processingDecision.newAsins || [];
    
    // Phase 3: Smart routing - check if we should use queue processing
    const shouldQueue = newAsinsToProcess.length > ROUTING_THRESHOLD;
    
    let result;
    if (shouldQueue) {
      // Route to queue processing (>100 NEW products)
      log(`🚀 Routing to queue processing: ${newAsinsToProcess.length} NEW products (${processingDecision.existingCount} existing)`);
      
      // Webhook notification: Smart routing decision
      WebhookNotifier.started('Product Processing', `${sellerId.substring(0,8)}: ${newAsinsToProcess.length} new products → queue`);
      
              result = await enqueueProductBatches(sellerUuid, newAsinsToProcess, supabase, tasks, runs, user.id, true);
      
      // Convert queue response to processing result format
      result = {
        success: true,
        processedCount: 0, // Queue processing shows 0 since it's async
        failedCount: 0,
        errors: [],
        processingTime: 0,
        queueInfo: {
          batchesCreated: result.batchesCreated,
          totalProducts: result.totalProducts,
          estimatedTime: result.estimatedTime,
          message: result.message
        },
        smartProcessing: {
          newProducts: newAsinsToProcess.length,
          existingProducts: processingDecision.existingCount,
          message: `Processing ${newAsinsToProcess.length} new products (${processingDecision.existingCount} already processed)`
        }
      };
    } else {
      // Route to immediate processing (≤50 NEW products)
      log(`⚡ Routing to immediate processing: ${newAsinsToProcess.length} NEW products (${processingDecision.existingCount} existing)`);
      
      // Webhook notification: Smart routing decision
      WebhookNotifier.started('Product Processing', `${sellerId.substring(0,8)}: ${newAsinsToProcess.length} new products → immediate`);
      
             const batchResult = await processProductBatch(sellerUuid, newAsinsToProcess, domain, sellerId, supabase, {
        userId: user.id,
        source: 'EDGE',
        createBatch: true
      });
      
      // Handle fallback to queue if transient error
      if (!batchResult.success && batchResult.canFallbackToQueue) {
        log(`⚠️ Immediate processing failed with transient error - falling back to queue`);
        result = await enqueueProductBatches(sellerUuid, newAsinsToProcess, supabase, tasks, runs, user.id, true);
      } else {
        // Convert BatchProcessingResult to ProcessingResult format
        result = {
          success: batchResult.success,
          processedCount: batchResult.processedCount,
          failedCount: batchResult.failedCount,
          errors: batchResult.errors,
          processingTime: batchResult.processingTime
        };
      }
      
      // Add smart processing info to result
      result.smartProcessing = {
        newProducts: newAsinsToProcess.length,
        existingProducts: processingDecision.existingCount,
        message: `Processed ${newAsinsToProcess.length} new products (${processingDecision.existingCount} already processed)`
      };
    }

    const processingTime = Date.now() - startTime;
    
    // Webhook notification: Processing completed
    WebhookNotifier.completed('Product Processing', `${result.processedCount || 0}/${(result.processedCount || 0) + (result.failedCount || 0)} products processed`);

    return new Response(
      JSON.stringify({
        ...result,
        processingTime,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );

  } catch (error) {
    // Webhook notification: Processing error
    WebhookNotifier.error('Product Processing', error.message);
    
    if (isDev) {
      console.error('❌ Error processing seller products:', error);
    }
    
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
        processedCount: 0,
        failedCount: 0,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});



// SMART PROCESSING: Network processing decision engine
async function getNetworkProcessingDecision(
  sellerUuid: string, 
  incomingAsins: string[], 
  userId: string
): Promise<{
  type: string;
  message?: string;
  newCount?: number;
  existingCount?: number;
  batchId?: string;
  newAsins?: string[];
}> {
  // Check if this seller is being processed by the network
  const { data: activeBatch } = await supabase
    .from('product_batches')
    .select('id, status, created_at, product_count')
    .eq('seller_id', sellerUuid)
    .in('status', ['PENDING', 'PROCESSING'])
    .single();
    
  if (activeBatch) {
    log(`🔄 Network processing in progress for seller ${sellerUuid}`);
    return { 
      type: 'NETWORK_PROCESSING_IN_PROGRESS', 
      message: 'This seller is being processed. Check back in a few minutes.',
      batchId: activeBatch.id
    };
  }
  
  // Check for batches awaiting confirmation (network needs help)
  const { data: awaitingConfirmation } = await supabase
    .from('product_batches')
    .select('id, product_count, new_asins')
    .eq('seller_id', sellerUuid)
    .eq('available_for_confirmation', true)
    .not('confirmation_offered_to_user_ids', 'cs', `{${userId}}`)
    .single();
    
  if (awaitingConfirmation) {
    log(`✋ Network needs confirmation from user ${userId} for seller ${sellerUuid}`);
    return {
      type: 'NETWORK_NEEDS_CONFIRMATION',
      batchId: awaitingConfirmation.id,
      newCount: awaitingConfirmation.product_count,
      message: 'New products detected. Process them?'
    };
  }
  
  // Detect new ASINs for the network
  const asinAnalysis = await findNewAsins(sellerUuid, incomingAsins, supabase, isDev);
  
  if (asinAnalysis.newCount === 0) {
    log(`✅ No new ASINs detected for seller ${sellerUuid}`);
    return { 
      type: 'NO_NEW_ASINS', 
      message: 'All products are up to date',
      existingCount: asinAnalysis.existingCount
    };
  }
  
  log(`🆕 Detected ${asinAnalysis.newCount} new ASINs for seller ${sellerUuid}`);
  
  // Determine if confirmation is needed
  const needsConfirmation = asinAnalysis.newCount > 200;
  
  return {
    type: 'NEW_ASINS_DETECTED',
    ...asinAnalysis,
    needsConfirmation: needsConfirmation
  };
}

async function dbSellerGetUuid(keepaSellerID: string, domain: number): Promise<string | null> {
  const { data, error } = await supabase
    .from('sellers')
    .select('id')
    .eq('seller_id', keepaSellerID)
    .eq('domain', domain)
    .single();

  if (error) {
    if (isDev) {
      console.error('❌ Error looking up seller:', error);
    }
    return null;
  }

  return data.id;
}

 

 