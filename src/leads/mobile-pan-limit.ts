/**
 * Mobile is the primary customer identifier: max 4 unique real PAN fingerprints
 * (pan_hash) per mobile. Drafts do not count. Status does not free a slot.
 *
 * Pure helpers live here so controllers stay thin and tests do not need a live DB.
 */

import { isApprovedLeadStatus } from '../common/lead-status';

export { isApprovedLeadStatus };

export const MOBILE_PAN_LIMIT = 4;

export const CODE_MOBILE_PAN_LIMIT_REACHED = 'MOBILE_PAN_LIMIT_REACHED';

/** Same mobile already has this product in progress or rejected. */
export const CODE_PHONE_PRODUCT_BLOCKED = 'PHONE_PRODUCT_BLOCKED';

export const MSG_MOBILE_PAN_LIMIT_REACHED =
  'This mobile number has already been used for multiple applications. Please use a different mobile number.';

export class LeadRuleError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'LeadRuleError';
    this.code = code;
  }
}

export type SlotClaimOk = { ok: true; reused: boolean; slot: number };
export type SlotClaimBlocked = {
  ok: false;
  code: typeof CODE_MOBILE_PAN_LIMIT_REACHED;
  message: string;
};
export type SlotClaimResult = SlotClaimOk | SlotClaimBlocked;

export type MobilePanSlot = { mobile: string; panHash: string; slot: number };

export type ExistingLeadSnapshot = {
  id?: string;
  mobile: string;
  panHash: string | null;
  category: string;
  insType?: string | null;
  status: string;
  isDraft: boolean;
};

export type DuplicateGateResult =
  | { allowed: true }
  | {
      allowed: false;
      gate: 1;
      code: typeof CODE_MOBILE_PAN_LIMIT_REACHED;
      message: string;
    }
  | {
      allowed: false;
      gate: 2;
      code: typeof CODE_PHONE_PRODUCT_BLOCKED;
      message: string;
      status: string;
      category: string;
      insType: string | null;
    };

/** Non-draft + not approved → same PAN + same product is blocked (any mobile). */
export function isBlockingPanProductStatus(
  status: unknown,
  isDraft: boolean,
): boolean {
  if (isDraft) return false;
  return !isApprovedLeadStatus(status);
}

export function countsTowardMobilePanLimit(input: {
  panHash?: string | null;
  isDraft: boolean;
}): boolean {
  if (input.isDraft) return false;
  return Boolean(String(input.panHash ?? '').trim());
}

export function uniquePanHashesForMobile(
  mobile: string,
  slots: Array<{ mobile: string; panHash: string }>,
): string[] {
  const m = mobile.trim();
  const hashes = new Set<string>();
  for (const row of slots) {
    if (row.mobile.trim() !== m) continue;
    const hash = String(row.panHash ?? '').trim();
    if (hash) hashes.add(hash);
  }
  return [...hashes];
}

export function uniquePanHashesFromLeads(
  mobile: string,
  leads: ExistingLeadSnapshot[],
): string[] {
  const m = mobile.trim();
  const hashes = new Set<string>();
  for (const lead of leads) {
    if (lead.mobile.trim() !== m) continue;
    if (!countsTowardMobilePanLimit(lead)) continue;
    hashes.add(String(lead.panHash).trim());
  }
  return [...hashes];
}

/**
 * Gate 1 (read-only): reuse of an existing mobile+PAN is always allowed at this
 * gate. A new fingerprint is blocked when 4 unique real PANs are already linked.
 */
export function checkMobilePanLimit(input: {
  mobile: string;
  panHash: string;
  slots: Array<{ mobile: string; panHash: string }>;
}): DuplicateGateResult {
  const panHash = input.panHash.trim();
  if (!panHash) return { allowed: true };

  const hashes = uniquePanHashesForMobile(input.mobile, input.slots);
  if (hashes.includes(panHash)) return { allowed: true };
  if (hashes.length >= MOBILE_PAN_LIMIT) {
    return {
      allowed: false,
      gate: 1,
      code: CODE_MOBILE_PAN_LIMIT_REACHED,
      message: MSG_MOBILE_PAN_LIMIT_REACHED,
    };
  }
  return { allowed: true };
}

