/**
 * Fixed-window, in-memory rate limits for the few endpoints reachable
 * without a session (OAuth registration and token exchange, the MCP
 * endpoint). The app runs as one Railway instance, so process memory is
 * the whole picture; a restart only resets the counters.
 */
type Window = { start: number; count: number };

const buckets = new Map<string, Window>();

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const w = buckets.get(key);
  if (!w || now - w.start >= windowMs) {
    buckets.set(key, { start: now, count: 1 });
    if (buckets.size > 10_000) prune(now, windowMs);
    return true;
  }
  w.count += 1;
  return w.count <= limit;
}

function prune(now: number, windowMs: number) {
  for (const [k, w] of buckets) if (now - w.start >= windowMs) buckets.delete(k);
}

/** For tests. */
export function resetRateLimits() {
  buckets.clear();
}

/** Caller address as Railway's edge reports it. Only used to key limits. */
export function clientAddress(req: Request): string {
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
