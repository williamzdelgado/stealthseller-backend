import { BATCH_STATUS, BATCH_PRIORITY, JOB_TYPE, BATCH_TYPE } from '../_domain/constants.ts';

export interface SellerData {
  id?: string;
  seller_id: string;
  domain: number;
  seller_name?: string;
  asin_count?: number;
  initial_asin_list?: string[];
  similar_sellers?: any;
  top_brands?: any;
  total_storefront_asin_list_csv?: string;
  last_checked_at?: string;
  created_by?: string; // Required for RLS policy compliance
  created_at?: string;
  updated_at?: string;
}

export interface ProductData {
  asin: string;
  seller_id: string;
  title?: string;
  brand?: string;
  category?: string;
  sales_rank?: number | null;
  storefront_price?: number | null;
  buy_box_price?: number | null;
  stock_count?: number | null;
  rating?: number | null;
  rating_count?: number | null;
  monthly_sold?: number;
  images_csv?: string;
  is_fba?: boolean;
  is_fbm?: boolean;
  first_seen_at?: string;
  last_update?: number;
  listed_since?: number;
}

export interface BatchData {
  id?: string;
  seller_id: string;
  user_id?: string;
  product_count: number;
  new_asins: string[];
  status: string;
  priority: string;
  job_type: string;
  batch_type?: string;
  estimated_tokens: number;
  worker_id?: string;
  started_at?: string;
  completed_at?: string;
  error_message?: string;
  created_at?: string;
  updated_at?: string;
}

export interface AsinComparison {
  existingCount: number;
  pendingCount: number;
  newAsins: string[];
  newCount: number;
}

export interface InsertResult {
  success: number;
  failed: number;
  errors: string[];
}

export async function getSellerBySellerIdAndDomain(
  supabase: any,
  sellerId: string,
  domain: number
): Promise<{ data: SellerData | null; error: any }> {
  const { data, error } = await supabase
    .from('sellers')
    .select('*')
    .eq('seller_id', sellerId)
    .eq('domain', domain)
    .single();
  
  // Handle "no rows found" as normal case (new seller)
  if (error && error.code === 'PGRST116') {
    return { data: null, error: null };
  }
  
  return { data, error };
}

export async function getSellerUuid(
  supabase: any,
  sellerId: string,
  domain: number
): Promise<{ uuid: string | null; error: any }> {
  const { data, error } = await supabase
    .from('sellers')
    .select('id')
    .eq('seller_id', sellerId)
    .eq('domain', domain)
    .single();
  
  if (error) {
    // Handle "no rows found" as normal case (new seller)
    if (error.code === 'PGRST116') {
      return { uuid: null, error: null };
    }
    return { uuid: null, error };
  }
  
  if (!data) {
    return { uuid: null, error: null };
  }
  
  return { uuid: data.id, error: null };
}

export async function saveSeller(
  supabase: any,
  sellerData: SellerData
): Promise<{ data: SellerData | null; error: any }> {
  try {
    const { data, error } = await supabase
      .from('sellers')
      .upsert(sellerData, {
        onConflict: 'seller_id',
        ignoreDuplicates: false
      })
      .select()
      .single();
    
    if (error) {
      console.error('saveSeller database error:', error);
      console.error('saveSeller data that failed:', JSON.stringify(sellerData, null, 2));
    }
    
    return { data, error };
  } catch (exception) {
    console.error('saveSeller exception:', exception);
    console.error('saveSeller data that caused exception:', JSON.stringify(sellerData, null, 2));
    return { data: null, error: exception };
  }
}

export async function getExistingAsins(
  supabase: any,
  sellerUuid: string
): Promise<{ asins: string[]; error: any }> {
  try {
    const allAsins = new Set<string>();
    
    const { data: sellerData, error: sellerError } = await supabase
      .from('sellers')
      .select('initial_asin_list')
      .eq('id', sellerUuid)
      .single();
    
    if (sellerError && sellerError.code !== 'PGRST116') {
      return { asins: [], error: sellerError };
    }
    
    if (sellerData?.initial_asin_list) {
      sellerData.initial_asin_list.forEach((asin: string) => allAsins.add(asin));
    }
    
    const { data: products, error: productsError } = await supabase
      .from('seller_products')
      .select('asin_id')
      .eq('seller_id', sellerUuid);
    
    if (productsError && productsError.code !== 'PGRST116') {
      return { asins: [], error: productsError };
    }
    
    if (products) {
      products.forEach((p: { asin_id: string }) => allAsins.add(p.asin_id));
    }
    
    return { asins: Array.from(allAsins), error: null };
  } catch (error) {
    return { asins: [], error };
  }
}

