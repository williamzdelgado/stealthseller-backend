import { KEEPA, LIMITS, KEEPA_DOMAINS } from '../_domain/constants.ts';
import { WebhookNotifier } from './discord.ts';
import { FailureMonitor } from './failure-monitor.ts';

// KEEPA API INTERFACES
export interface KeepaSellerResponse {
  sellerId: string;
  sellerName?: string;
  businessName?: string;
  asinList?: string[];
  totalStorefrontAsinsCSV?: string;
  trackedSince?: number;
  similarSellers?: Array<{percent: number, sellerId: string}>;
  topBrands?: Array<{avg30SalesRank: number, brand: string, productCount: number, productCountWithAmazonOffer: number}>;
}

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
  // Debug data
  debugRawRating?: number;
  lastUpdate?: number;
  listedSince?: number;
}

// Helper function to convert Keepa timestamps (EXACT FROM ORIGINAL)
function keepaConvertTimestamp(keepaMinutes: number): string {
  return new Date((keepaMinutes + 21564000) * 60000).toISOString();
}

// FETCH SELLER DATA FROM KEEPA API
export async function fetchSellerData(
  sellerId: string,
  domain: number,
  apiKey: string,
  requestId?: string
): Promise<KeepaSellerResponse | null> {
  const logPrefix = requestId ? `[${requestId}]` : '';
  
  if (!apiKey) {
    console.log(`${logPrefix} ❌ Keepa API key not configured`);
    throw new Error('Keepa API key not configured');
  }

  const url = `https://api.keepa.com/seller?key=${apiKey}&domain=${domain}&seller=${sellerId}&storefront=1`;
  const apiStart = Date.now();
  
  try {
    const response = await fetch(url);
    const apiDuration = Date.now() - apiStart;
    
    if (!response.ok) {
      await FailureMonitor.recordFailure('Keepa');
      console.log(`${logPrefix} ❌ Keepa API error: ${response.status} ${response.statusText}`);
      
      // Differentiate error types
      if (response.status === 404) {
        return null; // Seller not found - let caller handle
      } else if (response.status === 429) {
        throw new Error('RATE_LIMITED');
      } else if (response.status >= 500) {
        throw new Error('KEEPA_SERVER_ERROR');
      } else {
        throw new Error(`Keepa API error: ${response.status} ${response.statusText}`);
      }
    }
    
    const data = await response.json();
    
    // Disabled verbose Keepa response logging - keeping logs clean
    // console.log(`${logPrefix} 🔍 Raw Keepa response:`, JSON.stringify(data, null, 2).substring(0, 500) + '...');
    
    FailureMonitor.recordSuccess('Keepa');
    
    // Check if seller exists in response
    if (!data.sellers || !data.sellers[sellerId]) {
      console.log(`${logPrefix} 🔍 Seller not found in domain ${domain} - API returned valid response but no seller data`);
      console.log(`${logPrefix} 🔍 Available sellers:`, Object.keys(data.sellers || {}));
      return null; // Seller not found (EXACT FROM ORIGINAL)
    }
    
    const sellerInfo = data.sellers[sellerId];
    const asinCount = sellerInfo.asinList?.length || 0;
    console.log(`${logPrefix} ✅ Seller found: ${asinCount} ASINs`);
    
    // Return structured data with sellerId included (EXACT FROM ORIGINAL)
    return {
      sellerId: sellerId,
      sellerName: sellerInfo.sellerName,
      businessName: sellerInfo.businessName,
      asinList: sellerInfo.asinList || [],
      totalStorefrontAsinsCSV: sellerInfo.totalStorefrontAsinsCSV || null,
      trackedSince: sellerInfo.trackedSince || null,
      similarSellers: sellerInfo.competitors || [],
      topBrands: sellerInfo.sellerBrandStatistics || []
    };
  } catch (error) {
    // Let errors propagate up (EXACT FROM ORIGINAL BEHAVIOR)
    throw error;
  }
}

