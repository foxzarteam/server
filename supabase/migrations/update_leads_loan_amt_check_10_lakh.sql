-- Extend personal loan amount ranges up to ₹10 Lakhs (1 lakh steps).

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
      '400000_500000',
      '500000_600000',
      '600000_700000',
      '700000_800000',
      '800000_900000',
      '900000_1000000'
    )
  );
