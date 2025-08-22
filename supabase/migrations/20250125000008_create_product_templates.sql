-- Create Product Templates System - Phase 1
-- Migration: 20250125000008_create_product_templates.sql
-- Purpose: Create deduplicated product template storage

-- 1. Create product_templates table
CREATE TABLE product_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asin_id VARCHAR(20) NOT NULL,
    domain INTEGER NOT NULL,
    
    -- Static product data (extracted from seller_products)
    title TEXT,
    brand VARCHAR(255),
    category VARCHAR(255),
    subcategory VARCHAR(255),
    images TEXT[],
    product_url TEXT,
    
    -- Template metadata
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Constraints: Unique per ASIN + domain
    UNIQUE(asin_id, domain),
    CHECK (domain > 0)
);

-- 2. Add indexes for performance
CREATE INDEX idx_product_templates_asin ON product_templates(asin_id);
CREATE INDEX idx_product_templates_domain ON product_templates(domain);
CREATE INDEX idx_product_templates_asin_domain ON product_templates(asin_id, domain);
CREATE INDEX idx_product_templates_created ON product_templates(created_at);

-- 3. Enable RLS
ALTER TABLE product_templates ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies
CREATE POLICY "Anyone can view product templates" ON product_templates
    FOR SELECT USING (true);

CREATE POLICY "Service role can manage product templates" ON product_templates
    FOR ALL USING (auth.role() = 'service_role');

-- 5. Auto-update timestamps
CREATE TRIGGER update_product_templates_updated_at 
  BEFORE UPDATE ON product_templates 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 6. Comments for documentation
COMMENT ON TABLE product_templates IS 'Deduplicated product data shared across sellers - one record per ASIN per domain';
COMMENT ON COLUMN product_templates.asin_id IS 'Amazon ASIN identifier (B07ABC123 format)';
COMMENT ON COLUMN product_templates.domain IS 'Amazon marketplace: 1=US, 2=UK, 3=DE, etc.';
COMMENT ON COLUMN product_templates.title IS 'Product title from Amazon/Keepa API';
COMMENT ON COLUMN product_templates.brand IS 'Product brand/manufacturer';
COMMENT ON COLUMN product_templates.images IS 'Array of Amazon product image URLs'; 