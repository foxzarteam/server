/**
 * Strip schema/table/SQL details from messages shown to browsers.
 * Log the raw error server-side; never surface DB internals to users.
 */
export function toPublicErrorMessage(
  raw: string | undefined | null,
  fallback = 'Something went wrong. Please try again.',
): string {
  const msg = String(raw ?? '').trim();
  if (!msg) return fallback;

  const lower = msg.toLowerCase();

  if (
    /public\.\w+|schema cache|relation |column |postgres|supabase|postgrest|sqlstate|permission denied|row-level security|\brls\b|violates |foreign key|check constraint|duplicate key|2350[0-9]|pgrst/i.test(
      msg,
    )
  ) {
    if (/duplicate|unique|already exists|23505/i.test(lower)) {
      return 'This phone number is already registered. Please log in.';
    }
    if (/permission denied|row-level security|\brls\b/i.test(lower)) {
      return 'Unable to complete this action right now. Please try again later.';
    }
    return fallback;
  }

  return msg;
}
