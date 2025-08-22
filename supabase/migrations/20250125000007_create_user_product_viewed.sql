-- Add user_product_viewed table for tracking product views
-- Migration: 20250125000007_create_user_product_viewed.sql

CREATE TABLE user_product_viewed (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    asin_id VARCHAR(20) NOT NULL,
    seller_id UUID REFERENCES sellers(id) ON DELETE CASCADE,
    domain INTEGER NOT NULL,
    viewed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Optional metadata
    product_title TEXT,
    view_source TEXT DEFAULT 'product_list', -- 'product_list', 'search', etc.
    
    -- Audit fields
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_user_product_viewed_user_id ON user_product_viewed(user_id);
CREATE INDEX idx_user_product_viewed_asin ON user_product_viewed(asin_id);
CREATE INDEX idx_user_product_viewed_viewed_at ON user_product_viewed(viewed_at);
CREATE INDEX idx_user_product_viewed_user_asin ON user_product_viewed(user_id, asin_id);

-- Enable RLS
ALTER TABLE user_product_viewed ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view their own product views" ON user_product_viewed
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users can create their own product views" ON user_product_viewed
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- Comments
COMMENT ON TABLE user_product_viewed IS 'Tracks when users view/click on products for analytics and recommendations';
COMMENT ON COLUMN user_product_viewed.view_source IS 'Source of the view: product_list, search, recommendation, etc.'; 