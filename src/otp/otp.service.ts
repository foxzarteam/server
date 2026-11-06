import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../config/supabase';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import {
  MSG_OTP_SESSION_FAILED,
  MSG_OTP_VERIFIED,
  MSG_OTP_VERIFY_FAILED,
  TABLE_LEADS,
  TABLE_OTP_SESSIONS,
  getCurrentIsoTime,
  startOfTodayIstIso,
} from '../common/constants';

import type { OtpResult, SendOtpDto, VerifyFirebaseOtpDto } from './otp.dto';

@Injectable()
export class OtpService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly whatsapp: WhatsappService,
  ) {}

  private get otpSessions() {
    return this.supabase.from(TABLE_OTP_SESSIONS);
  }

  /** Firebase OTP SMS is disabled — never insert a send row or allow SMS. */
  async requestSend(_dto: SendOtpDto): Promise<OtpResult> {
    return {
      success: false,
      message: 'OTP is disabled. Submit the form without OTP.',
      remainingSends: 0,
    };
  }

  /**
   * Mark latest unverified send for this mobile as verified.
   * Does NOT insert a second row.
   */
  async markPhoneVerified(mobileNumber: string): Promise<OtpResult> {
    const mobile = mobileNumber.trim();
    const now = getCurrentIsoTime();

    const { data: rows, error: selectErr } = await this.otpSessions
      .select('id')
      .eq('mobile_number', mobile)
      .eq('is_verified', false)
      .order('created_at', { ascending: false })
      .limit(1);

    if (selectErr) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('OtpService.markPhoneVerified select', selectErr);
      }
      return { success: false, message: MSG_OTP_VERIFY_FAILED };
    }

    const latest = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

    if (latest?.id) {
      const { error: updateErr } = await this.otpSessions
        .update({
          is_verified: true,
          verified_at: now,
        })
        .eq('id', latest.id);

      if (updateErr) {
        if (process.env.NODE_ENV !== 'production') {
          console.error('OtpService.markPhoneVerified update', updateErr);
        }
        return { success: false, message: MSG_OTP_VERIFY_FAILED };
      }

      await this.markLeadsVerifiedForMobile(mobile);
      return { success: true, message: MSG_OTP_VERIFIED };
    }

    const { data: already, error: alreadyErr } = await this.otpSessions
      .select('id')
      .eq('mobile_number', mobile)
      .eq('is_verified', true)
      .gte('created_at', startOfTodayIstIso())
      .limit(1);

    if (alreadyErr) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('OtpService.markPhoneVerified already', alreadyErr);
      }
      return { success: false, message: MSG_OTP_VERIFY_FAILED };
    }

    if (Array.isArray(already) && already.length > 0) {
      await this.markLeadsVerifiedForMobile(mobile);
      return { success: true, message: MSG_OTP_VERIFIED };
    }

    // No pending send row (e.g. rate-limit insert was skipped) — one verified row only
    const { error: insertErr } = await this.otpSessions.insert({
      mobile_number: mobile,
      is_verified: true,
      verified_at: now,
    });

    if (insertErr) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('OtpService.markPhoneVerified insert', insertErr);
      }
      return { success: false, message: MSG_OTP_SESSION_FAILED };
    }

    await this.markLeadsVerifiedForMobile(mobile);
    return { success: true, message: MSG_OTP_VERIFIED };
  }

  /** True when this mobile already finished OTP, even if the lead row was saved later. */
  async hasVerifiedSession(mobileNumber: string): Promise<boolean> {
    const mobile = mobileNumber.trim();
    if (!mobile) return false;
    const { data, error } = await this.otpSessions
      .select('id')
      .eq('mobile_number', mobile)
      .eq('is_verified', true)
      .limit(1);
    if (error) {
      console.error('OtpService.hasVerifiedSession', error.message);
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  }

  /** Legacy helper if an old OTP path still marks a phone. Public apply already sets verified + KYC. */
  private async markLeadsVerifiedForMobile(mobile: string): Promise<void> {
    const { error } = await this.supabase
      .from(TABLE_LEADS)
      .update({ otp_verified: true, updated_at: getCurrentIsoTime() })
      .eq('mobile_number', mobile)
      .eq('is_active', true);

    if (error) {
      console.error('OtpService.markLeadsVerifiedForMobile', error.message);
      return;
    }

    const { data, error: readErr } = await this.supabase
      .from(TABLE_LEADS)
      .select('id, full_name, category, ins_type')
      .eq('mobile_number', mobile)
      .eq('is_active', true)
      .limit(20);

    if (readErr) {
      console.error('OtpService.markLeadsVerifiedForMobile read', readErr.message);
      return;
    }

    const ready = (Array.isArray(data) ? data : []).filter((row) => {
      const name = String((row as { full_name?: string }).full_name ?? '').trim();
      return name.length > 0 && name.toLowerCase() !== 'unknown';
    }) as { id?: string; full_name?: string; category?: string; ins_type?: string | null }[];
    if (ready.length === 0) return;
    this.whatsapp.notifyAfterOtpVerified(mobile, ready);
  }

  /** Firebase OTP SMS is disabled — never mark a phone verified via OTP. */
  async verifyFirebaseToken(_dto: VerifyFirebaseOtpDto): Promise<OtpResult> {
    return {
      success: false,
      message: 'OTP is disabled. Submit the form without OTP.',
    };
  }

  /**
   * Verified OTP timestamps per mobile (for attaching otp_verified to leads).
   * Only sessions with is_verified=true and a verified_at are returned.
   */
  async getVerifiedAtByMobiles(
    mobiles: string[],
  ): Promise<Map<string, string[]>> {
    const unique = [
      ...new Set(mobiles.map((m) => m.trim()).filter((m) => m.length === 10)),
    ];
    const out = new Map<string, string[]>();
    if (!unique.length) return out;

    const { data, error } = await this.otpSessions
      .select('mobile_number, verified_at')
      .in('mobile_number', unique)
      .eq('is_verified', true)
      .not('verified_at', 'is', null);

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('OtpService.getVerifiedAtByMobiles', error);
      }
      return out;
    }

    for (const row of data ?? []) {
      const mobile = String(
        (row as { mobile_number?: string }).mobile_number ?? '',
      ).trim();
      const at = String(
        (row as { verified_at?: string | null }).verified_at ?? '',
      ).trim();
      if (!mobile || !at) continue;
      const list = out.get(mobile) ?? [];
      list.push(at);
      out.set(mobile, list);
    }
    return out;
  }

  /** CRM lead delete: drop OTP send/verify rows for this mobile. Does not touch WhatsApp. */
  async deleteSessionsForMobile(mobileNumber: string): Promise<void> {
    const mobile = mobileNumber.trim();
    if (!/^[6-9]\d{9}$/.test(mobile)) return;
    const { error } = await this.otpSessions.delete().eq('mobile_number', mobile);
    if (error) console.error('OtpService.deleteSessionsForMobile', error.message);
  }
}
