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

/** Personal-loan income check. Employment type is collected only in the chatbots. */
export function personalLoanEmploymentError(dto: {
  netMonthlyIncome?: number | null;
}): string | null {
  const income = dto.netMonthlyIncome;
  if (income == null || !Number.isFinite(Number(income)) || Number(income) < 1) {
    return 'Net monthly income is required for personal loan.';
  }
  return null;
}
