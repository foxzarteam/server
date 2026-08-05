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
