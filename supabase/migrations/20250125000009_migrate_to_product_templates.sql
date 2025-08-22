-- Migrate Data to Product Templates - Phase 2
-- Migration: 20250125000009_migrate_to_product_templates.sql
-- Purpose: Extract product templates and link seller_products

-- 1. Extract unique products and create templates
INSERT INTO product_templates (asin_id, domain, title, brand, category, subcategory, images, product_url)
SELECT DISTINCT ON (asin_id, domain)
    asin_id,
    domain,
    title,
    brand,
    category,
    subcategory,
    images,
    product_url
FROM seller_products
WHERE asin_id IS NOT NULL
ORDER BY asin_id, domain, created_at DESC; -- Use most recent data for template

-- 2. Add foreign key column to seller_products (nullable for now)
ALTER TABLE seller_products 
ADD COLUMN product_template_id UUID REFERENCES product_templates(id);

-- 3. Update seller_products to link to templates
UPDATE seller_products 
SET product_template_id = pt.id
FROM product_templates pt
WHERE seller_products.asin_id = pt.asin_id 
  AND seller_products.domain = pt.domain;

-- 4. Add index for new foreign key
CREATE INDEX idx_seller_products_template_id ON seller_products(product_template_id);

-- 5. Verify all records have template links
DO $$
DECLARE
    unlinked_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO unlinked_count
    FROM seller_products 
    WHERE product_template_id IS NULL 
    AND asin_id IS NOT NULL;
    
    IF unlinked_count > 0 THEN
        RAISE EXCEPTION 'Migration error: % seller_products lack template links', unlinked_count;
    END IF;
    
    RAISE NOTICE 'Migration Phase 2 successful: All seller_products linked to templates';
END $$; 