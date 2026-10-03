import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';

const ENC_PREFIX = 'v1';

function settingsKey(): Buffer {
  const raw = (process.env.PAN_ENCRYPTION_KEY ?? process.env.ADMIN_INTERNAL_KEY ?? '').trim();
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('PAN_ENCRYPTION_KEY or ADMIN_INTERNAL_KEY is required to store WhatsApp settings');
    }
    return createHmac('sha256', 'az-settings-dev-only')
      .update('apnizaroorat-whatsapp-settings-dev-key')
      .digest();
  }
  return createHmac('sha256', raw).update('az-whatsapp-settings-v1').digest();
}

/** AES-256-GCM. Format: v1:<iv_b64>:<tag_b64>:<ct_b64> */
export function encryptSettingsJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', settingsKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    ENC_PREFIX,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptSettingsJson<T>(payload: string): T | null {
  const parts = String(payload ?? '').split(':');
  if (parts.length !== 4 || parts[0] !== ENC_PREFIX) return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const data = Buffer.from(parts[3], 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', settingsKey(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as T;
  } catch {
    return null;
  }
}
