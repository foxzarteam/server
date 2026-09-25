import { timingSafeEqual } from 'crypto';

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
