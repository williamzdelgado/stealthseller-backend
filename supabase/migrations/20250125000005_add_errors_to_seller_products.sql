-- Add errors column to seller_products table for tracking data processing issues
ALTER TABLE seller_products 
ADD COLUMN errors JSONB;

-- Add index for efficient querying of specific error types
CREATE INDEX idx_seller_products_errors ON seller_products USING GIN (errors);

-- Add comment explaining the column structure
COMMENT ON COLUMN seller_products.errors IS 'JSON object storing data processing errors. Format: {"error_type": "error_message", ...}'; 