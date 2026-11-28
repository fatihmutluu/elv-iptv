import { randomUUID } from 'node:crypto';
import {
  type Dirent,
  mkdirSync,
  readdirSync,
  rmSync,
  type StatsFs,
  statfsSync,
  statSync,
} from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import type { BufferPreset } from '@elv/domain';
import {
  type AttemptToken,
  computeVodBufferBudget,
  decayThrottleBackoffLevel,
  type EngineEvent,
  type MediaKind,
  nextThrottleBackoffLevel,
  type VodBufferBudget,
} from '@elv/playback';
import { streamFingerprint } from './readahead.ts';

const MIB = 1024 * 1024;
const VOD_CACHE_DIR_NAME = 'elv-vod-cache';
const SESSION_DIR_PREFIX = 's-';
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_THROTTLE_MAX_ENTRIES = 128;
const MAX_TRACKED_THROTTLE_ATTEMPTS = 16;
const THROTTLE_DECAY_WINDOW_SECONDS = 120;

const LIVE_DEFAULT_CACHE_OPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'cache-on-disk': 'no',
  'demuxer-max-bytes': '32MiB',
  'demuxer-max-back-bytes': '128MiB',
});

/** Resolves the sandbox-safe root directory for ephemeral desktop VOD disk cache sessions (`#350`). */
export function resolveVodCacheRoot(cacheBaseDir?: string): string {
  const trimmed = cacheBaseDir?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : tmpdir();
  return join(base, VOD_CACHE_DIR_NAME);
}

/**
 * Safely removes stale `s-*` ephemeral VOD cache session directories left behind by a crashed run (`#350`).
 * Never throws on `ENOENT`, `EPERM`, or other filesystem errors.
 */
export function purgeOrphanedVodCacheDirs(cacheRoot: string): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.name.startsWith(SESSION_DIR_PREFIX)) continue;
    try {
      rmSync(join(cacheRoot, entry.name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // best-effort startup cleanup
    }
  }
  return removed;
}

type StatfsFn = (path: string) => Pick<StatsFs, 'bavail' | 'bsize'>;

function statFreeBytes(target: string, statfs: StatfsFn): number | undefined {
  const info = statfs(target);
  const bytes = Number(info.bavail) * Number(info.bsize);
  return Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : undefined;
}

/**
 * Reads available free disk bytes for `dir` using `fs.statfsSync`, falling back once to the immediate
 * parent directory if `dir` has not been created yet, and returning `undefined` on any error (`#350`).
 */
export function readFreeDiskBytes(dir: string, statfs: StatfsFn = statfsSync): number | undefined {
  try {
    return statFreeBytes(dir, statfs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    const parent = dirname(dir);
    if (code === 'ENOENT' && parent !== dir) {
      try {
        return statFreeBytes(parent, statfs);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/** Active ephemeral per-session VOD disk cache directory handle (`#350`). */
export interface VodCacheSession {
  readonly dir: string;
  readonly maxDiskBytes: number;
  readUsedBytes(): number;
  cleanup(): void;
}

function measureDirBytes(dir: string): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += measureDirBytes(full);
      } else if (entry.isFile()) {
        total += statSync(full).size;
      }
    } catch {
      // file may disappear while mpv rotates cache segments
    }
  }
  return total;
}

/**
 * Creates a unique opaque `s-<uuid>` directory (`mode: 0o700`) for one VOD session when disk caching
 * is permitted by `budget`, or returns `null` when disk caching is disabled or creation fails (`#350`).
 */
export function createVodCacheSession(opts: {
  cacheRoot: string;
  budget: VodBufferBudget;
  sessionId?: string;
}): VodCacheSession | null {
  if (!opts.budget.allowDiskCache || opts.budget.maxDiskBytes <= 0) return null;
  const rawId = opts.sessionId;
  const safeId = rawId !== undefined && SAFE_SESSION_ID.test(rawId) ? rawId : randomUUID();
  const dir = join(opts.cacheRoot, `${SESSION_DIR_PREFIX}${safeId}`);
  try {
    mkdirSync(opts.cacheRoot, { recursive: true, mode: 0o700 });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  let cleaned = false;
  return {
    dir,
    maxDiskBytes: opts.budget.maxDiskBytes,
    readUsedBytes(): number {
      if (cleaned) return 0;
      return measureDirBytes(dir);
    },
    cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; startup orphan purge sweeps locked leftovers
      }
    },
  };
}

