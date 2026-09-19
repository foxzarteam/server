/**
 * Strip schema/SQL/stack/config details from messages shown to browsers.
 * Log the raw error server-side; never surface internals to users.
 */

const MSG_GENERIC = 'Something went wrong. Please try again.';
const MSG_DUPLICATE_PHONE = 'This phone number is already registered. Please log in.';
const MSG_MOBILE_PAN_LIMIT =
  'This mobile number has already been used for multiple applications. Please use a different mobile number.';
const MSG_INVALID_DETAILS = 'Some details are invalid. Please check and try again.';

const INTERNAL_RE =
  /public\.\w+|schema cache|relation |column |postgres|supabase|postgrest|sqlstate|permission denied|row-level security|\brls\b|violates |foreign key|check constraint|duplicate key|2350[0-9]|pgrst|service_role|SUPABASE_|firebase|firestore|auth\/|NEXT_PUBLIC_|ADMIN_|PAN_ENCRYPTION|nest server|\btable\b|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|socket hang|node_modules|\.(ts|js|tsx|jsx):\d+|at\s+\S+\s+\(|TypeError|ReferenceError|SyntaxError|Cannot read propert|undefined is not|is not a function|jwt|hmac|\bsecret\b|stack trace|vercel\.app|supabase\.co|should not exist|whitelist|forbidNonWhitelisted|Cannot GET|Cannot POST|ENOENT|EPERM|internal server error|prisma|knex|sequelize|axioserror|fetch failed/i;

export function looksLikeInternalError(raw: string): boolean {
  const msg = String(raw ?? '').trim();
  if (!msg) return false;
  if (INTERNAL_RE.test(msg)) return true;
  if (msg.length > 280) return true;
  if (msg.includes('{') && msg.includes('}')) return true;
  if (/[/\\](src|dist|node_modules|app)[/\\]/i.test(msg)) return true;
  return false;
}

export function toPublicErrorMessage(
  raw: string | string[] | undefined | null,
  fallback = MSG_GENERIC,
): string {
  const msg = Array.isArray(raw)
    ? raw.map((x) => String(x ?? '').trim()).filter(Boolean).join('. ')
    : String(raw ?? '').trim();
  if (!msg) return fallback;

  if (
    /MOBILE_PAN_LIMIT_REACHED/i.test(msg) ||
    /already been used for multiple applications/i.test(msg)
  ) {
    return MSG_MOBILE_PAN_LIMIT;
  }

  if (looksLikeInternalError(msg)) {
    if (/duplicate|unique|already exists|23505|already registered/i.test(msg)) {
      return MSG_DUPLICATE_PHONE;
    }
    if (/should not exist|whitelist|must be a|must be one of/i.test(msg) && !/duplicate/i.test(msg)) {
      return MSG_INVALID_DETAILS;
    }
    return fallback;
  }

  return msg;
}
