-- Affiliate: unique agent share code + lead attribution.
-- Run once in Supabase → SQL Editor.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS referral_code varchar(12);

CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_key
  ON public.users (referral_code)
  WHERE referral_code IS NOT NULL;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES public.users (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leads_agent_id
  ON public.leads (agent_id)
  WHERE agent_id IS NOT NULL;

-- Backfill codes for existing agents (8-char, no 0/O/1/I).
UPDATE public.users u
SET referral_code = upper(substr(replace(u.id::text, '-', ''), 1, 8))
WHERE u.referral_code IS NULL;