function formatMpvBytes(bytes: number): string {
  const safe = Math.max(1, Math.floor(bytes));
  if (safe >= MIB) {
    return `${Math.floor(safe / MIB)}MiB`;
  }
  return String(safe);
}

/** Input for {@link buildVodMpvLoadOptions}. */
export interface VodMpvLoadOptionsInput {
  readonly kind: MediaKind;
  readonly bufferPreset?: BufferPreset;
  readonly deviceRamBytes?: number;
  readonly freeDiskBytes?: number;
  readonly multiViewTileCount?: number;
  readonly throttleBackoffLevel?: number;
  readonly cacheDir?: string;
  /** Prefer RAM-only VOD caching on >= 8 GiB desktops for non-`large` presets (defaults to `true`). */
  readonly preferRamOnHighRam?: boolean;
}

/**
 * Computes per-file mpv `loadfile` demuxer cache options from `@elv/playback` `computeVodBufferBudget` (`#350`).
 * Live streams always disable VOD disk caching and retain bounded live time-shift limits.
 */
export function buildVodMpvLoadOptions(input: VodMpvLoadOptionsInput): Record<string, string> {
  if (input.kind === 'live') {
    return { ...LIVE_DEFAULT_CACHE_OPTIONS };
  }
  const preferRamOnHighRam = input.preferRamOnHighRam !== false;
  const budget = computeVodBufferBudget({
    kind: 'vod',
    ...(input.bufferPreset === undefined ? {} : { bufferPreset: input.bufferPreset }),
    deviceRamBytes: input.deviceRamBytes ?? totalmem(),
    ...(input.freeDiskBytes === undefined ? {} : { freeDiskBytes: input.freeDiskBytes }),
    ...(input.multiViewTileCount === undefined
      ? {}
      : { multiViewTileCount: input.multiViewTileCount }),
    ...(input.throttleBackoffLevel === undefined
      ? {}
      : { throttleBackoffLevel: input.throttleBackoffLevel }),
    preferRamOnHighRam,
  });

  const useDisk =
    budget.allowDiskCache && input.cacheDir !== undefined && input.cacheDir.trim().length > 0;
  const totalBytes = Math.max(2 * MIB, useDisk ? budget.maxDiskBytes : budget.maxMemoryBytes);
  const totalTargetMs = budget.forwardTargetMs + budget.backTargetMs;
  const rawBackRatio = totalTargetMs > 0 ? budget.backTargetMs / totalTargetMs : 0.25;
  const backRatio = Math.max(0.15, Math.min(0.4, rawBackRatio));
  const totalMiB = Math.max(2, Math.floor(totalBytes / MIB));
  const backMiB = Math.max(
    1,
    Math.min(Math.floor(totalMiB * 0.4), Math.floor(totalMiB * backRatio)),
  );
  const forwardMiB = Math.max(1, totalMiB - backMiB);

  return {
    'cache-on-disk': useDisk ? 'yes' : 'no',
    ...(useDisk && input.cacheDir !== undefined ? { 'demuxer-cache-dir': input.cacheDir } : {}),
    'demuxer-max-bytes': formatMpvBytes(forwardMiB * MIB),
    'demuxer-max-back-bytes': formatMpvBytes(backMiB * MIB),
    'demuxer-hysteresis-secs': '10',
    'demuxer-readahead-secs': String(Math.max(1, Math.round(budget.forwardTargetMs / 1000))),
  };
}

