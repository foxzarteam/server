import { timingSafeEqual } from 'crypto';

const DEV_ADMIN_INTERNAL_KEY = 'az-admin-internal-dev-key';

function safeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * BFF / admin internal key check.
 * Production: ADMIN_INTERNAL_KEY must be set — otherwise always false (fail-closed).
 * Development: falls back to a fixed local-only key when env unset.
 */
export function adminInternalKeyOk(header: string | undefined): boolean {
  const provided = (header ?? '').trim();
  if (!provided) return false;

  const expected = (process.env.ADMIN_INTERNAL_KEY ?? '').trim();
  if (expected) {
    return safeEqualString(provided, expected);
  }

  if (process.env.NODE_ENV === 'production') {
    return false;
  }

  return safeEqualString(provided, DEV_ADMIN_INTERNAL_KEY);
}
