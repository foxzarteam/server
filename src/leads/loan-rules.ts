/**
 * The only loan eligibility rules. The website and the API both import this file.
 * Change a limit or a sentence here, and both sides follow it.
 */

export const MIN_NET_MONTHLY_INCOME = 18000;
export const CIBIL_REPORT_MAX_BYTES = 200 * 1024 * 1024;

export const CIBIL_BANDS = ['above_680', 'below_680', 'unknown'] as const;
export type CibilBand = (typeof CIBIL_BANDS)[number];

export const MSG_NET_INCOME_MIN = 'Net monthly income must be at least ₹18,000';
export const MSG_CIBIL_BELOW =
  'Sorry, you are not eligible for this loan. A CIBIL score below 680 does not meet the current criteria.';
export const MSG_EMI_HALF =
  'Sorry, you are not eligible for this loan. Your existing EMI is half or more of your net monthly income.';

export function storedCibilBand(raw?: string | null): CibilBand | null {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'above_680' || v === 'below_680' || v === 'unknown') return v;
  return null;
}

export function netMonthlyIncomeTooLow(income: number | null | undefined): boolean {
  return income == null || !Number.isFinite(Number(income)) || Number(income) < MIN_NET_MONTHLY_INCOME;
}

/**
 * Reject when CIBIL is below 680, or existing EMI is half or more of net income.
 * A missing or non-positive income is a field error, not this popup.
 */
export function loanNotEligibleMessage(dto: {
  netMonthlyIncome?: number | null;
  cibilBand?: string | null;
  hasExistingEmi?: boolean | null;
  totalMonthlyEmi?: number | null;
}): string | null {
  const income = Number(dto.netMonthlyIncome);
  if (!Number.isFinite(income) || income <= 0) return null;
  if (storedCibilBand(dto.cibilBand) === 'below_680') return MSG_CIBIL_BELOW;
  const emi = Number(dto.totalMonthlyEmi);
  if (dto.hasExistingEmi === true && Number.isFinite(emi) && emi * 2 >= income) return MSG_EMI_HALF;
  return null;
}
