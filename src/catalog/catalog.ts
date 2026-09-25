/** Shared catalog helpers — insurance subtypes + service slug → lead category. */

export const INS_TYPE_SLUG_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export type InsuranceTypePublic = {
  value: string;
  label: string;
};

/** Used when `insurance_types` is missing or empty so apply forms still work. */
export const FALLBACK_INSURANCE_TYPES: InsuranceTypePublic[] = [
  { value: 'life_insurance', label: 'Life Insurance' },
  { value: 'health_insurance', label: 'Health Insurance' },
  { value: 'motor_insurance', label: 'Motor Insurance' },
  { value: 'cyber_insurance', label: 'Cyber Insurance' },
];

export function slugToLeadCategory(slug: string): string {
  const s = slug.trim().toLowerCase();
  if (!s) return 'personal_loan';
  return s.replace(/-/g, '_');
}

export function isInsTypeSlug(value: string): boolean {
  return INS_TYPE_SLUG_PATTERN.test(value.trim().toLowerCase());
}
