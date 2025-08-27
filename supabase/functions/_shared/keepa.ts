// Shared Keepa Operations Module
// Core API calls and database operations - used by both edge functions and Trigger.dev

import { FailureMonitor } from './failure-monitor.ts';
import { WebhookNotifier } from './discord.ts';
import { KEEPA_API_BATCH_SIZE } from './batch-processor.ts';

// Constants
const KEEPA_BASE_URL = 'https://api.keepa.com';

// Optimized validation using binary flags for performance
const ERROR_FLAGS = {
  MISSING_IMAGES: 1,        // 0b000001
  MISSING_FULFILLMENT: 2,   // 0b000010  
  MISSING_STOREFRONT: 4,    // 0b000100
  MISSING_BUYBOX: 8,        // 0b001000
  MISSING_SALESRANK: 16,    // 0b010000
  MISSING_RATING: 32,       // 0b100000
} as const;

// Interfaces
export interface KeepaProduct {
  asin: string;
  title?: string;
  brand?: string;
  category?: string;
  salesRank?: number | null;
  storefrontPrice?: number | null;  // Seller-specific price
  buyBoxPrice?: number | null;      // Separate buy box price
  stockCount?: number | null;
  rating?: number | null;
  ratingCount?: number | null;
  monthlySold?: number;
  imagesCSV?: string;
  isFBA?: boolean;
  isFBM?: boolean;
  firstSeenAt?: string;
  // Debug data - minimal extraction for logging only
  debugRawRating?: number;  // Raw stats.current[16] for conversion issue logging
  lastUpdate?: number;
  listedSince?: number;
}

export interface InsertResult {
  success: number;
  failed: number;
  errors: string[];
}

// Seller-specific interfaces and constants (for fetchSellerFromKeepa)
export interface KeepaSellerData {
  sellerId: string;
  sellerName?: string;
  businessName?: string;
  asinList: string[];
  totalStorefrontAsinsCSV?: string | null;
  trackedSince?: number | null;
}

// ASIN comparison analysis interface (for findNewAsins function)
export interface AsinComparison {
  existingCount: number;
  pendingCount: number;
  newAsins: string[];
  newCount: number;
}

// Seller data persistence interface (for saveSellerData function)
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

// Keepa domain mapping for seller endpoints
const KEEPA_DOMAINS: Record<number, string> = {
  1: "amazon.com",
  2: "amazon.co.uk", 
  3: "amazon.de",
  4: "amazon.fr",
  5: "amazon.co.jp",
  6: "amazon.ca",
  8: "amazon.it",
  9: "amazon.es",
  10: "amazon.in",
  11: "amazon.com.mx"
};

// Helper function to convert Keepa timestamps
function keepaConvertTimestamp(keepaMinutes: number): string {
  return new Date((keepaMinutes + 21564000) * 60000).toISOString();
}

