import { netMonthlyIncomeTooLow, storedCibilBand } from './loan-rules';
import { storedEmploymentType } from './personal-loan-employment';

export const CREDIT_CARD_KINDS = ['fd', 'normal'] as const;
export type CreditCardKind = (typeof CREDIT_CARD_KINDS)[number];
export const MIN_FD_CREDIT_AMOUNT = 5000;
export const FD_AMOUNT_MIN_ERROR = 'FD amount must be at least ₹5,000.';

export function storedCreditCardKind(raw?: string | null): CreditCardKind | null {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  return value === 'fd' || value === 'normal' ? value : null;
}

export function creditCardKindLabel(raw?: string | null): string {
  const kind = storedCreditCardKind(raw);
  if (kind === 'fd') return 'FD Credit Card';
  if (kind === 'normal') return 'Normal Credit Card';
  return '';
}

export function creditCardProfileError(dto: {
  category?: string | null;
  creditCardKind?: string | null;
  fdAmount?: number | null;
  cibilBand?: string | null;
  employmentType?: string | null;
  netMonthlyIncome?: number | null;
  hasExistingEmi?: boolean | null;
  totalMonthlyEmi?: number | null;
}): string | null {
  if (String(dto.category ?? '').trim().toLowerCase() !== 'credit_card') return null;
  const kind = storedCreditCardKind(dto.creditCardKind);
  if (!kind) return 'Select FD Credit Card or Normal Credit Card.';
  if (kind === 'fd') {
    const amount = Number(dto.fdAmount);
    if (!Number.isFinite(amount) || amount < 1) return 'Enter FD amount.';
    if (amount < MIN_FD_CREDIT_AMOUNT) return FD_AMOUNT_MIN_ERROR;
  } else if (!storedCibilBand(dto.cibilBand)) {
    return 'Select your CIBIL score.';
  }
  if (!storedEmploymentType(dto.employmentType)) {
    return 'Select salaried or self employee / business.';
  }
  if (netMonthlyIncomeTooLow(dto.netMonthlyIncome, 'personal_loan')) {
    return 'Net monthly income must be at least ₹18,000';
  }
  if (dto.hasExistingEmi !== true && dto.hasExistingEmi !== false) {
    return 'Tell us if a loan EMI is already running.';
  }
  const emi = Number(dto.totalMonthlyEmi);
  if (dto.hasExistingEmi === false) {
    if (Number.isFinite(emi) && emi !== 0) return 'Total monthly EMI is 0 when no EMI is running.';
    return null;
  }
  if (!Number.isFinite(emi) || emi < 1) return 'Enter the total monthly EMI you pay.';
  return null;
}

export function creditCardWorkColumns(dto: {
  employmentType?: string | null;
  netMonthlyIncome?: number | null;
  hasExistingEmi?: boolean | null;
  totalMonthlyEmi?: number | null;
}): {
  employment_type: string | null;
  net_monthly_income: number | null;
  has_existing_emi: boolean | null;
  total_monthly_emi: number | null;
} {
  const income = Number(dto.netMonthlyIncome);
  const noEmi = dto.hasExistingEmi === false;
  const emi = Number(dto.totalMonthlyEmi);
  return {
    employment_type: storedEmploymentType(dto.employmentType),
    net_monthly_income: Number.isFinite(income) && income > 0 ? Math.round(income) : null,
    has_existing_emi: dto.hasExistingEmi === true,
    total_monthly_emi: noEmi ? 0 : Number.isFinite(emi) ? Math.round(emi) : null,
  };
}

export function creditCardLeadColumns(dto: {
  creditCardKind?: string | null;
  fdAmount?: number | null;
  cibilBand?: string | null;
}): { credit_card_kind: CreditCardKind | null; fd_amount: number | null; cibil_band: string | null } {
  const kind = storedCreditCardKind(dto.creditCardKind);
  const amount = Number(dto.fdAmount);
  return {
    credit_card_kind: kind,
    fd_amount:
      kind === 'fd' && Number.isFinite(amount) && amount >= MIN_FD_CREDIT_AMOUNT ? Math.round(amount) : null,
    cibil_band: kind === 'normal' ? storedCibilBand(dto.cibilBand) : null,
  };
}
