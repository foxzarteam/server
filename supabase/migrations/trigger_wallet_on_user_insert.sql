-- Wallet row auto-create when a user is inserted in public.users
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor). No server code needed.

CREATE OR REPLACE FUNCTION public.create_wallet_on_user_insert()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.wallet (user_id, earning, redeem, balance, currency)
  VALUES (NEW.id::text, 0, 0, 0, 'INR')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_user_created_wallet ON public.users;
CREATE TRIGGER on_user_created_wallet
  AFTER INSERT ON public.users
  FOR EACH ROW
  EXECUTE PROCEDURE public.create_wallet_on_user_insert();
