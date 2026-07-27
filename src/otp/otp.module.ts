import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  Post,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import { IsString, Length, Matches, MinLength } from 'class-validator';
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

class SendOtpDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;
}

class VerifyFirebaseOtpDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;

  @IsString()
  @MinLength(20, { message: 'idToken is required' })
  idToken: string;
}

export type OtpResult = {
  success: boolean;
  message: string;
  remainingSends?: number;
  /** True when daily limit hit — allow again next calendar day (IST). */
  retryNextDay?: boolean;
};

/**
 * Simple otp_sessions usage:
 * - 1 send → 1 row (is_verified=false, created_at=now)
 * - verify → UPDATE that row (is_verified=true) — no second insert
 * - rate limit = count rows for mobile since start of today (IST). Max 5/day.
 */
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

@Controller('otp')
export class OtpController {
  constructor(
    private readonly otpService: OtpService,
    private readonly config: ConfigService,
  ) {}

  @Post('send')
  @HttpCode(HttpStatus.OK)
  async send(@Body() dto: SendOtpDto) {
    return this.otpService.send(dto);
  }

  /** Check limit + log one send row before Firebase SMS. */
  @Post('request-send')
  @HttpCode(HttpStatus.OK)
  async requestSend(@Body() dto: SendOtpDto) {
    return this.otpService.requestSend(dto);
  }

  @Post('verify-firebase')
  @HttpCode(HttpStatus.OK)
  async verifyFirebase(@Body() dto: VerifyFirebaseOtpDto) {
    return this.otpService.verifyFirebaseToken(dto);
  }

  @Get('live')
  live() {
    const raw = (this.config.get<string>('LIVE') ?? '').toLowerCase().trim();
    const live = raw === 'true' || raw === '1';
    return { live };
  }

  @Get('dev')
  async dev(@Res() res: Response) {
    try {
      const isProduction = this.config.get<string>('NODE_ENV') === 'production';
      const allowOtpDev = this.config.get<string>('ALLOW_OTP_DEV') === 'true';
      const rawLive = (this.config.get<string>('LIVE') ?? '').toLowerCase().trim();
      const live = rawLive === 'true' || rawLive === '1';
      if (isProduction && !allowOtpDev) {
        return res.status(404).json({ error: 'Not found' });
      }

      const entries = await this.otpService.getLatestOtpSessions(20);
      const rows = entries
        .map(
          (e) =>
            `<tr><td>${this.escapeHtml(e.mobile_number)}</td><td>${e.is_verified ? 'Yes' : 'No'}</td><td>${this.escapeHtml(
              e.created_at,
            )}</td><td>${this.escapeHtml(e.verified_at ?? '—')}</td></tr>`,
        )
        .join('');

      const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>OTP Dev</title>
<style>body{font-family:system-ui;max-width:720px;margin:2rem auto;padding:1rem}table{width:100%;border-collapse:collapse}th,td{padding:0.5rem;text-align:left;border-bottom:1px solid #ddd}th{background:#333;color:#fff}</style>
</head>
<body>
<h1>OTP Sessions</h1>
<p><strong>LIVE:</strong> ${live ? 'true' : 'false'} · 1 send = 1 row · verify updates same row</p>
<table>
<thead><tr><th>Mobile</th><th>Verified</th><th>Sent at</th><th>Verified at</th></tr></thead>
<tbody>${
        rows ||
        '<tr><td colspan="4">No OTP sessions yet.</td></tr>'
      }</tbody>
</table>
</body>
</html>`;

      return res.type('text/html').send(html);
    } catch {
      return res
        .type('text/html')
        .send(
          `<!DOCTYPE html><html><body><h1>OTP Sessions</h1><p>Error fetching logs.</p></body></html>`,
        );
    }
  }

  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }
}

@Module({
  controllers: [OtpController],
  providers: [OtpService],
  exports: [OtpService],
})
export class OtpModule {}
