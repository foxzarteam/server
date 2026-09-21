/**
 * Resolve applicant / browser IP for lead attribution.
 * Prefers x-az-client-ip (Next BFF) then body.clientIp (BFF-injected JSON),
 * because Cloudflare/ALB often overwrite X-Forwarded-For with the proxy IP.
 */

import { isPrivateOrLocalIp } from './ip-geo';

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  names: string[],
): string | null {
  for (const name of names) {
    const raw = headers[name];
    const headerVal = Array.isArray(raw) ? raw[0] : raw;
    if (typeof headerVal === 'string' && headerVal.trim()) return headerVal;
  }
  return null;
}

function firstPublicHop(value: string): string | null {
  for (const part of value.split(',')) {
    let hop = part.trim();
    if (!hop) continue;
    if (hop.startsWith('::ffff:')) hop = hop.slice(7);
    if (!isPrivateOrLocalIp(hop)) return hop.slice(0, 45);
  }
  return null;
}

export function extractClientIp(
  headers: Record<string, string | string[] | undefined>,
  socketIp?: string | null,
  bodyIp?: string | null,
): string | null {
  const az = headerValue(headers, ['x-az-client-ip', 'X-Az-Client-Ip']);
  if (az) {
    const hop = firstPublicHop(az);
    if (hop) return hop;
  }

  if (bodyIp) {
    const hop = firstPublicHop(bodyIp);
    if (hop) return hop;
  }

  const chain = headerValue(headers, [
    'x-forwarded-for',
    'X-Forwarded-For',
    'x-real-ip',
    'X-Real-Ip',
    'cf-connecting-ip',
    'CF-Connecting-IP',
    'true-client-ip',
    'True-Client-Ip',
    'x-vercel-forwarded-for',
    'X-Vercel-Forwarded-For',
  ]);
  if (chain) {
    const hop = firstPublicHop(chain);
    if (hop) return hop;
  }

  const sock = (socketIp ?? '').trim();
  if (!sock) return null;
  const v4 = sock.startsWith('::ffff:') ? sock.slice(7) : sock;
  if (!v4 || isPrivateOrLocalIp(v4)) return null;
  return v4.slice(0, 45) || null;
}
