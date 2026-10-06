import { createHmac, timingSafeEqual } from 'crypto';

function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Meta webhook handshake: GET ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
 * On match return the challenge string (plain text). Otherwise null.
 */
export function whatsappHubChallenge(input: {
  mode?: string;
  token?: string;
  challenge?: string;
  expectedToken: string;
}): string | null {
  const expected = String(input.expectedToken ?? '').trim();
  const token = String(input.token ?? '').trim();
  const mode = String(input.mode ?? '').trim();
  const challenge = String(input.challenge ?? '');
  if (!expected || mode !== 'subscribe' || !challenge) return null;
  if (!tokensEqual(token, expected)) return null;
  return challenge;
}

/**
 * Meta X-Hub-Signature-256. Missing app secret or bad signature is rejected.
 */
export function whatsappSignatureOk(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  const secret = String(appSecret ?? '').trim();
  if (!secret) return false;
  const header = String(signatureHeader ?? '').trim();
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header);
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return tokensEqual(expected.toLowerCase(), match[1].toLowerCase());
}
