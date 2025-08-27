import { logger, task } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";

// Import infrastructure operations
import { claimProductBatches } from "../supabase/functions/_infrastructure/database.ts";
import { processProductBatch } from "../supabase/functions/_infrastructure/batch-processing.ts";
import { calculateRequiredTokens } from "../supabase/functions/_domain/tokens.ts";
import { WebhookNotifier } from "../supabase/functions/_infrastructure/discord.ts";

// Dynamic memory management based on machine size
const MACHINE_MEMORY_LIMITS = {
  'micro': 250,      // 0.25 GB
  'small-1x': 500,   // 0.5 GB  
  'small-2x': 1000,  // 1 GB
  'medium-1x': 2000, // 2 GB
  'medium-2x': 4000, // 4 GB
  'large-1x': 8000,  // 8 GB
  'large-2x': 16000  // 16 GB
} as const;

// Get machine config and calculate thresholds
const currentMachine = 'small-2x'; // Will match task machine config
const memoryLimit = MACHINE_MEMORY_LIMITS[currentMachine] || 2000;
const gcThreshold = Math.floor(memoryLimit * 0.4); // 40% for GC trigger
const alertThreshold = Math.floor(memoryLimit * 0.7); // 70% for alerts

// Configurable token management
const MINIMUM_TOKENS_THRESHOLD = 7000; // Stop processing when Keepa tokens drop below this

