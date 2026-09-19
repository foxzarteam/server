import {
  CODE_MOBILE_PAN_LIMIT_REACHED,
  isMobilePanLimitText,
  MSG_MOBILE_PAN_LIMIT_REACHED,
} from './mobile-pan-limit';

/**
 * Map Supabase / PostgREST write failures to applicant-safe messages.
 * Keeps raw DB text out of production responses while aiding logs.
 */
export function leadWriteErrorCode(
  message: string | undefined | null,
): string | undefined {
  const m = String(message ?? '').toLowerCase();
  if (isMobilePanLimitText(message) || m.includes('lead_mobile_pan_slots')) {
    return CODE_MOBILE_PAN_LIMIT_REACHED;
  }
  return undefined;
}

export function mapLeadWriteError(message: string | undefined | null): string {
  const m = String(message ?? '').toLowerCase();
  if (!m) return 'Failed to create lead. Please try again.';

  if (isMobilePanLimitText(message) || m.includes('lead_mobile_pan_slots')) {
    return MSG_MOBILE_PAN_LIMIT_REACHED;
  }

  if (
    m.includes('duplicate') ||
    m.includes('unique') ||
    m.includes('leads_pan_hash') ||
    m.includes('23505')
  ) {
    return 'You already have an open application for this product. Check status or wait until it is Approved before applying again.';
  }

  if (m.includes('check constraint') || m.includes('23514')) {
    if (m.includes('employment')) {
      return 'Invalid employment type for personal loan.';
    }
    if (m.includes('status')) {
      return 'Invalid application status.';
    }
    if (m.includes('category') || m.includes('ins_type') || m.includes('loan_amt')) {
      return 'Invalid product selection. Please try again.';
    }
    return 'Some details are invalid. Please check and try again.';
  }

  if (m.includes('foreign key') || m.includes('23503')) {
    return 'Linked account is invalid. Please sign in again and retry.';
  }

  if (
    m.includes('column') &&
    (m.includes('schema cache') || m.includes('does not exist') || m.includes("could not find"))
  ) {
    return 'Service is updating. Please try again in a minute.';
  }

  return 'Failed to create lead. Please try again.';
}
