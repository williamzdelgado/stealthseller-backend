-- Function to get unique recent seller queries using DISTINCT ON
-- This eliminates duplicate query_input entries at the database level
-- Reduces data transfer from ~200 rows to ~20 unique rows (90% improvement)

CREATE OR REPLACE FUNCTION get_unique_recent_seller_queries(
  user_id_param UUID,
  limit_param INTEGER DEFAULT 20
)
RETURNS TABLE(
  id UUID,
  query_input TEXT,
  queried_at TIMESTAMP WITH TIME ZONE,
  seller_id UUID,
  user_id UUID,
  seller_name TEXT
) 
LANGUAGE SQL
STABLE
AS $$
  SELECT DISTINCT ON (sq.query_input)
    sq.id,
    sq.query_input,
    sq.queried_at,
    sq.seller_id,
    sq.user_id,
    s.seller_name
  FROM seller_queries sq
  LEFT JOIN sellers s ON sq.seller_id = s.id
  WHERE sq.user_id = user_id_param 
    AND sq.found_seller = true
  ORDER BY sq.query_input, sq.queried_at DESC
  LIMIT limit_param;
$$;

-- Add helpful comment
COMMENT ON FUNCTION get_unique_recent_seller_queries IS 'Returns unique seller queries (by query_input) for a user, with most recent entry per unique input. Eliminates client-side deduplication.';