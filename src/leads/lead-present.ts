import { FALLBACK_INSURANCE_TYPES } from '../catalog/catalog';
import { isApprovedLeadStatus } from '../common/lead-status';
import { LEAD_DRAFT_FULL_NAME, LEAD_DRAFT_PAN } from './lead-draft';

export { isApprovedLeadStatus };

/** Stored category key: lowercase, hyphens folded to underscores. */
export function categoryLookupKeys(category?: string | null): string[] {
  const c = normalizeStoredCategory(category);
  if (c === 'vehicle_loan' || c === 'car_loan') return ['vehicle_loan', 'car_loan'];
  return [c];
}

export function insTypeLookupKeys(insType?: string | null): string[] {
  const t = String(insType ?? '').trim().toLowerCase();
  if (t === 'vehicle_insurance' || t === 'car_insurance') return ['vehicle_insurance', 'car_insurance'];
  if (t === 'third_party_pvt_vehicle_insurance' || t === 'third_party_pvt_car_insurance') {
    return ['third_party_pvt_vehicle_insurance', 'third_party_pvt_car_insurance'];
  }
  return t ? [t] : [];
}

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
  if (c === 'vehicle_loan' || c === 'car_loan') return 'Vehicle Loan';
  return c.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function insTypeLabel(insType: unknown): string {
  const t = String(insType ?? '')
    .trim()
    .toLowerCase();
  if (!t) return 'Insurance';
  if (t === 'vehicle_insurance' || t === 'car_insurance') return 'Vehicle Insurance';
  if (t === 'third_party_pvt_vehicle_insurance' || t === 'third_party_pvt_car_insurance') {
    return 'Third Party Pvt Vehicle Insurance';
  }
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
  if (s === 'in_process') return 'Under Review';
  if (s === 'kyc_progress') return 'KYC progress';
  return 'KYC pending';
}

export function blockingApplicationMessage(lead: Record<string, unknown>): string {
  const product = productLabel(lead);
  const raw = String(lead.status ?? '')
    .trim()
    .toLowerCase();
  if (raw === 'rejected') {
    return `Your ${product} application was not approved. You cannot apply again for this product with this mobile number.`;
  }
  const status = statusLabel(lead.status);
  return `Your ${product} application status is ${status}.`;
}
