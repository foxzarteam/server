-- Unique open application per PAN + product:
-- - personal_loan (ins_type empty)
-- - insurance + life_insurance / health_insurance / motor_insurance separately
-- Approved leads do not block a new apply for the same product.

DROP INDEX IF EXISTS public.leads_pan_hash_category_active_uidx;
DROP INDEX IF EXISTS public.leads_pan_hash_category_open_uidx;
DROP INDEX IF EXISTS public.leads_pan_hash_product_open_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS leads_pan_hash_product_open_uidx
  ON public.leads (pan_hash, category, (COALESCE(ins_type, '')))
  WHERE is_active IS TRUE
    AND pan_hash IS NOT NULL
    AND pan_hash <> ''
    AND lower(COALESCE(status, 'pending')) <> 'approved';

COMMENT ON INDEX public.leads_pan_hash_product_open_uidx IS
  'One open (non-approved) active lead per PAN per product; insurance subtypes (life/health/motor) are separate; approved may be re-applied.';
