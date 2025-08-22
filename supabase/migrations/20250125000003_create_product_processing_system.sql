-- Create seller_products table with Keepa data
CREATE TABLE seller_products (
  -- PRIMARY FIELDS
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid REFERENCES sellers(id) ON DELETE CASCADE NOT NULL,
  asin_id varchar(20) NOT NULL,                    -- Amazon ASIN (B07ABC123)
  domain integer NOT NULL,                         -- Amazon marketplace (1=US, 2=UK, etc.)
  
  -- PRICING DATA (multi-currency support)
  storefront_price NUMERIC(10,2),                 -- Seller's current list price
  buy_box_price NUMERIC(10,2),                    -- Market buy box price
  after_fees_price NUMERIC(10,2),                 -- Price after Amazon fees
  avg_price_30d NUMERIC(10,2),                    -- 30-day average price
  currency CHAR(3) DEFAULT 'USD',                 -- ISO currency code
  
  -- FULFILLMENT STRATEGY
  is_fba boolean DEFAULT false,                   -- Uses Amazon warehouses
  is_fbm boolean DEFAULT false,                   -- Ships from own warehouse
  is_buy_box_fba boolean DEFAULT false,           -- Buy box winner uses FBA
  is_buy_box_amazon boolean DEFAULT false,        -- Amazon owns the buy box
  
  -- COMPETITION METRICS
  offer_fba_count integer DEFAULT 0,              -- Number of FBA competitors
  offer_fbm_count integer DEFAULT 0,              -- Number of FBM competitors
  is_offer_amazon boolean DEFAULT false,          -- Amazon directly competing
  sales_rank integer,                             -- Category ranking position
  sales_rank_percentile NUMERIC(5,2),             -- Rank as percentile (0-100)
  
  -- DEMAND INDICATORS
  monthly_sales integer,                          -- Monthly units sold
  stock_count integer,                            -- Available inventory
  rating NUMERIC(3,2),                            -- Average customer rating (1.00-5.00)
  rating_count integer DEFAULT 0,                 -- Total number of reviews
  
  -- PRODUCT METADATA
  title text,                                     -- Product name
  brand varchar(255),                             -- Brand name
  category varchar(255),                          -- Product category
  subcategory varchar(255),                       -- Product subcategory
  images text[],                                  -- Array of image URLs
  product_url text,                               -- Amazon product page URL
  
  -- TIMING FIELDS
  time_posted timestamptz,                        -- Last activity from seller
  first_seen_at timestamptz,                      -- When seller first listed this product
  
  -- AUDIT FIELDS
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  -- CONSTRAINTS
  UNIQUE(seller_id, asin_id, domain),             -- Prevent duplicate products per seller+domain
  CHECK (rating IS NULL OR (rating >= 1.0 AND rating <= 5.0)),
  CHECK (sales_rank_percentile IS NULL OR (sales_rank_percentile >= 0 AND sales_rank_percentile <= 100)),
  CHECK (domain > 0)                              -- Valid Amazon domain
);



-- PERFORMANCE INDEXES

-- Primary query patterns
CREATE INDEX idx_seller_products_seller_domain ON seller_products(seller_id, domain);
CREATE INDEX idx_seller_products_asin ON seller_products(asin_id);
CREATE INDEX idx_seller_products_updated ON seller_products(updated_at);
CREATE INDEX idx_seller_products_sales_rank ON seller_products(sales_rank) WHERE sales_rank IS NOT NULL;
CREATE INDEX idx_seller_products_monthly_sales ON seller_products(monthly_sales) WHERE monthly_sales IS NOT NULL;

-- FUNCTIONS AND TRIGGERS

-- Auto-update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply timestamp trigger to seller_products
CREATE TRIGGER update_seller_products_updated_at 
  BEFORE UPDATE ON seller_products 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS POLICIES

-- Enable RLS on seller_products table
ALTER TABLE seller_products ENABLE ROW LEVEL SECURITY;

-- Seller products policies
CREATE POLICY "Users can view all seller products" ON seller_products
  FOR SELECT USING (true);

CREATE POLICY "Service role can manage seller products" ON seller_products
  FOR ALL USING (auth.role() = 'service_role');

-- HELPER VIEWS

-- Products with seller details view (commonly queried)
CREATE VIEW seller_products_with_details AS
SELECT 
  sp.*,
  s.seller_name,
  s.domain as seller_domain
FROM seller_products sp
JOIN sellers s ON s.id = sp.seller_id;

-- COMMENTS FOR DOCUMENTATION

COMMENT ON TABLE seller_products IS 'Core data table storing individual Amazon products from tracked sellers with Keepa API data';

COMMENT ON COLUMN seller_products.asin_id IS 'Amazon ASIN identifier (B07ABC123 format)';
COMMENT ON COLUMN seller_products.domain IS 'Amazon marketplace: 1=US, 2=UK, 3=DE, etc.'; 