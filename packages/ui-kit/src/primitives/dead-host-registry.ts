const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_DNS_THRESHOLD = 1;
const DEFAULT_NETWORK_THRESHOLD = 2;
const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_TRACKED_HOSTS = 256;

const HTTP_4XX_PATTERN = /\b4(?:0[0134]|10|29)\b|not found|forbidden|unauthorized|http\s*4\d\d/i;
const DNS_PATTERN =
  /enotfound|unknownhostexception|eai_noname|err_name_not_resolved|nsurlerrorcannotfindhost|cannot find host|dns|nxdomain|unable to resolve host/i;
const NETWORK_PATTERN =
  /econnrefused|enetunreach|ehostunreach|etimedout|err_connection_refused|err_connection_timed_out|err_internet_disconnected|connectexception|sockettimeoutexception|cannot connect to host|network connection was lost|timed out/i;

/** Coarse error category returned by {@link classifyImageError}. */
export type ImageErrorKind = 'dns' | 'network' | 'http-4xx' | 'unknown';

/** Optional structured details extracted from a native or web image load error event. */
export interface ImageErrorInfo {
  readonly message?: string;
  readonly statusCode?: number;
}

/**
 * Safely extracts structured {@link ImageErrorInfo} from a React Native or web `Image` `onError`
 * event without assuming platform-specific event shapes (`#202`).
 */
export function extractNativeImageError(event: unknown): ImageErrorInfo | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const nativeEvent = (event as { nativeEvent?: unknown }).nativeEvent;
  if (typeof nativeEvent !== 'object' || nativeEvent === null) return undefined;
  const rawError = (nativeEvent as { error?: unknown }).error;
  const rawStatus = (nativeEvent as { statusCode?: unknown }).statusCode;
  let message: string | undefined;
  if (typeof rawError === 'string' && rawError.length > 0) {
    message = rawError;
  } else if (
    typeof rawError === 'object' &&
    rawError !== null &&
    typeof (rawError as { message?: unknown }).message === 'string'
  ) {
    message = (rawError as { message: string }).message;
  }
  const statusCode = typeof rawStatus === 'number' ? rawStatus : undefined;
  if (message === undefined && statusCode === undefined) return undefined;
  return {
    ...(message !== undefined ? { message } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
  };
}

/**
 * Classifies an image load failure so dead DNS hosts short-circuit immediately while single
 * missing posters (HTTP 404/4xx) never blacklist a healthy CDN host (`#202`).
 */
export function classifyImageError(error?: ImageErrorInfo): ImageErrorKind {
  if (error === undefined) return 'unknown';
  if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
    return 'http-4xx';
  }
  const message = error.message?.trim() ?? '';
  if (message.length === 0) return 'unknown';
  if (HTTP_4XX_PATTERN.test(message)) return 'http-4xx';
  if (DNS_PATTERN.test(message)) return 'dns';
  if (NETWORK_PATTERN.test(message)) return 'network';
  return 'unknown';
}

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
  recordFailure(uri: string, error?: ImageErrorInfo): boolean;
  recordSuccess(uri: string): void;
  reset(): void;
}

/** Configuration for {@link createDeadHostRegistry}. */
export interface DeadHostRegistryOptions {
  /** Failure weight threshold for `'unknown'` errors (default `3`). */
  failureThreshold?: number;
  /** Number of confirmed DNS/NXDOMAIN errors required to trip a host (default `1`). */
  dnsThreshold?: number;
  /** Number of confirmed network errors required to trip a host (default `2`). */
  networkThreshold?: number;
  /** Milliseconds a tripped host stays short-circuited before auto-recovery (default `300_000`). */
  ttlMs?: number;
  /** Maximum distinct hosts tracked before evicting the oldest entry (default `256`). */
  maxHosts?: number;
  /** Injectable wall-clock provider for deterministic TTL expiry tests (default `Date.now`). */
  now?: () => number;
}

interface HostFailureEntry {
  count: number;
  trippedAtMs: number | null;
}

/** Creates an isolated {@link DeadHostRegistry} instance. */
export function createDeadHostRegistry(opts?: DeadHostRegistryOptions): DeadHostRegistry {
  const threshold = Math.max(1, opts?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
  const dnsThreshold = Math.max(1, opts?.dnsThreshold ?? DEFAULT_DNS_THRESHOLD);
  const networkThreshold = Math.max(1, opts?.networkThreshold ?? DEFAULT_NETWORK_THRESHOLD);
  const ttlMs = Math.max(1, opts?.ttlMs ?? DEFAULT_TTL_MS);
  const maxHosts = Math.max(16, opts?.maxHosts ?? DEFAULT_MAX_TRACKED_HOSTS);
  const now = opts?.now ?? Date.now;
  const failures = new Map<string, HostFailureEntry>();

  const isExpired = (entry: HostFailureEntry, currentMs: number): boolean =>
    entry.trippedAtMs !== null && currentMs - entry.trippedAtMs >= ttlMs;

  const touch = (host: string, entry: HostFailureEntry): void => {
    failures.delete(host);
    failures.set(host, entry);
    if (failures.size > maxHosts) {
      const oldest = failures.keys().next().value;
      if (oldest !== undefined) failures.delete(oldest);
    }
  };

  const weightFor = (kind: ImageErrorKind): number => {
    switch (kind) {
      case 'dns':
        return Math.ceil(threshold / dnsThreshold);
      case 'network':
        return Math.ceil(threshold / networkThreshold);
      case 'unknown':
        return 1;
      case 'http-4xx':
        return 0;
    }
  };

  return {
    isDead(uri: string): boolean {
      const host = extractArtworkHost(uri);
      if (host === null) return false;
      const entry = failures.get(host);
      if (entry === undefined) return false;
      if (isExpired(entry, now())) {
        failures.delete(host);
        return false;
      }
      return entry.count >= threshold;
    },
    recordFailure(uri: string, error?: ImageErrorInfo): boolean {
      const host = extractArtworkHost(uri);
      if (host === null) return false;
      const kind = classifyImageError(error);
      if (kind === 'http-4xx') return false;
      const currentMs = now();
      const existing = failures.get(host);
      const baseCount =
        existing !== undefined && !isExpired(existing, currentMs) ? existing.count : 0;
      const nextCount = baseCount + weightFor(kind);
      const tripped = nextCount >= threshold;
      const existingTrippedAt =
        existing !== undefined && !isExpired(existing, currentMs) ? existing.trippedAtMs : null;
      touch(host, {
        count: nextCount,
        trippedAtMs: tripped ? (existingTrippedAt ?? currentMs) : null,
      });
      return tripped;
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
