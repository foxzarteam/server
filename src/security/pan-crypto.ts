import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** Indian PAN: 5 letters + 4 digits + 1 letter. */
export const PAN_FORMAT_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** Stored / displayed mask: ABCDE****F */
export const PAN_MASK_REGEX = /^[A-Z]{5}\*{4}[A-Z]$/;

const ENC_PREFIX = 'v1';

function requireKey(): Buffer {
  const raw = (process.env.PAN_ENCRYPTION_KEY ?? '').trim();
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('PAN_ENCRYPTION_KEY is required in production');
    }
    // 32-byte deterministic dev fallback (NOT for production).
    return createHmac('sha256', 'az-pan-dev-only')
      .update('apnizaroorat-pan-encryption-dev-key')
      .digest();
  }

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === 32) return b64;

  throw new Error(
    'PAN_ENCRYPTION_KEY must be 64 hex chars (32 bytes) or 32-byte base64',
  );
}

function hmacKey(): Buffer {
  return createHmac('sha256', requireKey()).update('az-pan-hmac-v1').digest();
}

export function normalizePan(input: string): string {
  return String(input ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

export function isValidPanFormat(pan: string): boolean {
  return PAN_FORMAT_REGEX.test(normalizePan(pan));
}

export function isMaskedPan(value: string): boolean {
  return PAN_MASK_REGEX.test(String(value ?? '').trim().toUpperCase());
}

/**
 * Mask for UI / API: first 5 + **** + last char → ABCDE****F
 */
export function maskPan(pan: string): string {
  const p = normalizePan(pan);
  if (isMaskedPan(p)) return p;
  if (!isValidPanFormat(p)) {
    if (p.length >= 6) return `${p.slice(0, 5)}****${p.slice(-1)}`;
    return 'XXXXX****X';
  }
  return `${p.slice(0, 5)}****${p.slice(-1)}`;
}

/** Deterministic HMAC for uniqueness / lookup. Never reversible to PAN. */
export function hashPan(pan: string): string {
  const p = normalizePan(pan);
  return createHmac('sha256', hmacKey()).update(`pan:${p}`).digest('hex');
}

/**
 * AES-256-GCM encrypt. Format: v1:<iv_b64>:<tag_b64>:<ct_b64>
 */
export function encryptPan(pan: string): string {
  const p = normalizePan(pan);
  if (!isValidPanFormat(p)) {
    throw new Error('Invalid PAN format');
  }
  const key = requireKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(p, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENC_PREFIX,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

export function decryptPan(ciphertext: string): string {
  const raw = String(ciphertext ?? '').trim();
  const parts = raw.split(':');
  if (parts.length !== 4 || parts[0] !== ENC_PREFIX) {
    throw new Error('Invalid PAN ciphertext');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const key = requireKey();
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(ctB64, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  const normalized = normalizePan(plain);
  if (!isValidPanFormat(normalized)) {
    throw new Error('Decrypted PAN failed validation');
  }
  return normalized;
}

export function panStorageFields(pan: string): {
  pan: string;
  pan_encrypted: string;
  pan_hash: string;
} {
  const normalized = normalizePan(pan);
  if (!isValidPanFormat(normalized)) {
    throw new Error('Invalid PAN format');
  }
  return {
    pan: maskPan(normalized),
    pan_encrypted: encryptPan(normalized),
    pan_hash: hashPan(normalized),
  };
}

/** Safe for logs / error dumps — never include ciphertext or plaintext PAN. */
export function redactSensitiveLeadPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...payload };
  if ('pan' in out) out.pan = maskPan(String(out.pan ?? ''));
  if ('pan_encrypted' in out) out.pan_encrypted = '[REDACTED]';
  if ('pan_hash' in out) out.pan_hash = '[REDACTED]';
  return out;
}

/**
 * Strip crypto columns and ensure `pan` is masked for any API response.
 * Legacy plaintext rows are masked on the fly (not re-written here).
 */
export function toSafeLeadRow(row: Record<string, unknown>): Record<string, unknown> {
  const { pan_encrypted: _enc, pan_hash: _hash, ...rest } = row;
  const stored = String(row.pan ?? '');
  let masked = stored;
  if (isValidPanFormat(stored)) {
    masked = maskPan(stored);
  } else if (isMaskedPan(stored)) {
    masked = normalizePan(stored);
  } else if (row.pan_encrypted) {
    try {
      masked = maskPan(decryptPan(String(row.pan_encrypted)));
    } catch {
      masked = 'XXXXX****X';
    }
  }
  return { ...rest, pan: masked };
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}
