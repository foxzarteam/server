-- Secure PAN at rest: ciphertext + lookup hash; `pan` column holds masked display only.
-- Audit every reveal / partner send.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS pan_encrypted text,
  ADD COLUMN IF NOT EXISTS pan_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS leads_pan_hash_active_uidx
  ON public.leads (pan_hash)
  WHERE is_active IS TRUE
    AND pan_hash IS NOT NULL
    AND pan_hash <> '';

COMMENT ON COLUMN public.leads.pan IS 'Masked PAN for display only (e.g. ABCDE****F). Never store plaintext.';
COMMENT ON COLUMN public.leads.pan_encrypted IS 'AES-256-GCM ciphertext (v1:iv:tag:ct).';
COMMENT ON COLUMN public.leads.pan_hash IS 'HMAC-SHA256 for duplicate detection / lookup. Not reversible.';

CREATE TABLE IF NOT EXISTS public.pan_access_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN (
    'reveal',
    'partner_send',
    'create',
    'update',
    'decrypt_failed'
  )),
  admin_id text,
  admin_email text,
  admin_role text,
  partner_id text,
  partner_name text,
  ip_address text,
  user_agent text,
  reason text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pan_access_audit_lead_id_idx
  ON public.pan_access_audit (lead_id, created_at DESC);

CREATE INDEX IF NOT EXISTS pan_access_audit_admin_email_idx
  ON public.pan_access_audit (admin_email, created_at DESC);

COMMENT ON TABLE public.pan_access_audit IS 'Immutable audit of PAN reveal and partner-send events.';
