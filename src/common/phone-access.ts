import { UnauthorizedException } from '@nestjs/common';
import { adminInternalKeyOk } from './admin-internal';
import type { OtpService } from '../otp/otp.service';

export type MobileAccessOpts = { adminKey?: string; idToken?: string };

/**
 * Allow access when:
 * 1) valid x-admin-internal-key, OR
 * 2) Firebase idToken matches this mobile, OR
 * 3) recent verified OTP session exists for this mobile.
 */
export async function assertMobileAccess(
  otpService: OtpService,
  mobileNumber: string,
  opts: MobileAccessOpts = {},
): Promise<void> {
  if (adminInternalKeyOk(opts.adminKey)) return;

  const mobile = mobileNumber.trim();
  if (!/^[6-9]\d{9}$/.test(mobile)) {
    throw new UnauthorizedException('Unauthorized');
  }

  if (await firebaseTokenMatchesMobile(otpService, mobile, opts.idToken)) return;

  if (await otpService.hasRecentPhoneVerification(mobile)) return;

  throw new UnauthorizedException('Unauthorized');
}

/**
 * Stricter gate for account-takeover sensitive mutations (e.g. MPIN reset).
 * Requires admin key OR a live Firebase idToken — not the OTP time-window alone.
 */
export async function assertStrictMobileAccess(
  otpService: OtpService,
  mobileNumber: string,
  opts: MobileAccessOpts = {},
): Promise<void> {
  if (adminInternalKeyOk(opts.adminKey)) return;

  const mobile = mobileNumber.trim();
  if (!/^[6-9]\d{9}$/.test(mobile)) {
    throw new UnauthorizedException('Unauthorized');
  }

  if (await firebaseTokenMatchesMobile(otpService, mobile, opts.idToken)) return;

  throw new UnauthorizedException('Phone verification required. Sign in with OTP again.');
}

/**
 * Lead apply / PAN submission only: admin key OR Firebase idToken OR recent OTP
 * for this mobile. OTP window is intentional here (verify before storing PAN),
 * but must not be reused as a general login session on wallet/payment/mpin routes.
 */
export async function assertLeadPiiAccess(
  otpService: OtpService,
  mobileNumber: string,
  opts: MobileAccessOpts = {},
): Promise<void> {
  if (adminInternalKeyOk(opts.adminKey)) return;

  const mobile = mobileNumber.trim();
  if (!/^[6-9]\d{9}$/.test(mobile)) {
    throw new UnauthorizedException('Unauthorized');
  }

  if (await firebaseTokenMatchesMobile(otpService, mobile, opts.idToken)) return;

  if (await otpService.hasRecentPhoneVerification(mobile)) return;

  throw new UnauthorizedException('Phone verification required before submitting details.');
}

async function firebaseTokenMatchesMobile(
  otpService: OtpService,
  mobile: string,
  idToken?: string,
): Promise<boolean> {
  const token = idToken?.trim();
  if (!token) return false;
  const verified = await otpService.verifyFirebaseToken({
    mobileNumber: mobile,
    idToken: token,
  });
  return verified.success === true;
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
