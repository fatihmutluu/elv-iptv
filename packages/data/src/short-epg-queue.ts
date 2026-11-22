/** Default maximum number of pending channel keys kept in the LIFO short-EPG queue (`#217`). */
export const DEFAULT_SHORT_EPG_CAPACITY = 60;

/** Default TTL (ms) for cached short-EPG entries (5 minutes). */
export const DEFAULT_SHORT_EPG_TTL_MS = 300_000;

/** Default batching delay (ms) before delivering resolved short-EPG updates via `onBatch`. */
export const DEFAULT_SHORT_EPG_BATCH_DELAY_MS = 150;

/** Default maximum concurrent short-EPG fetches. */
export const DEFAULT_SHORT_EPG_CONCURRENCY = 2;

/** Portable timer handle type compatible with browser, React Native, and Node runtimes. */
export type ShortEpgTimerHandle = ReturnType<typeof globalThis.setTimeout>;

/** Options for {@link createShortEpgQueue}. */
export interface ShortEpgQueueOptions<T> {
  /** Maximum queued keys before evicting the oldest head entry (default: `60`). */
  capacity?: number;
  /** Cache entry TTL in milliseconds (default: `300_000`). */
  ttlMs?: number;
  /** Coalescing delay in milliseconds for `onBatch` updates (default: `150`). */
  batchDelayMs?: number;
  /** Maximum concurrent in-flight fetches (default: `2`). */
  maxConcurrency?: number;
  /** Fetches a single channel's short-EPG value by key. */
  fetchEntry: (key: string) => Promise<T>;
  /** Receives coalesced batches of fetched `(key, value)` entries. */
  onBatch: (updates: ReadonlyMap<string, T>) => void;
  /** Injectable clock in epoch milliseconds (default: `Date.now`). */
  now?: () => number;
  /** Injectable timer scheduler for deterministic tests (default: `globalThis.setTimeout`). */
  setTimeout?: (fn: () => void, ms: number) => ShortEpgTimerHandle;
  /** Injectable timer canceller for deterministic tests (default: `globalThis.clearTimeout`). */
  clearTimeout?: (handle: ShortEpgTimerHandle) => void;
}

/** Bounded LIFO queue with TTL cache and batched callbacks for lazy visible-row short-EPG loading. */
export interface ShortEpgQueue<T> {
  /** Enqueues `key` at the tail (most recent), promoting existing queued keys and evicting the head at capacity. */
  enqueue(key: string): void;
  /** Returns the cached non-expired value for `key`, or `undefined` when missing/expired. */
  getCached(key: string): T | undefined;
  /** Clears queued keys, TTL cache, and pending batch callbacks without permanently disposing the queue. */
  clear(): void;
  /** Permanently stops dispatching, cancels timers, and clears queued/pending state. */
  dispose(): void;
  /** Number of keys currently waiting in the LIFO queue. */
  pendingCount(): number;
  /** Number of keys currently being fetched. */
  inFlightCount(): number;
}

interface CacheRecord<T> {
  value: T;
  expiresAt: number;
}

/**
 * Creates a pure-TS bounded LIFO queue + TTL cache for lazy visible-row short-EPG fetching (`#217`).
 * Rapid scroll bursts evict stale rows from the head while workers pop the most recently visible
 * rows from the tail, deduplicate in-flight keys, cache hits for `ttlMs`, and coalesce UI updates
 * into `batchDelayMs`-spaced `onBatch` calls.
 */
