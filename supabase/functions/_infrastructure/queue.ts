// Constants - EXACT FROM ORIGINAL
const SMART_ROUTING_THRESHOLD = 200;
const BATCH_SIZE = 100;
const ESTIMATED_TOKENS_PER_PRODUCT = 7;

// Types - EXACT FROM ORIGINAL
interface BatchRecord {
  id?: string;
  seller_id: string;
  user_id?: string;
  product_count: number;
  new_asins: string[];
  status: string;
  priority: 'HIGH' | 'LOW';
  job_type: 'TIME_MACHINE' | 'MONITORING';
  estimated_tokens: number;
  batch_type?: 'NEW_ASINS' | 'FULL_REFRESH' | 'INCREMENTAL';
  requested_by_user_id?: string;
  user_confirmed_at?: string;
  user_declined_at?: string;
  available_for_confirmation?: boolean;
  confirmation_offered_to_user_ids?: string[];
}

interface BatchResult {
  success: boolean;
  batchCount: number;
  totalProducts: number;
  batches: BatchRecord[];
  errors: string[];
}

interface TriggerResult {
  batchId: string;
  success: boolean;
  triggerResult: {
    success: boolean;
    runId?: string;
    error?: string;
  };
}

interface QueueResponse {
  batchesCreated: number;
  totalProducts: number;
  estimatedTime: string;
  message: string;
  triggeredJobs: TriggerResult[];
}

/**
 * Check active product-batches task count using Trigger.dev API
 * COPIED EXACTLY FROM ORIGINAL
 */
export async function checkActiveTaskCount(runs: any = null, taskId: string = "product-batches"): Promise<number> {
  try {
    console.log(`🔍 Checking active task count for ${taskId}...`);
    
    if (!runs) {
      console.warn(`⚠️ No runs SDK available - allowing trigger`);
      return 0;
    }
    
    const response = await runs.list({
      status: ["EXECUTING"], 
      taskIdentifier: [taskId],
      limit: 50
    });
    
    const activeCount = response.data?.length || 0;
    console.log(`📊 Found ${activeCount} active ${taskId} tasks`);
    return activeCount;
    
  } catch (error: any) {
    console.warn(`⚠️ Failed to check active task count: ${error.message}`);
    return 0;
  }
}

/**
 * Check for existing batches and handle deduplication
 * COPIED EXACTLY FROM ORIGINAL
 */
async function checkExistingBatches(
  sellerUuid: string,
  supabase: any,
  userId?: string,
  isTimeMachine: boolean = false
): Promise<{
  shouldCreateNew: boolean;
  reason: string;
  existingBatches?: any[];
}> {

  const { data: existingBatches, error } = await supabase
    .from('product_batches')
    .select('id, status, created_at, user_id, product_count')
    .eq('seller_id', sellerUuid)
    .in('status', ['PENDING', 'PROCESSING'])
    .order('created_at', { ascending: false });

  if (error) {
    console.log(`⚠️ Error checking existing batches: ${error.message}`);
    return { shouldCreateNew: true, reason: 'Database error - proceeding with creation' };
  }

  if (!existingBatches || existingBatches.length === 0) {
    return { shouldCreateNew: true, reason: 'No existing batches found' };
  }

  let recentBatches: any[] = [];
  let stuckBatches: any[] = [];
  const now = Date.now();
  const tenMinutesAgo = now - 10 * 60 * 1000;
  const thirtyMinutesAgo = now - 30 * 60 * 1000;

  for (const batch of existingBatches) {
    const batchTime = new Date(batch.created_at).getTime();
    if (batchTime > tenMinutesAgo) {
      recentBatches.push(batch);
    } else if ((batch.status === 'PENDING' || batch.status === 'PROCESSING') && batchTime < thirtyMinutesAgo) {
      stuckBatches.push(batch);
    }
  }

  if (recentBatches.length > 0) {
    const recentBatch = recentBatches[0];

    if (isTimeMachine && recentBatch.user_id === userId) {
      return {
        shouldCreateNew: false,
        reason: `Recent ${recentBatch.status} batches exist for this user (${recentBatches.length} batches)`,
        existingBatches: recentBatches
      };
    }

    return {
      shouldCreateNew: false,
      reason: `Recent ${recentBatch.status} batches exist (${recentBatches.length} batches)`,
      existingBatches: recentBatches
    };
  }

  if (stuckBatches.length > 0) {
    console.log(`🧹 Found ${stuckBatches.length} stuck PENDING batches - will clean them up`);

    await supabase
      .from('product_batches')
      .update({
        status: 'FAILED',
        error_message: 'Batch stuck in PENDING status - auto-failed',
        updated_at: new Date().toISOString()
      })
      .in('id', stuckBatches.map((b: any) => b.id));

    return { shouldCreateNew: true, reason: `Cleaned up ${stuckBatches.length} stuck batches` };
  }

  return { shouldCreateNew: true, reason: 'Existing batches are being processed' };
}

