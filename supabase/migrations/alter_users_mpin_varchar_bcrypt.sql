-- public.users.mpin is VARCHAR(4) + check_mpin_format (only 0000–9999).
-- The API stores bcrypt hashes (~60 chars), so Add agent fails.
-- Run once in Supabase → SQL Editor.

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS check_mpin_format;

ALTER TABLE public.users
  ALTER COLUMN mpin TYPE varchar(72)
  USING mpin::varchar(72);
