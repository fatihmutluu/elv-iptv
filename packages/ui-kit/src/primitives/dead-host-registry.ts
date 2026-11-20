const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_MAX_TRACKED_HOSTS = 256;

/**
 * Extracts a normalized lowercase `host[:port]` key from an artwork URL, or `null` for invalid or
 * non-HTTP(S) URIs (such as `data:` or malformed strings).
 */
export function extractArtworkHost(uri: string): string | null {
  const trimmed = uri.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  const match = /^https?:\/\/(?:[^/?#@]*@)?((?:\[[^\]]+\]|[^/?#:]+)(?::\d+)?)/i.exec(trimmed);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Bounded per-session circuit breaker short-circuiting dead artwork/logo hosts after consecutive
 * network/DNS load failures (`#202`), preventing scroll stalls on large IPTV channel grids.
 */
export interface DeadHostRegistry {
  isDead(uri: string): boolean;
  recordFailure(uri: string): boolean;
  recordSuccess(uri: string): void;
  reset(): void;
}

/** Configuration for {@link createDeadHostRegistry}. */
export interface DeadHostRegistryOptions {
  failureThreshold?: number;
  maxHosts?: number;
}

/** Creates an isolated {@link DeadHostRegistry} instance. */
export function createDeadHostRegistry(opts?: DeadHostRegistryOptions): DeadHostRegistry {
  const threshold = Math.max(1, opts?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
  const maxHosts = Math.max(16, opts?.maxHosts ?? DEFAULT_MAX_TRACKED_HOSTS);
  const failures = new Map<string, number>();

  const touch = (host: string, count: number): void => {
    failures.delete(host);
    failures.set(host, count);
    if (failures.size > maxHosts) {
      const oldest = failures.keys().next().value;
      if (oldest !== undefined) failures.delete(oldest);
    }
  };

  return {
    isDead(uri: string): boolean {
      const host = extractArtworkHost(uri);
      if (host === null) return false;
      return (failures.get(host) ?? 0) >= threshold;
    },
    recordFailure(uri: string): boolean {
      const host = extractArtworkHost(uri);
      if (host === null) return false;
      const next = (failures.get(host) ?? 0) + 1;
      touch(host, next);
      return next >= threshold;
    },
    recordSuccess(uri: string): void {
      const host = extractArtworkHost(uri);
      if (host !== null) failures.delete(host);
    },
    reset(): void {
      failures.clear();
    },
  };
}

/** Process-wide default dead-host registry shared by {@link ArtworkImage}. */
export const defaultDeadHostRegistry: DeadHostRegistry = createDeadHostRegistry();
