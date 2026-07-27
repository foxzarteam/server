-- Employment type + net monthly income for personal loan leads.

alter table public.leads
  add column if not exists employment_type character varying(30) null,
  add column if not exists net_monthly_income numeric(12, 0) null;

alter table public.leads
  drop constraint if exists leads_employment_type_check;

alter table public.leads
  add constraint leads_employment_type_check check (
    employment_type is null
    or employment_type in ('salaried', 'self_employed')
  );

alter table public.leads
  drop constraint if exists leads_net_monthly_income_check;

alter table public.leads
  add constraint leads_net_monthly_income_check check (
    net_monthly_income is null
    or net_monthly_income >= 0
  );

create index if not exists idx_leads_employment_type
  on public.leads using btree (employment_type);
