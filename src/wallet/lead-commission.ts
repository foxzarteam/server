/** Admin-chosen commission when a lead is approved. */

const PERCENT_MIN = 0.1;
const PERCENT_MAX = 10;
const FIXED_MIN = 100;
const FIXED_MAX = 30000;

export function commissionInputError(input: {
  category: string;
  loanAmount: number;
  type: unknown;
  value: unknown;
}): string | null {
  const type = String(input.type ?? '').trim().toLowerCase();
  const category = String(input.category ?? '').trim().toLowerCase().replace(/-/g, '_');
  const value = Number(input.value);
  if (category === 'insurance') {
    if (type !== 'fixed') return 'Insurance commission is a fixed amount';
    if (!Number.isFinite(value) || value < FIXED_MIN || value > FIXED_MAX) {
      return 'Enter a fixed amount from ₹100 to ₹30,000';
    }
    return null;
  }
  if (type !== 'percentage') return 'Personal loan commission is a percentage';
  if (!Number.isFinite(value) || value < PERCENT_MIN || value > PERCENT_MAX) {
    return 'Enter a percentage from 0.1 to 10';
  }
  if (!(input.loanAmount > 0)) {
    return 'Enter the loan amount before setting a percentage';
  }
  return null;
}
