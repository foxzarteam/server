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

/** Max OTP sends per mobile in a rolling window. */
export const OTP_MAX_SENDS_PER_WINDOW = 5;
export const OTP_SEND_WINDOW_HOURS = 24;

export const MSG_OTP_SESSION_FAILED = 'Failed to create OTP session.';
export const MSG_OTP_SENT = 'OTP sent successfully.';
export const MSG_OTP_VERIFY_FAILED = 'Verification failed.';
export const MSG_OTP_VERIFIED = 'OTP verified successfully.';
export const MSG_OTP_FIREBASE_NOT_CONFIGURED =
  'Firebase verification is not configured on the server.';
export const MSG_OTP_FIREBASE_MISMATCH = 'Mobile number does not match Firebase token.';
export const MSG_OTP_PHONE_NOT_VERIFIED = 'Please verify your mobile number with OTP first.';
export const MSG_OTP_DAILY_LIMIT =
  'Is mobile number par OTP ki limit (5) puri ho chuki hai. Kripya 24 hours baad dobara try karein.';
export const PHONE_VERIFICATION_WINDOW_MINUTES = 30;

export const MSG_USER_CREATE_FAILED = 'Failed to create user';

export function getCurrentIsoTime(): string {
  return new Date().toISOString();
}
