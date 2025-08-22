-- Time Machine tables migration
-- Extracted from staging environment (nlydrzszwijdbuzgnxzp)
-- Migration: 20250125000001_create_time_machine_tables.sql

-- 1. Create sellers table
CREATE TABLE sellers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    seller_id TEXT NOT NULL,
    seller_name TEXT,
    domain INTEGER NOT NULL,
    initial_asin_list TEXT[],
    asin_count INTEGER DEFAULT 0,
    last_checked_at TIMESTAMP WITH TIME ZONE,
    created_by UUID REFERENCES auth.users(id) ON DELETE CASCADE
);

-- 2. Create seller_queries table
CREATE TABLE seller_queries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    seller_id UUID REFERENCES sellers(id) ON DELETE CASCADE,
    query_input TEXT NOT NULL,
    found_seller BOOLEAN DEFAULT false,
    error_message TEXT,
    queried_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    domain INTEGER
);

-- 3. Create user_sellers table  
CREATE TABLE user_sellers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    is_active BOOLEAN DEFAULT true,
    notification_preferences JSONB DEFAULT '{}'::jsonb,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 4. Create seller_products table
CREATE TABLE seller_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    asin VARCHAR(10) NOT NULL,
    title TEXT,
    current_price NUMERIC(10,2),
    sales_rank INTEGER,
    first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Add constraints
ALTER TABLE sellers ADD CONSTRAINT sellers_seller_id_key UNIQUE (seller_id);
ALTER TABLE user_sellers ADD CONSTRAINT user_sellers_user_id_seller_id_key UNIQUE (user_id, seller_id);
ALTER TABLE seller_products ADD CONSTRAINT seller_products_seller_id_asin_key UNIQUE (seller_id, asin);

-- Add indexes for performance
CREATE INDEX idx_sellers_created_by ON sellers(created_by);
CREATE INDEX idx_sellers_domain ON sellers(domain);
CREATE INDEX idx_sellers_last_checked ON sellers(last_checked_at);
CREATE INDEX idx_sellers_seller_id ON sellers(seller_id);

CREATE INDEX idx_seller_queries_domain ON seller_queries(domain);
CREATE INDEX idx_seller_queries_queried_at ON seller_queries(queried_at);
CREATE INDEX idx_seller_queries_seller_id ON seller_queries(seller_id);
CREATE INDEX idx_seller_queries_user_id ON seller_queries(user_id);

CREATE INDEX idx_user_sellers_is_active ON user_sellers(is_active);
CREATE INDEX idx_user_sellers_seller_id ON user_sellers(seller_id);
CREATE INDEX idx_user_sellers_user_id ON user_sellers(user_id);

CREATE INDEX idx_seller_products_asin ON seller_products(asin);
CREATE INDEX idx_seller_products_first_seen ON seller_products(first_seen_at);
CREATE INDEX idx_seller_products_seller_id ON seller_products(seller_id);

-- Enable RLS on all tables
ALTER TABLE sellers ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sellers ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_products ENABLE ROW LEVEL SECURITY;

-- RLS Policies for sellers table
CREATE POLICY "Authenticated users can view all sellers" ON sellers
    FOR SELECT USING (auth.role() = 'authenticated'::text);

CREATE POLICY "Users can create sellers" ON sellers
    FOR INSERT WITH CHECK (created_by = auth.uid());

CREATE POLICY "Users can update sellers they created" ON sellers
    FOR UPDATE USING (created_by = auth.uid());

-- RLS Policies for seller_queries table
CREATE POLICY "Users can view their own queries" ON seller_queries
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users can create their own queries" ON seller_queries
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- RLS Policies for user_sellers table
CREATE POLICY "Users can view their own monitoring" ON user_sellers
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users can create their own monitoring" ON user_sellers
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own monitoring" ON user_sellers
    FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY "Users can delete their own monitoring" ON user_sellers
    FOR DELETE USING (user_id = auth.uid());

-- RLS Policies for seller_products table
CREATE POLICY "Users can view products from monitored sellers" ON seller_products
    FOR SELECT USING (
        seller_id IN (
            SELECT user_sellers.seller_id
            FROM user_sellers
            WHERE user_sellers.user_id = auth.uid()
            UNION
            SELECT sellers.id
            FROM sellers
            WHERE sellers.created_by = auth.uid()
        )
    );

-- Add comments for documentation
COMMENT ON TABLE sellers IS 'Core seller data from Time Machine feature';
COMMENT ON TABLE seller_queries IS 'Search history tracking for seller lookups';
COMMENT ON TABLE user_sellers IS 'User monitoring preferences for sellers';
COMMENT ON TABLE seller_products IS 'Discovered products from monitored sellers';
COMMENT ON COLUMN seller_queries.domain IS 'Keepa marketplace domain ID (1=amazon.com, 2=amazon.co.uk, etc.) - tracks which marketplace user searched'; 