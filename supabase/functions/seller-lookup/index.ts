/*
 * SELLER LOOKUP EDGE FUNCTION
 * 
 * WHAT IT DOES:
 * This edge function validates Amazon seller IDs and fetches seller information
 * from the Keepa API. It's the main way users discover and add sellers to monitor.
 * 
 * CORE FUNCTIONALITY:
 * 1. Validates seller ID format (13-15 alphanumeric characters)
 * 2. Checks database cache first (24-hour freshness)
 * 3. If cache miss/stale → calls Keepa API to fetch seller data
 * 4. Stores seller info in database (name, ASIN count, domain, etc.)
 * 5. Returns seller details to frontend for user confirmation
 * 
 * WHAT IT RETURNS:
 * - Seller ID and name
 * - Domain (marketplace: amazon.com, amazon.co.uk, etc.)
 * - ASIN count (number of products)
 * - Last checked timestamp
 * - Similar sellers (competitors from Keepa)
 * 
 * SNAPSHOT SYSTEM (OPTIMIZATION LAYER):
 * Instead of expensive full product queries, we snapshot ASIN lists cheaply
 * then do delta processing to only query NEW products.
 * 
 * TOKEN ECONOMICS & OPTIMIZATION:
 * - Query seller's ASIN list: 10 tokens
 * - Query each individual ASIN: 7 tokens per ASIN
 * - Example: Seller with 100 ASINs = 10 + (100 × 7) = 710 tokens
 * 
 * SNAPSHOT FLOW:
 * 1. User looks up Seller A (domain 1)
 * 2. Store similar sellers in Seller A's similar_sellers JSON field
 * 3. Extract similar seller IDs (B, C, D, E) with domain 1
 * 4. Check if B, C, D, E exist in sellers table with domain 1
 * 5. If they DON'T exist → add to seller_snapshot_queue
 * 6. Background job snapshots their ASIN lists (10 tokens each)
 * 7. Later when user searches Seller B → delta calculation → only query NEW ASINs
 * 
 * COST SAVINGS:
 * Without snapshots: 710 tokens per seller
 * With snapshots: 45 tokens per seller (93% savings)
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Import shared Keepa seller functions
import { fetchSellerFromKeepa, saveSellerData, type KeepaSellerData, type SellerPersistenceData } from '../_shared/keepa.ts';

// Module-level environment variables (cached once, reused forever)
const KEEPA_API_KEY = Deno.env.get('KEEPA_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Module-level Supabase client (created once, reused forever)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { enabled: false }, // Faster initialization
});

// CORS headers for browser requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

// Keepa domain mapping
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

const VALID_DOMAINS = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11];
const DEFAULT_DOMAIN = 1; // amazon.com

// Request/Response interfaces
interface SellerDetailsRequest {
  sellerId: string;
  domain?: number;
}

interface SellerDetailsResponse {
  success: boolean;
  data?: {
    sellerId: string;
    sellerName: string;
    domain: number;
    asinCount: number;
    recentlyAdded: Array<{
      asin: string;
      title: string;
      firstListingDate: string;
    }>;
    lastCheckedAt?: string | null;
  };
  error?: string;
  suggestion?: string;
}

// Validation functions
function validateSellerIdFormat(sellerId: string): boolean {
  return /^[A-Z0-9]{13,15}$/i.test(sellerId);
}

function validateDomain(domain: number): boolean {
  return VALID_DOMAINS.includes(domain);
}



async function findSellerAcrossMarketplaces(sellerId: string, userDomain: number): Promise<{ found: boolean; domain?: number; suggestion?: string }> {
  const searchDomains = VALID_DOMAINS.filter(d => d !== userDomain);
  
  for (const domain of searchDomains) {
    try {
      const sellerData = await fetchSellerFromKeepa(sellerId, domain, KEEPA_API_KEY);
      
      if (sellerData) {
        const marketplaceName = KEEPA_DOMAINS[domain];
        return {
          found: true,
          domain,
          suggestion: `Seller found in ${marketplaceName}`
        };
      }
      
      // Small delay between marketplace checks
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      // Continue searching other marketplaces if one fails
      continue;
    }
  }
  
  return { found: false };
}

// Database helper functions
async function logSellerQuery(supabase: any, userId: string, sellerId: string, queryInput: string, foundSeller: boolean, domain: number, errorMessage?: string) {
  await supabase
    .from('seller_queries')
    .insert({
      user_id: userId,
      seller_id: foundSeller ? sellerId : null,
      query_input: queryInput,
      found_seller: foundSeller,
      domain: domain,
      error_message: errorMessage || null
    });
}

// STEP 3: Store seller data including similar sellers JSON

// Build response from cached database data
function buildDatabaseResponse(dbSeller: any, domain: number): SellerDetailsResponse {
  return {
    success: true,
    data: {
      sellerId: dbSeller.seller_id,
      sellerName: dbSeller.seller_name || 'Unknown Seller',
      domain: domain,
      asinCount: dbSeller.asin_count || 0,
      recentlyAdded: [], // Don't send ASIN list - frontend doesn't need it, reduces payload
      lastCheckedAt: dbSeller.last_checked_at || null
    }
  };
}



serve(async (req) => {
  const requestStart = Date.now();
  const requestId = Math.random().toString(36).substring(7);
  
  console.log(`[${requestId}] 🚀 Seller Details request started`);
  
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    console.log(`[${requestId}] ✅ CORS preflight handled`);
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Extract JWT token
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      console.log(`[${requestId}] ❌ Missing Authorization header`);
      return Response.json(
        { success: false, error: 'Authentication required' },
        { status: 401, headers: corsHeaders }
      );
    }

    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    // Use JWT decode instead of expensive auth.getUser call (100x faster)
    const { user, error: authError } = decodeJWT(token);

    if (authError || !user) {
      console.log(`[${requestId}] ❌ Authentication failed:`, authError?.message);
      return Response.json(
        { success: false, error: 'Authentication required' },
        { status: 401, headers: corsHeaders }
      );
    }

    console.log(`[${requestId}] ✅ User authenticated: ${user.id}`);

    // Parse request body
    const body: SellerDetailsRequest = await req.json();
    const { sellerId, domain } = body;
    const originalInput = `${sellerId}${domain ? ` (domain: ${domain})` : ''}`;
    
    console.log(`[${requestId}] 📥 Request: sellerId=${sellerId}, domain=${domain || 'auto'}`);

    // Validate seller ID format
    if (!sellerId || !validateSellerIdFormat(sellerId)) {
      console.log(`[${requestId}] ❌ Invalid seller ID format: ${sellerId}`);
      await logSellerQuery(supabase, user.id, sellerId, originalInput, false, DEFAULT_DOMAIN, 'Invalid seller ID format');
      return Response.json(
        { success: false, error: 'Invalid seller ID format (must be 13-15 alphanumeric characters)' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Get user's domain preference (only query if domain not provided)
    let userDomain = domain || DEFAULT_DOMAIN;
    if (!domain) {
      const { data: userSettings } = await supabase
        .from('user_settings')
        .select('marketplace_domain_id')
        .eq('user_id', user.id)
        .single();
      
      if (userSettings?.marketplace_domain_id) {
        userDomain = userSettings.marketplace_domain_id;
      }
    }

    // Validate domain
    if (!validateDomain(userDomain)) {
      await logSellerQuery(supabase, user.id, sellerId, originalInput, false, userDomain, 'Invalid domain');
      return Response.json(
        { success: false, error: 'Invalid marketplace domain' },
        { status: 400, headers: corsHeaders }
      );
    }

    try {
      // Check database cache first
      console.log(`[${requestId}] 💾 Checking database cache for seller: ${sellerId} domain: ${userDomain}`);
      const { data: cachedSeller } = await supabase
        .from('sellers')
        .select('id, seller_id, domain, last_checked_at, asin_count, seller_name, initial_asin_list, total_storefront_asin_list_csv, similar_sellers')
        .eq('seller_id', sellerId)
        .eq('domain', userDomain)
        .single();

      // Check if cache is fresh (within 24 hours)
      const now = new Date();
      const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      
      if (cachedSeller && cachedSeller.last_checked_at) {
        const lastChecked = new Date(cachedSeller.last_checked_at);
        if (lastChecked > twentyFourHoursAgo) {
          console.log(`[${requestId}] ✅ Cache HIT - returning cached data (last checked: ${lastChecked.toISOString()})`);
          
          // Log successful cache hit
          await logSellerQuery(supabase, user.id, cachedSeller.id, originalInput, true, userDomain);
          
          const requestDuration = Date.now() - requestStart;
          console.log(`[${requestId}] ⚡ Request completed from cache in ${requestDuration}ms`);
          
          return Response.json(buildDatabaseResponse(cachedSeller, userDomain), { headers: corsHeaders });
        } else {
          console.log(`[${requestId}] 🔄 Cache STALE - last checked: ${lastChecked.toISOString()}, refreshing from Keepa`);
        }
      } else {
        console.log(`[${requestId}] 🆕 Cache MISS - seller not in database, fetching from Keepa`);
      }

      // Cache miss or stale - fetch from Keepa API
      console.log(`[${requestId}] 🎯 Calling Keepa API for fresh data: ${userDomain} (${KEEPA_DOMAINS[userDomain]})`);
      const keepaResponse = await fetchSellerFromKeepa(sellerId, userDomain, KEEPA_API_KEY, requestId);
      
      if (keepaResponse) {
        // Extract similar sellers and top brands from Keepa response
        const extractedData = extractSimilarSellersFromKeepa(keepaResponse, sellerId);
        const sellerData = {
          ...keepaResponse,
          similarSellers: extractedData.competitors,
          topBrands: extractedData.topBrands
        };
        
        // INTELLIGENT SIMILAR SELLERS QUEUING: Only queue if seller IDs have changed
        await queueSimilarSellersForSnapshots(keepaResponse, sellerId, userDomain, requestId, cachedSeller);
        
        // Check 50k ASIN limit
        const asinCount = sellerData.asinList?.length || 0;
        
        if (asinCount > 3000) {
          console.log(`[${requestId}] ❌ Seller exceeds 3k ASIN limit: ${asinCount.toLocaleString()}`);
          await logSellerQuery(supabase, user.id, sellerId, originalInput, false, userDomain, 'Seller exceeds 3k ASIN limit');
          return Response.json(
            {
              success: false,
              error: `Seller has ${asinCount.toLocaleString()} products, which exceeds our 3,000 product limit`
            },
            { status: 400, headers: corsHeaders }
          );
        }

        // SMART ASIN ROUTER: Determine if product-processing should be invoked
        const freshAsinList = sellerData.asinList || [];
        let shouldProcessProducts = false;
        let asinsToProcess: string[] = [];
        let processingReason = '';

        if (cachedSeller) {
          // EXISTING SELLER: Compare vs existing processed products
          console.log(`[${requestId}] 🔍 Existing seller - checking for new ASINs...`);
          
          const { data: existingProducts } = await supabase
            .from('seller_products')
            .select('asin_id')
            .eq('seller_id', cachedSeller.id);
          
          const existingAsins = new Set([
            ...(cachedSeller.initial_asin_list || []),     // Original ASINs from discovery
            ...(existingProducts?.map(p => p.asin_id) || []) // Processed ASINs with full data
          ]);
          const newAsins = freshAsinList.filter(asin => !existingAsins.has(asin));
          
          if (newAsins.length > 0) {
            shouldProcessProducts = true;
            asinsToProcess = newAsins;
            processingReason = `Found ${newAsins.length} new ASINs (out of ${freshAsinList.length} total)`;
            console.log(`[${requestId}] 🆕 ${processingReason}`);
          } else {
            console.log(`[${requestId}] ✅ No new ASINs found - seller up to date`);
          }
        } else {
          // NEW SELLER: Check if we have a snapshot for delta processing
          console.log(`[${requestId}] 🆕 New seller - checking for existing snapshot...`);
          
          const { data: snapshot } = await supabase
            .from('seller_snapshots')
            .select('asin_list, snapshot_date')
            .eq('seller_id', sellerId)
            .eq('domain', userDomain)
            .order('snapshot_date', { ascending: false })
            .limit(1)
            .maybeSingle();
          
          if (snapshot) {
            // NEW SELLER with SNAPSHOT: Delta processing
            const snapshotAsins = new Set(snapshot.asin_list);
            const deltaAsins = freshAsinList.filter(asin => !snapshotAsins.has(asin));
            
            if (deltaAsins.length > 0) {
              shouldProcessProducts = true;
              asinsToProcess = deltaAsins;
              processingReason = `Delta processing: ${deltaAsins.length} new ASINs (${Math.round((snapshotAsins.size / freshAsinList.length) * 100)}% saved via snapshot)`;
              console.log(`[${requestId}] 🚀 ${processingReason}`);
              console.log(`[${requestId}] 💰 Tokens saved: ~${snapshotAsins.size * 7} tokens`);
            } else {
              console.log(`[${requestId}] ✅ No new ASINs since snapshot - seller up to date`);
            }
          } else {
            // NEW SELLER without SNAPSHOT: Process all ASINs
            shouldProcessProducts = true;
            asinsToProcess = freshAsinList;
            processingReason = `New seller: processing all ${freshAsinList.length} ASINs`;
            console.log(`[${requestId}] 🆕 ${processingReason}`);
          }
        }

        // Store/update seller in database with fresh timestamp BEFORE auto-invocation
        // This ensures product-processing can find the seller UUID
        console.log(`[${requestId}] 💾 Updating database with fresh Keepa data...`);
        const dbSeller = await saveSellerData(supabase, cachedSeller, user.id, sellerId, userDomain, sellerData, true);

        // Auto-invoke product-processing if needed
        if (shouldProcessProducts && asinsToProcess.length > 0) {
          console.log(`[${requestId}] 🚀 Auto-invoking product-processing: ${processingReason}`);
          
          try {
            const processingResponse = await supabase.functions.invoke('product-processing', {
              body: {
                sellerId,
                userId: user.id,
                asinList: asinsToProcess,
                domain: userDomain
              },
              headers: {
                Authorization: authHeader // Pass the original Authorization header
              }
            });
            
            if (processingResponse.error) {
              console.error(`[${requestId}] ❌ Product processing failed:`, processingResponse.error);
            } else {
              console.log(`[${requestId}] ✅ Product processing completed successfully`);
            }
          } catch (error) {
            console.error(`[${requestId}] ❌ Error invoking product-processing:`, error);
          }
        }
        
        // Log successful query
        await logSellerQuery(supabase, user.id, dbSeller.id, originalInput, true, userDomain);

        const requestDuration = Date.now() - requestStart;
        console.log(`[${requestId}] ✅ Request completed with fresh data in ${requestDuration}ms`);

        // Return successful response
        return Response.json(
          {
            success: true,
            data: {
              sellerId: sellerData.sellerId,
              sellerName: sellerData.sellerName || sellerData.businessName || 'Unknown Seller',
              domain: userDomain,
              asinCount: asinCount,
              recentlyAdded: [], // Don't send ASIN list - frontend doesn't need it, reduces payload
              lastCheckedAt: new Date().toISOString() // Fresh data, just checked now
            }
          },
          { headers: corsHeaders }
        );
      }

      // Seller not found in preferred marketplace - only search others if no cached data exists
      if (!cachedSeller) {
        console.log(`[${requestId}] 🔄 Searching across all marketplaces...`);
        const crossMarketplaceResult = await findSellerAcrossMarketplaces(sellerId, userDomain);
        
        if (crossMarketplaceResult.found && crossMarketplaceResult.domain) {
          console.log(`[${requestId}] 🌍 Found in different marketplace: domain ${crossMarketplaceResult.domain}`);
          await logSellerQuery(supabase, user.id, sellerId, originalInput, false, userDomain, 'Seller found in different marketplace');
          return Response.json(
            {
              success: false,
              error: 'Seller not found in your preferred marketplace',
              suggestion: crossMarketplaceResult.suggestion
            },
            { status: 404, headers: corsHeaders }
          );
        }
      }

      // Seller not found anywhere
      console.log(`[${requestId}] 🚫 Seller not found in any marketplace`);
      await logSellerQuery(supabase, user.id, sellerId, originalInput, false, userDomain, 'Seller not found');
      return Response.json(
        {
          success: false,
          error: 'Seller not found in any marketplace'
        },
        { status: 404, headers: corsHeaders }
      );

    } catch (error) {
      console.error(`[${requestId}] ❌ Seller lookup error:`, error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      await logSellerQuery(supabase, user.id, sellerId, originalInput, false, userDomain, errorMessage);
      
      const requestDuration = Date.now() - requestStart;
      console.log(`[${requestId}] 💥 Request failed after ${requestDuration}ms`);
      
      return Response.json(
        {
          success: false,
          error: 'Failed to fetch seller details',
          suggestion: 'Please try again later'
        },
        { status: 500, headers: corsHeaders }
      );
    }

  } catch (error) {
    console.error(`[${requestId}] 💥 Request processing error:`, error);
    const requestDuration = Date.now() - requestStart;
    console.log(`[${requestId}] 🔚 Request ended with error after ${requestDuration}ms`);
    
    return Response.json(
      { success: false, error: 'Internal server error' },
      { status: 500, headers: corsHeaders }
    );
  }
});

// STEP 2: Queue similar sellers for background ASIN list snapshots
// Only queue sellers that DON'T exist in our database yet (with same domain)
// AND only if similar sellers have actually changed since last lookup
async function queueSimilarSellersForSnapshots(
  keepaResponse: any, 
  sourceSellerId: string, 
  domain: number, 
  logPrefix: string,
  cachedSeller: any = null
) {
  try {
    // Extract similar sellers from Keepa response
    const extractedData = extractSimilarSellersFromKeepa(keepaResponse, sourceSellerId);
    const similarSellers = extractedData.competitors;
    
    if (!similarSellers || similarSellers.length === 0) {
      return;
    }
    
    // Extract seller IDs from competitors array
    const newSellerIds = similarSellers.map(competitor => competitor.sellerId);
    
    // INTELLIGENT COMPARISON: Only queue if similar sellers have actually changed
    if (cachedSeller && cachedSeller.similar_sellers) {
      const existingSimilarSellers = cachedSeller.similar_sellers;
      const existingSellerIds = existingSimilarSellers.map(s => s.sellerId);
      
      // Compare seller IDs - if they're the same, no need to queue
      const sellerIdsChanged = JSON.stringify(newSellerIds.sort()) !== JSON.stringify(existingSellerIds.sort());
      
      if (!sellerIdsChanged) {
        return;
      }
    }
    
    // Check if similar sellers already exist in our database with same domain
    // We only want to snapshot sellers we haven't seen before
    const { data: existingSellers } = await supabase
      .from('sellers')
      .select('seller_id')
      .in('seller_id', newSellerIds)
      .eq('domain', domain);
    
    const existingSellerIds = existingSellers?.map(s => s.seller_id) || [];
    const sellersToQueue = newSellerIds.filter(id => !existingSellerIds.includes(id));
    
    if (sellersToQueue.length === 0) {
      return;
    }
    
    // Queue only new sellers for background ASIN list snapshots
    const queueEntries = sellersToQueue.map(sellerId => ({
      seller_id: sellerId,
      domain: domain,
      discovered_from_seller_id: sourceSellerId
    }));
    
    // Bulk insert with conflict resolution (ignore duplicates)
    const { data, error } = await supabase
      .from('seller_snapshot_queue')
      .upsert(queueEntries, { 
        onConflict: 'seller_id,domain',
        ignoreDuplicates: true 
      });
    
    if (error) {
      console.error(`${logPrefix} ❌ Failed to queue similar sellers:`, error);
    }
    
  } catch (error) {
    console.error(`${logPrefix} ❌ Error in queueSimilarSellersForSnapshots:`, error);
  }
}

// STEP 1: Extract similar sellers and top brands from Keepa response
// Extracts competitors array and sellerBrandStatistics from sellers.{sellerId}
function extractSimilarSellersFromKeepa(keepaResponse: any, sourceSellerId: string): any {
  const sellerData = keepaResponse.sellers?.[sourceSellerId];
  
  if (!sellerData) {
    return { competitors: [], topBrands: [] };
  }
  
  // Extract the actual data
  const competitors = sellerData.competitors || [];
  const topBrands = sellerData.sellerBrandStatistics || [];
  
  return {
    // Similar sellers with competition percentages
    // Format: [{percent: 18, sellerId: "ATVPDKIKX0DER"}, ...]
    competitors: competitors,
    
    // Top brands with sales performance metrics
    // Format: [{avg30SalesRank: 33971, brand: "pampers", productCount: 113, productCountWithAmazonOffer: 16}, ...]
    topBrands: topBrands
  };
} 