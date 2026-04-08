import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../config/supabase.config';
import {
  TABLE_OTP_SESSIONS,
  OTP_LENGTH,
  OTP_EXPIRY_MINUTES,
  OTP_MAX_ATTEMPTS,
  getCurrentIsoTime,
  MSG_OTP_SESSION_FAILED,
  MSG_OTP_SENT,
  MSG_OTP_VERIFY_FAILED,
  MSG_OTP_INVALID_EXPIRED,
  MSG_OTP_MAX_ATTEMPTS,
  MSG_OTP_VERIFIED,
} from '../common/constants';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';

export type OtpResult = { success: boolean; message: string };

@Injectable()
export class OtpService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

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
    const otp = this.generateOtp();
    const expiresAt = this.getExpiryTime();

    const sessionError = await this.createOtpSession(
      dto.mobileNumber,
      otp,
      expiresAt,
    );
    if (sessionError) return sessionError;

    // Firebase Phone Auth flow is handled on the client.
    // For LIVE=false flows (dev), we only create the OTP session in DB.
    return { success: true, message: MSG_OTP_SENT };
  }

  // Dev endpoint helper: query latest OTP sessions from DB (works in serverless).
  async getLatestOtpSessions(
    limit = 10,
  ): Promise<Array<{ mobile_number: string; otp_code: string; created_at: string }>> {
    const { data, error } = await this.otpSessions
      .select('mobile_number, otp_code, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !Array.isArray(data)) return [];

    return data.map((row: any) => ({
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
}
