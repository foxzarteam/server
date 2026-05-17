const DEFAULT_ADMIN_INTERNAL_KEY = 'az-admin-internal-dev-key';

export function adminInternalKeyOk(header: string | undefined): boolean {
  const provided = (header ?? '').trim();
  const expected = (process.env.ADMIN_INTERNAL_KEY ?? '').trim();
  if (expected) return provided.length > 0 && provided === expected;
  if (process.env.NODE_ENV === 'production') return false;
  return provided === DEFAULT_ADMIN_INTERNAL_KEY;
}
