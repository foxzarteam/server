/**
 * MPIN brute-force protection (4-digit space).
 * Process-local buckets — pair with Redis in multi-instance production when available.
 */
type LockState = { fails: number; lockedUntil: number };

const locks = new Map<string, LockState>();

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;
const FAIL_WINDOW_MS = 15 * 60_000;

function prune(key: string, now: number): LockState {
  const cur = locks.get(key);
  if (!cur) return { fails: 0, lockedUntil: 0 };
  if (cur.lockedUntil && cur.lockedUntil < now) {
    locks.delete(key);
    return { fails: 0, lockedUntil: 0 };
  }
  return cur;
}

export function isMpinLocked(mobile: string): { locked: boolean; retryAfterSec: number } {
  const key = mobile.trim();
  const now = Date.now();
  const cur = prune(key, now);
  if (cur.lockedUntil > now) {
    return { locked: true, retryAfterSec: Math.ceil((cur.lockedUntil - now) / 1000) };
  }
  return { locked: false, retryAfterSec: 0 };
}

export function recordMpinFailure(mobile: string): { locked: boolean; retryAfterSec: number } {
  const key = mobile.trim();
  const now = Date.now();
  const cur = prune(key, now);
  const fails = cur.fails + 1;
  if (fails >= MAX_FAILS) {
    const lockedUntil = now + LOCK_MS;
    locks.set(key, { fails, lockedUntil });
    return { locked: true, retryAfterSec: Math.ceil(LOCK_MS / 1000) };
  }
  locks.set(key, { fails, lockedUntil: 0 });
  // Soft decay: clear fails after window if no lock
  setTimeout(() => {
    const latest = locks.get(key);
    if (latest && latest.fails === fails && !latest.lockedUntil) {
      locks.delete(key);
    }
  }, FAIL_WINDOW_MS).unref?.();
  return { locked: false, retryAfterSec: 0 };
}

export function clearMpinFailures(mobile: string): void {
  locks.delete(mobile.trim());
}
