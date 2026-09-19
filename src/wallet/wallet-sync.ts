/** Commission-affecting lead status changes and wallet sync errors. */

export const CODE_WALLET_SYNC_FAILED = 'WALLET_SYNC_FAILED';
export const CODE_APPROVE_ADMIN_ONLY = 'APPROVE_ADMIN_ONLY';

export const MSG_APPROVE_ADMIN_ONLY =
  'Only an admin can approve, un-approve, or change commission on an approved lead.';

export const MSG_WALLET_SYNC_FAILED =
  'Commission wallet could not be updated. The lead was not approved. Please retry.';

export const MSG_WALLET_SYNC_FAILED_STATUS_SAVED =
  'Lead status changed but the partner wallet could not be updated. Save again to retry commission, or contact admin.';

export class WalletSyncError extends Error {
  readonly code = CODE_WALLET_SYNC_FAILED;
  readonly leadStatusSaved: boolean;

  constructor(message: string, leadStatusSaved = false) {
    super(message);
    this.name = 'WalletSyncError';
    this.leadStatusSaved = leadStatusSaved;
  }
}

export function isApprovedLeadStatus(status: unknown): boolean {
  return String(status ?? '').trim().toLowerCase() === 'approved';
}

/** True when a save will add, remove, or reassign commission. */
export function isCommissionAffectingChange(
  before: { status?: unknown; agent_id?: unknown },
  after: { status?: unknown; agent_id?: unknown },
): boolean {
  const beforeApproved = isApprovedLeadStatus(before.status);
  const afterApproved = isApprovedLeadStatus(after.status);
  if (beforeApproved !== afterApproved) return true;
  if (!beforeApproved) return false;
  return String(before.agent_id ?? '').trim() !== String(after.agent_id ?? '').trim();
}

function normalizeLeadCategory(category: unknown): string {
  return String(category ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
}

function commissionAmountKey(lead: {
  required_amount?: unknown;
  loan_amt?: unknown;
}): string {
  return `${Number(lead.required_amount) || 0}|${String(lead.loan_amt ?? '').trim()}`;
}

/** True when only an admin may save (status/agent/amount/product on an approved lead). */
export function requiresAdminCommissionGate(
  before: {
    status?: unknown;
    agent_id?: unknown;
    required_amount?: unknown;
    loan_amt?: unknown;
    category?: unknown;
  },
  after: {
    status?: unknown;
    agent_id?: unknown;
    required_amount?: unknown;
    loan_amt?: unknown;
    category?: unknown;
  },
): boolean {
  if (isCommissionAffectingChange(before, after)) return true;
  const wasApproved = isApprovedLeadStatus(before.status);
  const willApproved = isApprovedLeadStatus(after.status);
  if (!wasApproved && !willApproved) return false;
  return (
    commissionAmountKey(before) !== commissionAmountKey(after) ||
    normalizeLeadCategory(before.category) !== normalizeLeadCategory(after.category)
  );
}
