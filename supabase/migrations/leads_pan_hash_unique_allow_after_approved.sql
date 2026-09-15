-- Allow a new application for the same PAN + category after the prior one is approved.
-- Still blocks a second open (non-approved) active lead for the same PAN + category.

DROP INDEX IF EXISTS public.leads_pan_hash_category_active_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS leads_pan_hash_category_open_uidx
  ON public.leads (pan_hash, category)
  WHERE is_active IS TRUE
    AND pan_hash IS NOT NULL
    AND pan_hash <> ''
    AND lower(COALESCE(status, 'pending')) <> 'approved';

COMMENT ON INDEX public.leads_pan_hash_category_open_uidx IS
  'One open (non-approved) active application per PAN per category; approved leads may be followed by a new apply.';