/**
 * Creates smart batches in the database for large sellers
 * COPIED EXACTLY FROM ORIGINAL
 */
async function createSmartBatches(
  sellerUuid: string,
  asinList: string[],
  supabase: any,
  userId?: string,
  isTimeMachine: boolean = false
): Promise<BatchResult> {
  const errors: string[] = [];
  const batches: BatchRecord[] = [];

  try {
    console.log(`📦 Creating smart batches for ${asinList.length} products`);

    const totalBatches = Math.ceil(asinList.length / BATCH_SIZE);
    console.log(`📊 Creating ${totalBatches} batches for ${asinList.length} products`);

    const allBatchRecords = new Array(totalBatches);

    const baseRecord = {
      seller_id: sellerUuid,
      user_id: userId,
      status: 'PENDING',
      priority: asinList.length <= 200 ? 'HIGH' : 'LOW' as 'HIGH' | 'LOW',
      job_type: isTimeMachine ? 'TIME_MACHINE' : 'MONITORING' as 'TIME_MACHINE' | 'MONITORING',
      batch_type: 'NEW_ASINS',
      requested_by_user_id: userId,
      available_for_confirmation: false,
      confirmation_offered_to_user_ids: []
    };

    for (let i = 0; i < totalBatches; i++) {
      const startIdx = i * BATCH_SIZE;
      const endIdx = Math.min(startIdx + BATCH_SIZE, asinList.length);
      const batchSize = endIdx - startIdx;

      allBatchRecords[i] = {
        ...baseRecord,
        product_count: batchSize,
        new_asins: asinList.slice(startIdx, endIdx),
        estimated_tokens: batchSize * ESTIMATED_TOKENS_PER_PRODUCT
      };
    }

    const { data, error } = await supabase
      .from('product_batches')
      .insert(allBatchRecords)
      .select();

    if (error) {
      console.error(`❌ Bulk INSERT FAILED:`, {
        error: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
        batchCount: allBatchRecords.length
      });
      errors.push(`Bulk insert failed: ${error.message} (${error.code})`);
    } else {
      batches.push(...data);
      console.log(`✅ Created ${data.length} batches (${asinList.length} products) successfully`);
    }

    return {
      success: batches.length > 0,
      batchCount: batches.length,
      totalProducts: asinList.length,
      batches,
      errors
    };

  } catch (error: any) {
    console.log(`❌ Error creating batches: ${error.message}`);
    return {
      success: false,
      batchCount: 0,
      totalProducts: 0,
      batches: [],
      errors: [error.message]
    };
  }
}

/**
 * Triggers ONE processing job for ALL batches of a seller
 * COPIED EXACTLY FROM ORIGINAL
 */
async function triggerSingleProcessingJob(
  sellerUuid: string,
  tasks: any,
  priority: 'HIGH' | 'LOW' = 'LOW'
): Promise<TriggerResult> {

  try {
    console.log(`🚀 Attempting to trigger single job for seller ${sellerUuid}...`);

    const handle = await tasks.trigger("product-batches", {
      sellerId: sellerUuid,
      priority: priority
    });

    console.log(`✅ Triggered single job for seller ${sellerUuid}, run ID: ${handle.id}`);

    return {
      batchId: sellerUuid,
      success: true,
      triggerResult: {
        success: true,
        runId: handle.id
      }
    };

  } catch (error: any) {
    console.error(`❌ Trigger.dev SDK error for seller ${sellerUuid}:`, {
      error: error.message,
      errorName: error.name,
      stack: error.stack,
      payload: {
        sellerId: sellerUuid,
        priority: priority
      }
    });

    console.log(`❌ Failed to trigger job for seller ${sellerUuid}: ${error.message || 'Unknown error'}`);

    return {
      batchId: sellerUuid,
      success: false,
      triggerResult: {
        success: false,
        error: error.message || 'Unknown error'
      }
    };
  }
}

/**
 * Complete queue workflow for large sellers - EXACT SIGNATURE FROM ORIGINAL
 */
