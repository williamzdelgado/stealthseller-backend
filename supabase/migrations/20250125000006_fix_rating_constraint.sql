-- Fix rating constraint to allow -1 for missing rating data
-- Migration: 20250125000006_fix_rating_constraint.sql

-- Drop the existing constraint that only allows 1.0-5.0
ALTER TABLE seller_products DROP CONSTRAINT seller_products_rating_check;

-- Add new constraint that allows NULL, -1 (missing data), or valid ratings 1.0-5.0
ALTER TABLE seller_products ADD CONSTRAINT seller_products_rating_check 
  CHECK (rating IS NULL OR rating = -1 OR (rating >= 1.0 AND rating <= 5.0));

-- Add comment explaining the constraint logic
COMMENT ON CONSTRAINT seller_products_rating_check ON seller_products IS 
'Allows NULL (no data), -1 (missing/unavailable rating), or valid ratings between 1.0-5.0'; 