# Dynamic Product Routing Implementation - REFACTORING PROGRESS

##  COMPLETED: Domain Layer (Pure Functions)
All domain layer files have been created with pure, testable functions:

### Created Files:
-  `_domain/constants.ts` - All business constants centralized
-  `_domain/validation.ts` - Input validation rules  
-  `_domain/tokens.ts` - Token calculations and logic
-  `_domain/asins.ts` - ASIN operations and comparisons
-  `_domain/batching.ts` - Batch splitting and management
-  `_domain/routing.ts` - Dynamic routing decisions

##  COMPLETED: Infrastructure Layer (I/O Operations)
All infrastructure layer files have been created for external interactions:

### Created Files:
-  `_infrastructure/database.ts` - All Supabase operations
-  `_infrastructure/keepa-api.ts` - Keepa API interactions
-  `_infrastructure/token-tracker.ts` - Token state management
-  `_infrastructure/queue.ts` - Queue and Trigger.dev operations
-  `_infrastructure/auth.ts` - JWT and authentication helpers
-  `_infrastructure/discord.ts` - Discord webhook notifications

## 🚧 IN PROGRESS: Edge Functions Refactoring

### Completed:
1. **✅ seller-lookup/index.ts** - Refactored to use new domain/infrastructure layers
   - ✅ Uses `_domain/validation.ts`, `_domain/constants.ts`, `_domain/asins.ts`
   - ✅ Uses `_infrastructure/keepa-api.ts`, `_infrastructure/database.ts`, `_infrastructure/auth.ts`
   - ✅ Maintains exact orchestration patterns and auto-invocation to product-processing

### In Progress:
2. **❌ product-processing/index.ts** - STILL USING OLD `_shared` IMPORTS
   - ❌ Still imports from `../shared/keepa.ts`, `../shared/batch-processor.ts`, `../shared/queue.ts`
   - ❌ Uses old functions: `fetchKeepaData`, `insertProducts`, `findNewAsins`, `processProductBatch`
   - ❌ Needs migration to new infrastructure layer functions

### Missing:
3. **❌ product-batches** - EXISTS IN `/trigger/product-batches.ts` NOT `/supabase/functions/`
   - ❌ Trigger.dev task lives in `/trigger/product-batches.ts`
   - ❌ Still imports from old `_shared/shared-node.ts`
   - ❌ Decision needed: Keep in `/trigger/` or move to `/supabase/functions/`

## 🔍 MIGRATION STATUS ANALYSIS (Latest Discovery)

### Functions Still Using `_shared` (Need Migration):
- **product-processing/index.ts**:
  - `fetchKeepaData` → Should use `fetchProductData` from `_infrastructure/keepa-api.ts`
  - `insertProducts` → Should use `insertProducts` from `_infrastructure/database.ts`
  - `findNewAsins` → **MISSING** from infrastructure (needs adding)
  - `processProductBatch` → **MISSING** from infrastructure (needs refactoring)
  - `enqueueProductBatches` → Available in `_infrastructure/queue.ts` (ready)
  - `WebhookNotifier` → Available in `_infrastructure/discord.ts` (ready)

- **trigger/product-batches.ts**:
  - `fetchKeepaData`, `insertProducts`, `claimProductBatches`, `processProductBatch` → From `_shared/shared-node.ts`
  - `WebhookNotifier` → From `_shared/discord.ts`

### Architecture Decision Needed:
- **Queue Processing**: Current setup has Trigger.dev tasks in `/trigger/` folder
- **Edge Functions**: Product-processing routes to either edge processing OR queue
- **Question**: Should product-batches remain in `/trigger/` or be moved to `/supabase/functions/`?

## 🔍 DUPLICATE FUNCTIONS ANALYSIS (CRITICAL DISCOVERY)

### CONFIRMED DUPLICATES - Same functionality, different locations:

1. **`fetchKeepaData` vs `fetchProductData`**:
   - ❌ OLD: `_shared/keepa.ts` → `fetchKeepaData(asins[], domain, keepaSellerID, keepaApiKey, isDev)`
   - ✅ NEW: `_infrastructure/keepa-api.ts` → `fetchProductData(asins[], domain, keepaSellerID, keepaApiKey, isDev)`
   - **SAME LOGIC**: Both fetch products from Keepa API with concurrent chunking

2. **`insertProducts` - DIFFERENT SIGNATURES**:
   - ❌ OLD: `_shared/keepa.ts` → `insertProducts(sellerId, products[], domain, keepaSellerID, supabase, isDev, processingSource)`
   - ❌ NEW: `_infrastructure/database.ts` → `insertProducts(supabase, products[])` 
   - **PROBLEM**: New version has simplified signature, may not work with old callers

3. **`findNewAsins` - MISSING**:
   - ❌ OLD: `_shared/keepa.ts` → `findNewAsins(sellerUuid, currentAsins[], supabase, isDev)`
   - ❌ NEW: **MISSING** from infrastructure layer

## ✅ MIGRATION CHECKLIST (Must Preserve Exact Orchestration)

