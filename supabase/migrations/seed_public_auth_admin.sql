-- Run in Supabase → SQL Editor (once `public.auth` exists).
-- Matches az_web admin login prefill:
--   Email:    info@apnizaroorat.com
--   Password: admin@123
--
-- Hash is bcrypt cost 10 (bcryptjs). Plain text in `password` also works for login but is not recommended.
-- New hash: in server/ run:
--   node -e "console.log(require('bcryptjs').hashSync('YourNewPassword', 10))"
-- then UPDATE public.auth SET password = '<hash>' WHERE email = 'info@apnizaroorat.com';

INSERT INTO public.auth (full_name, email, password, role)
VALUES (
  'Site Admin',
  'info@apnizaroorat.com',
  '$2b$10$Q5u2OtodPLtViOkCx2MgbOozGzdJS7x9K78kdn6Vql.8wTD6inSte',
  'admin'
)
ON CONFLICT (email) DO UPDATE SET
  full_name = EXCLUDED.full_name,
  password = EXCLUDED.password,
  role = EXCLUDED.role;