// FETCH PRODUCT DATA FROM KEEPA API
export async function fetchProductData(
  asins: string[],
  domain: number,
  keepaSellerID: string,
  keepaApiKey: string,
  isDev: boolean = false
): Promise<KeepaProduct[]> {
  try {
    // Split ASINs into chunks of 10 for concurrent processing
    const chunks: string[][] = [];
    for (let i = 0; i < asins.length; i += LIMITS.KEEPA_API_BATCH_SIZE) {
      chunks.push(asins.slice(i, i + LIMITS.KEEPA_API_BATCH_SIZE));
    }

    if (isDev) {
      console.log(`🌐 Fetching Keepa data for ${asins.length} ASINs in ${chunks.length} concurrent chunks...`);
    }

    // Process all chunks concurrently
    const chunkPromises = chunks.map(async (chunk) => {
      const asinString = chunk.join(',');
      const url = `${KEEPA.BASE_URL}/product?key=${keepaApiKey}&domain=${domain}&asin=${asinString}&stats=1&buybox=1&only-live-offers=0&stock=1&rating=1&offers=100&history=1`;

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
      
      FailureMonitor.recordSuccess('Keepa');

      // Log token warnings  
      if (data.products?.length === 0 || data.tokensLeft < 1000) {
        console.log(`⚠️ Keepa: ${data.products?.length || 0} products, ${data.tokensLeft} tokens left`);
        
        // Webhook alert for low tokens (EXACT FROM ORIGINAL)
        if (data.tokensLeft < 1000) {
          WebhookNotifier.alert(`Keepa tokens low: ${data.tokensLeft} remaining`);
        }
      }

      // Log seller offer warnings
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
    } catch (error: any) {
      await FailureMonitor.recordFailure('Keepa');
      const debugUrl = url.replace(keepaApiKey, '***MASKED***');
      console.error(`❌ Keepa API chunk failed for ASINs [${asinString}]: ${error.message}`);
      console.error(`❌ URL was: ${debugUrl}`);
      throw error;
    }
    });

    // Wait for all concurrent chunks to complete
    const allChunkResults = await Promise.all(chunkPromises);

    // Flatten results from all chunks
    const allProducts = allChunkResults.flat();

    if (isDev) {
      console.log(`✅ Received ${allProducts.length} products from ${chunks.length} concurrent Keepa requests`);
    }

    // Transform all products from concurrent chunks
    const transformedProducts = allProducts.map((product: any): KeepaProduct => {
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
      
      // Extract seller-specific storefront price
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
      
      // Determine FBA/FBM status
      const isFBA = isPrime;
      const isFBM = !isPrime;
      
      // Extract monthly sales
      const monthlySold = (product.monthlySold !== undefined && product.monthlySold !== null) ? product.monthlySold : null;
      
      // Extract first seen date
      const firstSeenAt = (offerCSV && offerCSV.length > 0) 
        ? keepaConvertTimestamp(offerCSV[0]) 
        : null;
      
      // Extract stock count
      const stockCount = (stockCSV && stockCSV.length >= 2) 
        ? stockCSV[1] 
        : (product.stockCount !== undefined ? product.stockCount : null);
      
      // Inline sales rank extraction using correct Keepa format
      const salesRank = (categoryId && product.salesRanks?.[categoryId]?.slice(-1)[0]) ?? null;

      // Inline rating transformation
      const rawRating = statsArray?.[16];
      const rating = (rawRating === undefined || rawRating === null || rawRating <= 0) 
        ? -1 
        : Math.min(Math.max(rawRating / 10, 1), 5);

      // Inline rating count transformation
      const rawRatingCount = statsArray?.[17];
      const ratingCount = (rawRatingCount === undefined || rawRatingCount === null || rawRatingCount <= 0)
        ? -1
        : Math.min(rawRatingCount, 2147483647);

      return {
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
    });

    return transformedProducts;

  } catch (error: any) {
    // Log API failures with context for debugging (COPIED FROM ORIGINAL)
    console.error(`❌ Keepa API fetch failed for ${asins.length} ASINs: ${error.message}`);
    
    // Re-throw to be handled by calling function (COPIED FROM ORIGINAL)
    throw error;
  }
}

// Export helper functions for similar sellers and top brands
export function extractSimilarSellers(response: KeepaSellerResponse, _sellerId: string): Array<{percent: number, sellerId: string}> {
  return response.similarSellers || [];
}

export function extractTopBrands(response: KeepaSellerResponse, _sellerId: string): Array<{avg30SalesRank: number, brand: string, productCount: number, productCountWithAmazonOffer: number}> {
  return response.topBrands || [];
}