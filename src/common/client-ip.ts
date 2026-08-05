/**
 * Resolve applicant / browser IP for lead attribution.
 * Uses first X-Forwarded-For hop when behind Vercel/proxy (trust proxy enabled).
 */
export function extractClientIp(
  headers: Record<string, string | string[] | undefined>,
  socketIp?: string | null,
): string | null {
  const raw =
    headers['x-forwarded-for'] ??
    headers['X-Forwarded-For'] ??
    headers['x-real-ip'] ??
    headers['X-Real-Ip'] ??
    headers['cf-connecting-ip'] ??
    headers['CF-Connecting-IP'] ??
    headers['true-client-ip'] ??
    headers['True-Client-Ip'];

  const headerVal = Array.isArray(raw) ? raw[0] : raw;
  if (typeof headerVal === 'string' && headerVal.trim()) {
    // x-forwarded-for: client, proxy1, proxy2
    const first = headerVal.split(',')[0]?.trim() ?? '';
    if (first) return first.slice(0, 45);
  }

  const sock = (socketIp ?? '').trim();
  if (!sock) return null;
  // Express may give :ffff:1.2.3.4
  const v4 = sock.startsWith('::ffff:') ? sock.slice(7) : sock;
  return v4.slice(0, 45) || null;
}
