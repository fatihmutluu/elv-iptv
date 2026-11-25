/** Sliding-window limit configuration for a route group. */
interface RateLimitRule {
  readonly windowMs: number;
  readonly maxRequests: number;
}

/** Outcome of checking a request against a sliding-window limiter. */
interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSec: number;
}

/** Sliding-window per-key rate limiter interface. */
export interface SlidingWindowRateLimiter {
  check(bucket: string, clientKey: string, rule: RateLimitRule): RateLimitDecision;
}

/** Default per-IP rate limits by route group. */
export interface RateLimitConfig {
  readonly auth: RateLimitRule;
  readonly pair: RateLimitRule;
  readonly telemetry: RateLimitRule;
  readonly feedback: RateLimitRule;
  readonly accountDeletion: RateLimitRule;
}

/** Production default per-IP sliding-window limits. */
export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  auth: { windowMs: 60_000, maxRequests: 30 },
  pair: { windowMs: 60_000, maxRequests: 60 },
  telemetry: { windowMs: 60_000, maxRequests: 120 },
  feedback: { windowMs: 60_000, maxRequests: 15 },
  accountDeletion: { windowMs: 60_000, maxRequests: 10 },
};

const MAX_TRACKED_BUCKETS = 10_000;

/** Extracts a best-effort client IP key from Cloudflare / proxy headers. */
export function extractClientIp(request: Request): string {
  const cfIp = request.headers.get('cf-connecting-ip')?.trim();
  if (cfIp) return cfIp.slice(0, 128);
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first.slice(0, 128);
  }
  const realIp = request.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp.slice(0, 128);
  return 'unknown';
}

/** Creates an in-memory sliding-window rate limiter with bounded key eviction. */
export function createSlidingWindowRateLimiter(
  now: () => number = () => Date.now(),
): SlidingWindowRateLimiter {
  const buckets = new Map<string, number[]>();

  function pruneOldEntries(currentMs: number, maxWindowMs: number): void {
    const cutoff = currentMs - maxWindowMs;
    for (const [key, timestamps] of buckets) {
      const kept = timestamps.filter((ts) => ts > cutoff);
      if (kept.length === 0) {
        buckets.delete(key);
      } else {
        buckets.set(key, kept);
      }
    }
    if (buckets.size > MAX_TRACKED_BUCKETS) {
      let toDelete = buckets.size - MAX_TRACKED_BUCKETS;
      for (const key of buckets.keys()) {
        buckets.delete(key);
        toDelete -= 1;
        if (toDelete <= 0) break;
      }
    }
  }

  return {
    check(bucket: string, clientKey: string, rule: RateLimitRule): RateLimitDecision {
      const currentMs = now();
      if (buckets.size > MAX_TRACKED_BUCKETS) {
        pruneOldEntries(currentMs, rule.windowMs);
      }
      const key = `${bucket}:${clientKey}`;
      const cutoff = currentMs - rule.windowMs;
      const existing = buckets.get(key) ?? [];
      const active = existing.filter((ts) => ts > cutoff);

      if (active.length >= rule.maxRequests) {
        const oldest = active[0] ?? currentMs;
        const retryAfterMs = Math.max(1_000, oldest + rule.windowMs - currentMs);
        buckets.set(key, active);
        return {
          allowed: false,
          remaining: 0,
          retryAfterSec: Math.ceil(retryAfterMs / 1_000),
        };
      }

      active.push(currentMs);
      buckets.set(key, active);
      return {
        allowed: true,
        remaining: Math.max(0, rule.maxRequests - active.length),
        retryAfterSec: 0,
      };
    },
  };
}