// Product batch processing job - handles product batches from queue
export const productBatches = task({
  id: "product-batches",
  maxDuration: 1800, // 30 minutes max (was hitting 30s limit)
  machine: "small-2x", // 1GB RAM, 2 vCPU - Testing cost optimization
  queue: {
    concurrencyLimit: 3, // Maximum 3 concurrent instances
  },
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 30000,
    outOfMemory: {
      machine: "medium-1x", // Auto-upgrade to 2GB if OOM
    },
  },
  run: async (payload: { sellerId: string; priority: 'HIGH' | 'LOW' }, { ctx }) => {
    logger.info(`WORKER | v2.5.0 | seller=${payload.sellerId.substring(0,8)} | priority=${payload.priority} | started`);

    try {
      // Warm start safety: Clear any stale singleton state
      // This ensures clean state for each task run even with processKeepAlive
      if (typeof TokenManager !== 'undefined' && TokenManager.clearInstances) {
        TokenManager.clearInstances();
      }
      
      // Memory monitoring
      const startMemory = process.memoryUsage();

      // Phase 4: Real batch processing implementation
      const supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      );

      // Step 2: Atomic batch claiming with worker ID
      const workerId = `${ctx.run.id}`;
      
      // Job-level timing for continuous processing timeout
      const jobStartTime = Date.now();
      
      // Helper function to check timeout
      const isApproachingTimeout = (): boolean => {
        const elapsed = Date.now() - jobStartTime;
        const maxDuration = 25 * 60 * 1000; // 25 minutes (5 min buffer)
        return elapsed > maxDuration;
      };
      
      // Seller info cache to avoid redundant DB queries across all loops
      // Note: This cache is task-scoped, safe for warm starts
      const sellerInfoCache = new Map<string, { domain: number; seller_id: string }>();
      
      // Get seller info with caching
      const getBatchSellerInfo = async (batchSellerId: string) => {
        if (sellerInfoCache.has(batchSellerId)) {
          return sellerInfoCache.get(batchSellerId)!;
        }
        
        const { data: sellerInfo, error } = await supabase
          .from('sellers')
          .select('seller_id, domain')
          .eq('id', batchSellerId)
          .single();
          
        if (error || !sellerInfo) {
          throw new Error(`Seller not found: ${batchSellerId}`);
        }
        
        sellerInfoCache.set(batchSellerId, {
          domain: sellerInfo.domain,
          seller_id: sellerInfo.seller_id
        });
        
        return sellerInfoCache.get(batchSellerId)!;
      };
      
      // Continuous processing: Keep working until no more batches available
      let hasMoreWork = true;
      let loopCount = 0;
      let totalProcessedInJob = 0;
      let totalFailedInJob = 0;
      let totalBatchesProcessed = 0;
      
      while (hasMoreWork && !isApproachingTimeout()) {
        loopCount++;
        
        // Token checking can be simplified or removed since we check in the domain layer
        // For now just continue without the complex token state checking
        // The domain functions will handle token calculations when needed
        
        const claimedBatches = await claimProductBatches(supabase, payload.sellerId, workerId, 3);

        if (!claimedBatches || claimedBatches.length === 0) {
          const successRate = totalProcessedInJob === 0 ? 0 : Math.round((totalProcessedInJob / (totalProcessedInJob + totalFailedInJob)) * 100);
          logger.info(`WORKER | ${loopCount} loops done | ${totalProcessedInJob} total processed | ${successRate}% success`);
          hasMoreWork = false;
          break;
        }

        // Process claimed batches using existing chunked logic
        const startTime = Date.now();
        const totalProducts = claimedBatches.reduce((sum, b) => sum + b.product_count, 0);
        logger.info(`CLAIM | loop=${loopCount} | found ${claimedBatches.length} batches | ${totalProducts} products`);
      


      // Webhook notification: Batch processing started
      WebhookNotifier.started('Product Batches', `Loop ${loopCount}: ${totalProducts} products (${claimedBatches.length} batches) - Seller: ${payload.sellerId.substring(0,8)}`);

      // Step 3: Process batches in chunks of 3 with GC between chunks
      let totalProcessed = 0;
      let totalFailed = 0;
      let completedBatches = 0;
      let globalBatchNumber = 0; // Global batch counter for numbering
      const batchResults = [];
      
      // Performance tracking variables
      let chunkStartTime = Date.now();
      let peakMemory = 0;
      
      // Process each batch sequentially
      for (let batchIndex = 0; batchIndex < claimedBatches.length; batchIndex++) {
        const batch = claimedBatches[batchIndex];
        const currentBatchNumber = globalBatchNumber + batchIndex + 1;
        
        // Get seller info for THIS specific batch
        const batchSellerInfo = await getBatchSellerInfo(batch.seller_id);
        
        try {
          // Use shared processor for consistent batch handling
          const processingResult = await processProductBatch(
            batch.seller_id,
            batch.new_asins,
            batchSellerInfo.domain,
            batchSellerInfo.seller_id,
            supabase,
            {
              batchId: batch.id,
              source: 'TRIGGER_DEV',
              createBatch: false  // Batch already exists
            }
          );

          const duration = ((Date.now() - startTime) / 1000).toFixed(1);
          logger.info(`BATCH | ${batch.id.substring(0,8)} (${batchIndex + 1}/${claimedBatches.length}) | ${processingResult.processedCount} processed, ${processingResult.failedCount} failed | ${duration}s`);

          completedBatches++;
          totalProcessed += processingResult.processedCount;
          totalFailed += processingResult.failedCount;

          batchResults.push({
            batchId: batch.id,
            success: processingResult.processedCount,
            failed: processingResult.failedCount,
            status: processingResult.batchStatus
          });

        } catch (batchError) {
          const currentMemory = process.memoryUsage();
          const memoryInfo = `RSS: ${Math.round(currentMemory.rss / 1024 / 1024)}MB, Heap: ${Math.round(currentMemory.heapUsed / 1024 / 1024)}MB`;
          
          logger.error(`BATCH | ${batch.id.substring(0,8)} (${batchIndex + 1}/${claimedBatches.length}) | FAILED | error="${batchError.message}"`);
          
          // CHECKPOINT: Mark specific failure reason with memory info
          try {
            await supabase
              .from('product_batches')
              .update({ 
                status: 'FAILED',
                updated_at: new Date().toISOString(),
                error_message: `${batchError.message} | Memory: ${memoryInfo}`,
                memory_stats: {
                  final_heap_mb: Math.round(currentMemory.heapUsed / 1024 / 1024),
                  product_count: batch.product_count,
                  machine_type: currentMachine,
                  error_stage: "batch_processing"
                }
              })
              .eq('id', batch.id);
          } catch (updateError) {
            logger.error(`BATCH: Update failed batch=${batch.id.substring(0,8)} error="${updateError.message}"`);
          }

          totalFailed += batch.product_count;
          batchResults.push({
            batchId: batch.id,
            success: 0,
            failed: batch.product_count,
            status: 'FAILED',
            error: batchError.message
          });
        }
      }

      // Calculate timing metrics for alerts
      const avgBatchTime = (Date.now() - chunkStartTime) / 1000 / claimedBatches.length;
      if (avgBatchTime > 45) {
        const slowBy = (avgBatchTime - 45).toFixed(1);
        logger.warn(`PERF | ${avgBatchTime.toFixed(1)}s avg > 45s threshold | +${slowBy}s slow`);
        WebhookNotifier.alert(`Slow processing: ${avgBatchTime.toFixed(1)}s (threshold: 45s)`);
      }



      // Dynamic memory management every 5 loops
      if (loopCount % 5 === 0) {
        const currentMemory = process.memoryUsage();
        const memoryMB = Math.round(currentMemory.heapUsed / 1024 / 1024);
        
        if (memoryMB > gcThreshold) {
          logger.info(`MEMORY | GC triggered | ${memoryMB}MB > ${gcThreshold}MB threshold`);
          if (global.gc) {
            const beforeGC = memoryMB;
            global.gc();
            const afterGC = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
            const freed = beforeGC - afterGC;
            logger.info(`MEMORY | GC complete | ${beforeGC}MB → ${afterGC}MB | ${freed}MB freed`);
          }
        }
        
        // Alert if approaching limit
        if (memoryMB > alertThreshold) {
          logger.warn(`MEMORY | high usage | ${memoryMB}MB/${memoryLimit}MB limit | ${Math.round((memoryMB/memoryLimit)*100)}% used`);
          WebhookNotifier.alert(`⚠️ Memory high: ${memoryMB}MB approaching ${currentMachine} limit: ${memoryLimit}MB`);
        }
      }

      // Update global batch counter for next loop iteration
      globalBatchNumber += claimedBatches.length;

      // Webhook notification: Batch processing completed for this loop
      const endTime = Date.now();
      const duration = endTime - startTime;
      const finalMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      WebhookNotifier.completed('Product Batches', 
        `Loop ${loopCount}: ${totalProcessed}/${totalProcessed + totalFailed} products processed - ${Math.round(duration/1000)}s\n` +
        `🧠 Final memory: ${finalMemory}MB (${currentMachine}: ${memoryLimit}MB limit)`
      );

      // Accumulate results from this loop iteration
      totalProcessedInJob += totalProcessed;
      totalFailedInJob += totalFailed;
      totalBatchesProcessed += completedBatches;
      
      const loopDuration = ((Date.now() - startTime) / 1000).toFixed(1);
      const successEmoji = totalFailed === 0 ? '✅' : '⚠️';
      logger.info(`LOOP | #${loopCount} complete | ${totalProcessed}/${totalProcessed + totalFailed} processed | ${loopDuration}s total ${successEmoji}`);
      
      // Check for timeout before next loop iteration
      if (isApproachingTimeout()) {
        logger.warn(`WORKER | timeout approaching | ${loopCount} loops | graceful shutdown`);
        break;
      }
    }

    // Final webhook notification: Complete continuous processing job
    WebhookNotifier.completed('Continuous Product Batches', 
      `🔄 Continuous processing complete: ${loopCount} loops, ${totalProcessedInJob} total products processed`
    );

    const finalDuration = ((Date.now() - jobStartTime) / 1000).toFixed(1);
    logger.info(`FINISHED | ${totalProcessedInJob} products | ${totalFailedInJob} failures | ${totalBatchesProcessed} batches | ${finalDuration}s`);

    return {
      processed: totalProcessedInJob,
      failed: totalFailedInJob,
      continuousLoops: loopCount,
      totalBatchesProcessed: totalBatchesProcessed,
      status: "Continuous processing with queue draining",
      timestamp: new Date().toISOString()
    };

    } catch (error) {
      logger.error("❌ Batch processing failed", { error });
      
      // Webhook notification: Processing error
      WebhookNotifier.error("Product Batches", error.message);
      
      throw error;
    }
  },
}); 