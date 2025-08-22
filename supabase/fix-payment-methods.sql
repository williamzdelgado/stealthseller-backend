-- Add a unique constraint on payment_methods.user_id if it doesn't already exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'payment_methods_user_id_key' 
    AND conrelid = 'public.payment_methods'::regclass
  ) THEN
    ALTER TABLE public.payment_methods ADD CONSTRAINT payment_methods_user_id_key UNIQUE (user_id);
    RAISE NOTICE 'Unique constraint added to payment_methods.user_id';
  ELSE
    RAISE NOTICE 'Unique constraint already exists on payment_methods.user_id';
  END IF;
END
$$; 