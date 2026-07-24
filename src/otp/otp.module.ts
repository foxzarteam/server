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
  MSG_OTP_INVALID_EXPIRED,
  MSG_OTP_MAX_ATTEMPTS,
  MSG_OTP_SESSION_FAILED,
  MSG_OTP_SENT,
  MSG_OTP_VERIFIED,
  MSG_OTP_VERIFY_FAILED,
  OTP_EXPIRY_MINUTES,
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_SENDS_PER_WINDOW,
  OTP_SEND_ATTEMPT_CODE,
  OTP_SEND_WINDOW_HOURS,
  PHONE_VERIFICATION_WINDOW_MINUTES,
  TABLE_OTP_SESSIONS,
  getCurrentIsoTime,
} from '../common/constants';

class SendOtpDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;
}

class VerifyOtpDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;

  @IsString()
  @Length(6, 6, { message: 'otp must be 6 digits' })
  @Matches(/^\d{6}$/, { message: 'otp must be 6 digits' })
  otp: string;
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
  retryAfterHours?: number;
};

@Injectable()
export class OtpService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get otpSessions() {
    return this.supabase.from(TABLE_OTP_SESSIONS);
  }

  private generateOtp(): string {
    let otp = '';
    for (let i = 0; i < OTP_LENGTH; i++) {
      otp += Math.floor(Math.random() * 10);
    }
    return otp;
  }

  private getExpiryTime(): string {
    const d = new Date();
    d.setMinutes(d.getMinutes() + OTP_EXPIRY_MINUTES);
    return d.toISOString();
  }

  private sendWindowSinceIso(): string {
    return new Date(Date.now() - OTP_SEND_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  }

  /** Count Firebase/SMS send attempts for this mobile in the rolling window. */
  private async countSendAttempts(mobileNumber: string): Promise<number> {
    const { count, error } = await this.otpSessions
      .select('id', { count: 'exact', head: true })
      .eq('mobile_number', mobileNumber.trim())
      .eq('otp_code', OTP_SEND_ATTEMPT_CODE)
      .gte('created_at', this.sendWindowSinceIso());

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('OtpService.countSendAttempts', error);
      }
      return 0;
    }
    return count ?? 0;
  }

  /**
   * Gate OTP sends: max OTP_MAX_SENDS_PER_WINDOW per mobile per OTP_SEND_WINDOW_HOURS.
   * Call this before Firebase (or custom) SMS is triggered from the client.
   */
  async requestSend(dto: SendOtpDto): Promise<OtpResult> {
    const mobile = dto.mobileNumber.trim();
    const used = await this.countSendAttempts(mobile);

    if (used >= OTP_MAX_SENDS_PER_WINDOW) {
      return {
        success: false,
        message: MSG_OTP_DAILY_LIMIT,
        remainingSends: 0,
        retryAfterHours: OTP_SEND_WINDOW_HOURS,
      };
    }

    const expiresAt = new Date(
      Date.now() + OTP_SEND_WINDOW_HOURS * 60 * 60 * 1000,
    ).toISOString();

    const { error } = await this.otpSessions.insert({
      mobile_number: mobile,
      otp_code: OTP_SEND_ATTEMPT_CODE,
      expires_at: expiresAt,
      is_verified: false,
      attempts: 0,
      max_attempts: 1,
    });

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('OtpService.requestSend', error);
      }
      return { success: false, message: MSG_OTP_SESSION_FAILED };
    }

    return {
      success: true,
      message: MSG_OTP_SENT,
      remainingSends: OTP_MAX_SENDS_PER_WINDOW - used - 1,
    };
  }

  private async createOtpSession(
    mobileNumber: string,
    otp: string,
    expiresAt: string,
  ): Promise<OtpResult | null> {
    const { error } = await this.otpSessions.insert({
      mobile_number: mobileNumber,
      otp_code: otp,
      expires_at: expiresAt,
      is_verified: false,
      attempts: 0,
      max_attempts: OTP_MAX_ATTEMPTS,
    });
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('OtpService.createOtpSession', error);
      }
      return { success: false, message: MSG_OTP_SESSION_FAILED };
    }
    return null;
  }

  async send(dto: SendOtpDto): Promise<OtpResult> {
    const gate = await this.requestSend(dto);
    if (!gate.success) return gate;

    const otp = this.generateOtp();
    const expiresAt = this.getExpiryTime();
    const sessionError = await this.createOtpSession(dto.mobileNumber, otp, expiresAt);
    if (sessionError) return sessionError;
    return {
      success: true,
      message: MSG_OTP_SENT,
      remainingSends: gate.remainingSends,
    };
  }

  async getLatestOtpSessions(
    limit = 10,
  ): Promise<Array<{ mobile_number: string; otp_code: string; created_at: string }>> {
    const { data, error } = await this.otpSessions
      .select('mobile_number, otp_code, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !Array.isArray(data)) return [];

    return data.map((row: Record<string, unknown>) => ({
      mobile_number: String(row.mobile_number ?? ''),
      otp_code: String(row.otp_code ?? ''),
      created_at: String(row.created_at ?? ''),
    }));
  }

  async verify(dto: VerifyOtpDto): Promise<OtpResult> {
    const now = getCurrentIsoTime();
    const { data: rows, error } = await this.otpSessions
      .select('id, attempts, max_attempts')
      .eq('mobile_number', dto.mobileNumber)
      .eq('otp_code', dto.otp)
      .eq('is_verified', false)
      .gt('expires_at', now);

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('OtpService.verify select', error);
      }
      return { success: false, message: MSG_OTP_VERIFY_FAILED };
    }

    const session = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    if (!session) {
      return { success: false, message: MSG_OTP_INVALID_EXPIRED };
    }

    const attempts = (session.attempts as number) ?? 0;
    const maxAttempts = (session.max_attempts as number) ?? OTP_MAX_ATTEMPTS;
    if (attempts >= maxAttempts) {
      return { success: false, message: MSG_OTP_MAX_ATTEMPTS };
    }

    const { error: updateErr } = await this.otpSessions
      .update({
        is_verified: true,
        verified_at: getCurrentIsoTime(),
      })
      .eq('id', session.id);

    if (updateErr) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('OtpService.verify update', updateErr);
      }
      return { success: false, message: MSG_OTP_VERIFY_FAILED };
    }

    return { success: true, message: MSG_OTP_VERIFIED };
  }

  /** Record Firebase phone verification (used by az_web after client sign-in). */
  async markPhoneVerified(mobileNumber: string): Promise<OtpResult> {
    const expiresAt = this.getExpiryTime();
    const { error } = await this.otpSessions.insert({
      mobile_number: mobileNumber,
      otp_code: '000000',
      expires_at: expiresAt,
      is_verified: true,
      verified_at: getCurrentIsoTime(),
      attempts: 0,
      max_attempts: OTP_MAX_ATTEMPTS,
    });
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('OtpService.markPhoneVerified', error);
      }
      return { success: false, message: MSG_OTP_SESSION_FAILED };
    }
    return { success: true, message: MSG_OTP_VERIFIED };
  }

  async verifyFirebaseToken(dto: VerifyFirebaseOtpDto): Promise<OtpResult> {
    const app = getFirebaseAdmin();
    if (!app) {
      return { success: false, message: MSG_OTP_FIREBASE_NOT_CONFIGURED };
    }

    try {
      const decoded = await app.auth().verifyIdToken(dto.idToken);
      const tokenMobile = normalizeIndianMobile(decoded.phone_number);
      if (!tokenMobile || tokenMobile !== dto.mobileNumber.trim()) {
        return { success: false, message: MSG_OTP_FIREBASE_MISMATCH };
      }
      return this.markPhoneVerified(dto.mobileNumber.trim());
    } catch (e) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('OtpService.verifyFirebaseToken', e);
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

  /** Check + consume one send slot before Firebase SMS (az_web). */
  @Post('request-send')
  @HttpCode(HttpStatus.OK)
  async requestSend(@Body() dto: SendOtpDto) {
    return this.otpService.requestSend(dto);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verify(@Body() dto: VerifyOtpDto) {
    return this.otpService.verify(dto);
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

      const entries = await this.otpService.getLatestOtpSessions(10);
      const rows = live
        ? ''
        : entries
            .map(
              (e) =>
                `<tr><td>${this.escapeHtml(e.mobile_number)}</td><td><strong>${e.otp_code}</strong></td><td>${this.escapeHtml(
                  e.created_at,
                )}</td></tr>`,
            )
            .join('');

      const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>OTP Dev</title>
<style>body{font-family:system-ui;max-width:600px;margin:2rem auto;padding:1rem}table{width:100%;border-collapse:collapse}th,td{padding:0.5rem;text-align:left;border-bottom:1px solid #ddd}th{background:#333;color:#fff}</style>
</head>
<body>
<h1>OTP Dev Logs</h1>
<p><strong>LIVE:</strong> ${live ? 'true' : 'false'}</p>
<table>
<thead><tr><th>Mobile</th><th>OTP</th><th>Time</th></tr></thead>
<tbody>${
        rows ||
        (live
          ? '<tr><td colspan="3">LIVE=true. Firebase Phone Auth is active, so /api/otp/send is not used.</td></tr>'
          : '<tr><td colspan="3">No OTPs yet. Send one via POST /api/otp/send</td></tr>')
      }</tbody>
</table>
</body>
</html>`;

      return res.type('text/html').send(html);
    } catch {
      return res
        .type('text/html')
        .send(
          `<!DOCTYPE html><html><body><h1>OTP Dev Logs</h1><p>Error fetching OTP logs.</p></body></html>`,
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