export async function insertProducts(
  sellerId: string,
  products: ProductData[],
  domain: number,
  keepaSellerID: string,
  supabase: any,
  isDev: boolean = false,
  processingSource: string = 'UNKNOWN'
): Promise<InsertResult> {
  const errors: string[] = [];
  let success = 0;
  let failed = 0;

  if (isDev) {
    console.log(`💾 Batch processing ${products.length} products...`);
  }

  // Pre-allocate array to avoid resizing during processing (COPIED FROM ORIGINAL)
  const allRecords: { template: any; seller: any }[] = new Array(products.length);
  let recordIndex = 0;

  for (const product of products) {
    try {
      // Extract image IDs with minimal error handling - optimized to avoid intermediate arrays (COPIED FROM ORIGINAL)
      const imageIds: string[] = [];
      if (product.images_csv) {
        const parts = product.images_csv.split(',');
        for (let i = 0; i < parts.length; i++) {
          const trimmed = parts[i].trim();
          if (trimmed) imageIds.push(trimmed);
        }
      }

      // Prepare template record (shared data) (COPIED FROM ORIGINAL)
      const templateRecord = {
        asin_id: product.asin,
        domain: domain,
        title: product.title,
        brand: product.brand,
        category: product.category,
        images: imageIds,
        product_url: `https://amazon.com/dp/${product.asin}`,
        updated_at: new Date().toISOString(),
      };

      // Prepare seller record (seller-specific data) (COPIED FROM ORIGINAL)
      const sellerRecord = {
        seller_id: sellerId,
        asin_id: product.asin,  // Required by database schema
        domain: domain,         // Required by database schema
        _asin_id: product.asin, // Temporary field for template linking only
        _domain: domain,        // Temporary field for template linking only
        sales_rank: product.sales_rank,
        storefront_price: product.storefront_price,
        buy_box_price: product.buy_box_price,
        stock_count: product.stock_count,
        rating: product.rating,
        rating_count: product.rating_count,
        monthly_sales: product.monthly_sold,
        is_fba: product.is_fba,
        is_fbm: product.is_fbm,
        first_seen_at: product.first_seen_at,
        processing_source: processingSource,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      allRecords[recordIndex++] = { template: templateRecord, seller: sellerRecord };
      
    } catch (error) {
      failed++;
      const errorMessage = `Failed to process product ${product.asin}: ${error}`;
      errors.push(errorMessage);
      if (isDev) {
        console.log(`❌ ${errorMessage}`);
      }
    }
  }

  // Trim array to actual size (remove unused slots from failed products) (COPIED FROM ORIGINAL)
  const validRecords = allRecords.slice(0, recordIndex);

  // Two-phase batch database operation (COPIED FROM ORIGINAL)
  if (validRecords.length > 0) {
    try {
      // Phase 1: Upsert all templates (COPIED FROM ORIGINAL)
      const templateRecords = validRecords.map(r => r.template);
      const { data: templateResults, error: templateError } = await supabase
        .from('product_templates')
        .upsert(templateRecords, {
          onConflict: 'asin_id,domain'
        })
        .select('id,asin_id,domain');

      if (templateError) {
        failed += validRecords.length;
        const batchError = `Template batch insert failed: ${templateError.message}`;
        errors.push(batchError);
        if (isDev) {
          console.log(`❌ ${batchError}`);
        }
      } else {
        // Phase 2: Link seller records to templates with O(1) Map lookup (COPIED FROM ORIGINAL)
        const templateMap = new Map(
          templateResults.map((t: any) => [`${t.asin_id}-${t.domain}`, t.id])
        );

        const sellerRecords = validRecords.map(r => {
          const templateId = templateMap.get(`${r.seller._asin_id}-${r.seller._domain}`);
          return {
            seller_id: r.seller.seller_id,
            asin_id: r.seller.asin_id,
            domain: r.seller.domain,
            product_template_id: templateId,
            sales_rank: r.seller.sales_rank,
            storefront_price: r.seller.storefront_price,
            buy_box_price: r.seller.buy_box_price,
            stock_count: r.seller.stock_count,
            rating: r.seller.rating,
            rating_count: r.seller.rating_count,
            monthly_sales: r.seller.monthly_sales,
            is_fba: r.seller.is_fba,
            is_fbm: r.seller.is_fbm,
            first_seen_at: r.seller.first_seen_at,
            processing_source: r.seller.processing_source,
            created_at: r.seller.created_at,
            updated_at: r.seller.updated_at,
          };
        });

        const { error: sellerError } = await supabase
          .from('seller_products')
          .upsert(sellerRecords, {
            onConflict: 'seller_id,asin_id'
          });

        if (sellerError) {
          failed += validRecords.length;
          const batchError = `Seller batch insert failed: ${sellerError.message}`;
          errors.push(batchError);
          if (isDev) {
            console.log(`❌ ${batchError}`);
          }
        } else {
          success += validRecords.length;
          if (isDev) {
            console.log(`✅ Batch inserted ${validRecords.length} products successfully`);
          }
        }
      }
    } catch (error) {
      failed += validRecords.length;
      const batchError = `Batch operation error: ${error}`;
      errors.push(batchError);
      if (isDev) {
        console.log(`❌ ${batchError}`);
      }
    }
  }

  // Log error details only for failed products (COPIED FROM ORIGINAL)
  if (errors.length > 0 && isDev) {
    console.log(`🚨 Insert errors: [${errors.join(', ')}]`);
  }

  return {
    success,
    failed,
    errors
  };
}

export async function getActiveBatch(
  supabase: any,
  sellerUuid: string
): Promise<{ data: BatchData | null; error: any }> {
  const { data, error } = await supabase
    .from('product_batches')
    .select('*')
    .eq('seller_id', sellerUuid)
    .in('status', [BATCH_STATUS.PENDING, BATCH_STATUS.PROCESSING])
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  
  return { data, error };
}

export async function createBatch(
  supabase: any,
  sellerUuid: string,
  asins: string[],
  options?: {
    userId?: string;
    priority?: string;
    jobType?: string;
    batchType?: string;
  }
): Promise<{ data: BatchData | null; error: any }> {
  const batchData: BatchData = {
    seller_id: sellerUuid,
    user_id: options?.userId,
    product_count: asins.length,
    new_asins: asins,
    status: BATCH_STATUS.PENDING,
    priority: options?.priority || BATCH_PRIORITY.LOW,
    job_type: options?.jobType || JOB_TYPE.TIME_MACHINE,
    batch_type: options?.batchType || BATCH_TYPE.NEW_ASINS,
    estimated_tokens: asins.length * 7
  };
  
  const { data, error } = await supabase
    .from('product_batches')
    .insert(batchData)
    .select()
    .single();
  
  return { data, error };
}

export async function updateBatchStatus(
  supabase: any,
  batchId: string,
  status: string,
  options?: {
    workerId?: string;
    errorMessage?: string;
    completedAt?: string;
  }
): Promise<{ data: BatchData | null; error: any }> {
  const updates: any = { status };
  
  if (options?.workerId) updates.worker_id = options.workerId;
  if (options?.errorMessage) updates.error_message = options.errorMessage;
  if (options?.completedAt) updates.completed_at = options.completedAt;
  if (status === BATCH_STATUS.PROCESSING) updates.started_at = new Date().toISOString();
  
  const { data, error } = await supabase
    .from('product_batches')
    .update(updates)
    .eq('id', batchId)
    .select()
    .single();
  
  return { data, error };
}

export async function claimBatches(
  supabase: any,
  workerId: string,
  limit: number = 5
): Promise<{ data: BatchData[]; error: any }> {
  const { data, error } = await supabase.rpc('claim_product_batches', {
    p_worker_id: workerId,
    p_limit: limit
  });
  
  if (error) {
    return { data: [], error };
  }
  
  return { data: data || [], error: null };
}

// Complex batch claiming function for Trigger.dev workers
export async function claimProductBatches(
  supabase: any,
  sellerId: string, 
  workerId: string,
  limit: number = 3
): Promise<BatchData[]> {
  let totalClaimed: BatchData[] = [];
  let remainingCapacity = limit;
  let attemptCount = 0;
  const maxAttempts = 3;

  while (remainingCapacity > 0 && attemptCount < maxAttempts) {
    let claimedThisRound: BatchData[] = [];
    
    // Step 1: Try assigned seller
    if (remainingCapacity > 0) {
      const step1 = await claimAssignedSeller(supabase, sellerId, workerId, remainingCapacity);
      claimedThisRound.push(...step1);
      remainingCapacity -= step1.length;
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
  
  return totalClaimed;
}

// Helper functions for batch claiming
async function claimAssignedSeller(
  supabase: any,
  sellerId: string,
  workerId: string,
  limit: number
): Promise<BatchData[]> {
  const { data, error } = await supabase
    .from('product_batches')
    .update({ 
      status: BATCH_STATUS.PROCESSING,
      worker_id: workerId,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('seller_id', sellerId)
    .eq('status', BATCH_STATUS.PENDING)
    .is('worker_id', null)
    .order('created_at', { ascending: true })
    .limit(limit)
    .select();

  if (error) {
    console.error('Error claiming assigned seller batches:', error);
    return [];
  }

  return data || [];
}

async function claimOrphanedBatches(
  supabase: any,
  workerId: string,
  limit: number
): Promise<BatchData[]> {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('product_batches')
    .update({ 
      status: BATCH_STATUS.PROCESSING,
      worker_id: workerId,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('status', BATCH_STATUS.PROCESSING)
    .not('worker_id', 'is', null)
    .lt('started_at', tenMinutesAgo)
    .order('started_at', { ascending: true })
    .limit(limit)
    .select();

  if (error) {
    console.error('Error claiming orphaned batches:', error);
    return [];
  }

  return data || [];
}

async function claimCrossSellerBatches(
  supabase: any,
  sellerId: string,
  workerId: string,
  limit: number
): Promise<BatchData[]> {
  const { data, error } = await supabase
    .from('product_batches')
    .update({ 
      status: BATCH_STATUS.PROCESSING,
      worker_id: workerId,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('status', BATCH_STATUS.PENDING)
    .neq('seller_id', sellerId)
    .is('worker_id', null)
    .order('created_at', { ascending: true })
    .limit(limit)
    .select();

  if (error) {
    console.error('Error claiming cross-seller batches:', error);
    return [];
  }

  return data || [];
}

export async function getUserTokenUsage(
  supabase: any,
  userId: string,
  timeWindow: string = '1 hour'
): Promise<{ usage: number; error: any }> {
  const cutoff = new Date();
  
  if (timeWindow === '1 hour' || timeWindow === '1h') {
    cutoff.setHours(cutoff.getHours() - 1);
  } else if (timeWindow === '24 hours' || timeWindow === '1d') {
    cutoff.setHours(cutoff.getHours() - 24);
  }
  
  const { data, error } = await supabase
    .from('product_batches')
    .select('estimated_tokens')
    .eq('user_id', userId)
    .gte('created_at', cutoff.toISOString());
  
  if (error) {
    return { usage: 0, error };
  }
  
  const totalUsage = (data || []).reduce((sum: number, batch: any) => {
    return sum + (batch.estimated_tokens || 0);
  }, 0);
  
  return { usage: totalUsage, error: null };
}


export async function getQueueStatus(
  supabase: any
): Promise<{ pending: number; processing: number; error: any }> {
  const { data, error } = await supabase
    .from('product_batches')
    .select('status', { count: 'exact', head: true })
    .in('status', [BATCH_STATUS.PENDING, BATCH_STATUS.PROCESSING]);
  
  if (error) {
    return { pending: 0, processing: 0, error };
  }
  
  const { data: statusCounts, error: countError } = await supabase
    .from('product_batches')
    .select('status')
    .in('status', [BATCH_STATUS.PENDING, BATCH_STATUS.PROCESSING]);
  
  if (countError) {
    return { pending: 0, processing: 0, error: countError };
  }
  
  const pending = statusCounts.filter((b: any) => b.status === BATCH_STATUS.PENDING).length;
  const processing = statusCounts.filter((b: any) => b.status === BATCH_STATUS.PROCESSING).length;
  
  return { pending, processing, error: null };
}

// Additional functions for seller-lookup
export async function updateSeller(
  supabase: any,
  sellerId: string,
  updates: Partial<SellerData>
): Promise<{ data: SellerData | null; error: any }> {
  const { data, error } = await supabase
    .from('sellers')
    .update(updates)
    .eq('id', sellerId)
    .select()
    .single();
  
  return { data, error };
}

export async function captureSellerSearch(
  supabase: any,
  userId: string,
  sellerId: string,
  sellerName: string,
  domain: number
): Promise<void> {
  await supabase
    .from('seller_queries')
    .insert({
      user_id: userId,
      seller_id: sellerId,
      seller_name: sellerName,
      domain: domain,
      found_seller: true,
      searched_at: new Date().toISOString()
    });
}

// Optimized function to get seller with existing ASINs in one query (eliminates N+1 pattern)
export async function getSellerWithAsins(
  supabase: any,
  sellerId: string,
  domain: number
): Promise<{ seller: any | null; asins: string[]; error: any }> {
  // Get seller data
  const { data: seller, error: sellerError } = await getSellerBySellerIdAndDomain(
    supabase,
    sellerId,
    domain
  )
  
  if (sellerError || !seller) {
    return { seller: null, asins: [], error: sellerError }
  }
  
  // Get existing ASINs in same function call (only if seller exists)
  if (!seller || !seller.id) {
    return { seller, asins: [], error: null }
  }
  
  const { asins, error: asinError } = await getExistingAsins(supabase, seller.id)
  
  return { seller, asins, error: asinError }
}

export async function queueSimilarSellers(
  supabase: any,
  similarSellers: Array<{percent: number, sellerId: string}>,
  domain: number,
  sourceSellerId: string
): Promise<void> {
  if (!similarSellers || similarSellers.length === 0) {
    return;
  }
  
  const sellerIds = similarSellers.map(s => s.sellerId);
  
  // Check which sellers already exist
  const { data: existingSellers } = await supabase
    .from('sellers')
    .select('seller_id')
    .in('seller_id', sellerIds)
    .eq('domain', domain);
  
  const existingIds = existingSellers?.map((s: any) => s.seller_id) || [];
  const sellersToQueue = sellerIds.filter(id => !existingIds.includes(id));
  
  if (sellersToQueue.length > 0) {
    const queueEntries = sellersToQueue.map(sellerId => ({
      seller_id: sellerId,
      domain: domain,
      discovered_from_seller_id: sourceSellerId
    }));
    
    await supabase
      .from('seller_snapshot_queue')
      .upsert(queueEntries, { 
        onConflict: 'seller_id,domain',
        ignoreDuplicates: true 
      });
  }
}


export async function findNewAsins(
  sellerUuid: string, 
  currentAsins: string[], 
  supabase: any,
  isDev: boolean = false
): Promise<AsinComparison> {
  const log = isDev ? console.log : () => {};
  
  log(`🔍 Detecting new ASINs for seller ${sellerUuid} - checking ${currentAsins.length} ASINs`);

  // Check against ALREADY PROCESSED products
  const { data: existingProducts } = await supabase
    .from('seller_products')
    .select('asin_id')
    .eq('seller_id', sellerUuid);
    
  // Check against PENDING/PROCESSING batches  
  const { data: pendingBatches } = await supabase
    .from('product_batches')
    .select('new_asins')
    .eq('seller_id', sellerUuid)
    .in('status', ['PENDING', 'PROCESSING']);

  // Note: No need to fetch seller data anymore since we only use processed products
    
  const existingAsins = new Set([
    // Only use processed products - initial_asin_list is discovery data, not processing status
    ...(existingProducts?.map(p => p.asin_id) || []) // Processed ASINs with full data
  ]);
  const pendingAsins = new Set(pendingBatches?.flatMap(b => b.new_asins) || []);
  
  // TRUE new ASINs = not in products AND not in pending batches
  const trulyNewAsins = currentAsins.filter(asin => 
    !existingAsins.has(asin) && !pendingAsins.has(asin)
  );

  log(`📊 ASIN Analysis: ${existingAsins.size} existing, ${pendingAsins.size} pending, ${trulyNewAsins.length} truly new`);
  
  return {
    existingCount: existingAsins.size,
    pendingCount: pendingAsins.size,
    newAsins: trulyNewAsins,
    newCount: trulyNewAsins.length
  };
}

// Seller data persistence interface (COPIED FROM ORIGINAL)
export interface SellerPersistenceData {
  sellerId: string;
  sellerName?: string;
  businessName?: string;
  asinList: string[];
  totalStorefrontAsinsCSV?: string | null;
  trackedSince?: number | null;
  similarSellers?: Array<{percent: number, sellerId: string}>;
  topBrands?: Array<{avg30SalesRank: number, brand: string, productCount: number, productCountWithAmazonOffer: number}>;
}

// Helper function to replace storefront ASIN data (COPIED FROM ORIGINAL)
function replaceStorefrontData(existingCSV: string | null, newCSV: string | null): string | null {
  // Always replace with new data, never append
  return newCSV || existingCSV;
}

// Convert Keepa time to ISO string (COPIED FROM ORIGINAL)
function convertKeepaTime(keepaMinutes: number): string {
  const timestamp = keepaMinutes * 60 * 1000 + 21564000 * 60 * 1000;
  return new Date(timestamp).toISOString();
}

// Seller data persistence with upsert logic (COPIED EXACTLY FROM ORIGINAL)
export async function saveSellerData(
  supabase: any,
  existingSeller: any,
  userId: string,
  sellerId: string,
  domain: number,
  sellerData: SellerPersistenceData,
  updateTimestamp: boolean = true
): Promise<any> {
  const now = updateTimestamp ? new Date().toISOString() : null;
  const asinList = sellerData.asinList || [];   

  if (existingSeller) {
    // Update existing seller (never overwrite initial_asin_list - it's a snapshot from first discovery)
    const updateData: any = { 
      asin_count: asinList.length,
      seller_name: sellerData.sellerName || sellerData.businessName || existingSeller.seller_name
    };
    
    // Store similar sellers JSON (from competitors array)
    // Format: [{percent: 18, sellerId: "ATVPDKIKX0DER"}, ...]
    if (sellerData.similarSellers && sellerData.similarSellers.length > 0) {
      updateData.similar_sellers = sellerData.similarSellers;
    }
    
    // Store top brands JSON (from sellerBrandStatistics array)
    // Format: [{avg30SalesRank: 33971, brand: "pampers", productCount: 113, productCountWithAmazonOffer: 16}, ...]
    if (sellerData.topBrands && sellerData.topBrands.length > 0) {
      updateData.top_brands = sellerData.topBrands;
    }
    
    // Replace storefront ASIN tracking data (always replace)
    if (sellerData.totalStorefrontAsinsCSV) {
      updateData.total_storefront_asin_list_csv = replaceStorefrontData(
        existingSeller.total_storefront_asin_list_csv,
        sellerData.totalStorefrontAsinsCSV
      );
    }
    
    // Convert trackedSince to estimated_start_date
    if (sellerData.trackedSince && !existingSeller.estimated_start_date) {
      updateData.estimated_start_date = convertKeepaTime(sellerData.trackedSince);
    }
    
    if (updateTimestamp) {
      updateData.last_checked_at = now;
    }

    const { error: updateError } = await supabase
      .from('sellers')
      .update(updateData)
      .eq('id', existingSeller.id);
    
    if (updateError) {
      console.error('❌ Database update failed:', updateError);
      throw new Error(`Failed to update seller: ${updateError.message}`);
    }
    
    return { ...existingSeller, ...updateData };
  }

  // Create new seller
  const insertData: any = {
    seller_id: sellerId,
    seller_name: sellerData.sellerName || sellerData.businessName || null,
    domain: domain,
    initial_asin_list: asinList,
    asin_count: asinList.length,
    created_by: userId,
    total_storefront_asin_list_csv: sellerData.totalStorefrontAsinsCSV || null,
    estimated_start_date: sellerData.trackedSince ? convertKeepaTime(sellerData.trackedSince) : null,
    similar_sellers: (sellerData.similarSellers && sellerData.similarSellers.length > 0) ? sellerData.similarSellers : null,
    top_brands: (sellerData.topBrands && sellerData.topBrands.length > 0) ? sellerData.topBrands : null
  };

  if (updateTimestamp) {
    insertData.last_checked_at = now;
  }

  const { data: newSeller, error: insertError } = await supabase
    .from('sellers')
    .insert(insertData)
    .select()
    .single();

  if (insertError) {
    console.error('❌ Database insert failed:', insertError);
    throw new Error(`Failed to create seller: ${insertError.message}`);
  }

  if (!newSeller) {
    console.error('❌ Database insert returned null');
    throw new Error('Failed to create seller: No data returned');
  }

  return newSeller;
}