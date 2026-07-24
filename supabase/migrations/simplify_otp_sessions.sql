-- Simplify otp_sessions: one row per OTP send; track verified + date only.
-- Removes otp_code / expires_at / attempts / max_attempts (Firebase handles the code).

alter table public.otp_sessions drop constraint if exists check_otp_format;

drop index if exists idx_otp_expires_at;

alter table public.otp_sessions drop column if exists otp_code;
alter table public.otp_sessions drop column if exists expires_at;
alter table public.otp_sessions drop column if exists attempts;
alter table public.otp_sessions drop column if exists max_attempts;

alter table public.otp_sessions
  alter column is_verified set default false;

alter table public.otp_sessions
  alter column created_at set default now();

comment on table public.otp_sessions is
  'One row per OTP send attempt. Count rows for rate limit; set is_verified on success.';
