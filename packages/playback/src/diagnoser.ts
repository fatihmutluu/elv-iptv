import type { ElvError } from '@elv/domain';
import type { PlaybackClock } from './types';

/** Default monotonic-clock TTL (ms) for cached account health snapshots (`#316`). */
export const DEFAULT_ACCOUNT_HEALTH_TTL_MS = 60_000;

/** Actionable high-level cause of a playback failure (`#316`). */
export type PlaybackVerdict =
  | 'offline'
  | 'account-expired'
  | 'account-disabled'
  | 'connection-limit'
  | 'auth-failed'
  | 'not-found'
  | 'server-silent'
  | 'codec-unsupported'
  | 'upstream-error'
  | 'network-error'
  | 'unknown';

/** Minimal provider account status snapshot used for playback failure diagnosis. */
export interface AccountHealthSnapshot {
  readonly status: string;
  readonly expiresAt?: number;
  readonly activeConnections?: number;
  readonly maxConnections?: number;
}

/** Input signals fed into {@link diagnosePlaybackFailure} and {@link PlaybackDiagnoser.diagnose}. */
export interface PlaybackDiagnosisInput {
  readonly error: ElvError;
  readonly online?: boolean;
  readonly bytesReceived?: number;
  readonly httpStatus?: number;
  readonly url?: string;
  readonly accountKey?: string;
  readonly accountHealth?: AccountHealthSnapshot;
  readonly nowWallMs?: number;
}

/** Redacted diagnosis result suitable for display or diagnostics without leaking secrets. */
export interface PlaybackDiagnosis {
  readonly verdict: PlaybackVerdict;
  readonly evidence: string;
  readonly httpStatus?: number;
  readonly host?: string;
}

/** Dependencies of {@link createPlaybackDiagnoser}. */
export interface PlaybackDiagnoserDeps {
  readonly clock: PlaybackClock;
  readonly checkAccountHealth?: (accountKey: string) => Promise<AccountHealthSnapshot | undefined>;
  readonly ttlMs?: number;
  readonly nowWallMs?: () => number;
}

/** Stateful playback failure diagnoser with monotonic-TTL account health caching (`#316`). */
export interface PlaybackDiagnoser {
  diagnose(input: PlaybackDiagnosisInput): Promise<PlaybackDiagnosis>;
  invalidate(accountKey?: string): void;
  clear(): void;
}

const DISABLED_STATUSES = new Set(['disabled', 'banned', 'suspended', 'inactive']);
const ALLOWED_STREAM_PROTOCOLS = new Set(['http:', 'https:', 'rtmp:', 'rtmps:', 'rtsp:', 'rtsps:']);
const AUTH_HTTP_STATUSES = new Set([401, 403, 407]);
const NOT_FOUND_HTTP_STATUSES = new Set([404, 410]);
const LIMIT_HTTP_STATUSES = new Set([429, 458, 460, 461, 462, 463, 469, 509]);
const SAFE_TOKEN = /^[a-zA-Z0-9._-]+$/;

/**
 * Extracts strictly `hostname[:port]` (lowercased, IPv6 brackets preserved) from `url`.
 * Never returns userinfo (`user:pass@`), path, query parameters, or fragments.
 */
export function extractRedactedHost(url?: string): string | undefined {
  if (url === undefined) return undefined;
  const trimmed = url.trim();
  if (trimmed === '') return undefined;
  try {
    const parsed = new URL(trimmed);
    if (!ALLOWED_STREAM_PROTOCOLS.has(parsed.protocol.toLowerCase())) return undefined;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === '') return undefined;
    const host = parsed.port ? `${hostname}:${parsed.port}` : hostname;
    if (host.includes('@') || host.includes('/') || host.includes('?') || host.includes('#')) {
      return undefined;
    }
    return host;
  } catch {
    return undefined;
  }
}

function validHttpStatus(status: number | undefined): number | undefined {
  if (status === undefined || !Number.isInteger(status) || status < 100 || status > 599) {
    return undefined;
  }
  return status;
}

function diagnoseAccountHealth(
  health: AccountHealthSnapshot | undefined,
  nowWallMs: number,
): PlaybackVerdict | undefined {
  if (health === undefined) return undefined;
  const status = health.status.trim().toLowerCase();
  if (status === 'expired') return 'account-expired';
  if (DISABLED_STATUSES.has(status)) return 'account-disabled';
  if (
    health.expiresAt !== undefined &&
    Number.isFinite(health.expiresAt) &&
    health.expiresAt > 0 &&
    health.expiresAt <= nowWallMs
  ) {
    return 'account-expired';
  }
  if (
    health.maxConnections !== undefined &&
    health.activeConnections !== undefined &&
    Number.isFinite(health.maxConnections) &&
    Number.isFinite(health.activeConnections) &&
    health.maxConnections > 0 &&
    health.activeConnections >= health.maxConnections
  ) {
    return 'connection-limit';
  }
  return undefined;
}

function sanitizeCodeToken(raw: string): string {
  return SAFE_TOKEN.test(raw) ? raw : 'unknown';
}

function buildEvidence(
  error: ElvError,
  host: string | undefined,
  httpStatus: number | undefined,
  bytesReceived: number | undefined,
): string {
  const parts: string[] = [];
  if (host !== undefined) parts.push(`host=${host}`);
  if (httpStatus !== undefined) {
    parts.push(`status=${httpStatus}`);
  } else {
    parts.push(`code=${sanitizeCodeToken(error.category)}/${sanitizeCodeToken(error.code)}`);
  }
  if (bytesReceived !== undefined && Number.isFinite(bytesReceived) && bytesReceived >= 0) {
    parts.push(`bytes=${Math.floor(bytesReceived)}`);
  }
  return parts.join(' ');
}

