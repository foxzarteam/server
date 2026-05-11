-- Run once in Supabase → SQL Editor (project where `public.auth` lives).
-- Fixes: RLS hiding rows / policies blocking PostgREST reads used by Nest (service_role).
-- Nest must use the service_role key (Settings → API), not anon.

-- 1) Turn off RLS on admin credentials table (protect access via API key + app logic).
ALTER TABLE IF EXISTS public.auth DISABLE ROW LEVEL SECURITY;

-- 2) Drop every policy on public.auth (safe if none exist).
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'auth'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.auth', pol.policyname);
  END LOOP;
END $$;

-- 3) Tighten grants: only postgres + service_role (Supabase REST with service_role JWT uses this).
REVOKE ALL ON TABLE public.auth FROM PUBLIC;
REVOKE ALL ON TABLE public.auth FROM anon;
REVOKE ALL ON TABLE public.auth FROM authenticated;

GRANT ALL ON TABLE public.auth TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.auth TO service_role;

-- If you intentionally need anon/authenticated to read this table (not recommended), uncomment:
-- GRANT SELECT ON TABLE public.auth TO anon, authenticated;
