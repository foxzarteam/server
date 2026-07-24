-- OTP status lives in otp_sessions (by mobile). Drop duplicate column on leads.
alter table public.leads drop constraint if exists leads_otp_verify_check;
drop index if exists idx_leads_otp_verify;
alter table public.leads drop column if exists otp_verify;
