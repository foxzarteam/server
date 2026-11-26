import { storedCibilBand } from './loan-rules';

export const CREDIT_CARD_KINDS = ['fd', 'normal'] as const;
export type CreditCardKind = (typeof CREDIT_CARD_KINDS)[number];

export function storedCreditCardKind(raw?: string | null): CreditCardKind | null {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  return value === 'fd' || value === 'normal' ? value : null;
}

export function creditCardProfileError(dto: {
  category?: string | null;
  creditCardKind?: string | null;
  fdAmount?: number | null;
  cibilBand?: string | null;
}): string | null {
  if (String(dto.category ?? '').trim().toLowerCase() !== 'credit_card') return null;
  const kind = storedCreditCardKind(dto.creditCardKind);
  if (!kind) return 'Select FD Credit Card or Normal Credit Card.';
  if (kind === 'fd') {
    const amount = Number(dto.fdAmount);
    if (!Number.isFinite(amount) || amount < 1) return 'Enter FD amount.';
    return null;
  }
  if (!storedCibilBand(dto.cibilBand)) return 'Select your CIBIL score.';
  return null;
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
    fd_amount: kind === 'fd' && Number.isFinite(amount) && amount >= 1 ? Math.round(amount) : null,
    cibil_band: kind === 'normal' ? storedCibilBand(dto.cibilBand) : null,
  };
}
