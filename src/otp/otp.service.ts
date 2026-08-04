import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../config/supabase';
import { getFirebaseAdmin, normalizeIndianMobile } from '../firebase/firebase-admin';
import {
  MSG_OTP_DAILY_LIMIT,
  MSG_OTP_FIREBASE_MISMATCH,
  MSG_OTP_FIREBASE_NOT_CONFIGURED,
  MSG_OTP_SESSION_FAILED,
  MSG_OTP_SENT,
  MSG_OTP_VERIFIED,
  MSG_OTP_VERIFY_FAILED,
  OTP_MAX_SENDS_PER_DAY,
  PHONE_VERIFICATION_WINDOW_MINUTES,
  TABLE_OTP_SESSIONS,
  getCurrentIsoTime,
  startOfTodayIstIso,
} from '../common/constants';

import type { OtpResult, SendOtpDto, VerifyFirebaseOtpDto } from './otp.dto';

@Injectable()
export class OtpService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get otpSessions() {
    return this.supabase.from(TABLE_OTP_SESSIONS);
  }

  private async countSendsToday(mobileNumber: string): Promise<number> {
    const { count, error } = await this.otpSessions
      .select('id', { count: 'exact', head: true })
      .eq('mobile_number', mobileNumber.trim())
      .gte('created_at', startOfTodayIstIso());

    if (error) {
      console.error('OtpService.countSendsToday', error);
      throw new Error('OTP_COUNT_FAILED');
    }
    return count ?? 0;
  }

  /**
   * Before Firebase SMS: check today's IST limit, then insert ONE send row.
   * Max 5 OTPs per mobile per day. Resets next calendar day (IST midnight).
   */
  async requestSend(dto: SendOtpDto): Promise<OtpResult> {
    const mobile = dto.mobileNumber.trim();

    let used = 0;
    try {
      used = await this.countSendsToday(mobile);
    } catch {
      return {
        success: false,
        message: 'Could not check OTP limit. Please try again.',
      };
    }

    if (used >= OTP_MAX_SENDS_PER_DAY) {
      return {
        success: false,
        message: MSG_OTP_DAILY_LIMIT,
        remainingSends: 0,
        retryNextDay: true,
      };
    }

    const { data, error } = await this.otpSessions
      .insert({
        mobile_number: mobile,
        is_verified: false,
      })
      .select('id')
      .single();

    if (error || !data) {
      console.error('OtpService.requestSend insert', error);
      return {
        success: false,
        message: MSG_OTP_SESSION_FAILED,
      };
    }

    return {
      success: true,
      message: MSG_OTP_SENT,
      remainingSends: Math.max(0, OTP_MAX_SENDS_PER_DAY - used - 1),
    };
  }

  /** Same as requestSend (legacy /api/otp/send). */
  async send(dto: SendOtpDto): Promise<OtpResult> {
    return this.requestSend(dto);
  }

  async getLatestOtpSessions(
    limit = 10,
  ): Promise<
    Array<{
      mobile_number: string;
      is_verified: boolean;
      created_at: string;
      verified_at: string | null;
    }>
  > {
    const { data, error } = await this.otpSessions
      .select('mobile_number, is_verified, created_at, verified_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !Array.isArray(data)) return [];

    return data.map((row: Record<string, unknown>) => ({
      mobile_number: String(row.mobile_number ?? ''),
      is_verified: Boolean(row.is_verified),
      created_at: String(row.created_at ?? ''),
      verified_at: row.verified_at != null ? String(row.verified_at) : null,
    }));
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

    return { success: true, message: MSG_OTP_VERIFIED };
  }

  async verifyFirebaseToken(dto: VerifyFirebaseOtpDto): Promise<OtpResult> {
    const checked = await this.assertFirebaseIdToken(
      dto.mobileNumber.trim(),
      dto.idToken,
    );
    if (!checked.success) return checked;
    return this.markPhoneVerified(dto.mobileNumber.trim());
  }

  /** Verify Firebase idToken matches mobile — no DB write (fast path for login). */
  async assertFirebaseIdToken(
    mobileNumber: string,
    idToken: string,
  ): Promise<OtpResult> {
    const app = getFirebaseAdmin();
    if (!app) {
      return { success: false, message: MSG_OTP_FIREBASE_NOT_CONFIGURED };
    }

    try {
      const decoded = await app.auth().verifyIdToken(idToken);
      const tokenMobile = normalizeIndianMobile(decoded.phone_number);
      if (!tokenMobile || tokenMobile !== mobileNumber.trim()) {
        return { success: false, message: MSG_OTP_FIREBASE_MISMATCH };
      }
      return { success: true, message: MSG_OTP_VERIFIED };
    } catch (e) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('OtpService.assertFirebaseIdToken', e);
      }
      return { success: false, message: MSG_OTP_VERIFY_FAILED };
    }
  }

  async hasRecentPhoneVerification(
    mobileNumber: string,
    withinMinutes = PHONE_VERIFICATION_WINDOW_MINUTES,
  ): Promise<boolean> {
    const since = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
    const { data, error } = await this.otpSessions
      .select('id')
      .eq('mobile_number', mobileNumber.trim())
      .eq('is_verified', true)
      .gte('verified_at', since)
      .limit(1);

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('OtpService.hasRecentPhoneVerification', error);
      }
      return false;
    }

    return Array.isArray(data) && data.length > 0;
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

  /** Mobiles that have at least one verified OTP session. */
  async getVerifiedMobiles(mobiles: string[]): Promise<Set<string>> {
    const map = await this.getVerifiedAtByMobiles(mobiles);
    return new Set(map.keys());
  }
}
