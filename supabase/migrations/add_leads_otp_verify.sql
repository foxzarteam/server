-- Add OTP verification flag on leads (0 = pending OTP, 1 = verified)
alter table public.leads
  add column if not exists otp_verify smallint not null default 0;

alter table public.leads
  drop constraint if exists leads_otp_verify_check;

alter table public.leads
  add constraint leads_otp_verify_check check (otp_verify in (0, 1));

create index if not exists idx_leads_otp_verify on public.leads using btree (otp_verify);

comment on column public.leads.otp_verify is '0 = OTP not verified, 1 = OTP verified';
