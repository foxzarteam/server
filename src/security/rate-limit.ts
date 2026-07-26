/**
 * Simple in-memory rate limiter for sensitive admin actions (PAN reveal).
 * Per-process only — fine for single Nest instance / serverless warm isolate.
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
