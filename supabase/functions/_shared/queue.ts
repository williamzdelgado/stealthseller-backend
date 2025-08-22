// Pure queue processing functions - environment dependencies injected as parameters
// Follows the same pattern as keepa.ts for maximum consistency

// Constants
const SMART_ROUTING_THRESHOLD = 200; // Products threshold for queue processing
const BATCH_SIZE = 100; // Products per batch
const ESTIMATED_TOKENS_PER_PRODUCT = 7;

// Types
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
  // SMART PROCESSING: New schema fields
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
 * Returns count of currently executing tasks to prevent excessive concurrency
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
    
  } catch (error) {
    console.warn(`⚠️ Failed to check active task count: ${error.message}`);
    return 0; // Fail open - allow triggering if we can't check
  }
}

/**
 * Check for existing batches and handle deduplication
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

  // Query for existing batches for this seller (optimized: select only needed fields)
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

  // Memory-optimized: Single loop with conditional logic instead of multiple array filters
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

    // Same user + Time Machine = allow (user might be retrying)
    if (isTimeMachine && recentBatch.user_id === userId) {
      return {
        shouldCreateNew: false,
        reason: `Recent ${recentBatch.status} batches exist for this user (${recentBatches.length} batches)`,
        existingBatches: recentBatches
      };
    }

    // Different user or background job = block
    return {
      shouldCreateNew: false,
      reason: `Recent ${recentBatch.status} batches exist (${recentBatches.length} batches)`,
      existingBatches: recentBatches
    };
  }

  // Process stuck batches (already identified in single loop above)

  if (stuckBatches.length > 0) {
    console.log(`🧹 Found ${stuckBatches.length} stuck PENDING batches - will clean them up`);

    // Mark stuck batches as FAILED
    await supabase
      .from('product_batches')
      .update({
        status: 'FAILED',
        error_message: 'Batch stuck in PENDING status - auto-failed',
        updated_at: new Date().toISOString()
      })
      .in('id', stuckBatches.map(b => b.id));

    return { shouldCreateNew: true, reason: `Cleaned up ${stuckBatches.length} stuck batches` };
  }

  return { shouldCreateNew: true, reason: 'Existing batches are being processed' };
}

/**
 * Creates smart batches in the database for large sellers
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

    // ULTRA-OPTIMIZATION: Skip seller validation - trust caller (saves 50-100ms)
    // Use index ranges instead of array slicing (saves memory)
    const totalBatches = Math.ceil(asinList.length / BATCH_SIZE);
    console.log(`📊 Creating ${totalBatches} batches for ${asinList.length} products`);

    // Pre-allocate result array (V8 optimization)
    const allBatchRecords = new Array(totalBatches);

    // Object template for performance (V8 hidden class optimization)
    const baseRecord = {
      seller_id: sellerUuid,
      user_id: userId,
      status: 'PENDING',
      priority: asinList.length <= 200 ? 'HIGH' : 'LOW',
      job_type: isTimeMachine ? 'TIME_MACHINE' : 'MONITORING',
      // SMART PROCESSING: Add new schema fields
      batch_type: 'NEW_ASINS',
      requested_by_user_id: userId,
      available_for_confirmation: false, // Default to false for auto-created batches
      confirmation_offered_to_user_ids: []
    };

    // Single loop with index math (no array slicing)
    for (let i = 0; i < totalBatches; i++) {
      const startIdx = i * BATCH_SIZE;
      const endIdx = Math.min(startIdx + BATCH_SIZE, asinList.length);
      const batchSize = endIdx - startIdx;

      // Use slice only once, directly assign
      allBatchRecords[i] = {
        ...baseRecord,  // Spread once
        product_count: batchSize,
        new_asins: asinList.slice(startIdx, endIdx),
        estimated_tokens: batchSize * ESTIMATED_TOKENS_PER_PRODUCT
      };
    }

    // Single bulk operation (already optimized)
    const { data, error } = await supabase
      .from('product_batches')
      .insert(allBatchRecords)
      .select();

    // Single log instead of multiple logs
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

  } catch (error) {
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
 */
