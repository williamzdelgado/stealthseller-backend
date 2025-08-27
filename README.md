 🔄 Batch Processing Flow Overview

  1. Domain Layer (_domain/)

  - batching.ts - Pure functions for splitting ASINs into batches (no I/O)
  - routing.ts - Decides whether to process immediately (≤50 products) or queue
  (>50 products)
  - tokens.ts - Calculates required tokens (7 tokens per product)

  2. Infrastructure Layer (_infrastructure/)

  - batch-processing.ts - Main processor that orchestrates the complete flow
  - queue.ts - Handles large batches by creating records and triggering
  Trigger.dev jobs
  - database.ts - Database operations (batch tracking, product inserts)

  3. Batch Processing Pipeline

  📊 Product Discovery (seller-lookup)
      ↓
  🧮 Token & Size Check (domain/routing.ts)
      ↓
     📦 ≤50 products?     🚛 >50 products?
      ↓                      ↓
  [IMMEDIATE PROCESSING]   [QUEUE PROCESSING]
      ↓                      ↓
  batch-processing.ts      queue.ts creates batches
      ↓                      ↓
  1. Create batch record   Multiple batch records
  2. Mark PROCESSING       Mark PENDING
  3. Fetch from Keepa      ↓
  4. Insert to database    Trigger.dev picks up
  5. Update batch status   ↓
  6. Update seller         Uses batch-processing.ts
                           for each batch

  4. How They Work Together:

  batch-processing.ts is the core orchestrator:
  // Step 1: Create batch tracking record
  // Step 2: Mark as PROCESSING  
  // Step 3: Fetch from Keepa API (10 ASINs per API call)
  // Step 4: Insert products (sophisticated two-phase DB operation)  
  // Step 5: Mark batch as COMPLETED/FAILED/PARTIAL
  // Step 6: Update seller last_checked_at

  queue.ts handles large sellers:
  // 1. Check for existing batches (deduplication)
  // 2. Split into 100-product batches  
  // 3. Create all batch records as PENDING
  // 4. Trigger ONE Trigger.dev job for the seller
  // 5. Trigger.dev claims and processes each batch using batch-processing.ts

  5. Key Differences Between Files:

  - Original _shared/batch-processor.ts: Uses fetchKeepaData and has all logic
  inline
  - My _infrastructure/batch-processing.ts: Uses fetchProductData and delegates to
   other infrastructure functions
  - _shared/queue.ts: Complex batch claiming logic for Trigger.dev workers
  - My _infrastructure/queue.ts: Simplified batch creation and triggering

  The batch processing system handles:
  - Immediate processing for small sellers (≤50 products)
  - Queue processing for large sellers (>50 products, split into 100-product
  batches)
  - Concurrency control (max 3 Trigger.dev jobs running)
  - Error handling with transient vs hard error classification
  - Batch deduplication to prevent duplicate processing
  - Token management and Keepa API rate limiting