export async function enqueueProductBatches(
  sellerUuid: string,
  newProducts: string[],
  supabase: any,
  tasks: any,
  runs: any = null,
  userId?: string,
  isTimeMachine: boolean = true
): Promise<QueueResponse> {
  console.log(`🚀 Processing large seller queue: ${newProducts.length} products`);

  const batchCheck = await checkExistingBatches(sellerUuid, supabase, userId, isTimeMachine);

  if (!batchCheck.shouldCreateNew) {
    console.log(`🔄 Skipping batch creation: ${batchCheck.reason}`);

    const existingBatches = batchCheck.existingBatches || [];
    const totalProducts = existingBatches.reduce((sum: number, b: any) => sum + b.product_count, 0);

    return {
      batchesCreated: existingBatches.length,
      totalProducts,
      estimatedTime: '< 1 minute',
      message: `Using existing batches: ${batchCheck.reason}`,
      triggeredJobs: []
    };
  }

  console.log(`✅ Proceeding with batch creation: ${batchCheck.reason}`);

  const batchResult = await createSmartBatches(sellerUuid, newProducts, supabase, userId, isTimeMachine);

  if (!batchResult.success) {
    console.log(`❌ Batch creation failed: ${batchResult.errors.join(', ')}`);
    return {
      batchesCreated: 0,
      totalProducts: 0,
      estimatedTime: '0 minutes',
      message: `Failed to create batches: ${batchResult.errors.join(', ')}`,
      triggeredJobs: []
    };
  }

  const activeCount = await checkActiveTaskCount(runs, "product-batches");
  if (activeCount >= 3) {
    console.log(`⏭️ Skipping trigger: ${activeCount}/3 product-batches tasks already running`);
    
    const estimatedMinutes = Math.ceil(batchResult.totalProducts / 100) * 0.5;
    const estimatedTime = estimatedMinutes < 1 ? '< 1 minute' : `${Math.ceil(estimatedMinutes)} minutes`;
    
    return {
      batchesCreated: batchResult.batchCount,
      totalProducts: batchResult.totalProducts,
      estimatedTime,
      message: `Existing ${activeCount} tasks will handle ${batchResult.totalProducts} products in ${batchResult.batchCount} batches`,
      triggeredJobs: []
    };
  }

  const priority = newProducts.length <= 200 ? 'HIGH' : 'LOW';
  const triggerResult = await triggerSingleProcessingJob(sellerUuid, tasks, priority);

  const estimatedMinutes = Math.ceil(batchResult.totalProducts / 100) * 0.5;
  const estimatedTime = estimatedMinutes < 1 ? '< 1 minute' : `${Math.ceil(estimatedMinutes)} minutes`;

  console.log(`📊 Queue processing summary: ${triggerResult.success ? 'job triggered successfully' : 'job failed'}`);

  return {
    batchesCreated: batchResult.batchCount,
    totalProducts: batchResult.totalProducts,
    estimatedTime,
    message: `Processing ${batchResult.totalProducts} products in ${batchResult.batchCount} batches`,
    triggeredJobs: [triggerResult]
  };
}

/**
 * Phase 3: Graceful degradation - fallback to immediate processing if queue fails
 * COPIED EXACTLY FROM ORIGINAL
 */
export async function handleQueueFailure(
  sellerUuid: string,
  newProducts: string[],
  fallbackThreshold: number = 100
): Promise<{ shouldFallback: boolean; reason: string }> {
  if (newProducts.length <= fallbackThreshold) {
    console.log(`🔄 Queue failure - falling back to immediate processing (${newProducts.length} products)`);
    return {
      shouldFallback: true,
      reason: `Queue failed but ${newProducts.length} products manageable for immediate processing`
    };
  }

  return {
    shouldFallback: false,
    reason: `Too many products (${newProducts.length}) for immediate processing fallback`
  };
}

/**
 * Atomically claim product batches for processing
 * COPIED EXACTLY FROM ORIGINAL
 */