export function normalizeLeadCategory(category?: string | null): string {
  const c = String(category ?? '').trim();
  return c || 'personal_loan';
}

export function normalizeLeadInsType(
  category: string,
  insType?: string | null,
): string | null {
  if (normalizeLeadCategory(category) !== 'insurance') return null;
  const t = String(insType ?? '')
    .trim()
    .toLowerCase();
  return t || null;
}

function canonicalCategory(category?: string | null): string {
  const c = String(category ?? '').trim();
  if (c === 'car_loan' || c === 'car-loan') return 'vehicle_loan';
  return c || 'personal_loan';
}

function canonicalInsType(insType?: string | null): string {
  const t = String(insType ?? '').trim().toLowerCase();
  if (t === 'car_insurance') return 'vehicle_insurance';
  if (t === 'third_party_pvt_car_insurance') return 'third_party_pvt_vehicle_insurance';
  return t;
}

export function isSameProduct(
  a: { category?: string | null; insType?: string | null },
  b: { category?: string | null; insType?: string | null },
): boolean {
  const catA = canonicalCategory(a.category);
  const catB = canonicalCategory(b.category);
  if (!catA || !catB || catA !== catB) return false;
  if (catA !== 'insurance') return true;
  return canonicalInsType(a.insType) === canonicalInsType(b.insType);
}

/**
 * Newest real lead for this mobile + product.
 * Approved → allow another apply. Rejected or in progress → block.
 * PAN is not used.
 */
export function findBlockingPhoneProductLead(
  input: {
    mobile: string;
    category?: string | null;
    insType?: string | null;
    ignoreLeadId?: string;
  },
  leads: ExistingLeadSnapshot[],
): ExistingLeadSnapshot | null {
  const mobile = input.mobile.trim();
  if (!mobile) return null;
  const ignore = String(input.ignoreLeadId ?? '').trim();

  for (const lead of leads) {
    if (lead.mobile.trim() !== mobile) continue;
    if (ignore && String(lead.id ?? '').trim() === ignore) continue;
    if (!isSameProduct(input, lead)) continue;
    if (lead.isDraft) continue;
    if (isApprovedLeadStatus(lead.status)) return null;
    return lead;
  }
  return null;
}

/** @deprecated PAN is no longer the duplicate key. Use findBlockingPhoneProductLead. */
export function findBlockingSamePanProductLead(
  input: {
    panHash: string;
    category?: string | null;
    insType?: string | null;
    ignoreLeadId?: string;
  },
  leads: ExistingLeadSnapshot[],
): ExistingLeadSnapshot | null {
  const panHash = input.panHash.trim();
  if (!panHash) return null;
  const ignore = String(input.ignoreLeadId ?? '').trim();

  for (const lead of leads) {
    if (ignore && String(lead.id ?? '').trim() === ignore) continue;
    if (String(lead.panHash ?? '').trim() !== panHash) continue;
    if (!isSameProduct(input, lead)) continue;
    if (!isBlockingPanProductStatus(lead.status, lead.isDraft)) continue;
    return lead;
  }
  return null;
}

export function evaluateDuplicateGates(input: {
  mobile: string;
  panHash?: string;
  category?: string | null;
  insType?: string | null;
  slots?: Array<{ mobile: string; panHash: string }>;
  existingLeads: ExistingLeadSnapshot[];
  ignoreLeadId?: string;
}): DuplicateGateResult {
  const blocking = findBlockingPhoneProductLead(
    {
      mobile: input.mobile,
      category: input.category,
      insType: input.insType,
      ignoreLeadId: input.ignoreLeadId,
    },
    input.existingLeads,
  );
  if (!blocking) return { allowed: true };

  const status = String(blocking.status ?? 'pending').trim().toLowerCase() || 'pending';
  const product = normalizeLeadCategory(blocking.category);
  const label = product === 'insurance'
    ? normalizeLeadInsType(product, blocking.insType) || 'insurance'
    : product.replace(/_/g, ' ');
  const shown =
    status === 'kyc_progress'
      ? 'KYC progress'
      : status === 'in_process'
        ? 'Under Review'
        : status === 'pending'
          ? 'KYC pending'
          : status;
  const message =
    status === 'rejected'
      ? `Your ${label} application was not approved. You cannot apply again for this product with this mobile number.`
      : `Your ${label} application status is ${shown}.`;

  return {
    allowed: false,
    gate: 2,
    code: CODE_PHONE_PRODUCT_BLOCKED,
    message,
    status,
    category: product,
    insType: normalizeLeadInsType(blocking.category, blocking.insType),
  };
}