/** Per-stream HTTP `429`/`509` VOD throttle backoff tracker keyed by URL-free SHA-256 fingerprint (`#350`). */
export interface VodThrottleTracker {
  getBackoffLevel(url: string): number;
  recordHttpStatus(url: string, httpStatus: number): number;
  recordHealthySeconds(url: string, healthySeconds: number): number;
  reset(url?: string): void;
  readonly size: number;
}

/** Creates a bounded LRU VOD HTTP `429`/`509` throttle backoff tracker (`#350`). */
export function createVodThrottleTracker(opts?: { maxEntries?: number }): VodThrottleTracker {
  const maxEntries = Math.max(1, opts?.maxEntries ?? DEFAULT_THROTTLE_MAX_ENTRIES);
  const map = new Map<string, { level: number; healthySeconds: number }>();

  const touch = (key: string, level: number, healthySeconds: number): void => {
    map.delete(key);
    if (level > 0) {
      map.set(key, { level, healthySeconds });
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    }
  };

  return {
    get size() {
      return map.size;
    },
    getBackoffLevel(url) {
      const key = streamFingerprint(url);
      const entry = map.get(key);
      if (entry === undefined) return 0;
      map.delete(key);
      map.set(key, entry);
      return entry.level;
    },
    recordHttpStatus(url, httpStatus) {
      const key = streamFingerprint(url);
      const current = map.get(key);
      const level = current?.level ?? 0;
      const next = nextThrottleBackoffLevel(level, httpStatus);
      if (next !== level || httpStatus === 429 || httpStatus === 509) {
        touch(key, next, 0);
      } else if (current !== undefined) {
        touch(key, level, current.healthySeconds);
      }
      return next;
    },
    recordHealthySeconds(url, healthySeconds) {
      const key = streamFingerprint(url);
      const current = map.get(key);
      if (current === undefined || current.level === 0) return 0;
      if (!Number.isFinite(healthySeconds) || healthySeconds <= 0) return current.level;
      const totalHealthy = current.healthySeconds + healthySeconds;
      const next = decayThrottleBackoffLevel(current.level, totalHealthy);
      const decayedSteps = current.level - next;
      const remainder =
        next === 0 ? 0 : Math.max(0, totalHealthy - decayedSteps * THROTTLE_DECAY_WINDOW_SECONDS);
      touch(key, next, remainder);
      return next;
    },
    reset(url) {
      if (url === undefined) {
        map.clear();
      } else {
        map.delete(streamFingerprint(url));
      }
    },
  };
}

/** Media load descriptor evaluated by {@link VodCacheCoordinator}. */
interface VodCacheLoadRequest {
  readonly url: string;
  readonly kind: MediaKind;
  readonly bufferPreset?: BufferPreset;
}

/** Coordinates per-engine ephemeral VOD disk cache sessions and HTTP `429`/`509` throttle backoff (`#350`). */
export interface VodCacheCoordinator {
  prepareLoad(req: VodCacheLoadRequest): Readonly<Record<string, string>>;
  prepareQueuedLoad(req: VodCacheLoadRequest): Readonly<Record<string, string>>;
  promoteQueuedSession(): void;
  discardQueuedSession(): void;
  retireActiveSession(): void;
  sweepRetired(): void;
  getBackoffLevel(url: string): number;
  recordThrottleForAttempt(
    attempt: AttemptToken,
    url: string,
    kind: MediaKind,
    httpStatus: number,
  ): number;
  recordHealthySeconds(url: string, deltaSeconds: number): number;
  onPlaybackEvents(url: string, kind: MediaKind, events: readonly EngineEvent[]): void;
  onMpvLog(attempt: AttemptToken, url: string, kind: MediaKind, text: string): void;
  onEndFile(
    attempt: AttemptToken,
    url: string,
    kind: MediaKind,
    events: readonly EngineEvent[],
  ): void;
  dispose(): void;
}