// Seller data fetching from Keepa API (extracted from seller-lookup/index.ts)
export async function fetchSellerFromKeepa(
  sellerId: string, 
  domain: number, 
  apiKey: string, 
  requestId?: string
): Promise<KeepaSellerData | null> {
  const logPrefix = requestId ? `[${requestId}]` : '';
  console.log(`${logPrefix} 🌐 Calling Keepa API: domain=${domain} (${KEEPA_DOMAINS[domain]})`);
  
  if (!apiKey) {
    console.log(`${logPrefix} ❌ Keepa API key not configured`);
    throw new Error('Keepa API key not configured');
  }

  const url = `https://api.keepa.com/seller?key=${apiKey}&domain=${domain}&seller=${sellerId}&storefront=1`;
  const apiStart = Date.now();
  
  const response = await fetch(url);
  const apiDuration = Date.now() - apiStart;
  
  console.log(`${logPrefix} ⏱️ Keepa API call took ${apiDuration}ms`);
  
  if (!response.ok) {
    await FailureMonitor.recordFailure('Keepa');
    console.log(`${logPrefix} ❌ Keepa API error: ${response.status} ${response.statusText}`);
    throw new Error(`Keepa API error: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  
  // Record success to reset failure counter
  FailureMonitor.recordSuccess('Keepa');
  
  // Essential: Log API response success/failure only
  
  // Check if seller exists in response
  if (!data.sellers || !data.sellers[sellerId]) {
    console.log(`${logPrefix} 🔍 Seller not found in domain ${domain} - API returned valid response but no seller data`);
    return null; // Seller not found
  }
  
  const sellerInfo = data.sellers[sellerId];
  const asinCount = sellerInfo.asinList?.length || 0;
  console.log(`${logPrefix} ✅ Seller found: ${asinCount} ASINs`);
  
  // Essential: Seller found with ASIN count
  
  // Essential: ASIN data validation for core functionality
  
          // Similar sellers queuing will be handled in main function with cachedSeller context
  
  // Return structured data with sellerId included
  return {
    sellerId: sellerId,
    sellerName: sellerInfo.sellerName,
    businessName: sellerInfo.businessName,
    asinList: sellerInfo.asinList || [],
    totalStorefrontAsinsCSV: sellerInfo.totalStorefrontAsinsCSV || null,
    trackedSince: sellerInfo.trackedSince || null
  };
}

// ASIN comparison with 3-scenario handling (extracted from product-processing/index.ts)
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

// Optimized helper functions for data transformation
function convertRating(rawRating: any): number {
  if (rawRating === undefined || rawRating === null || rawRating <= 0) return -1;
  return Math.min(Math.max(rawRating / 10, 1), 5);
}

function convertRatingCount(rawCount: any): number {
  if (rawCount === undefined || rawCount === null || rawCount <= 0) return -1;
  return Math.min(rawCount, 2147483647);
}

function extractPrimaryCategory(product: any) {
  return product.categoryTree?.[0] || null;
}

// Core Keepa API function - shared between environments
export async function fetchKeepaData(
  asins: string[], 
  domain: number, 
  keepaSellerID: string,
  keepaApiKey: string,
  isDev: boolean = false
): Promise<KeepaProduct[]> {

  // Split ASINs into chunks of 10 for concurrent processing
  const chunks: string[][] = [];
  for (let i = 0; i < asins.length; i += KEEPA_API_BATCH_SIZE) {
    chunks.push(asins.slice(i, i + KEEPA_API_BATCH_SIZE));
  }

  if (isDev) {
    console.log(`🌐 Fetching Keepa data for ${asins.length} ASINs in ${chunks.length} concurrent chunks...`);
  }

  // Process all chunks concurrently
  const chunkPromises = chunks.map(async (chunk) => {
    const asinString = chunk.join(',');
    const url = `${KEEPA_BASE_URL}/product?key=${keepaApiKey}&domain=${domain}&asin=${asinString}&stats=1&buybox=1&only-live-offers=0&stock=1&rating=1&offers=100&history=1`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        await FailureMonitor.recordFailure('Keepa');
        const responseText = await response.text();
        console.log(`🔍 KEEPA ERROR BODY: ${responseText}`);
        const errorMsg = `Keepa API error: ${response.status} ${response.statusText} - ${responseText}`;
        throw new Error(errorMsg);
      }

      const data = await response.json();
      
      // Record success to reset failure counter
      FailureMonitor.recordSuccess('Keepa');

      // Only log if there are potential issues
        if (data.products?.length === 0 || data.tokensLeft < 1000) {
    console.log(`⚠️ Keepa: ${data.products?.length || 0} products, ${data.tokensLeft} tokens left`);
    
    // Webhook alert for low tokens
    if (data.tokensLeft < 1000) {
      WebhookNotifier.alert(`Keepa tokens low: ${data.tokensLeft} remaining`);
    }
      }

      // Only log seller offer warnings (not successes)
      if (data.products && data.products.length > 0) {
        const firstProduct = data.products[0];
        const sellerOffer = firstProduct.offers?.find((offer: any) => offer.sellerId === keepaSellerID);
        
        if (!sellerOffer) {
          console.log(`⚠️ No seller offer found for ${keepaSellerID} (${firstProduct.offers?.length || 0} offers available)`);
        }
      } else {
        console.log(`⚠️ No products returned for ASINs: ${asinString}`);
      }

      if (!data.products || !Array.isArray(data.products)) {
        console.log(`🔍 INVALID RESPONSE FORMAT:`, { dataKeys: Object.keys(data), dataType: typeof data });
        throw new Error('Invalid Keepa API response format');
      }

      return data.products;
    } catch (error) {
      await FailureMonitor.recordFailure('Keepa');
      const debugUrl = url.replace(keepaApiKey, '***MASKED***');
      console.error(`❌ Keepa API chunk failed for ASINs [${asinString}]: ${error.message}`);
      console.error(`❌ URL was: ${debugUrl}`);
      throw error;
    }
  });

  try {
    // Wait for all concurrent chunks to complete
    const allChunkResults = await Promise.all(chunkPromises);

    // Flatten results from all chunks
    const allProducts = allChunkResults.flat();

    if (isDev) {
      console.log(`✅ Received ${allProducts.length} products from ${chunks.length} concurrent Keepa requests`);
    }

    // Transform all products from concurrent chunks
    return allProducts.map((product: any): KeepaProduct => {
      // Pre-extract commonly used values once (eliminates repeated object access)
      // OPTIMIZED: Check first offer first (90% of cases), then fallback to find()
      const sellerOffer = product.offers?.[0]?.sellerId === keepaSellerID 
        ? product.offers[0] 
        : product.offers?.find((offer: any) => offer.sellerId === keepaSellerID);
      const offerCSV = sellerOffer?.offerCSV;
      const stockCSV = sellerOffer?.stockCSV;
      const statsArray = product.stats?.current;
      const categoryTree = product.categoryTree?.[0];
      const categoryId = categoryTree?.catId?.toString();
      const isPrime = sellerOffer?.isPrime ?? false;
      
      // Extract seller-specific storefront price using pre-extracted values
      const storefrontPrice = (offerCSV && offerCSV.length >= 2) 
        ? offerCSV[1] / 100 
        : null;
      
      // Extract buy box price (different from storefront price)
      let buyBoxPrice: number | null = null;
      if (product.stats?.buyBoxPrice) {
        buyBoxPrice = product.stats.buyBoxPrice / 100;
      } else if (product.buyBoxPrice && product.buyBoxPrice.length > 0) {
        const lastEntry = product.buyBoxPrice[product.buyBoxPrice.length - 1];
        buyBoxPrice = lastEntry[1] / 100;
      }
      
      // Determine FBA/FBM status from pre-extracted values
      const isFBA = isPrime;
      const isFBM = !isPrime;
      
      // Extract monthly sales
      const monthlySold = (product.monthlySold !== undefined && product.monthlySold !== null) ? product.monthlySold : null;
      
      // Extract first seen date using pre-extracted values
      const firstSeenAt = (offerCSV && offerCSV.length > 0) 
        ? keepaConvertTimestamp(offerCSV[0]) 
        : null;
      
      // Extract stock count using pre-extracted values
      const stockCount = (stockCSV && stockCSV.length >= 2) 
        ? stockCSV[1] 
        : (product.stockCount !== undefined ? product.stockCount : null);
      
      // Inline sales rank extraction using correct Keepa format
      const salesRank = (categoryId && product.salesRanks?.[categoryId]?.slice(-1)[0]) ?? null;

      // Inline rating transformation (replaces convertRating function call)
      const rawRating = statsArray?.[16];
      const rating = (rawRating === undefined || rawRating === null || rawRating <= 0) 
        ? -1 
        : Math.min(Math.max(rawRating / 10, 1), 5);

      // Inline rating count transformation (replaces convertRatingCount function call)  
      const rawRatingCount = statsArray?.[17];
      const ratingCount = (rawRatingCount === undefined || rawRatingCount === null || rawRatingCount <= 0)
        ? -1
        : Math.min(rawRatingCount, 2147483647);
      


      const transformedProduct: KeepaProduct = {
        asin: product.asin,
        title: product.title,
        brand: product.brand,
        category: categoryTree?.name,
        salesRank: salesRank,
        storefrontPrice: storefrontPrice, // Seller-specific price
        buyBoxPrice: buyBoxPrice,         // Separate buy box price
        stockCount: stockCount,
        rating: rating,
        ratingCount: ratingCount,
        monthlySold: monthlySold ?? undefined,
        imagesCSV: product.imagesCSV || '',
        isFBA: isFBA,
        isFBM: isFBM,
        firstSeenAt: firstSeenAt ?? undefined,
        debugRawRating: rawRating, // Add debug field
        lastUpdate: product.lastUpdate,
        listedSince: product.listedSince,
      };

      return transformedProduct;
    });

  } catch (error) {
    // Record API failure for monitoring
    await FailureMonitor.recordFailure('Keepa');
    
    // Log API failures with context for debugging
    console.error(`❌ Keepa API fetch failed for ${asins.length} ASINs: ${error.message}`);
    
    // Re-throw to be handled by calling function
    throw error;
  }
}

// Core database insertion function - shared between environments
export async function insertProducts(
  sellerId: string, 
  products: KeepaProduct[], 
  domain: number, 
  keepaSellerID: string,
  supabaseClient: any,
  isDev: boolean = false,
  processingSource: string = 'UNKNOWN'
): Promise<InsertResult> {
  const errors: string[] = [];
  let success = 0;
  let failed = 0;

  if (isDev) {
    console.log(`💾 Batch processing ${products.length} products...`);
  }

  // Pre-allocate array to avoid resizing during processing
  const allRecords: { template: any; seller: any }[] = new Array(products.length);
  let recordIndex = 0;

  for (const product of products) {
    try {


      // Extract image IDs with minimal error handling - optimized to avoid intermediate arrays
      const imageIds: string[] = [];
      if (product.imagesCSV) {
        const parts = product.imagesCSV.split(',');
        for (let i = 0; i < parts.length; i++) {
          const trimmed = parts[i].trim();
          if (trimmed) imageIds.push(trimmed);
        }
      }

      // Prepare template record (shared data)
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

      // Prepare seller record (seller-specific data)
      const sellerRecord = {
        seller_id: sellerId,
        asin_id: product.asin,  // Required by database schema
        domain: domain,         // Required by database schema
        _asin_id: product.asin, // Temporary field for template linking only
        _domain: domain,        // Temporary field for template linking only
        sales_rank: product.salesRank,
        storefront_price: product.storefrontPrice,
        buy_box_price: product.buyBoxPrice,
        stock_count: product.stockCount,
        rating: product.rating,
        rating_count: product.ratingCount,
        monthly_sales: product.monthlySold,
        is_fba: product.isFBA,
        is_fbm: product.isFBM,
        first_seen_at: product.firstSeenAt,
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

  // Trim array to actual size (remove unused slots from failed products)
  const validRecords = allRecords.slice(0, recordIndex);

  // Two-phase batch database operation
  if (validRecords.length > 0) {
    try {
      // Phase 1: Upsert all templates
      const templateRecords = validRecords.map(r => r.template);
      const { data: templateResults, error: templateError } = await supabaseClient
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
        // Phase 2: Link seller records to templates with O(1) Map lookup
        const templateMap = new Map(
          templateResults.map(t => [`${t.asin_id}-${t.domain}`, t.id])
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

        const { error: sellerError } = await supabaseClient
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

  // Log error details only for failed products
  if (errors.length > 0 && isDev) {
    console.log(`🚨 Insert errors: [${errors.join(', ')}]`);
  }

  return {
    success,
    failed,
    errors
  };
} 

// Helper function to replace storefront ASIN data
function replaceStorefrontData(existingCSV: string | null, newCSV: string | null): string | null {
  // Always replace with new data, never append
  return newCSV || existingCSV;
}

// Convert Keepa time to ISO string
function convertKeepaTime(keepaMinutes: number): string {
  const timestamp = keepaMinutes * 60 * 1000 + 21564000 * 60 * 1000;
  return new Date(timestamp).toISOString();
}

// Seller data persistence with upsert logic (extracted from seller-lookup/index.ts)
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
 