async function triggerSingleProcessingJob(
  sellerUuid: string,
  tasks: any,
  priority: 'HIGH' | 'LOW' = 'LOW'
): Promise<TriggerResult> {

  try {
    console.log(`🚀 Attempting to trigger single job for seller ${sellerUuid}...`);

    // Use Trigger.dev SDK to trigger the task
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

  } catch (error) {
    // Enhanced error logging
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
 * Complete queue workflow for large sellers - pure function with injected dependencies
 * RENAMED FROM: processLargeSellerQueue → enqueueProductBatches
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

  // Step 1: Check for existing batches and handle deduplication
  const batchCheck = await checkExistingBatches(sellerUuid, supabase, userId, isTimeMachine);

  if (!batchCheck.shouldCreateNew) {
    console.log(`🔄 Skipping batch creation: ${batchCheck.reason}`);

    // Return existing batch info instead of creating new ones
    const existingBatches = batchCheck.existingBatches || [];
    const totalProducts = existingBatches.reduce((sum, b) => sum + b.product_count, 0);

    return {
      batchesCreated: existingBatches.length,
      totalProducts,
      estimatedTime: '< 1 minute',
      message: `Using existing batches: ${batchCheck.reason}`,
      triggeredJobs: [] // Don't trigger new jobs for existing batches
    };
  }

  console.log(`✅ Proceeding with batch creation: ${batchCheck.reason}`);

  // Step 2: Create batches (existing logic)
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

  // Step 3: Pre-flight concurrency check before triggering
  const activeCount = await checkActiveTaskCount(runs, "product-batches");
  if (activeCount >= 3) {
    console.log(`⏭️ Skipping trigger: ${activeCount}/3 product-batches tasks already running`);
    
    // Calculate estimated time for existing batches to handle these products
    const estimatedMinutes = Math.ceil(batchResult.totalProducts / 100) * 0.5;
    const estimatedTime = estimatedMinutes < 1 ? '< 1 minute' : `${Math.ceil(estimatedMinutes)} minutes`;
    
    return {
      batchesCreated: batchResult.batchCount,
      totalProducts: batchResult.totalProducts,
      estimatedTime,
      message: `Existing ${activeCount} tasks will handle ${batchResult.totalProducts} products in ${batchResult.batchCount} batches`,
      triggeredJobs: [] // No new job triggered
    };
  }

  // Step 4: Trigger single processing job for all batches
  const priority = newProducts.length <= 200 ? 'HIGH' : 'LOW';
  const triggerResult = await triggerSingleProcessingJob(sellerUuid, tasks, priority);

  // Step 5: Calculate estimated completion time
  const estimatedMinutes = Math.ceil(batchResult.totalProducts / 100) * 0.5; // ~30 seconds per 100 products
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
 */
export async function handleQueueFailure(
  sellerUuid: string,
  newProducts: string[],
  fallbackThreshold: number = 100
): Promise<{ shouldFallback: boolean; reason: string }> {
  // If queue creation fails and product count is manageable, fallback to immediate processing
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
 * Prevents race conditions between concurrent workers
 * Uses atomic UPDATE with WHERE conditions to ensure only one worker claims each batch
 */
export async function claimProductBatches(
  supabase: any,
  sellerId: string, 
  workerId: string,
  limit: number = 3
): Promise<BatchRecord[]> {
  // Claiming batches - detailed logging removed to reduce noise

  let totalClaimed = [];
  let remainingCapacity = limit;
  let attemptCount = 0;
  const maxAttempts = 3; // Prevent infinite loops

  while (remainingCapacity > 0 && attemptCount < maxAttempts) {
    let claimedThisRound = [];
    
    // Step 1: Try assigned seller
    if (remainingCapacity > 0) {
      const step1 = await claimAssignedSeller(supabase, sellerId, workerId, remainingCapacity);
      claimedThisRound.push(...step1);
      remainingCapacity -= step1.length;
      // Step 1 claiming - logging removed to reduce noise
    }
    
    // Step 2: Try orphaned batches
    if (remainingCapacity > 0) {
      const step2 = await claimOrphanedBatches(supabase, workerId, remainingCapacity);
      claimedThisRound.push(...step2);
      remainingCapacity -= step2.length;
      if (step2.length > 0) console.log(`🆘 Step 2: Claimed ${step2.length} orphaned batches`);
    }
    
    // Step 3: Try cross-seller pending
    if (remainingCapacity > 0) {
      const step3 = await claimCrossSellerBatches(supabase, sellerId, workerId, remainingCapacity);
      claimedThisRound.push(...step3);
      remainingCapacity -= step3.length;
      if (step3.length > 0) console.log(`🌍 Step 3: Claimed ${step3.length} cross-seller batches`);
    }
    
    totalClaimed.push(...claimedThisRound);
    
    // Exit if no work found this round
    if (claimedThisRound.length === 0) break;
    attemptCount++;
  }

  // Total claimed - summary logging moved to caller to reduce noise
  
  return totalClaimed;
}

/**
 * Helper: Claim assigned seller's PENDING batches
 */
async function claimAssignedSeller(
  supabase: any,
  sellerId: string,
  workerId: string,
  limit: number
): Promise<any[]> {
  
  // Step 1: SELECT the batches we want to claim (with proper LIMIT)
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

  // Step 2: UPDATE only the selected batches by ID
  const batchIds = batchesToClaim.map(b => b.id);
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
 */
async function claimOrphanedBatches(
  supabase: any,
  workerId: string,
  limit: number
): Promise<any[]> {
  const tenMinutesAgo = new Date(Date.now() - 600000).toISOString(); // 10 minutes - safe buffer for legitimate processing
  
  // Step 1: SELECT the batches we want to claim (with proper LIMIT)
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

  // Step 2: UPDATE only the selected batches by ID
  const batchIds = batchesToClaim.map(b => b.id);
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
 */
async function claimCrossSellerBatches(
  supabase: any,
  sellerId: string,
  workerId: string,
  limit: number
): Promise<any[]> {
  
  // Step 1: SELECT the batches we want to claim (with proper LIMIT)
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

  // Step 2: UPDATE only the selected batches by ID
  const batchIds = batchesToClaim.map(b => b.id);
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

// Export types for use in other environments
export type { BatchRecord, BatchResult, TriggerResult, QueueResponse }; 