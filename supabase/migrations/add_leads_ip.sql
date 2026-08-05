-- Applicant device/network IP when form is submitted (from Nest trust-proxy headers).
-- IPv4 and IPv6 fit in 45 chars.

alter table public.leads
  add column if not exists ip character varying(45) null;

comment on column public.leads.ip is
  'Client IP at lead apply/start/complete time (from X-Forwarded-For / request).';

create index if not exists idx_leads_ip
  on public.leads using btree (ip);
