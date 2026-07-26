import { Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { Inject } from '@nestjs/common';
import { SUPABASE_CLIENT } from '../config/supabase';
import { TABLE_PAN_ACCESS_AUDIT } from '../common/constants';

export type PanAuditAction =
  | 'reveal'
  | 'partner_send'
  | 'create'
  | 'update'
  | 'decrypt_failed';

export type PanAuditEntry = {
  leadId: string;
  action: PanAuditAction;
  adminId?: string | null;
  adminEmail?: string | null;
  adminRole?: string | null;
  partnerId?: string | null;
  partnerName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
};

@Injectable()
export class PanAuditService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  async record(entry: PanAuditEntry): Promise<void> {
    const payload = {
      lead_id: entry.leadId,
      action: entry.action,
      admin_id: entry.adminId ?? null,
      admin_email: entry.adminEmail ?? null,
      admin_role: entry.adminRole ?? null,
      partner_id: entry.partnerId ?? null,
      partner_name: entry.partnerName ?? null,
      ip_address: entry.ipAddress ?? null,
      user_agent: entry.userAgent ?? null,
      reason: entry.reason ?? null,
      metadata: entry.metadata ?? null,
      created_at: new Date().toISOString(),
    };

    const { error } = await this.supabase.from(TABLE_PAN_ACCESS_AUDIT).insert(payload);
    if (error && process.env.NODE_ENV !== 'production') {
      console.error('PanAuditService.record failed', error.message);
    }
  }
}
