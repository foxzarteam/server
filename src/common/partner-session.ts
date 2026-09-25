import {
  signAdminActor,
  verifyAdminActor,
  type AdminActor,
} from './admin-actor';

/** Mobile partner session — same HMAC as CRM actor, longer TTL, role=agent only. */
export const PARTNER_TOKEN_TTL_SEC = 60 * 60 * 24 * 30;

export function issuePartnerToken(input: { id: string; mobile: string }): string {
  return signAdminActor({
    sub: String(input.id).trim(),
    email: String(input.mobile).trim(),
    role: 'agent',
    ttlSec: PARTNER_TOKEN_TTL_SEC,
  });
}

export function extractBearerToken(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers['authorization'] ?? headers['Authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const m = /^Bearer\s+(\S+)/i.exec(value.trim());
  return m?.[1]?.trim() || undefined;
}

export function extractPartnerToken(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers['x-partner-token'] ?? headers['X-Partner-Token'];
  const headerTok = Array.isArray(raw) ? raw[0] : raw;
  return headerTok?.trim() || extractBearerToken(headers);
}

export function verifyPartnerActor(token: string | undefined | null): AdminActor | null {
  const actor = verifyAdminActor(token);
  if (!actor || actor.role !== 'agent' || !actor.sub) return null;
  return actor;
}
