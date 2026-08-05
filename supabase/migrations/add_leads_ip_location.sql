-- Geo place label resolved from leads.ip at apply time (best-effort).

alter table public.leads
  add column if not exists ip_location character varying(255) null;

comment on column public.leads.ip_location is
  'Best-effort city/region/country resolved from client IP when the lead was saved.';
