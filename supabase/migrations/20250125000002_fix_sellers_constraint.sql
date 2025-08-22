-- Fix sellers table constraint issue
-- Migration: 20250125000002_fix_sellers_constraint.sql
-- CRITICAL: This fixes the constraint that prevents same seller on different domains

-- Drop the incorrect unique constraint on seller_id only
ALTER TABLE sellers DROP CONSTRAINT sellers_seller_id_key;

-- Add the correct compound unique constraint
-- This allows same seller_id on different domains, but prevents duplicates within same domain
ALTER TABLE sellers ADD CONSTRAINT sellers_seller_id_domain_key UNIQUE (seller_id, domain);

-- Add comment for documentation
COMMENT ON CONSTRAINT sellers_seller_id_domain_key ON sellers IS 'Ensures same seller can exist on different Amazon marketplaces, but prevents duplicates within same marketplace'; 