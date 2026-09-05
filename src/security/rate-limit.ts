/**
 * Simple in-memory rate limiter for sensitive actions (PAN reveal, login, etc.).
 * Per-process only — fine for single Nest instance / serverless warm isolate.
 * Pair with Redis in multi-instance production when available.
 */
const buckets = new Map<string, number[]>();

export function allowRateLimitedAction(
  key: string,
  maxPerWindow = 10,
  windowMs = 60_000,
): boolean {
  const now = Date.now();
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= maxPerWindow) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  return true;
}

/** Convenience: same as allowRateLimitedAction with a longer default window (15 min). */
export function allowRateLimitedActionLong(
  key: string,
  maxPerWindow = 20,
  windowMs = 15 * 60_000,
): boolean {
  return allowRateLimitedAction(key, maxPerWindow, windowMs);
}
