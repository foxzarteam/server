import {
  incomeMinMessage,
  isVehicleLoanCategory,
  netMonthlyIncomeTooLow,
  selectableCibilBands,
  storedCibilBand,
} from './loan-rules';

export {
  CIBIL_BANDS,
  MIN_NET_MONTHLY_INCOME,
  loanNotEligibleMessage,
  storedCibilBand,
  type CibilBand,
} from './loan-rules';

/** Applicant name: letters, spaces, dots. Matches website forms. */
export const LEAD_FULL_NAME_REGEX = /^[A-Za-z][A-Za-z\s.]{1,253}$/;

export function leadFullNameError(name?: string | null): string | null {
  const n = String(name ?? '').trim();
  if (n.length < 2) return 'Full name is required.';
  if (!LEAD_FULL_NAME_REGEX.test(n)) {
    return 'Name should not contain special characters or numbers.';
  }
  return null;
}

/** Stored employment. Old rows stay `salaried`. */
export const STORED_EMPLOYMENT_TYPES = [
  'salaried',
  'salaried_bank',
  'salaried_cash',
  'self_employed',
] as const;

export type StoredEmployment = (typeof STORED_EMPLOYMENT_TYPES)[number];

/** Loan apply: income is required. Employment type is optional. */
export function personalLoanEmploymentError(dto: {
  category?: string | null;
  netMonthlyIncome?: number | null;
  employmentType?: string | null;
}): string | null {
  if (netMonthlyIncomeTooLow(dto.netMonthlyIncome, dto.category)) return incomeMinMessage(dto.category);
  const employment = String(dto.employmentType ?? '').trim();
  if (employment && !storedEmploymentType(employment)) {
    return 'Select salaried or self employee / business.';
  }
  return null;
}

export function storedEmploymentType(raw?: string | null): StoredEmployment | null {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (v === 'salaried' || v === 'salaried_bank' || v === 'salaried_cash' || v === 'self_employed') {
    return v;
  }
  if (v === 'selfemployed') return 'self_employed';
  return null;
}

/** WhatsApp KYC lists: bank and cash salary both use the salaried document list. */
export function kycEmploymentBucket(raw?: string | null): 'salaried' | 'self_employed' | null {
  const stored = storedEmploymentType(raw);
  if (!stored) return null;
  return stored === 'self_employed' ? 'self_employed' : 'salaried';
}

/** CIBIL band and existing EMI. The report file itself is optional. */
export function loanProfileError(dto: {
  category?: string | null;
  cibilBand?: string | null;
  hasExistingEmi?: boolean | null;
  totalMonthlyEmi?: number | null;
}): string | null {
  const band = storedCibilBand(dto.cibilBand);
  if (!band) return 'Select your CIBIL score.';
  if (isVehicleLoanCategory(dto.category)) return null;
  if (!selectableCibilBands(dto.category).includes(band)) {
    return 'Select your CIBIL score.';
  }
  if (dto.hasExistingEmi !== true && dto.hasExistingEmi !== false) {
    return 'Tell us if a loan EMI is already running.';
  }
  const emi = Number(dto.totalMonthlyEmi);
  if (dto.hasExistingEmi === false) {
    if (emi !== 0) return 'Total monthly EMI is 0 when no EMI is running.';
    return null;
  }
  if (!Number.isFinite(emi) || emi < 1) return 'Enter the total monthly EMI you pay.';
  return null;
}
