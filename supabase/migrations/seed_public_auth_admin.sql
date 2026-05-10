-- Run in Supabase → SQL Editor (once `public.auth` exists and is empty or you want this row).
-- Login (dev prefill in az_web .env.local matches these):
--   Email:    info@apnizaroorat.com
--   Password: Admin@123
--
-- Hash is bcrypt cost 10, compatible with server/src/auth (bcryptjs).
-- To change password: in project server/ folder run:
--   node -e "console.log(require('bcryptjs').hashSync('YourNewPassword', 10))"
-- then UPDATE public.auth SET password = '<hash>' WHERE email = 'info@apnizaroorat.com';

INSERT INTO public.auth (full_name, email, password, role)
VALUES (
  'Site Admin',
  'info@apnizaroorat.com',
  '$2b$10$mr6XVmpEdDZsB7AarRL.1eJKcIpSvsXjYzFL3dbyrczYOHKzj3w16',
  'admin'
)
ON CONFLICT (email) DO UPDATE SET
  full_name = EXCLUDED.full_name,
  password = EXCLUDED.password,
  role = EXCLUDED.role;
