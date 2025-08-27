/*
 * SELLER LOOKUP EDGE FUNCTION
 * 
 * ORCHESTRATION FLOW:
 * 1. Validates seller ID format (13-15 alphanumeric)
 * 2. Validates domain (1-11) or defaults to 1
 * 3. Fetches seller from Keepa API
 * 4. Extracts seller name, ASIN list, competitors, brands
 * 5. Saves/updates seller in database
 * 6. Determines new ASINs (checks against: initial_asin_list + seller_products + product_batches)
 * 7. Checks 3000 ASIN limit
 * 8. Fire-and-forget to product-processing (if under limit)
 * 9. Returns seller info to frontend immediately
 * 
 * TOKEN ECONOMICS:
 * - Query seller's ASIN list: 10 tokens
 * - Query each individual ASIN: 7 tokens per ASIN
 * - Example: Seller with 100 ASINs = 10 + (100 × 7) = 710 tokens
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Import domain layer (pure functions)
import { validateSellerId, validateDomain } from '../_domain/validation.ts'
import { LIMITS } from '../_domain/constants.ts'
import { determineNewAsins } from '../_domain/asins.ts'

// Import infrastructure layer (I/O operations)
import {
  getSellerBySellerIdAndDomain,
  getExistingAsins,
  getSellerWithAsins,
  saveSeller,
  updateSeller,
  captureSellerSearch,
  queueSimilarSellers,
} from '../_infrastructure/database.ts'
import { fetchSellerData, extractSimilarSellers, extractTopBrands } from '../_infrastructure/keepa-api.ts'
import { validateAuthToken } from '../_infrastructure/auth.ts'

// Module-level environment variables (cached once, reused forever)
const KEEPA_API_KEY = Deno.env.get('KEEPA_API_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

// Business logic constants
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours in milliseconds

// CORS headers for browser requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Request/Response interfaces
interface SellerDetailsRequest {
  sellerId: string
  domain?: number
}

interface SellerDetailsResponse {
  success: boolean
  data?: {
    sellerId: string
    sellerName: string
    domain: number
    asinCount: number
    recentlyAdded: Array<{
      asin: string
      title: string
      firstListingDate: string
    }>
    lastCheckedAt?: string | null
  }
  error?: string
  suggestion?: string
}

// Build response from existing seller data
function buildSellerResponse(dbSeller: any, domain: number): SellerDetailsResponse {
  return {
    success: true,
    data: {
      sellerId: dbSeller.seller_id,
      sellerName: dbSeller.seller_name || 'Unknown Seller',
      domain: domain,
      asinCount: dbSeller.asin_count || 0,
      recentlyAdded: [], // Don't send ASIN list - frontend doesn't need it
      lastCheckedAt: dbSeller.last_checked_at || null
    }
  }
}



serve(async (req) => {
  const requestStart = Date.now()
  const requestId = Math.random().toString(36).substring(7)

  console.log(`[${requestId}] 🚀 Seller Details request started`)

  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    console.log(`[${requestId}] ✅ CORS preflight handled`)
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Parse request body first
    const body: SellerDetailsRequest = await req.json()
    const { sellerId, domain } = body

    console.log(`[${requestId}] 📥 Request: sellerId=${sellerId}, domain=${domain || 'auto'}`)

    // Validate auth token
    const authHeader = req.headers.get('Authorization')
    const { userId, error: authError } = validateAuthToken(authHeader)

    if (authError || !userId) {
      console.log(`[${requestId}] ❌ Authentication failed:`, authError?.message)
      return Response.json(
        { success: false, error: 'Authentication required' },
        { status: 401, headers: corsHeaders }
      )
    }

    console.log(`[${requestId}] ✅ User authenticated: ${userId}`)

    // Create user-authenticated Supabase client
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      realtime: { enabled: false },
      global: {
        headers: {
          Authorization: authHeader!
        }
      }
    })

    // Validate seller ID format
    const sellerValidation = validateSellerId(sellerId)
    if (!sellerValidation.valid) {
      console.log(`[${requestId}] ❌ Invalid seller ID: ${sellerValidation.error}`)
      return Response.json(
        { success: false, error: sellerValidation.error },
        { status: 400, headers: corsHeaders }
      )
    }

    // Validate and get domain
    const domainValidation = validateDomain(domain)
    const userDomain = domainValidation.domain

    if (!domainValidation.valid) {
      return Response.json(
        { success: false, error: domainValidation.error },
        { status: 400, headers: corsHeaders }
      )
    }

    try {
      // Check existing seller data first - OPTIMIZED: Get seller and ASINs in one call
      console.log(`[${requestId}] 🔍 Checking if seller ${sellerId} exists in sellers table...`)
      const dbQueryStart = Date.now()
      const { seller: existingSeller, asins: knownAsins, error: fetchError } = await getSellerWithAsins(
        supabase,
        sellerId,
        userDomain
      )
      console.log(`[${requestId}] ⏱️ Seller lookup: ${Date.now() - dbQueryStart}ms`)

      if (fetchError) {
        console.error(`[${requestId}] ❌ Database error:`, fetchError)
        throw new Error(`Database error: ${fetchError.message}`)
      }

      // Check if seller data is fresh (within 24 hours) - SIMPLIFIED
      if (existingSeller && existingSeller.last_checked_at) {
        const lastCheckTime = new Date(existingSeller.last_checked_at).getTime()
        const timeAgoMs = Date.now() - lastCheckTime

        if (timeAgoMs < REFRESH_INTERVAL_MS) {
          const timeAgo = Math.round(timeAgoMs / (1000 * 60 * 60)) // hours ago
          console.log(`[${requestId}] ✅ [CACHE HIT] Seller data fresh (${timeAgo}h old) - returning without Keepa API call`)

          const requestDuration = Date.now() - requestStart
          console.log(`[${requestId}] ⚡ Completed: ${requestDuration}ms (cached)`)

          return Response.json(buildSellerResponse(existingSeller, userDomain), { headers: corsHeaders })
        } else {
          console.log(`[${requestId}] 🔄 Data >24h old, refreshing...`)
        }
      }

      // Fetch from Keepa API
      console.log(`[${requestId}] 🎯 Calling Keepa API (domain=${userDomain})...`)
      const keepaStart = Date.now()
      const keepaResponse = await fetchSellerData(sellerId, userDomain, KEEPA_API_KEY, requestId)
      console.log(`[${requestId}] ⏱️ Keepa fetch: ${Date.now() - keepaStart}ms`)
      
      // Disabled verbose response logging - keeping logs clean
      // console.log(`[${requestId}] 🔍 Keepa response details:`, {
      //   hasResponse: !!keepaResponse,
      //   sellerName: keepaResponse?.sellerName,
      //   businessName: keepaResponse?.businessName,
      //   asinCount: keepaResponse?.asinList?.length || 0
      // })

      if (keepaResponse) {
        // Compute values once for reuse (PERFORMANCE OPTIMIZATION)
        const sellerDisplayName = keepaResponse.sellerName || keepaResponse.businessName || 'Unknown Seller'
        const requestTimestamp = new Date().toISOString()
        let searchCaptured = false // Track if we already logged this search

        // Extract similar sellers and top brands
        const similarSellers = extractSimilarSellers(keepaResponse, sellerId)
        const topBrands = extractTopBrands(keepaResponse, sellerId)

        // Queue similar sellers for snapshots (intelligent comparison) - OPTIMIZED
        if (similarSellers.length > 0) {
          const existingSimilar = existingSeller?.similar_sellers || []
          const existingIds = existingSimilar.map((s: any) => s.sellerId)
          const newIds = similarSellers.map(s => s.sellerId)

          // PERFORMANCE OPTIMIZATION: Use Set-based comparison instead of JSON.stringify
          const existingSet = new Set(existingIds)
          const hasChanges = newIds.some(id => !existingSet.has(id)) || newIds.length !== existingIds.length

          if (hasChanges) {
            await queueSimilarSellers(supabase, similarSellers, userDomain, sellerId)
          }
        }

        // Determine new ASINs for processing
        const currentAsinList = keepaResponse.asinList || []

        // Check ASIN limit
        const asinCount = currentAsinList.length

        if (asinCount > LIMITS.MAX_NEW_PRODUCTS) {
          console.log(`[${requestId}] ❌ Seller exceeds ${LIMITS.MAX_NEW_PRODUCTS} ASIN limit: ${asinCount}`)
          return Response.json(
            {
              success: false,
              error: `Seller has ${asinCount.toLocaleString()} products, which exceeds our ${LIMITS.MAX_NEW_PRODUCTS.toLocaleString()} product limit`
            },
            { status: 400, headers: corsHeaders }
          )
        }
        let shouldProcessProducts = false
        let asinsToProcess: string[] = []
        let processingReason = ''

        if (existingSeller) {
          // EXISTING SELLER: Check for new ASINs
          console.log(`[${requestId}] 🔍 Comparing ASINs: ${knownAsins.length} known vs ${currentAsinList.length} current`)

          // PERFORMANCE OPTIMIZATION: Use known ASINs from earlier seller lookup (eliminates N+1 pattern)
          const newAsins = determineNewAsins(knownAsins, currentAsinList)

          if (newAsins.length > 0) {
            shouldProcessProducts = true
            asinsToProcess = newAsins
            processingReason = `Found ${newAsins.length} new ASINs`
            console.log(`[${requestId}] 🆕 ${processingReason}`)
          } else {
            console.log(`[${requestId}] ✅ No new ASINs`)
          }
        } else {
          // NEW SELLER: Process all ASINs
          shouldProcessProducts = true
          asinsToProcess = currentAsinList
          processingReason = `New seller: ${currentAsinList.length} ASINs`
          console.log(`[${requestId}] 🆕 New seller: processing all ${currentAsinList.length} ASINs`)
        }

        // Save/update seller in database BEFORE auto-invocation
        let dbSeller
        if (existingSeller) {
          console.log(`[${requestId}] 💾 Updating sellers table: asin_count=${asinCount}, similar_sellers, last_checked_at...`)
          const { data: updatedSeller } = await updateSeller(supabase, existingSeller.id!, {
            asin_count: asinCount,
            seller_name: sellerDisplayName, // PERFORMANCE: Use computed value
            similar_sellers: similarSellers.length > 0 ? similarSellers : existingSeller.similar_sellers,
            top_brands: topBrands.length > 0 ? topBrands : existingSeller.top_brands,
            total_storefront_asin_list_csv: keepaResponse.totalStorefrontAsinsCSV,
            last_checked_at: requestTimestamp // PERFORMANCE: Use computed timestamp
          })
          dbSeller = updatedSeller || existingSeller
          
          // NULL SAFETY: Ensure dbSeller exists after update operation
          if (!dbSeller) {
            console.error(`[${requestId}] ❌ updateSeller returned null:`, { updatedSeller, existingSeller })
            throw new Error('Failed to update seller - database operation returned null')
          }
        } else {
          console.log(`[${requestId}] 💾 Inserting new seller ${sellerId} into sellers table...`)
          const { data: newSeller } = await saveSeller(supabase, {
            seller_id: sellerId,
            seller_name: sellerDisplayName, // PERFORMANCE: Use computed value
            domain: userDomain,
            initial_asin_list: currentAsinList,
            asin_count: asinCount,
            similar_sellers: similarSellers.length > 0 ? similarSellers : undefined,
            top_brands: topBrands.length > 0 ? topBrands : undefined,
            total_storefront_asin_list_csv: keepaResponse.totalStorefrontAsinsCSV,
            last_checked_at: requestTimestamp, // PERFORMANCE: Use computed timestamp
            created_by: userId // FIX: RLS policy requires this field for INSERT
          })
          dbSeller = newSeller
          
          // NULL SAFETY: Ensure dbSeller exists after save operation
          if (!dbSeller) {
            console.error(`[${requestId}] ❌ saveSeller returned null:`, { newSeller, sellerId, userDomain })
            throw new Error('Failed to save new seller - database operation returned null (check constraints/RLS)')
          }
        }

        // Check for existing processing before starting new processing (ORCHESTRATION)
        if (shouldProcessProducts && asinsToProcess.length > 0) {
          console.log(`[${requestId}] 💾 Batch check: Querying product_batches for active jobs...`)
          
          // DEFENSIVE CHECK: Ensure dbSeller exists before accessing .id
          if (!dbSeller || !dbSeller.id) {
            console.error(`[${requestId}] ❌ dbSeller invalid for batch check:`, { dbSeller, hasId: !!dbSeller?.id })
            throw new Error('Cannot check batches - seller record is null or missing ID')
          }

          // Check if batches already exist for this seller
          const batchCheckStart = Date.now()
          const { data: existingBatches, error: batchCheckError } = await supabase
            .from('product_batches')
            .select('id, status, product_count')
            .eq('seller_id', dbSeller.id)
            .in('status', ['PENDING', 'PROCESSING'])
          console.log(`[${requestId}] ⏱️ Batch check: ${Date.now() - batchCheckStart}ms`)

          if (batchCheckError) {
            console.error(`[${requestId}] ❌ Error checking batches:`, batchCheckError)
          }

          if (existingBatches && existingBatches.length > 0) {
            // Batches already exist - someone else triggered processing
            const stats = {
              total: existingBatches.length,
              pending: existingBatches.filter(b => b.status === 'PENDING').length,
              processing: existingBatches.filter(b => b.status === 'PROCESSING').length,
              totalProducts: existingBatches.reduce((sum, b) => sum + (b.product_count || 0), 0)
            }

            console.log(`[${requestId}] 📊 Processing active: ${stats.total} batches, ${stats.totalProducts} products`)

            // Record successful seller search (PERFORMANCE: Prevent duplicate calls)
            if (!searchCaptured) {
              await captureSellerSearch(
                supabase,
                userId,
                dbSeller.id,
                sellerDisplayName, // PERFORMANCE: Use computed value
                userDomain
              )
              searchCaptured = true
            }

            const requestDuration = Date.now() - requestStart
            console.log(`[${requestId}] ⚡ Completed: ${requestDuration}ms (processing)`)

            return Response.json({
              success: true,
              data: {
                sellerId: keepaResponse.sellerId,
                sellerName: sellerDisplayName, // PERFORMANCE: Use computed value
                domain: userDomain,
                asinCount: asinCount,
                recentlyAdded: [],
                lastCheckedAt: requestTimestamp, // PERFORMANCE: Use computed timestamp
                processingStatus: 'in_progress',
                batchStats: stats,
                subscriptionChannel: `seller_batches:${dbSeller.id}`
              }
            }, { headers: corsHeaders })
          }

          // No existing batches - start new processing
          console.log(`[${requestId}] ✅ No active batches found - safe to process`)
          console.log(`[${requestId}] 🚀 Triggering ${asinsToProcess.length} new ASINs into product-processing function...`)

          // Fire-and-forget product processing (async, non-blocking)
          supabase.functions.invoke('product-processing', {
            body: {
              sellerId,
              userId,
              asinList: asinsToProcess,
              domain: userDomain
            },
            headers: {
              Authorization: authHeader // Pass the original auth header
            }
          }).then(() => {
            console.log(`[${requestId}] ✅ Product processing triggered`)
          }).catch(error => {
            console.error(`[${requestId}] ❌ Background processing failed:`, error)
          })
        }

        // Record successful seller search (PERFORMANCE: Prevent duplicate calls)
        if (!searchCaptured) {
          await captureSellerSearch(
            supabase,
            userId,
            dbSeller.id,
            sellerDisplayName, // PERFORMANCE: Use computed value
            userDomain
          )
          searchCaptured = true
        }

        const requestDuration = Date.now() - requestStart
        console.log(`[${requestId}] ✅ Completed: ${requestDuration}ms`)

        // Return successful response
        return Response.json(
          {
            success: true,
            data: {
              sellerId: keepaResponse.sellerId,
              sellerName: sellerDisplayName, // PERFORMANCE: Use computed value
              domain: userDomain,
              asinCount: asinCount,
              recentlyAdded: [], // Don't send ASIN list
              lastCheckedAt: requestTimestamp, // PERFORMANCE: Use computed timestamp
              processingStatus: shouldProcessProducts ? 'started' : 'none',
              subscriptionChannel: shouldProcessProducts ? `seller_batches:${dbSeller.id}` : undefined
            }
          },
          { headers: corsHeaders }
        )
      }


      // Seller not found anywhere
      console.log(`[${requestId}] 🚫 Seller not found`)
      return Response.json(
        {
          success: false,
          error: 'Seller not found in any marketplace'
        },
        { status: 404, headers: corsHeaders }
      )

    } catch (error) {
      console.error(`[${requestId}] ❌ Seller lookup error:`, error)
      const requestDuration = Date.now() - requestStart
      console.log(`[${requestId}] 💥 Request failed after ${requestDuration}ms`)

      // Classify errors properly
      if (error.message === 'RATE_LIMITED') {
        return Response.json(
          {
            success: false,
            error: 'Service temporarily unavailable due to rate limiting',
            suggestion: 'Please try again in a few minutes'
          },
          { status: 429, headers: corsHeaders }
        )
      } else if (error.message === 'KEEPA_SERVER_ERROR') {
        return Response.json(
          {
            success: false,
            error: 'External service temporarily unavailable',
            suggestion: 'Please try again later'
          },
          { status: 503, headers: corsHeaders }
        )
      } else if (error.message?.includes('Database error')) {
        return Response.json(
          {
            success: false,
            error: 'Database connection issue',
            suggestion: 'Please try again later'
          },
          { status: 503, headers: corsHeaders }
        )
      } else {
        // Keep generic 500 for truly unexpected errors
        return Response.json(
          {
            success: false,
            error: 'Failed to fetch seller details',
            suggestion: 'Please try again later'
          },
          { status: 500, headers: corsHeaders }
        )
      }
    }

  } catch (error) {
    console.error(`[${requestId}] 💥 Request processing error:`, error)
    const requestDuration = Date.now() - requestStart
    console.log(`[${requestId}] 🔚 Request ended with error after ${requestDuration}ms`)

    return Response.json(
      { success: false, error: 'Internal server error' },
      { status: 500, headers: corsHeaders }
    )
  }
})