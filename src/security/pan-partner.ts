import {
  decryptPan,
  maskPan,
  toSafeLeadRow,
} from './pan-crypto';
import type { PanAuditService } from './pan-audit.service';

export type PartnerPanSendContext = {
  leadId: string;
  partnerId: string;
  partnerName?: string;
  adminId?: string;
  adminEmail?: string;
  adminRole?: string;
  ipAddress?: string;
  userAgent?: string;
  reason?: string;
};

/**
 * Temporarily decrypt PAN for a lending-partner handoff.
 * Full PAN exists only inside `handler` and is never logged.
 */
export async function withDecryptedPanForPartner(
  encryptedPan: string,
  audit: PanAuditService,
  ctx: PartnerPanSendContext,
  handler: (plainPan: string) => Promise<void> | void,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let plain: string;
  try {
    plain = decryptPan(encryptedPan);
  } catch {
    await audit.record({
      leadId: ctx.leadId,
      action: 'decrypt_failed',
      adminId: ctx.adminId,
      adminEmail: ctx.adminEmail,
      adminRole: ctx.adminRole,
      partnerId: ctx.partnerId,
      partnerName: ctx.partnerName,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      reason: ctx.reason ?? 'partner_send',
    });
    return { ok: false, message: 'Unable to decrypt PAN for partner send' };
  }

  try {
    const audited = await audit.record({
      leadId: ctx.leadId,
      action: 'partner_send',
      adminId: ctx.adminId,
      adminEmail: ctx.adminEmail,
      adminRole: ctx.adminRole,
      partnerId: ctx.partnerId,
      partnerName: ctx.partnerName,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      reason: ctx.reason ?? 'Outbound lending partner transmission',
      metadata: { pan_masked: maskPan(plain) },
    });
    if (!audited) {
      return { ok: false, message: 'Audit logging failed; PAN not sent' };
    }
    await handler(plain);
    return { ok: true };
  } finally {
    plain = '';
  }
}

export { toSafeLeadRow, maskPan, decryptPan };
