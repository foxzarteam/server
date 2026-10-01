import { FALLBACK_INSURANCE_TYPES } from '../catalog/catalog';
import { isApprovedLeadStatus } from '../common/lead-status';
import { LEAD_DRAFT_FULL_NAME, LEAD_DRAFT_PAN } from './lead-draft';

export { isApprovedLeadStatus };

/** Stored category key: lowercase, hyphens folded to underscores. */
export function normalizeStoredCategory(category?: string | null): string {
  const c = String(category ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  return c || 'personal_loan';
}

export function normalizeStoredInsType(
  category: string,
  insType?: string | null,
): string | null {
  if (normalizeStoredCategory(category) !== 'insurance') return null;
  const t = String(insType ?? '')
    .trim()
    .toLowerCase();
  return t || null;
}

export function isDraftLead(lead: Record<string, unknown>): boolean {
  const name = String(lead['full_name'] ?? '')
    .trim()
    .toLowerCase();
  const pan = String(lead['pan'] ?? '')
    .trim()
    .toUpperCase();
  return name === LEAD_DRAFT_FULL_NAME.toLowerCase() || pan === LEAD_DRAFT_PAN;
}

export function categoryLabel(category: unknown): string {
  const c = normalizeStoredCategory(String(category ?? ''));
  if (c === 'personal_loan') return 'Personal Loan';
  if (c === 'insurance') return 'Insurance';
  return c.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function insTypeLabel(insType: unknown): string {
  const t = String(insType ?? '')
    .trim()
    .toLowerCase();
  if (!t) return 'Insurance';
  const found = FALLBACK_INSURANCE_TYPES.find((row) => row.value === t);
  if (found) return found.label;
  if (t === 'motor_insurance') return 'Motor Insurance';
  return t.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/** Personal Loan, or the insurance type label. */
export function productLabel(lead: { category?: unknown; ins_type?: unknown }): string {
  const cat = normalizeStoredCategory(String(lead.category ?? ''));
  if (cat === 'insurance') return insTypeLabel(lead.ins_type);
  return categoryLabel(cat);
}

export function statusLabel(status: unknown): string {
  const s = String(status ?? '')
    .trim()
    .toLowerCase();
  if (s === 'approved') return 'Approved';
  if (s === 'rejected') return 'Not Approved';
  if (s === 'in_process') return 'In Process';
  if (s === 'action_required') return 'Action Required';
  return 'Under Review';
}

export function blockingApplicationMessage(lead: Record<string, unknown>): string {
  const product = productLabel(lead);
  const status = statusLabel(lead.status);
  return `Your ${product} application is already ${status}. You can apply again for this product only after it is Approved.`;
}
