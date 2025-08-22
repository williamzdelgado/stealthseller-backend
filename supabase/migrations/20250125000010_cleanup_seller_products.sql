-- Clean Up Seller Products - Phase 3
-- Migration: 20250125000010_cleanup_seller_products.sql
-- Purpose: Remove redundant columns and optimize structure

-- 1. Double-check all records have template links before cleanup
DO $$
DECLARE
    unlinked_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO unlinked_count
    FROM seller_products 
    WHERE product_template_id IS NULL 
    AND asin_id IS NOT NULL;
    
    IF unlinked_count > 0 THEN
        RAISE EXCEPTION 'Cleanup aborted: % seller_products lack template links', unlinked_count;
    END IF;
    
    RAISE NOTICE 'Pre-cleanup verification passed: All seller_products have template links';
END $$;

-- 2. Drop existing view that depends on columns we're removing
DROP VIEW IF EXISTS seller_products_with_details;

-- 3. Drop redundant columns from seller_products (now in templates)
ALTER TABLE seller_products DROP COLUMN title;
ALTER TABLE seller_products DROP COLUMN brand;
ALTER TABLE seller_products DROP COLUMN category;
ALTER TABLE seller_products DROP COLUMN subcategory;
ALTER TABLE seller_products DROP COLUMN images;
ALTER TABLE seller_products DROP COLUMN product_url;

-- 4. Make template reference required
ALTER TABLE seller_products 
ALTER COLUMN product_template_id SET NOT NULL;

-- 5. Update unique constraint to use template instead of ASIN
ALTER TABLE seller_products 
DROP CONSTRAINT IF EXISTS seller_products_seller_id_asin_id_domain_key;

ALTER TABLE seller_products 
ADD CONSTRAINT seller_products_seller_template_unique 
UNIQUE(seller_id, product_template_id);

-- 6. Create helpful view for queries (replaces old structure)
CREATE VIEW seller_products_with_templates AS
SELECT 
    sp.id,
    sp.seller_id,
    sp.product_template_id,
    sp.storefront_price,
    sp.buy_box_price,
    sp.after_fees_price,
    sp.avg_price_30d,
    sp.currency,
    sp.sales_rank,
    sp.sales_rank_percentile,
    sp.stock_count,
    sp.rating,
    sp.rating_count,
    sp.monthly_sales,
    sp.is_fba,
    sp.is_fbm,
    sp.is_buy_box_fba,
    sp.is_buy_box_amazon,
    sp.offer_fba_count,
    sp.offer_fbm_count,
    sp.is_offer_amazon,
    sp.first_seen_at,
    sp.time_posted,
    sp.created_at,
    sp.updated_at,
    sp.errors,
    -- Product template data joined in
    pt.asin_id,
    pt.domain,
    pt.title,
    pt.brand,
    pt.category,
    pt.subcategory,
    pt.images,
    pt.product_url
FROM seller_products sp
JOIN product_templates pt ON sp.product_template_id = pt.id;

-- 7. Grant permissions on view
GRANT SELECT ON seller_products_with_templates TO service_role;

-- 8. Update table comments
COMMENT ON TABLE seller_products IS 'Seller-specific product data linked to shared product templates';
COMMENT ON COLUMN seller_products.product_template_id IS 'References shared product template data (required)';
COMMENT ON VIEW seller_products_with_templates IS 'Seller products with template data joined - use this for queries requiring product details'; 