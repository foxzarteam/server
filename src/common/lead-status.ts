/** Shared lead status check. Wallet commission and duplicate-PAN gates both use this. */
export function isApprovedLeadStatus(status: unknown): boolean {
  return String(status ?? '').trim().toLowerCase() === 'approved';
}