### Phase 1: Fix Function Signatures & Add Missing Functions
- [x] **Fix `insertProducts` signature** in `_infrastructure/database.ts` to match old version (7 params)
- [x] **Add `findNewAsins`** to `_infrastructure/database.ts` (copied from `_shared/keepa.ts`)
- [x] **Verify signatures match exactly** between old/new versions:
  - ✅ `fetchKeepaData` vs `fetchProductData` - signatures match exactly
  - ✅ `insertProducts` - now has correct 7-parameter signature
  - ✅ `findNewAsins` - copied with exact signature and logic

### Phase 2: Migrate product-processing/index.ts
- [x] Replace `fetchKeepaData` → `fetchProductData` from `_infrastructure/keepa-api.ts` (via batch-processing.ts)
- [x] Replace `insertProducts` → `insertProducts` from `_infrastructure/database.ts`
- [x] Replace `findNewAsins` → `findNewAsins` from `_infrastructure/database.ts`
- [x] Replace `enqueueProductBatches` → `enqueueProductBatches` from `_infrastructure/queue.ts`
- [x] Replace `WebhookNotifier` → `WebhookNotifier` from `_infrastructure/discord.ts`
- [x] Replace `processProductBatch` → `processProductBatch` from `_infrastructure/batch-processing.ts`
- [x] Replace `ROUTING_THRESHOLD` → `LIMITS.ROUTING_THRESHOLD` from `_domain/constants.ts`
- [x] **CRITICAL**: Preserve exact orchestration flow and error handling

### Phase 3: Update trigger/product-batches.ts
- [x] **Decision**: Keep in `/trigger/` folder (maintain existing Trigger.dev structure)
- [x] Replace `fetchKeepaData`, `insertProducts` → via `processProductBatch` from `_infrastructure/batch-processing.ts`
- [x] Replace `claimProductBatches` → `claimProductBatches` from `_infrastructure/database.ts`
- [x] Replace `TokenManager` → `TokenManager` from `_infrastructure/token-tracker.ts`
- [x] Replace `WebhookNotifier` → `WebhookNotifier` from `_infrastructure/discord.ts`
- [x] All `_shared/` imports replaced with `_infrastructure/` imports

### Phase 4: Cleanup
- [x] **Migration completed** - All functions moved to proper domain/infrastructure layers
- [x] Delete old `_shared/` folder (✅ DELETED)
- [x] Update imports in trigger files (`product-batches.ts`, `keepa-discovery.ts`)
- ⚠️ **Note**: `trigger/keepa-discovery.ts` has signature mismatches due to infrastructure changes (requires separate fix)

## ⚠️ CRITICAL PRESERVATION REQUIREMENTS

1. **Exact Orchestration**: seller-lookup → product-processing → (edge OR queue) flow must be identical
2. **Function Signatures**: All replacement functions must accept same parameters in same order
3. **Error Handling**: All error paths and fallback logic must be preserved
4. **Token Economics**: 7 tokens/product, routing thresholds, bucket management unchanged
5. **Database Operations**: All SQL queries and upsert logic must be identical
6. **Webhook Notifications**: All Discord notifications must fire at same times with same data

## 📝 ONE-LINE MEMORY LOGS

- **DUPLICATE DISCOVERY**: `fetchKeepaData`=`fetchProductData`, `insertProducts` has different signatures
- **MISSING FUNCTION**: `findNewAsins` needs to be added to infrastructure layer  
- **SIGNATURE MISMATCH**: New `insertProducts` simplified, may break existing callers
- **ORCHESTRATION PRESERVED**: seller-lookup works, product-processing needs migration
- **QUEUE LOCATION**: Trigger.dev tasks in `/trigger/` folder, not `/supabase/functions/`
- **CLEANUP PENDING**: Old `_shared/` folder still fully intact, used by product-processing + trigger

---

## Original Requirements & Architecture

### Dynamic Product Routing Implementation

#### Core Architecture
Implement a dynamic routing system that decides between immediate edge function processing vs background queue processing based on token availability and user usage patterns.

#### Confirmed System Parameters
- **Keepa Token Bucket**: 15,000 max tokens, regenerates 250 tokens/minute
- **Token Cost**: ~7 tokens per product (varies between 6-12 tokens)
- **Sustainable Rate**: ~35 products/minute continuous processing
- **Caching**: Products are cached permanently after first lookup

### Implementation Requirements

#### 1. Token Tracking Function
```javascript
async function getKeepTokens() {
  // Must return object with:
  // - available: current tokens in bucket
  // - max: 15000 (bucket maximum)
  // Implementation depends on your token tracking system
}
```

#### 2. User Usage Tracking via Product Batches
Track token usage by adding `user_id` to product batch records:
- Add `user_id` column to product_batches table
- Query pattern: `SELECT SUM(product_count * 7) as token_usage FROM product_batches WHERE user_id = ? AND created_at > ?`
- This provides accurate per-user token consumption history