function classifyVerdict(
  input: PlaybackDiagnosisInput,
  httpStatus: number | undefined,
): PlaybackVerdict {
  if (input.online === false) return 'offline';

  const healthVerdict = diagnoseAccountHealth(input.accountHealth, input.nowWallMs ?? Date.now());
  if (healthVerdict !== undefined) return healthVerdict;

  const { category, code } = input.error;
  if (category === 'auth') {
    if (code === 'expired' || code === 'account-expired') return 'account-expired';
    if (code === 'disabled' || code === 'account-disabled') return 'account-disabled';
    return 'auth-failed';
  }

  if (
    (httpStatus !== undefined && AUTH_HTTP_STATUSES.has(httpStatus)) ||
    code === 'http-401' ||
    code === 'http-403'
  ) {
    return 'auth-failed';
  }

  if (
    (httpStatus !== undefined && NOT_FOUND_HTTP_STATUSES.has(httpStatus)) ||
    code === 'http-404' ||
    code === 'item-not-found'
  ) {
    return 'not-found';
  }

  if (
    (httpStatus !== undefined && LIMIT_HTTP_STATUSES.has(httpStatus)) ||
    code === 'http-429' ||
    code === 'http-509' ||
    code === 'connection-limit' ||
    code === 'rate-limited'
  ) {
    return 'connection-limit';
  }

  if (code === 'decoder' || code === 'unsupported-format' || code === 'unsupported-codec') {
    return 'codec-unsupported';
  }

  const isUpstream5xx = httpStatus !== undefined && httpStatus >= 500;
  const isNetworkOrTimeout =
    category === 'network' ||
    code === 'network' ||
    code === 'timeout' ||
    code === 'unreachable' ||
    code === 'resolve-failed';

  if (input.bytesReceived === 0 && (isUpstream5xx || isNetworkOrTimeout)) {
    return 'server-silent';
  }
  if (isUpstream5xx) return 'upstream-error';
  if (isNetworkOrTimeout) return 'network-error';

  return 'unknown';
}

/** Pure failure classifier producing an actionable verdict and strictly redacted evidence (`#316`). */
export function diagnosePlaybackFailure(input: PlaybackDiagnosisInput): PlaybackDiagnosis {
  const host = extractRedactedHost(input.url);
  const httpStatus = validHttpStatus(input.httpStatus);
  const verdict = classifyVerdict(input, httpStatus);
  const evidence = buildEvidence(input.error, host, httpStatus, input.bytesReceived);
  return {
    verdict,
    evidence,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(host !== undefined ? { host } : {}),
  };
}

interface CacheEntry {
  readonly snapshot: AccountHealthSnapshot | undefined;
  readonly expiresAtMonoMs: number;
}

/**
 * Creates a {@link PlaybackDiagnoser} that caches `checkAccountHealth` results per `accountKey`
 * for `ttlMs` (default 60 s) using a monotonic clock, deduplicating in-flight probes (`#316`).
 */
export function createPlaybackDiagnoser(deps: PlaybackDiagnoserDeps): PlaybackDiagnoser {
  const ttlMs = Math.max(0, deps.ttlMs ?? DEFAULT_ACCOUNT_HEALTH_TTL_MS);
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<AccountHealthSnapshot | undefined>>();
  const keyEpochs = new Map<string, number>();
  let globalEpoch = 0;

  const epochOf = (key: string): number => (keyEpochs.get(key) ?? 0) + globalEpoch;

  const resolveHealth = async (accountKey: string): Promise<AccountHealthSnapshot | undefined> => {
    const probe = deps.checkAccountHealth;
    if (probe === undefined) return undefined;

    const now = deps.clock.now();
    const cached = cache.get(accountKey);
    if (cached !== undefined && now < cached.expiresAtMonoMs) return cached.snapshot;

    const active = inFlight.get(accountKey);
    if (active !== undefined) return active;

    const startedEpoch = epochOf(accountKey);
    const pending = (async (): Promise<AccountHealthSnapshot | undefined> => {
      try {
        const snapshot = await probe(accountKey);
        if (ttlMs > 0 && epochOf(accountKey) === startedEpoch) {
          cache.set(accountKey, { snapshot, expiresAtMonoMs: deps.clock.now() + ttlMs });
        }
        return snapshot;
      } catch {
        return undefined;
      }
    })();

    inFlight.set(accountKey, pending);
    try {
      return await pending;
    } finally {
      if (inFlight.get(accountKey) === pending) inFlight.delete(accountKey);
    }
  };

  return {
    async diagnose(input) {
      if (input.online === false || input.accountHealth !== undefined) {
        return diagnosePlaybackFailure({
          ...input,
          ...(input.nowWallMs === undefined && deps.nowWallMs !== undefined
            ? { nowWallMs: deps.nowWallMs() }
            : {}),
        });
      }

      let accountHealth: AccountHealthSnapshot | undefined;
      if (input.accountKey !== undefined && input.accountKey !== '' && deps.checkAccountHealth) {
        accountHealth = await resolveHealth(input.accountKey);
      }

      return diagnosePlaybackFailure({
        ...input,
        ...(accountHealth !== undefined ? { accountHealth } : {}),
        ...(input.nowWallMs === undefined && deps.nowWallMs !== undefined
          ? { nowWallMs: deps.nowWallMs() }
          : {}),
      });
    },

    invalidate(accountKey) {
      if (accountKey === undefined) {
        this.clear();
        return;
      }
      cache.delete(accountKey);
      inFlight.delete(accountKey);
      keyEpochs.set(accountKey, (keyEpochs.get(accountKey) ?? 0) + 1);
    },

    clear() {
      cache.clear();
      inFlight.clear();
      keyEpochs.clear();
      globalEpoch += 1;
    },
  };
}