export async function claimProductBatches(
  supabase: any,
  sellerId: string, 
  workerId: string,
  limit: number = 3
): Promise<BatchRecord[]> {

  let totalClaimed = [];
  let remainingCapacity = limit;
  let attemptCount = 0;
  const maxAttempts = 3;

  while (remainingCapacity > 0 && attemptCount < maxAttempts) {
    let claimedThisRound = [];
    
    if (remainingCapacity > 0) {
      const step1 = await claimAssignedSeller(supabase, sellerId, workerId, remainingCapacity);
      claimedThisRound.push(...step1);
      remainingCapacity -= step1.length;
    }
    
    if (remainingCapacity > 0) {
      const step2 = await claimOrphanedBatches(supabase, workerId, remainingCapacity);
      claimedThisRound.push(...step2);
      remainingCapacity -= step2.length;
      if (step2.length > 0) console.log(`🆘 Step 2: Claimed ${step2.length} orphaned batches`);
    }
    
    if (remainingCapacity > 0) {
      const step3 = await claimCrossSellerBatches(supabase, sellerId, workerId, remainingCapacity);
      claimedThisRound.push(...step3);
      remainingCapacity -= step3.length;
      if (step3.length > 0) console.log(`🌍 Step 3: Claimed ${step3.length} cross-seller batches`);
    }
    
    totalClaimed.push(...claimedThisRound);
    
    if (claimedThisRound.length === 0) break;
    attemptCount++;
  }
  
  return totalClaimed;
}

/**
 * Helper: Claim assigned seller's PENDING batches
 * COPIED EXACTLY FROM ORIGINAL
 */
async function claimAssignedSeller(
  supabase: any,
  sellerId: string,
  workerId: string,
  limit: number
): Promise<any[]> {
  
  const { data: batchesToClaim, error: selectError } = await supabase
    .from('product_batches')
    .select('id')
    .eq('seller_id', sellerId)
    .eq('status', 'PENDING')
    .is('processing_by', null)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(limit);

  if (selectError) {
    console.error("❌ Failed to select assigned seller batches", { error: selectError });
    throw selectError;
  }

  if (!batchesToClaim || batchesToClaim.length === 0) {
    return [];
  }

  const batchIds = batchesToClaim.map((b: any) => b.id);
  const { data, error } = await supabase
    .from('product_batches')
    .update({ 
      processing_by: workerId,
      status: 'PROCESSING',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .in('id', batchIds)
    .select();

  if (error) {
    console.error("❌ Failed to claim assigned seller batches", { error });
    throw error;
  }

  return data || [];
}

/**
 * Helper: Claim orphaned PROCESSING batches from any seller
 * COPIED EXACTLY FROM ORIGINAL
 */
async function claimOrphanedBatches(
  supabase: any,
  workerId: string,
  limit: number
): Promise<any[]> {
  const tenMinutesAgo = new Date(Date.now() - 600000).toISOString();
  
  const { data: batchesToClaim, error: selectError } = await supabase
    .from('product_batches')
    .select('id')
    .eq('status', 'PROCESSING')
    .lt('started_at', tenMinutesAgo)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(limit);

  if (selectError) {
    console.error("❌ Failed to select orphaned batches", { error: selectError });
    throw selectError;
  }

  if (!batchesToClaim || batchesToClaim.length === 0) {
    return [];
  }

  const batchIds = batchesToClaim.map((b: any) => b.id);
  const { data, error } = await supabase
    .from('product_batches')
    .update({ 
      processing_by: workerId,
      status: 'PROCESSING',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .in('id', batchIds)
    .select();

  if (error) {
    console.error("❌ Failed to claim orphaned batches", { error });
    throw error;
  }

  return data || [];
}

/**
 * Helper: Claim PENDING batches from other sellers
 * COPIED EXACTLY FROM ORIGINAL
 */
async function claimCrossSellerBatches(
  supabase: any,
  sellerId: string,
  workerId: string,
  limit: number
): Promise<any[]> {
  
  const { data: batchesToClaim, error: selectError } = await supabase
    .from('product_batches')
    .select('id')
    .eq('status', 'PENDING')
    .is('processing_by', null)
    .neq('seller_id', sellerId)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(limit);

  if (selectError) {
    console.error("❌ Failed to select cross-seller batches", { error: selectError });
    throw selectError;
  }

  if (!batchesToClaim || batchesToClaim.length === 0) {
    return [];
  }

  const batchIds = batchesToClaim.map((b: any) => b.id);
  const { data, error } = await supabase
    .from('product_batches')
    .update({ 
      processing_by: workerId,
      status: 'PROCESSING',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .in('id', batchIds)
    .select();

  if (error) {
    console.error("❌ Failed to claim cross-seller batches", { error });
    throw error;
  }

  return data || [];
}

// Export types for use in other environments - EXACT FROM ORIGINAL
export type { BatchRecord, BatchResult, TriggerResult, QueueResponse };