import { normalizeStreamUrl } from '@elv/domain';
import type { PlaybackClock } from './types';

/** Default LRU capacity for {@link createStreamHealthCache} (`#167`). */
export const DEFAULT_STREAM_HEALTH_MAX_ENTRIES = 4_096;

/** Default expiration window (6 hours) for passive stream health entries (`#167`). */
export const DEFAULT_STREAM_HEALTH_TTL_MS = 6 * 60 * 60 * 1_000;

/** Passive stream health classification derived from real tune, stall, and error outcomes (`#167`). */
export type StreamHealthStatus = 'healthy' | 'flaky' | 'dead';

/** Snapshot of passive health telemetry stored for one canonical stream or item key (`#167`). */
export interface StreamHealthEntry {
  readonly status: StreamHealthStatus;
  readonly consecutiveFailures: number;
  readonly stallCount: number;
  readonly lastOutcomeAtMs: number;
  readonly lastSuccessAtMs?: number;
  readonly lastFailureAtMs?: number;
  readonly lastTtffMs?: number;
}

/** Configuration options for {@link createStreamHealthCache}. */
export interface StreamHealthCacheOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly clock?: PlaybackClock;
}

/** TTL-bounded, O(1) LRU passive stream health cache keyed by credential-free canonical keys (`#167`). */
export interface StreamHealthCache {
  get(key: string): StreamHealthEntry | undefined;
  recordSuccess(key: string, ttffMs?: number): StreamHealthEntry | undefined;
  recordStall(key: string): StreamHealthEntry | undefined;
  recordFailure(key: string, terminal?: boolean): StreamHealthEntry | undefined;
  prune(): number;
  clear(): void;
  size(): number;
  snapshot(): ReadonlyMap<string, StreamHealthEntry>;
  subscribe(listener: () => void): () => void;
}

/** Options for starting an idle background stream probe (`#167`). */
export interface IdleProbeOptions {
  readonly maxConnections?: number;
}

/** Coordinates cancellation of background stream probes on tune/navigation while guarding 1-connection accounts (`#167`). */
export interface IdleProbeController {
  beginProbe(opts?: IdleProbeOptions): AbortSignal | null;
  finishProbe(signal: AbortSignal): void;
  abortAll(reason?: string): void;
  activeCount(): number;
}

const DEFAULT_CLOCK: PlaybackClock = { now: () => Date.now() };

/**
 * Canonicalizes a cache/scorer key without leaking credentials: raw URLs (containing `://`) pass
 * through {@link normalizeStreamUrl}, while non-URL item keys are returned trimmed as-is.
 */
export function canonicalizeHealthKey(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.includes('://')) {
    const normalized = normalizeStreamUrl(trimmed);
    return normalized.length > 0 ? normalized : undefined;
  }
  return trimmed;
}

