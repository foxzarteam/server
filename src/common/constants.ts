export const TABLE_OTP_SESSIONS = 'otp_sessions';
export const TABLE_USERS = 'users';
export const TABLE_LEADS = 'leads';
export const TABLE_BANNERS = 'banners';
export const TABLE_SERVICES = 'services';
export const TABLE_PARTNER = 'partner';
export const TABLE_PAYMENT_ACCOUNTS = 'payment_accounts';
export const TABLE_WALLET = 'wallet';
/** Admin/staff panel users (`public.auth`). */
export const TABLE_AUTH = 'auth';

export const OTP_LENGTH = 6;
export const OTP_EXPIRY_MINUTES = 5;
export const OTP_MAX_ATTEMPTS = 3;

export const MSG_OTP_SESSION_FAILED = 'Failed to create OTP session.';
export const MSG_OTP_SENT = 'OTP sent successfully.';
export const MSG_OTP_VERIFY_FAILED = 'Verification failed.';
export const MSG_OTP_INVALID_EXPIRED = 'Invalid or expired OTP.';
export const MSG_OTP_MAX_ATTEMPTS = 'Max attempts exceeded.';
export const MSG_OTP_VERIFIED = 'OTP verified successfully.';

export const MSG_USER_CREATE_FAILED = 'Failed to create user';

export function getCurrentIsoTime(): string {
  return new Date().toISOString();
}
