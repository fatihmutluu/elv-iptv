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

/** Proxy header trust policy for extracting client IP keys. */
export type TrustProxyMode = 'cloudflare' | 'none';

/** Default per-IP rate limits by route group. */
export interface RateLimitConfig {
  readonly auth: RateLimitRule;
  readonly authCheckEmail: RateLimitRule;
  readonly pair: RateLimitRule;
  readonly pairLookup: RateLimitRule;
  readonly vault: RateLimitRule;
  readonly telemetry: RateLimitRule;
  readonly feedback: RateLimitRule;
  readonly accountDeletion: RateLimitRule;
  readonly admin: RateLimitRule;
  readonly elvMatch: RateLimitRule;
  readonly elvDetail: RateLimitRule;
  readonly elvFeeds: RateLimitRule;
  readonly elvSearch: RateLimitRule;
}

/** Production default per-IP sliding-window limits. */
export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  auth: { windowMs: 60_000, maxRequests: 30 },
  authCheckEmail: { windowMs: 60_000, maxRequests: 20 },
  pair: { windowMs: 60_000, maxRequests: 60 },
  pairLookup: { windowMs: 60_000, maxRequests: 20 },
  vault: { windowMs: 60_000, maxRequests: 60 },
  telemetry: { windowMs: 60_000, maxRequests: 120 },
  feedback: { windowMs: 60_000, maxRequests: 15 },
  accountDeletion: { windowMs: 60_000, maxRequests: 10 },
  admin: { windowMs: 60_000, maxRequests: 30 },
  elvMatch: { windowMs: 60_000, maxRequests: 120 },
  elvDetail: { windowMs: 60_000, maxRequests: 180 },
  elvFeeds: { windowMs: 60_000, maxRequests: 60 },
  elvSearch: { windowMs: 60_000, maxRequests: 60 },
};

const DEFAULT_MAX_TRACKED_BUCKETS = 10_000;
const PRUNE_INTERVAL_MS = 30_000;

interface BucketEntry {
  readonly timestamps: number[];
  readonly expiresAt: number;
}

/**
 * Extracts a client IP key honoring the explicit proxy trust policy.
 * Never trusts client-supplied `x-forwarded-for` or `x-real-ip` headers.
 */
export function extractClientIp(
  request: Request,
  trustProxy: TrustProxyMode = 'none',
  directClientIp?: string,
): string {
  if (trustProxy === 'cloudflare') {
    const cfIp = request.headers.get('cf-connecting-ip')?.trim();
    if (cfIp) return cfIp.slice(0, 128);
  }
  const peerIp = directClientIp?.trim();
  if (peerIp) return peerIp.slice(0, 128);
  return 'unknown';
}

/** Creates an in-memory sliding-window rate limiter with O(1) LRU eviction and throttled expiry sweeps. */
export function createSlidingWindowRateLimiter(
  now: () => number = () => Date.now(),
  maxTrackedBuckets = DEFAULT_MAX_TRACKED_BUCKETS,
): SlidingWindowRateLimiter {
  const maxBuckets = Math.max(1, maxTrackedBuckets);
  const buckets = new Map<string, BucketEntry>();
  let lastPruneMs = Number.NEGATIVE_INFINITY;

  function sweepExpired(currentMs: number): void {
    for (const [key, entry] of buckets) {
      if (entry.expiresAt <= currentMs) {
        buckets.delete(key);
      }
    }
    lastPruneMs = currentMs;
  }

  function makeRoomIfAtCapacity(currentMs: number): void {
    if (buckets.size < maxBuckets) return;
    if (currentMs - lastPruneMs >= PRUNE_INTERVAL_MS) {
      sweepExpired(currentMs);
    }
    while (buckets.size >= maxBuckets) {
      const oldest = buckets.keys().next();
      if (oldest.done) break;
      buckets.delete(oldest.value);
    }
  }

  return {
    check(bucket: string, clientKey: string, rule: RateLimitRule): RateLimitDecision {
      const currentMs = now();
      const key = `${bucket}:${clientKey}`;
      const cutoff = currentMs - rule.windowMs;
      const existing = buckets.get(key);
      if (!existing) {
        makeRoomIfAtCapacity(currentMs);
      }
      const active = existing ? existing.timestamps.filter((ts) => ts > cutoff) : [];

      if (active.length >= rule.maxRequests) {
        const oldest = active[0] ?? currentMs;
        const retryAfterMs = Math.max(1_000, oldest + rule.windowMs - currentMs);
        const latest = active[active.length - 1] ?? currentMs;
        buckets.delete(key);
        buckets.set(key, { timestamps: active, expiresAt: latest + rule.windowMs });
        return {
          allowed: false,
          remaining: 0,
          retryAfterSec: Math.ceil(retryAfterMs / 1_000),
        };
      }

      active.push(currentMs);
      buckets.delete(key);
      buckets.set(key, { timestamps: active, expiresAt: currentMs + rule.windowMs });
      return {
        allowed: true,
        remaining: Math.max(0, rule.maxRequests - active.length),
        retryAfterSec: 0,
      };
    },
  };
}
