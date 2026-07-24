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

/** Max OTP sends per mobile per calendar day (IST). */
export const OTP_MAX_SENDS_PER_DAY = 5;

export const MSG_OTP_SESSION_FAILED = 'Failed to create OTP session.';
export const MSG_OTP_SENT = 'OTP sent successfully.';
export const MSG_OTP_VERIFY_FAILED = 'Verification failed.';
export const MSG_OTP_VERIFIED = 'OTP verified successfully.';
export const MSG_OTP_FIREBASE_NOT_CONFIGURED =
  'Firebase verification is not configured on the server.';
export const MSG_OTP_FIREBASE_MISMATCH = 'Mobile number does not match Firebase token.';
export const MSG_OTP_PHONE_NOT_VERIFIED = 'Please verify your mobile number with OTP first.';
export const MSG_OTP_DAILY_LIMIT =
  'OTP limit reached for this mobile number. Please try again tomorrow.';
export const PHONE_VERIFICATION_WINDOW_MINUTES = 30;

export const MSG_USER_CREATE_FAILED = 'Failed to create user';

export function getCurrentIsoTime(): string {
  return new Date().toISOString();
}

/** Start of today in IST (Asia/Kolkata), as UTC ISO string. */
export function startOfTodayIstIso(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  return new Date(`${y}-${m}-${d}T00:00:00+05:30`).toISOString();
}
