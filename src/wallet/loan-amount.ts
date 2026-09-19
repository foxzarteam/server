/** Personal-loan amount for commission: exact rupees, else midpoint of loan_amt range. */

export const CODE_LOAN_AMOUNT_REQUIRED = 'LOAN_AMOUNT_REQUIRED';

export const MSG_LOAN_AMOUNT_REQUIRED =
  'Set a loan amount before approving this personal loan. Commission cannot be ₹0.';

function roundMoney(n: number): number {
  return Math.round(Math.max(0, n) * 100) / 100;
}

/** Midpoint of `25000_100000`-style range keys. */
export function amountFromLoanAmtRange(loanAmt: unknown): number {
  const key = String(loanAmt ?? '').trim();
  if (!key) return 0;
  const m = key.match(/^(\d+)_(\d+)$/);
  if (!m) return 0;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= 0) return 0;
  return roundMoney((lo + hi) / 2);
}

export function leadLoanAmount(lead: {
  required_amount?: unknown;
  loan_amt?: unknown;
}): number {
  const exact = Number(lead.required_amount);
  if (Number.isFinite(exact) && exact > 0) return exact;
  return amountFromLoanAmtRange(lead.loan_amt);
}

/** Persist an exact amount when the client only sent a range. */
export function resolvePersonalLoanAmounts(input: {
  requiredAmount?: number | null;
  loanAmt?: string | null;
}): { requiredAmount: number | null; loanAmt: string | null } {
  const loanAmt = input.loanAmt != null && String(input.loanAmt).trim() !== ''
    ? String(input.loanAmt).trim()
    : null;
  const exact = Number(input.requiredAmount);
  if (Number.isFinite(exact) && exact > 0) {
    return { requiredAmount: Math.round(exact), loanAmt };
  }
  const fromRange = amountFromLoanAmtRange(loanAmt);
  if (fromRange > 0) {
    return { requiredAmount: fromRange, loanAmt };
  }
  return { requiredAmount: null, loanAmt };
}
