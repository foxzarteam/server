-- Allow same PAN across different product categories (e.g. personal_loan + insurance).
-- Still one active lead per (PAN, category).

DROP INDEX IF EXISTS public.leads_pan_hash_active_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS leads_pan_hash_category_active_uidx
  ON public.leads (pan_hash, category)
  WHERE is_active IS TRUE
    AND pan_hash IS NOT NULL
    AND pan_hash <> '';

COMMENT ON INDEX public.leads_pan_hash_category_active_uidx IS
  'One active application per PAN per category; same PAN may apply for personal_loan and insurance.';
