import { logger, task } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";
import {
  fetchSellerFromKeepa,
  findNewAsins,
  saveSellerData,
  enqueueProductBatches
} from "../supabase/functions/_shared/shared-node";

// Automated seller monitoring job - runs every 2 hours
export const keepaDiscovery = task({
  id: "keepa-discovery",
  maxDuration: 1800, // 30 minutes max
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 10000,
    maxTimeoutInMs: 60000,
  },
  run: async (payload: any, { ctx }) => {
    logger.log("🔍 Starting automated seller monitoring", { 
      payload, 
      ctx,
      timestamp: new Date().toISOString()
    });

    try {
      const supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      );

      const KEEPA_API_KEY = process.env.KEEPA_API_KEY!;

      // Get eligible sellers for monitoring (12h+ stale, active users with subscriptions)
      logger.log("📊 Querying eligible sellers for monitoring...");
      
      const { data: sellers, error } = await supabase
        .from('sellers')
        .select(`
          id, seller_id, domain, last_checked_at, asin_count, is_active,
          user_sellers!inner(
            user_id,
            users!inner(subscription_status)
          )
        `)
        .eq('is_active', true)
        .is('trashed_at', null)
        .in('user_sellers.users.subscription_status', ['active', 'trialing'])
        .or('last_checked_at.is.null,last_checked_at.lt.' + new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString())
        .order('last_checked_at', { ascending: true, nullsFirst: true })
        .limit(50);

      if (error) {
        logger.error("❌ Error fetching eligible sellers", { error });
        throw error;
      }

      logger.log("📊 Found eligible sellers for monitoring", { 
        count: sellers?.length || 0,
        sellers: sellers?.map(s => ({ 
          id: s.id, 
          seller_id: s.seller_id, 
          domain: s.domain,
          last_checked_at: s.last_checked_at,
          asin_count: s.asin_count,
          active_users: s.user_sellers?.length || 0
        }))
      });

      // Process each eligible seller using shared functions
      const results = [];
      let totalNewAsins = 0;
      let totalBatchesCreated = 0;

      for (const seller of sellers || []) {
        try {
          logger.log(`🔍 Processing seller ${seller.seller_id}`, { 
            sellerId: seller.seller_id, 
            domain: seller.domain,
            lastChecked: seller.last_checked_at 
          });

          // 1. Fetch current seller data from Keepa API
          const keepaData = await fetchSellerFromKeepa(seller.seller_id, seller.domain, KEEPA_API_KEY);
          if (!keepaData) {
            logger.warn(`⚠️ No Keepa data for seller ${seller.seller_id}`);
            results.push({
              sellerId: seller.seller_id,
              status: 'no_data',
              message: 'No data returned from Keepa API'
            });
            continue;
          }

          // 2. Find new ASINs compared to database
          const asinAnalysis = await findNewAsins(seller.id, keepaData.asinList, supabase);
          
          // 3. Update seller data with fresh information and timestamp
          await saveSellerData(supabase, seller, null, seller.seller_id, seller.domain, keepaData, true);

          // 4. Enqueue new products for processing if found
          let queueResult = null;
          if (asinAnalysis.newAsins.length > 0) {
            queueResult = await enqueueProductBatches(seller.id, asinAnalysis.newAsins, null, false);
            logger.log(`📦 Queued ${asinAnalysis.newAsins.length} new products for background processing`, { 
              sellerId: seller.seller_id,
              batchesCreated: queueResult.batchesCreated,
              estimatedTime: queueResult.estimatedTime
            });
            totalBatchesCreated += queueResult.batchesCreated;
          }

          totalNewAsins += asinAnalysis.newAsins.length;

                     results.push({
             sellerId: seller.seller_id,
             domain: seller.domain,
             totalAsins: keepaData.asinList.length,
             newAsins: asinAnalysis.newAsins.length,
             existingAsins: keepaData.asinList.length - asinAnalysis.newAsins.length,
             batchesCreated: queueResult?.batchesCreated || 0,
             estimatedProcessingTime: queueResult?.estimatedTime || '0 minutes',
             status: 'success'
           });

          logger.log(`✅ Completed seller ${seller.seller_id}`, {
            totalAsins: keepaData.asinList.length,
            newAsins: asinAnalysis.newAsins.length,
            batchesCreated: queueResult?.batchesCreated || 0
          });

        } catch (error) {
          logger.error(`❌ Failed processing seller ${seller.seller_id}`, { 
            error: error.message,
            stack: error.stack 
          });
          results.push({
            sellerId: seller.seller_id,
            status: 'failed',
            error: error.message
          });
        }
      }

      // Summary logging
      const successCount = results.filter(r => r.status === 'success').length;
      const failureCount = results.filter(r => r.status === 'failed').length;

      logger.log("🎉 Automated monitoring cycle completed", {
        sellersProcessed: sellers?.length || 0,
        successfulSellers: successCount,
        failedSellers: failureCount,
        totalNewAsinsFound: totalNewAsins,
        totalBatchesCreated: totalBatchesCreated,
        results
      });

      // Return comprehensive results
      return {
        sellersProcessed: sellers?.length || 0,
        successfulSellers: successCount,
        failedSellers: failureCount,
        totalNewAsinsFound: totalNewAsins,
        totalBatchesCreated: totalBatchesCreated,
        status: "Automated monitoring completed successfully",
        timestamp: new Date().toISOString(),
        detailedResults: results
      };

    } catch (error) {
      logger.error("❌ Automated monitoring failed", { 
        error: error.message,
        stack: error.stack 
      });
      throw error;
    }
  },
}); 