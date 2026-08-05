/**
 * Best-effort city / region / country from public IP (cached).
 * Free HTTPS geo API — time-capped so it never blocks lead create.
 */

const GEO_TIMEOUT_MS = 2_500;
const cache = new Map<string, string | null>();

/** Exported for unit tests + shared private-range detection. */
export function isPrivateOrLocalIp(ip: string): boolean {
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

/** Join unique place parts without empty/dupes. */
export function buildLocationLabel(parts: Array<string | null | undefined>): string | null {
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

    const label = buildLocationLabel([data.city, data.region, data.country]);
    cache.set(raw, label);
    return label;
  } catch {
    // Don't cache hard failures forever so next attempt can succeed
    return null;
  }
}

/** Resolve many IPs with limited concurrency (admin enrich). */
export async function resolveIpLocationsBatch(
  ips: string[],
  concurrency = 5,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const unique = [...new Set(ips.map((i) => i.trim()).filter(Boolean))];
  let idx = 0;

  async function worker() {
    while (idx < unique.length) {
      const i = idx++;
      const ip = unique[i]!;
      out.set(ip, await resolveIpLocation(ip));
    }
  }

  const n = Math.max(1, Math.min(concurrency, unique.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}
