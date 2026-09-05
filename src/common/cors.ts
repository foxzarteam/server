/** Shared CORS origin resolution — production fail-closed without ALLOWED_ORIGINS. */
export function resolveCorsOrigin(): boolean | string[] {
  const isProduction = process.env.NODE_ENV === 'production';
  const allowed = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (isProduction) {
    if (allowed.length === 0) {
      console.error(
        'ALLOWED_ORIGINS is required in production. CORS is blocked until it is set.',
      );
      return [];
    }
    return allowed;
  }

  return true;
}

export const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Accept',
  'Authorization',
  'x-admin-internal-key',
  'x-admin-actor',
  'x-firebase-id-token',
];
