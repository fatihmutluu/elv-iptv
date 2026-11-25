import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Adaptive mpv demuxer readahead tiers (`#196`). */
export type ReadaheadTier = 'fast' | 'normal' | 'aggressive';

/** Readahead buffer duration in seconds for each adaptive tier. */
export const READAHEAD_TIER_SECS: Readonly<Record<ReadaheadTier, number>> = Object.freeze({
  fast: 4,
  normal: 8,
  aggressive: 20,
});

/** Minimum cooldown between consecutive step-ups so a single stall burst never skips tiers. */
export const DEFAULT_READAHEAD_STEP_UP_COOLDOWN_MS = 10_000;
/** Sustained healthy cache duration required before stepping down one tier. */
export const DEFAULT_READAHEAD_STEP_DOWN_HEALTHY_MS = 120_000;
/** Minimum cache fill ratio (`demuxer-cache-duration / tierSecs`) considered healthy for step-down. */
const DEFAULT_READAHEAD_HEALTHY_RATIO = 0.75;
/** Maximum number of stream fingerprints kept in the LRU {@link ReadaheadTierStore}. */
export const MAX_READAHEAD_STORE_ENTRIES = 500;

const TIER_ORDER: readonly ReadaheadTier[] = ['fast', 'normal', 'aggressive'];
const SAFE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const isReadaheadTier = (value: unknown): value is ReadaheadTier =>
  value === 'fast' || value === 'normal' || value === 'aggressive';

const isSafeKey = (value: unknown): value is string =>
  typeof value === 'string' && SAFE_KEY_PATTERN.test(value);

const criticalCacheSecs = (tier: ReadaheadTier): number =>
  Math.min(1, READAHEAD_TIER_SECS[tier] * 0.25);

/**
 * Computes a deterministic, URL-free SHA-256 hex fingerprint from a stream's lowercased host and pathname,
 * stripping credentials, query string, and fragment so raw URLs and tokens never enter disk caches.
 */
export function streamFingerprint(rawUrl: string): string {
  let canonical: string;
  try {
    const parsed = new URL(rawUrl);
    canonical = `${parsed.host.toLowerCase()}${parsed.pathname}`;
  } catch {
    canonical = rawUrl.replace(/[?#].*$/s, '').replace(/^([a-zA-Z]+:\/\/)[^/@]*@/, '$1');
  }
  return createHash('sha256').update(canonical).digest('hex');
}

/** Injectable persistence adapter for {@link createReadaheadTierStore}. */
export interface ReadaheadPersistence {
  read(): string | undefined;
  write(data: string): void;
}

/** Bounded LRU store mapping URL-free stream fingerprints to remembered readahead tiers. */
export interface ReadaheadTierStore {
  get(key: string): ReadaheadTier | undefined;
  set(key: string, tier: ReadaheadTier): void;
  readonly size: number;
}

/** Creates a file-backed JSON persistence adapter that swallows I/O errors safely. */
export function createFileReadaheadPersistence(filePath: string): ReadaheadPersistence {
  return {
    read() {
      try {
        return readFileSync(filePath, 'utf8');
      } catch {
        return undefined;
      }
    },
    write(data) {
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, data, 'utf8');
      } catch {
        // best-effort cache persistence
      }
    },
  };
}

/** Creates a bounded LRU `ReadaheadTierStore` (max 500 entries by default) with optional JSON persistence. */
export function createReadaheadTierStore(opts?: {
  maxEntries?: number;
  persistence?: ReadaheadPersistence;
}): ReadaheadTierStore {
  const maxEntries = Math.max(1, opts?.maxEntries ?? MAX_READAHEAD_STORE_ENTRIES);
  const persistence = opts?.persistence;
  const map = new Map<string, ReadaheadTier>();

  const loadInitial = (): void => {
    if (!persistence) return;
    let raw: string | undefined;
    try {
      raw = persistence.read();
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { entries?: unknown };
      if (!Array.isArray(parsed.entries)) return;
      const valid: Array<[string, ReadaheadTier]> = [];
      for (const item of parsed.entries) {
        if (
          Array.isArray(item) &&
          item.length === 2 &&
          isSafeKey(item[0]) &&
          isReadaheadTier(item[1])
        ) {
          valid.push([item[0], item[1]]);
        }
      }
      for (const [k, tier] of valid.slice(-maxEntries)) {
        map.delete(k);
        map.set(k, tier);
      }
    } catch {
      // ignore corrupt cache file
    }
  };

  const persist = (): void => {
    if (!persistence) return;
    try {
      persistence.write(JSON.stringify({ version: 1, entries: [...map.entries()] }));
    } catch {
      // ignore write failure
    }
  };

  loadInitial();

  return {
    get size() {
      return map.size;
    },
    get(key) {
      if (!isSafeKey(key)) return undefined;
      const tier = map.get(key);
      if (tier === undefined) return undefined;
      map.delete(key);
      map.set(key, tier);
      return tier;
    },
    set(key, tier) {
      if (!isSafeKey(key) || !isReadaheadTier(tier)) return;
      map.delete(key);
      map.set(key, tier);
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
      persist();
    },
  };
}

