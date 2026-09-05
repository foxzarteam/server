import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export type AdminActor = {
  sub: string;
  email: string;
  role: string;
  exp: number;
  jti: string;
};

const DEV_FALLBACK = 'local-dev-admin-actor-not-for-prod';

function actorSecret(): string {
  const fromEnv = (
    process.env.ADMIN_ACTOR_SECRET ??
    process.env.ADMIN_INTERNAL_KEY ??
    ''
  ).trim();
  if (fromEnv) {
    if (fromEnv.length < 16 && process.env.NODE_ENV === 'production') {
      throw new Error('ADMIN_ACTOR_SECRET / ADMIN_INTERNAL_KEY must be at least 16 characters');
    }
    return fromEnv;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ADMIN_ACTOR_SECRET or ADMIN_INTERNAL_KEY is required in production');
  }
  return DEV_FALLBACK;
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/** Sign BFF CRM actor identity (Nest trusts this, not request body). */
export function signAdminActor(input: {
  sub: string;
  email: string;
  role: string;
  ttlSec?: number;
}): string {
  const ttl = input.ttlSec ?? 60 * 10; // 10 minutes
  const payload: AdminActor = {
    sub: String(input.sub).trim(),
    email: String(input.email).trim().toLowerCase(),
    role: String(input.role).trim().toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + ttl,
    jti: randomBytes(12).toString('hex'),
  };
  const body = JSON.stringify(payload);
  const sig = createHmac('sha256', actorSecret()).update(body).digest('hex');
  return Buffer.from(`${body}::${sig}`, 'utf8').toString('base64url');
}

export function verifyAdminActor(token: string | undefined | null): AdminActor | null {
  if (!token?.trim()) return null;
  try {
    const raw = Buffer.from(token.trim(), 'base64url').toString('utf8');
    const idx = raw.lastIndexOf('::');
    if (idx === -1) return null;
    const body = raw.slice(0, idx);
    const sig = raw.slice(idx + 2);
    const expected = createHmac('sha256', actorSecret()).update(body).digest('hex');
    if (!safeEqualHex(sig, expected)) return null;
    const payload = JSON.parse(body) as AdminActor;
    if (
      typeof payload.exp !== 'number' ||
      payload.exp < Math.floor(Date.now() / 1000) ||
      !payload.sub ||
      !payload.role
    ) {
      return null;
    }
    return {
      sub: String(payload.sub),
      email: String(payload.email ?? ''),
      role: String(payload.role).toLowerCase(),
      exp: payload.exp,
      jti: String(payload.jti ?? ''),
    };
  } catch {
    return null;
  }
}

export function isCrmAdminActor(actor: AdminActor | null): boolean {
  if (!actor) return false;
  return actor.role === 'admin' || actor.role === 'staff';
}

export function extractAdminActorToken(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers['x-admin-actor'] ?? headers['X-Admin-Actor'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}
