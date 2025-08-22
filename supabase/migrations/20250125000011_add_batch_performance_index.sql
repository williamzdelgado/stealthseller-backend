-- Add composite index for batch deduplication performance
-- This index optimizes the checkExistingBatches() query pattern:
-- WHERE seller_id = ? AND status IN ('PENDING', 'PROCESSING') ORDER BY created_at DESC
-- Expected performance improvement: 10x faster queries

CREATE INDEX idx_batches_seller_status_created
ON product_batches(seller_id, status, created_at DESC);

-- Add comment for future reference
COMMENT ON INDEX idx_batches_seller_status_created IS 
'Optimizes batch deduplication queries by seller_id, status, and creation time'; 