/** Configuration for {@link createReadaheadController}. */
export interface ReadaheadControllerOptions {
  now(): number;
  onApply(secs: number): void;
  store?: ReadaheadTierStore;
  stepUpCooldownMs?: number;
  stepDownHealthyMs?: number;
  healthyCacheRatio?: number;
}

/** Per-session adaptive `demuxer-readahead-secs` controller (`#196`). */
export interface ReadaheadController {
  readonly tier: ReadaheadTier;
  readonly secs: number;
  /** Starts tracking a new stream URL, applying its remembered (or `'fast'`) readahead tier. */
  beginMedia(streamUrl: string): void;
  onPlaybackRestart(): void;
  onFirstFrame(): void;
  /** Consumes mpv property updates (`pause`, `seeking`, `paused-for-cache`, `demuxer-cache-duration`). */
  property(name: string, value: unknown): void;
  /** Resets session state when the mpv process detaches or restarts. */
  reset(): void;
}

/** Creates an adaptive readahead tier controller with step-up cooldown and sustained-healthy step-down hysteresis. */
export function createReadaheadController(opts: ReadaheadControllerOptions): ReadaheadController {
  const stepUpCooldownMs = opts.stepUpCooldownMs ?? DEFAULT_READAHEAD_STEP_UP_COOLDOWN_MS;
  const stepDownHealthyMs = opts.stepDownHealthyMs ?? DEFAULT_READAHEAD_STEP_DOWN_HEALTHY_MS;
  const healthyRatio = opts.healthyCacheRatio ?? DEFAULT_READAHEAD_HEALTHY_RATIO;

  let tier: ReadaheadTier = 'fast';
  let fingerprint: string | undefined;
  let appliedSecs: number | undefined;
  let restarted = false;
  let firstFrame = false;
  let paused = false;
  let seeking = false;
  let lastStepUpAtMs = Number.NEGATIVE_INFINITY;
  let healthySinceMs: number | undefined;

  const isSteady = (): boolean => restarted && firstFrame && !paused && !seeking;

  const applyTier = (next: ReadaheadTier, persist: boolean): void => {
    tier = next;
    if (persist && fingerprint !== undefined) opts.store?.set(fingerprint, tier);
    const secs = READAHEAD_TIER_SECS[tier];
    if (appliedSecs !== secs) {
      appliedSecs = secs;
      opts.onApply(secs);
    }
  };

  const tryStepUp = (): void => {
    healthySinceMs = undefined;
    const idx = TIER_ORDER.indexOf(tier);
    if (idx < 0 || idx >= TIER_ORDER.length - 1) return;
    const nowMs = opts.now();
    if (nowMs - lastStepUpAtMs < stepUpCooldownMs) return;
    lastStepUpAtMs = nowMs;
    const next = TIER_ORDER[idx + 1];
    if (next) applyTier(next, true);
  };

  const tryStepDown = (): void => {
    const idx = TIER_ORDER.indexOf(tier);
    // Keep 'normal' sticky once promoted so bursty live HLS/TS segments never re-enter
    // a 2-minute step-down -> re-stall oscillation cycle; only 'aggressive' steps back down.
    if (idx <= 1) {
      healthySinceMs = undefined;
      return;
    }
    const nowMs = opts.now();
    if (healthySinceMs === undefined) {
      healthySinceMs = nowMs;
      return;
    }
    if (nowMs - healthySinceMs >= stepDownHealthyMs) {
      healthySinceMs = undefined;
      const next = TIER_ORDER[idx - 1];
      if (next) applyTier(next, true);
    }
  };

  return {
    get tier() {
      return tier;
    },
    get secs() {
      return READAHEAD_TIER_SECS[tier];
    },
    beginMedia(streamUrl) {
      fingerprint = streamFingerprint(streamUrl);
      appliedSecs = undefined;
      restarted = false;
      firstFrame = false;
      paused = false;
      seeking = false;
      lastStepUpAtMs = Number.NEGATIVE_INFINITY;
      healthySinceMs = undefined;
      const remembered = opts.store?.get(fingerprint) ?? 'fast';
      applyTier(remembered, false);
    },
    onPlaybackRestart() {
      restarted = true;
    },
    onFirstFrame() {
      firstFrame = true;
    },
    property(name, value) {
      switch (name) {
        case 'pause':
          paused = value === true;
          if (paused) healthySinceMs = undefined;
          return;
        case 'seeking':
          seeking = value === true;
          if (seeking) healthySinceMs = undefined;
          return;
        case 'paused-for-cache':
          if (value === true && isSteady()) tryStepUp();
          return;
        case 'demuxer-cache-duration': {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !isSteady()) {
            return;
          }
          if (value <= criticalCacheSecs(tier)) {
            tryStepUp();
          } else if (value >= READAHEAD_TIER_SECS[tier] * healthyRatio) {
            tryStepDown();
          } else {
            healthySinceMs = undefined;
          }
          return;
        }
      }
    },
    reset() {
      tier = 'fast';
      fingerprint = undefined;
      appliedSecs = undefined;
      restarted = false;
      firstFrame = false;
      paused = false;
      seeking = false;
      lastStepUpAtMs = Number.NEGATIVE_INFINITY;
      healthySinceMs = undefined;
    },
  };
}
