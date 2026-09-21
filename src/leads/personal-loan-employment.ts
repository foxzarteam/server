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

/** Pure personal-loan employment / income check (DTO + service defense). */
export function personalLoanEmploymentError(dto: {
  employmentType?: string | null;
  netMonthlyIncome?: number | null;
}): string | null {
  const emp = String(dto.employmentType ?? '').trim();
  if (emp !== 'salaried' && emp !== 'self_employed') {
    return 'Employment type is required for personal loan.';
  }
  const income = dto.netMonthlyIncome;
  if (income == null || !Number.isFinite(Number(income)) || Number(income) < 1) {
    return 'Net monthly income is required for personal loan.';
  }
  return null;
}
