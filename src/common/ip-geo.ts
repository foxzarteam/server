/**
 * Best-effort city / region / country from public IP (cached).
 * Uses free HTTPS geo API — never blocks longer than GEO_TIMEOUT_MS.
 */

const GEO_TIMEOUT_MS = 2_500;
const cache = new Map<string, string | null>();

function isPrivateOrLocalIp(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  if (!v || v === 'unknown' || v === '::1' || v === 'localhost') return true;
  if (v.startsWith('127.') || v.startsWith('10.') || v.startsWith('192.168.') || v.startsWith('169.254.')) {
    return true;
  }
  // 172.16.0.0 – 172.31.255.255
  const m = /^172\.(\d+)\./.exec(v);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:')) return true;
  return false;
}

function buildLabel(parts: Array<string | null | undefined>): string | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const s = String(p ?? '').trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.length ? out.join(', ') : null;
}

/**
 * Returns a short place label e.g. "Jaipur, Rajasthan, India", or null.
 */
export async function resolveIpLocation(ip: string | null | undefined): Promise<string | null> {
  const raw = String(ip ?? '').trim().slice(0, 45);
  if (!raw) return null;
  if (cache.has(raw)) return cache.get(raw) ?? null;

  if (isPrivateOrLocalIp(raw)) {
    cache.set(raw, 'Local / private network');
    return 'Local / private network';
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(raw)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);

    if (!res.ok) {
      cache.set(raw, null);
      return null;
    }

    const data = (await res.json()) as {
      success?: boolean;
      city?: string;
      region?: string;
      country?: string;
    };

    if (data.success === false) {
      cache.set(raw, null);
      return null;
    }

    const label = buildLabel([data.city, data.region, data.country]);
    cache.set(raw, label);
    return label;
  } catch {
    // Don't cache hard failures forever so next attempt can succeed
    return null;
  }
}