#### 3. Routing Decision Logic
```javascript
async function shouldQueueProducts(productCount, userId) {
  // Get current token level
  const tokens = await getKeepTokens();
  const fillPercent = tokens.available / tokens.max;
  
  // Simple dynamic threshold
  let threshold = 50; // default
  if (fillPercent < 0.3) threshold = 20; // low tokens
  if (fillPercent > 0.8) threshold = 75; // plenty of tokens
  
  // Basic per-user check
  const userTokensLastHour = await getUserTokenUsage(userId, '1h');
  if (userTokensLastHour > 2000) threshold = 20; // heavy user, throttle
  
  return productCount > threshold;
}
```

### Performance Considerations

#### Speed Optimizations
1. **Cache token status** - Update every 30 seconds rather than checking live
2. **Cache user usage** - Store rolling 1-hour usage in Redis/memory with 5-minute refresh
3. **Database query optimization** - Index on `(user_id, created_at)` for product_batches table

#### Error Handling
1. **Token fetch failure** - Default to conservative threshold (20) if token status unavailable
2. **User usage query failure** - Proceed with system-level threshold only
3. **Database timeout** - Use cached values or default to queueing for safety

### Database Schema Change
```sql
ALTER TABLE product_batches
ADD COLUMN user_id UUID REFERENCES users(id),
ADD INDEX idx_user_token_usage (user_id, created_at);
```

### Integration Points
1. **seller-lookup function** - Call `shouldQueueProducts()` before routing
2. **processProductBatch** - Record user_id in batch creation
3. **enqueueProductBatches** - Record user_id in batch creation

### Monitoring Requirements
- Log routing decisions: `{userId, productCount, threshold, decision, tokenPercent}`
- Track metrics: queue vs immediate processing ratio
- Alert if token level stays below 30% for >5 minutes

### Future Considerations (not for initial implementation)
- Webhook for token bucket status updates
- Different thresholds for paid tiers
- Time-of-day adjustments for threshold

---

## CORE FLOW CHECKLIST

### 1. SELLER-LOOKUP
- [ ] Validate seller ID format (13-15 alphanumeric)
- [ ] Validate domain (1-11) or default to 1
- [ ] Fetch seller from Keepa API
- [ ] Extract seller name, ASIN list, competitors, brands
- [ ] Save/update seller in database
- [ ] **Determine new ASINs** (check against: initial_asin_list + seller_products + product_batches)
- [ ] Check 3000 ASIN limit
- [ ] Fire-and-forget to product-processing (if under limit)
- [ ] Return seller info to frontend immediately

### 2. PRODUCT-PROCESSING
- [ ] Validate auth token matches userId
- [ ] Get seller UUID from database
- [ ] Check for active batches (PENDING/PROCESSING)
- [ ] **Trust incoming ASINs are new** (no re-checking)
- [ ] Get token status (bucket fill %, recent usage)
- [ ] Make routing decision (d50 edge, >50 queue)
- [ ] If edge: Process immediately with Keepa
- [ ] If queue: Create batches and enqueue
- [ ] Return processing status

### 3. PRODUCT-BATCHES (Trigger.dev)
- [ ] Claim batches atomically with worker ID
- [ ] Check token threshold (stop if <7000)
- [ ] Loop through batches until none left or timeout
- [ ] Fetch from Keepa in chunks
- [ ] Insert products to database
- [ ] Update batch status (COMPLETED/FAILED)
- [ ] Memory management (GC every 5 loops)
- [ ] Continue until no more work

---

## BUILD ORDER 

1. ** Domain layer** (no dependencies):
   -  `validation.ts` - Simplest, pure functions
   -  `tokens.ts` - Simple math
   -  `asins.ts` - Array operations
   -  `batching.ts` - Array chunking
   -  `routing.ts` - Decision logic

2. ** Infrastructure layer**:
   -  `database.ts` - Just queries
   -  `keepa-api.ts` - Just API calls
   -  `token-tracker.ts` - Token management
   -  `queue.ts` - Queue operations

3. **=� Edge functions** (In Progress):
   - � `seller-lookup` - Orchestrates everything
   - � `product-processing` - Routes to edge/queue
   - � `product-batches` - Processes from queue

---

## WHAT TO DELETE (After Refactoring Complete)
- [ ] `getNetworkProcessingDecision()` - Redundant
- [ ] `findTrulyNewAsins()` - Use new domain function
- [ ] `findNewAsins()` in keepa.ts - Wrong place
- [ ] `batch-processor.ts` - Rewrite in edge function
- [ ] `shared-node.ts` - Unnecessary wrapper
- [ ] `debug-db-enums/` - Delete entire folder
- [ ] `index-old.ts` - Delete backup
- [ ] Old `_shared/` folder after migration

---

## Progress Summary
- **Domain Layer**: 100% Complete 
- **Infrastructure Layer**: 100% Complete 
- **Edge Functions**: 0% Complete (Next Step)
- **Overall Progress**: ~70% Complete

The foundation is now in place with clean separation of concerns. Next step is to refactor the edge functions to use these new layers.