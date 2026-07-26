import * as bcrypt from 'bcryptjs';

const MPIN_ROUNDS = 10;

export function storedMpinLooksBcrypt(stored: string): boolean {
  const s = stored.trim();
  return s.length >= 59 && /^\$2[aby]\$\d{2}\$/.test(s);
}

export async function hashMpin(plain: string): Promise<string> {
  return bcrypt.hash(plain.trim(), MPIN_ROUNDS);
}

export async function mpinMatches(plain: string, storedRaw: string | null | undefined): Promise<boolean> {
  const stored = String(storedRaw ?? '').trim();
  const p = plain.trim();
  if (!stored || !p) return false;
  if (storedMpinLooksBcrypt(stored)) {
    try {
      return await bcrypt.compare(p, stored);
    } catch {
      return false;
    }
  }
  // Legacy plaintext rows (migrate on next successful verify).
  return p === stored;
}

/** Public user shape — never includes mpin. */
export function sanitizeUserPublic(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) return null;
  const { mpin: _mpin, ...rest } = row;
  const hasMpin = String(_mpin ?? '').trim().length > 0;
  return { ...rest, has_mpin: hasMpin };
}
