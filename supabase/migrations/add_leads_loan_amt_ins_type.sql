-- Add loan amount range and insurance type columns to leads table.

alter table public.leads
  add column if not exists loan_amt character varying(50) null,
  add column if not exists ins_type character varying(50) null;

alter table public.leads
  drop constraint if exists leads_loan_amt_check;

alter table public.leads
  add constraint leads_loan_amt_check check (
    loan_amt is null
    or loan_amt in (
      '25000_100000',
      '100000_200000',
      '200000_300000',
      '300000_400000',
      '400000_500000'
    )
  );

alter table public.leads
  drop constraint if exists leads_ins_type_check;

alter table public.leads
  add constraint leads_ins_type_check check (
    ins_type is null
    or ins_type in (
      'life_insurance',
      'health_insurance',
      'motor_insurance'
    )
  );

create index if not exists idx_leads_loan_amt on public.leads using btree (loan_amt);

create index if not exists idx_leads_ins_type on public.leads using btree (ins_type);