export function createShortEpgQueue<T>(opts: ShortEpgQueueOptions<T>): ShortEpgQueue<T> {
  const capacity =
    opts.capacity !== undefined && Number.isFinite(opts.capacity)
      ? Math.max(1, Math.floor(opts.capacity))
      : DEFAULT_SHORT_EPG_CAPACITY;
  const ttlMs =
    opts.ttlMs !== undefined && Number.isFinite(opts.ttlMs)
      ? Math.max(0, opts.ttlMs)
      : DEFAULT_SHORT_EPG_TTL_MS;
  const batchDelayMs =
    opts.batchDelayMs !== undefined && Number.isFinite(opts.batchDelayMs)
      ? Math.max(0, opts.batchDelayMs)
      : DEFAULT_SHORT_EPG_BATCH_DELAY_MS;
  const maxConcurrency =
    opts.maxConcurrency !== undefined && Number.isFinite(opts.maxConcurrency)
      ? Math.max(1, Math.floor(opts.maxConcurrency))
      : DEFAULT_SHORT_EPG_CONCURRENCY;
  const maxCacheEntries = Math.max(capacity * 4, 240);

  const now = opts.now ?? (() => Date.now());
  const setTimer =
    opts.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimeout ??
    ((handle: ShortEpgTimerHandle) => {
      globalThis.clearTimeout(handle);
    });

  const queue: string[] = [];
  const inFlight = new Set<string>();
  const cache = new Map<string, CacheRecord<T>>();
  const pendingBatch = new Map<string, T>();

  let flushTimer: ShortEpgTimerHandle | undefined;
  let drainScheduled = false;
  let disposed = false;
  let generation = 0;

  const lookupCached = (key: string): CacheRecord<T> | undefined => {
    const rec = cache.get(key);
    if (rec === undefined) return undefined;
    if (now() >= rec.expiresAt) {
      cache.delete(key);
      return undefined;
    }
    return rec;
  };

  const storeCache = (key: string, value: T): void => {
    if (ttlMs <= 0) return;
    cache.delete(key);
    cache.set(key, { value, expiresAt: now() + ttlMs });
    while (cache.size > maxCacheEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const cancelFlushTimer = (): void => {
    if (flushTimer !== undefined) {
      clearTimer(flushTimer);
      flushTimer = undefined;
    }
  };

  const flushBatch = (): void => {
    flushTimer = undefined;
    if (disposed || pendingBatch.size === 0) return;
    const batch = new Map(pendingBatch);
    pendingBatch.clear();
    opts.onBatch(batch);
  };

  const scheduleFlush = (): void => {
    if (disposed || pendingBatch.size === 0) return;
    if (batchDelayMs <= 0) {
      flushBatch();
      return;
    }
    if (flushTimer === undefined) {
      flushTimer = setTimer(flushBatch, batchDelayMs);
    }
  };

  const drain = (): void => {
    drainScheduled = false;
    if (disposed) return;
    const runGen = generation;
    while (inFlight.size < maxConcurrency && queue.length > 0) {
      const key = queue.pop();
      if (key === undefined) break;
      if (inFlight.has(key) || lookupCached(key) !== undefined) continue;
      inFlight.add(key);
      let request: Promise<T>;
      try {
        request = Promise.resolve(opts.fetchEntry(key));
      } catch (error) {
        request = Promise.reject(error);
      }
      void request.then(
        (value) => {
          inFlight.delete(key);
          if (disposed || generation !== runGen) return;
          storeCache(key, value);
          pendingBatch.set(key, value);
          scheduleFlush();
          drain();
        },
        () => {
          inFlight.delete(key);
          if (!disposed && generation === runGen) drain();
        },
      );
    }
  };

  const scheduleDrain = (): void => {
    if (disposed || drainScheduled) return;
    drainScheduled = true;
    void Promise.resolve().then(drain);
  };

  const clearState = (): void => {
    generation += 1;
    queue.length = 0;
    cache.clear();
    pendingBatch.clear();
    cancelFlushTimer();
  };

  return {
    enqueue(key: string): void {
      if (disposed) return;
      if (lookupCached(key) !== undefined || inFlight.has(key)) return;
      const existingIdx = queue.indexOf(key);
      if (existingIdx >= 0) {
        queue.splice(existingIdx, 1);
      } else {
        while (queue.length >= capacity) {
          queue.shift();
        }
      }
      queue.push(key);
      scheduleDrain();
    },

    getCached(key: string): T | undefined {
      return lookupCached(key)?.value;
    },

    clear(): void {
      clearState();
    },

    dispose(): void {
      disposed = true;
      clearState();
    },

    pendingCount(): number {
      return queue.length;
    },

    inFlightCount(): number {
      return inFlight.size;
    },
  };
}