/** In-memory replica of unique(mobile, pan_hash) + unique(mobile, slot 1–4). */
export class MobilePanSlotStore {
  private readonly byMobile = new Map<string, Map<string, number>>();

  snapshot(mobile: string): MobilePanSlot[] {
    const rows = this.byMobile.get(mobile.trim());
    if (!rows) return [];
    return [...rows.entries()].map(([panHash, slot]) => ({
      mobile: mobile.trim(),
      panHash,
      slot,
    }));
  }

  claim(mobile: string, panHash: string): SlotClaimResult {
    const m = mobile.trim();
    const hash = panHash.trim();
    if (!m || !hash) {
      return { ok: true, reused: true, slot: 0 };
    }

    const rows = this.byMobile.get(m) ?? new Map<string, number>();
    const existing = rows.get(hash);
    if (existing != null) {
      return { ok: true, reused: true, slot: existing };
    }
    if (rows.size >= MOBILE_PAN_LIMIT) {
      return {
        ok: false,
        code: CODE_MOBILE_PAN_LIMIT_REACHED,
        message: MSG_MOBILE_PAN_LIMIT_REACHED,
      };
    }

    const used = new Set(rows.values());
    let slot = 1;
    while (used.has(slot) && slot <= MOBILE_PAN_LIMIT) slot += 1;
    if (slot > MOBILE_PAN_LIMIT) {
      return {
        ok: false,
        code: CODE_MOBILE_PAN_LIMIT_REACHED,
        message: MSG_MOBILE_PAN_LIMIT_REACHED,
      };
    }

    rows.set(hash, slot);
    this.byMobile.set(m, rows);
    return { ok: true, reused: false, slot };
  }
}

/**
 * Two concurrent claims that both read the same snapshot: unique(mobile, slot)
 * allows only one winner for the next free slot.
 */
export function applyConcurrentSlotClaims(
  existing: MobilePanSlot[],
  claims: string[],
): { results: SlotClaimResult[]; final: MobilePanSlot[] } {
  const occupiedPans = new Map(existing.map((r) => [r.panHash, r.slot]));
  const occupiedSlots = new Set(existing.map((r) => r.slot));
  const results: SlotClaimResult[] = [];

  for (const panHash of claims) {
    const hash = panHash.trim();
    const reused = occupiedPans.get(hash);
    if (reused != null) {
      results.push({ ok: true, reused: true, slot: reused });
      continue;
    }
    let slot = 1;
    while (occupiedSlots.has(slot) && slot <= MOBILE_PAN_LIMIT) slot += 1;
    if (slot > MOBILE_PAN_LIMIT) {
      results.push({
        ok: false,
        code: CODE_MOBILE_PAN_LIMIT_REACHED,
        message: MSG_MOBILE_PAN_LIMIT_REACHED,
      });
      continue;
    }
    occupiedSlots.add(slot);
    occupiedPans.set(hash, slot);
    results.push({ ok: true, reused: false, slot });
  }

  const mobile = existing[0]?.mobile ?? '';
  const final: MobilePanSlot[] = [...occupiedPans.entries()].map(([panHash, slot]) => ({
    mobile,
    panHash,
    slot,
  }));
  return { results, final };
}

export function isMobilePanLimitText(raw: string | undefined | null): boolean {
  const m = String(raw ?? '');
  return (
    m.includes(CODE_MOBILE_PAN_LIMIT_REACHED) ||
    /already been used for multiple applications/i.test(m)
  );
}
