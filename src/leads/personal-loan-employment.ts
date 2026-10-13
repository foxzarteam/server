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

/** Loan apply: income and salaried / self-employed business are both required. */
export function personalLoanEmploymentError(dto: {
  netMonthlyIncome?: number | null;
  employmentType?: string | null;
}): string | null {
  const income = dto.netMonthlyIncome;
  if (income == null || !Number.isFinite(Number(income)) || Number(income) < 1) {
    return 'Net monthly income is required.';
  }
  if (!storedEmploymentType(dto.employmentType)) {
    return 'Select salaried or self employee / business.';
  }
  return null;
}

export function storedEmploymentType(raw?: string | null): 'salaried' | 'self_employed' | null {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (v === 'salaried') return 'salaried';
  if (v === 'self_employed' || v === 'selfemployed') return 'self_employed';
  return null;
}
