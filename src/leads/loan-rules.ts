/**
 * The only loan eligibility rules. The website imports this file.
 * Change a limit or a sentence here, and both sides follow it.
 */

export const MIN_NET_MONTHLY_INCOME = 18000;
export const MIN_VEHICLE_NET_MONTHLY_INCOME = 10000;

export const CIBIL_BANDS = ['above_680', 'below_680', 'unknown', 'above_650', 'below_650'] as const;
export type CibilBand = (typeof CIBIL_BANDS)[number];

/** Bands the public and staff forms may select. Vehicle uses the 650 set. */
export const SELECTABLE_CIBIL_BANDS = ['above_680', 'below_680', 'unknown'] as const;
export const SELECTABLE_VEHICLE_CIBIL_BANDS = ['above_650', 'below_650', 'unknown'] as const;

export const MSG_NET_INCOME_MIN = 'Net monthly income must be at least ₹18,000';
export const MSG_VEHICLE_NET_INCOME_MIN = 'Net monthly income must be at least ₹10,000';
export const MSG_CIBIL_BELOW =
  'Sorry, you are not eligible for this loan. A CIBIL score below 680 does not meet the current criteria.';
export const MSG_CIBIL_BELOW_650 =
  'Sorry, you are not eligible for this loan. A CIBIL score below 650 does not meet the current criteria.';
export const MSG_EMI_HALF =
  'Sorry, you are not eligible for this loan. Your existing EMI is half or more of your net monthly income.';

export function isVehicleLoanCategory(category?: string | null): boolean {
  const value = String(category ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  return value === 'vehicle_loan' || value === 'car_loan';
}

export function selectableCibilBands(category?: string | null): readonly CibilBand[] {
  return isVehicleLoanCategory(category) ? SELECTABLE_VEHICLE_CIBIL_BANDS : SELECTABLE_CIBIL_BANDS;
}

export function incomeFloor(category?: string | null): number {
  return isVehicleLoanCategory(category) ? MIN_VEHICLE_NET_MONTHLY_INCOME : MIN_NET_MONTHLY_INCOME;
}

export function incomeMinMessage(category?: string | null): string {
  return isVehicleLoanCategory(category) ? MSG_VEHICLE_NET_INCOME_MIN : MSG_NET_INCOME_MIN;
}

export function storedCibilBand(raw?: string | null): CibilBand | null {
  const v = String(raw ?? '').trim().toLowerCase();
  if (
    v === 'above_680' ||
    v === 'below_680' ||
    v === 'unknown' ||
    v === 'above_650' ||
    v === 'below_650'
  ) {
    return v;
  }
  return null;
}

export function netMonthlyIncomeTooLow(income: number | null | undefined, category?: string | null): boolean {
  return income == null || !Number.isFinite(Number(income)) || Number(income) < incomeFloor(category);
}

/**
 * Other loans: reject CIBIL below 680, or existing EMI that is half or more of net income.
 * Vehicle loan: reject only when the applicant says CIBIL is below 650. No EMI rule.
 * A missing or non-positive income is a field error, not this popup.
 */
export function loanNotEligibleMessage(dto: {
  category?: string | null;
  netMonthlyIncome?: number | null;
  cibilBand?: string | null;
  hasExistingEmi?: boolean | null;
  totalMonthlyEmi?: number | null;
}): string | null {
  const income = Number(dto.netMonthlyIncome);
  if (!Number.isFinite(income) || income <= 0) return null;
  const band = storedCibilBand(dto.cibilBand);
  if (isVehicleLoanCategory(dto.category)) {
    if (band === 'below_650') return MSG_CIBIL_BELOW_650;
    return null;
  }
  if (band === 'below_680' || band === 'below_650') return MSG_CIBIL_BELOW;
  const emi = Number(dto.totalMonthlyEmi);
  if (dto.hasExistingEmi === true && Number.isFinite(emi) && emi * 2 >= income) return MSG_EMI_HALF;
  return null;
}
