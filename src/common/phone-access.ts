import { UnauthorizedException } from '@nestjs/common';
import { adminInternalKeyOk } from './admin-internal';
import type { OtpService } from '../otp/otp.service';

/**
 * Allow access when:
 * 1) valid x-admin-internal-key, OR
 * 2) Firebase idToken matches this mobile, OR
 * 3) recent verified OTP session exists for this mobile.
 */
export async function assertMobileAccess(
  otpService: OtpService,
  mobileNumber: string,
  opts: { adminKey?: string; idToken?: string } = {},
): Promise<void> {
  if (adminInternalKeyOk(opts.adminKey)) return;

  const mobile = mobileNumber.trim();
  if (!/^[6-9]\d{9}$/.test(mobile)) {
    throw new UnauthorizedException('Unauthorized');
  }

  const idToken = opts.idToken?.trim();
  if (idToken) {
    const verified = await otpService.verifyFirebaseToken({
      mobileNumber: mobile,
      idToken,
    });
    if (verified.success) return;
  }

  if (await otpService.hasRecentPhoneVerification(mobile)) return;

  throw new UnauthorizedException('Unauthorized');
}

/** Read Firebase id token from common header names / Authorization Bearer. */
export function extractIdToken(
  headers: Record<string, string | string[] | undefined>,
  bodyToken?: unknown,
): string | undefined {
  if (typeof bodyToken === 'string' && bodyToken.trim()) return bodyToken.trim();

  const raw =
    headers['x-firebase-id-token'] ??
    headers['X-Firebase-Id-Token'] ??
    headers['authorization'] ??
    headers['Authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v.toLowerCase().startsWith('bearer ')) return v.slice(7).trim();
  return v || undefined;
}