function positiveIntOr(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

/** Creates a bounded LRU + TTL passive stream health cache (`#167`). */
export function createStreamHealthCache(opts?: StreamHealthCacheOptions): StreamHealthCache {
  const maxEntries = positiveIntOr(opts?.maxEntries, DEFAULT_STREAM_HEALTH_MAX_ENTRIES);
  const ttlMs = positiveIntOr(opts?.ttlMs, DEFAULT_STREAM_HEALTH_TTL_MS);
  const clock = opts?.clock ?? DEFAULT_CLOCK;
  const entries = new Map<string, StreamHealthEntry>();
  const listeners = new Set<() => void>();

  const isExpired = (entry: StreamHealthEntry, now: number): boolean =>
    now - entry.lastOutcomeAtMs >= ttlMs;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Subscriber errors must not interrupt health cache updates.
      }
    }
  };

  const readLive = (
    canonical: string,
    now: number,
    touch: boolean,
  ): StreamHealthEntry | undefined => {
    const existing = entries.get(canonical);
    if (existing === undefined) return undefined;
    if (isExpired(existing, now)) {
      entries.delete(canonical);
      return undefined;
    }
    if (touch) {
      entries.delete(canonical);
      entries.set(canonical, existing);
    }
    return existing;
  };

  const writeEntry = (canonical: string, entry: StreamHealthEntry): StreamHealthEntry => {
    entries.delete(canonical);
    while (entries.size >= maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }
    entries.set(canonical, entry);
    notify();
    return entry;
  };

  return {
    get(key) {
      const canonical = canonicalizeHealthKey(key);
      if (canonical === undefined) return undefined;
      return readLive(canonical, clock.now(), true);
    },

    recordSuccess(key, ttffMs) {
      const canonical = canonicalizeHealthKey(key);
      if (canonical === undefined) return undefined;
      const now = clock.now();
      const prev = readLive(canonical, now, false);
      const validTtff =
        ttffMs !== undefined && Number.isFinite(ttffMs) && ttffMs >= 0 ? ttffMs : undefined;
      const lastTtffMs = validTtff ?? prev?.lastTtffMs;
      return writeEntry(canonical, {
        status: 'healthy',
        consecutiveFailures: 0,
        stallCount: 0,
        lastOutcomeAtMs: now,
        lastSuccessAtMs: now,
        ...(prev?.lastFailureAtMs === undefined ? {} : { lastFailureAtMs: prev.lastFailureAtMs }),
        ...(lastTtffMs === undefined ? {} : { lastTtffMs }),
      });
    },

    recordStall(key) {
      const canonical = canonicalizeHealthKey(key);
      if (canonical === undefined) return undefined;
      const now = clock.now();
      const prev = readLive(canonical, now, false);
      const stallCount = (prev?.stallCount ?? 0) + 1;
      const status: StreamHealthStatus =
        prev?.status === 'dead'
          ? 'dead'
          : prev?.status === 'flaky' || stallCount >= 2
            ? 'flaky'
            : 'healthy';
      return writeEntry(canonical, {
        status,
        consecutiveFailures: prev?.consecutiveFailures ?? 0,
        stallCount,
        lastOutcomeAtMs: now,
        ...(prev?.lastSuccessAtMs === undefined ? {} : { lastSuccessAtMs: prev.lastSuccessAtMs }),
        ...(prev?.lastFailureAtMs === undefined ? {} : { lastFailureAtMs: prev.lastFailureAtMs }),
        ...(prev?.lastTtffMs === undefined ? {} : { lastTtffMs: prev.lastTtffMs }),
      });
    },

    recordFailure(key, terminal = false) {
      const canonical = canonicalizeHealthKey(key);
      if (canonical === undefined) return undefined;
      const now = clock.now();
      const prev = readLive(canonical, now, false);
      const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
      const status: StreamHealthStatus = terminal || consecutiveFailures >= 2 ? 'dead' : 'flaky';
      return writeEntry(canonical, {
        status,
        consecutiveFailures,
        stallCount: prev?.stallCount ?? 0,
        lastOutcomeAtMs: now,
        lastFailureAtMs: now,
        ...(prev?.lastSuccessAtMs === undefined ? {} : { lastSuccessAtMs: prev.lastSuccessAtMs }),
        ...(prev?.lastTtffMs === undefined ? {} : { lastTtffMs: prev.lastTtffMs }),
      });
    },

    prune() {
      const now = clock.now();
      let removed = 0;
      for (const [key, entry] of entries) {
        if (isExpired(entry, now)) {
          entries.delete(key);
          removed += 1;
        }
      }
      if (removed > 0) notify();
      return removed;
    },

    clear() {
      if (entries.size === 0) return;
      entries.clear();
      notify();
    },

    size: () => entries.size,

    snapshot() {
      const now = clock.now();
      const out = new Map<string, StreamHealthEntry>();
      for (const [key, entry] of entries) {
        if (isExpired(entry, now)) {
          entries.delete(key);
        } else {
          out.set(key, entry);
        }
      }
      return out;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Creates an {@link IdleProbeController} that skips 1-connection providers and cancels synchronously on tune (`#167`). */
export function createIdleProbeController(): IdleProbeController {
  const active = new Map<AbortSignal, AbortController>();

  return {
    beginProbe(opts) {
      const maxConnections = opts?.maxConnections ?? 1;
      if (!Number.isFinite(maxConnections) || maxConnections <= 1) {
        return null;
      }
      const controller = new AbortController();
      const { signal } = controller;
      active.set(signal, controller);
      signal.addEventListener(
        'abort',
        () => {
          active.delete(signal);
        },
        { once: true },
      );
      return signal;
    },

    finishProbe(signal) {
      active.delete(signal);
    },

    abortAll(reason) {
      if (active.size === 0) return;
      const controllers = [...active.values()];
      active.clear();
      for (const controller of controllers) {
        if (!controller.signal.aborted) {
          controller.abort(reason);
        }
      }
    },

    activeCount: () => active.size,
  };
}