const HTTP_THROTTLE_LOG_PATTERN = /HTTP error (429|509)\b/;

/** Creates an engine-scoped VOD disk cache & throttle coordinator (`#350`). */
export function createVodCacheCoordinator(opts: {
  cacheRoot: string;
  getDeviceRamBytes?: () => number;
  readFreeDiskBytes?: (dir: string) => number | undefined;
  getMultiViewTileCount?: () => number;
  removeDir?: (dir: string) => void;
  /** Prefer RAM-only VOD caching on >= 8 GiB desktops for non-`large` presets (defaults to `true`). */
  preferRamOnHighRam?: boolean;
}): VodCacheCoordinator {
  const getRam = opts.getDeviceRamBytes ?? totalmem;
  const getFreeDisk = opts.readFreeDiskBytes ?? readFreeDiskBytes;
  const preferRamOnHighRam = opts.preferRamOnHighRam !== false;
  const removeDir =
    opts.removeDir ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }));
  const throttle = createVodThrottleTracker();
  const recordedAttempts = new Set<AttemptToken>();
  const retiredDirs = new Set<string>();
  let activeSession: VodCacheSession | null = null;
  let queuedSession: VodCacheSession | null = null;
  let healthyUrl: string | undefined;
  let lastHealthyClockAtMs: number | undefined;
  let isStalled = false;

  const resetHealthyTracking = (): void => {
    healthyUrl = undefined;
    lastHealthyClockAtMs = undefined;
    isStalled = false;
  };

  const sweepRetired = (): void => {
    for (const dir of [...retiredDirs]) {
      try {
        removeDir(dir);
        retiredDirs.delete(dir);
      } catch {
        // retry on next end-file or dispose if mpv still holds an open handle
      }
    }
  };

  const retireActiveSession = (): void => {
    resetHealthyTracking();
    if (!activeSession) return;
    retiredDirs.add(activeSession.dir);
    activeSession = null;
  };

  const discardQueuedSession = (): void => {
    if (!queuedSession) return;
    const dir = queuedSession.dir;
    queuedSession = null;
    try {
      removeDir(dir);
    } catch {
      retiredDirs.add(dir);
    }
  };

  const allocateVodOptions = (
    req: VodCacheLoadRequest,
  ): {
    readonly session: VodCacheSession | null;
    readonly options: Readonly<Record<string, string>>;
  } => {
    if (req.kind === 'live') {
      return { session: null, options: buildVodMpvLoadOptions({ kind: 'live' }) };
    }
    const deviceRamBytes = getRam();
    const freeDiskBytes = getFreeDisk(opts.cacheRoot);
    const multiViewTileCount = opts.getMultiViewTileCount?.();
    const throttleBackoffLevel = throttle.getBackoffLevel(req.url);
    const budget = computeVodBufferBudget({
      kind: 'vod',
      ...(req.bufferPreset === undefined ? {} : { bufferPreset: req.bufferPreset }),
      deviceRamBytes,
      ...(freeDiskBytes === undefined ? {} : { freeDiskBytes }),
      ...(multiViewTileCount === undefined ? {} : { multiViewTileCount }),
      throttleBackoffLevel,
      preferRamOnHighRam,
    });
    const session = createVodCacheSession({ cacheRoot: opts.cacheRoot, budget });
    const options = buildVodMpvLoadOptions({
      kind: 'vod',
      ...(req.bufferPreset === undefined ? {} : { bufferPreset: req.bufferPreset }),
      deviceRamBytes,
      ...(freeDiskBytes === undefined ? {} : { freeDiskBytes }),
      ...(multiViewTileCount === undefined ? {} : { multiViewTileCount }),
      throttleBackoffLevel,
      preferRamOnHighRam,
      ...(session ? { cacheDir: session.dir } : {}),
    });
    return { session, options };
  };

  const recordThrottleForAttempt = (
    attempt: AttemptToken,
    url: string,
    kind: MediaKind,
    httpStatus: number,
  ): number => {
    if (kind !== 'vod' || (httpStatus !== 429 && httpStatus !== 509)) {
      return kind === 'vod' ? throttle.getBackoffLevel(url) : 0;
    }
    if (recordedAttempts.has(attempt)) return throttle.getBackoffLevel(url);
    recordedAttempts.add(attempt);
    if (recordedAttempts.size > MAX_TRACKED_THROTTLE_ATTEMPTS) {
      const oldest = recordedAttempts.values().next().value;
      if (oldest !== undefined) recordedAttempts.delete(oldest);
    }
    return throttle.recordHttpStatus(url, httpStatus);
  };

  return {
    prepareLoad(req) {
      discardQueuedSession();
      retireActiveSession();
      const { session, options } = allocateVodOptions(req);
      activeSession = session;
      return options;
    },
    prepareQueuedLoad(req) {
      discardQueuedSession();
      const { session, options } = allocateVodOptions(req);
      queuedSession = session;
      return options;
    },
    promoteQueuedSession() {
      retireActiveSession();
      activeSession = queuedSession;
      queuedSession = null;
      sweepRetired();
    },
    discardQueuedSession,
    retireActiveSession,
    sweepRetired,
    getBackoffLevel(url) {
      return throttle.getBackoffLevel(url);
    },
    recordThrottleForAttempt,
    recordHealthySeconds(url, deltaSeconds) {
      return throttle.recordHealthySeconds(url, deltaSeconds);
    },
    onPlaybackEvents(url, kind, events) {
      if (kind !== 'vod') {
        resetHealthyTracking();
        return;
      }
      if (healthyUrl !== url) {
        healthyUrl = url;
        lastHealthyClockAtMs = undefined;
        isStalled = false;
      }
      for (const ev of events) {
        if (ev.type === 'stall') {
          isStalled = ev.phase === 'start';
          lastHealthyClockAtMs = undefined;
        } else if (ev.type === 'state') {
          if (ev.state === 'buffering') {
            isStalled = true;
            lastHealthyClockAtMs = undefined;
          } else if (ev.state === 'playing') {
            isStalled = false;
          } else {
            lastHealthyClockAtMs = undefined;
          }
        } else if (ev.type === 'error') {
          lastHealthyClockAtMs = undefined;
        } else if (ev.type === 'clock') {
          const { rate, atMs } = ev.anchor;
          if (rate > 0 && !isStalled && Number.isFinite(atMs)) {
            if (lastHealthyClockAtMs !== undefined) {
              const deltaSeconds = (atMs - lastHealthyClockAtMs) / 1000;
              if (Number.isFinite(deltaSeconds) && deltaSeconds > 0) {
                throttle.recordHealthySeconds(url, deltaSeconds);
              }
            }
            lastHealthyClockAtMs = atMs;
          } else {
            lastHealthyClockAtMs = undefined;
          }
        }
      }
    },
    onMpvLog(attempt, url, kind, text) {
      if (kind !== 'vod') return;
      const match = HTTP_THROTTLE_LOG_PATTERN.exec(text);
      if (match?.[1]) {
        recordThrottleForAttempt(attempt, url, kind, Number(match[1]));
      }
    },
    onEndFile(attempt, url, kind, events) {
      if (kind === 'vod') {
        for (const ev of events) {
          if (ev.type !== 'error') continue;
          const status =
            ev.error.httpStatus ??
            (ev.error.code === 'http-429' ? 429 : ev.error.code === 'http-509' ? 509 : undefined);
          if (status === 429 || status === 509) {
            recordThrottleForAttempt(attempt, url, kind, status);
          }
        }
        retireActiveSession();
      }
      sweepRetired();
    },
    dispose() {
      discardQueuedSession();
      retireActiveSession();
      sweepRetired();
      throttle.reset();
      recordedAttempts.clear();
    },
  };
}
