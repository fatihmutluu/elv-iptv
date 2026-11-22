import type { CatalogService } from './catalog';
import { DEFAULT_PROFILE_ID } from './user-state';

/** Default debounce window (ms) for coalescing rapid user-state writes. */
export const DEFAULT_WRITE_COALESCE_MS = 500;

/** Timer injection and window configuration for {@link createWriteCoalescer}. */
export interface WriteCoalescerOptions {
  /** Coalescing window in milliseconds (default: {@link DEFAULT_WRITE_COALESCE_MS}). */
  windowMs?: number;
  /** Injectable timer scheduler for deterministic tests (defaults to `globalThis.setTimeout`). */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Injectable timer canceller for deterministic tests (defaults to `globalThis.clearTimeout`). */
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Deduplicates rapid async writes per key within a sliding time window. */
export interface WriteCoalescer {
  /**
   * Schedules `job` under `key`. Rapid calls for the same `key` within `windowMs` collapse into a
   * single execution of the latest `job`; all superseded callers resolve or reject with the final
   * committed outcome.
   */
  schedule<T>(key: string, job: () => Promise<T>): Promise<T>;
  /**
   * Synchronously starts any pending write for `key` (cancelling its timer) and returns its
   * in-flight settlement promise (or an already in-flight promise for `key`), or `undefined` if idle.
   */
  triggerKey(key: string): Promise<void> | undefined;
  /** Immediately flushes any pending or in-flight write for `key`. */
  flushKey(key: string): Promise<void>;
  /** Immediately flushes all pending or in-flight writes whose key starts with `prefix`. */
  flushPrefix(prefix: string): Promise<void>;
  /** Cancels all active timers and awaits all pending and in-flight writes (concurrent & re-entrant safe). */
  flush(): Promise<void>;
  /** Number of keys currently queued on a debounce timer. */
  pendingCount(): number;
  /** Number of writes currently executing in-flight. */
  inFlightCount(): number;
  /** Cancels all pending debounce timers and rejects waiting callers with a disposal error. */
  dispose(): void;
}

interface PendingEntry {
  timer: ReturnType<typeof setTimeout> | undefined;
  job: () => Promise<unknown>;
  waiters: Array<{
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }>;
}

/**
 * Creates a pure-TS per-key write coalescer that collapses rapid async write bursts into a single
 * committed operation per key while guaranteeing every awaiting caller settles cleanly.
 */
export function createWriteCoalescer(opts: WriteCoalescerOptions = {}): WriteCoalescer {
  const windowMs =
    opts.windowMs !== undefined && Number.isFinite(opts.windowMs)
      ? Math.max(0, opts.windowMs)
      : DEFAULT_WRITE_COALESCE_MS;
  const setTimer =
    opts.setTimeoutFn ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimeoutFn ??
    ((handle: ReturnType<typeof setTimeout>) => {
      globalThis.clearTimeout(handle);
    });

  const pending = new Map<string, PendingEntry>();
  const inFlight = new Set<Promise<void>>();
  const keyTail = new Map<string, Promise<void>>();

  const runEntry = (key: string, entry: PendingEntry): Promise<void> => {
    const prev = keyTail.get(key) ?? Promise.resolve();
    const execution = prev.then(async () => {
      try {
        const value = await entry.job();
        for (const w of entry.waiters) w.resolve(value);
      } catch (error) {
        for (const w of entry.waiters) w.reject(error);
      }
    });
    inFlight.add(execution);
    keyTail.set(key, execution);
    void execution.finally(() => {
      inFlight.delete(execution);
      if (keyTail.get(key) === execution) {
        keyTail.delete(key);
      }
    });
    return execution;
  };

  const triggerKey = (key: string): Promise<void> | undefined => {
    const entry = pending.get(key);
    if (entry === undefined) return keyTail.get(key);
    pending.delete(key);
    if (entry.timer !== undefined) {
      clearTimer(entry.timer);
      entry.timer = undefined;
    }
    return runEntry(key, entry);
  };

  const flushKey = async (key: string): Promise<void> => {
    while (pending.has(key) || keyTail.has(key)) {
      const active = triggerKey(key);
      if (active !== undefined) {
        await active;
      }
    }
  };

  return {
    schedule<T>(key: string, job: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const waiter = {
          resolve: (value: unknown) => resolve(value as T),
          reject,
        };
        if (windowMs <= 0) {
          void runEntry(key, { timer: undefined, job, waiters: [waiter] });
          return;
        }
        const existing = pending.get(key);
        if (existing !== undefined) {
          if (existing.timer !== undefined) {
            clearTimer(existing.timer);
          }
          existing.job = job;
          existing.waiters.push(waiter);
          existing.timer = setTimer(() => {
            triggerKey(key);
          }, windowMs);
          return;
        }
        const entry: PendingEntry = {
          timer: undefined,
          job,
          waiters: [waiter],
        };
        pending.set(key, entry);
        entry.timer = setTimer(() => {
          triggerKey(key);
        }, windowMs);
      });
    },

    triggerKey,
    flushKey,

    async flushPrefix(prefix: string): Promise<void> {
      if (pending.size === 0 && keyTail.size === 0) return;
      for (;;) {
        const matching: Promise<void>[] = [];
        for (const key of [...pending.keys()]) {
          if (key.startsWith(prefix)) {
            const active = triggerKey(key);
            if (active !== undefined) matching.push(active);
          }
        }
        for (const [key, tail] of keyTail) {
          if (key.startsWith(prefix)) matching.push(tail);
        }
        if (matching.length === 0) return;
        await Promise.all(matching);
      }
    },

    async flush(): Promise<void> {
      while (pending.size > 0 || inFlight.size > 0) {
        if (pending.size > 0) {
          for (const key of [...pending.keys()]) {
            triggerKey(key);
          }
        }
        if (inFlight.size > 0) {
          await Promise.all([...inFlight]);
        }
      }
    },

    pendingCount(): number {
      return pending.size;
    },

    inFlightCount(): number {
      return inFlight.size;
    },

    dispose(): void {
      const error = new Error('WriteCoalescer disposed');
      const entries = [...pending.values()];
      pending.clear();
      for (const entry of entries) {
        if (entry.timer !== undefined) {
          clearTimer(entry.timer);
          entry.timer = undefined;
        }
        for (const w of entry.waiters) w.reject(error);
      }
    },
  };
}

/** Options for {@link createCoalescedCatalog}. */
export type CoalescedCatalogOptions = WriteCoalescerOptions;

/** A {@link CatalogService} wrapper that coalesces rapid user-state writes and guarantees `flushPendingWrites`. */
export interface CoalescedCatalogService extends CatalogService {
  flushPendingWrites(): Promise<void>;
}

const normalizeProfile = (profileId?: string): string => {
  const trimmed = profileId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_PROFILE_ID;
};

/**
 * Wraps a {@link CatalogService} so rapid `setFavorite`, `setWatched`, and `saveProgress` bursts
 * coalesce per `(profileId, itemKey)` within `windowMs` (default 500 ms). Preserves causal
 * ordering between `saveProgress` and `setWatched`, flushes matching pending writes before reads
 * and `toggleFavorite`/`clearProgress`, and flushes all pending writes before `removeSource`/`close`.
 */
export function createCoalescedCatalog(
  catalog: CatalogService,
  opts?: CoalescedCatalogOptions,
): CoalescedCatalogService {
  const coalescer = createWriteCoalescer(opts);
  const c = catalog;

  const favKey = (itemKey: string, profileId?: string): string =>
    `fav:${normalizeProfile(profileId)}:${itemKey}`;
  const progressKey = (itemKey: string, profileId?: string): string =>
    `progress:${normalizeProfile(profileId)}:${itemKey}`;
  const watchedKey = (itemKey: string, profileId?: string): string =>
    `watched:${normalizeProfile(profileId)}:${itemKey}`;

  const flushPendingWrites = async (): Promise<void> => {
    await coalescer.flush();
    await c.flushPendingWrites?.();
  };

  const saveProgressFn = c.saveProgress?.bind(c);
  const setWatchedFn = c.setWatched?.bind(c);
  const getProgressFn = c.getProgress?.bind(c);
  const listContinueWatchingFn = c.listContinueWatching?.bind(c);
  const listProgressByKeysFn = c.listProgressByKeys?.bind(c);
  const clearProgressFn = c.clearProgress?.bind(c);
  const setFavoriteFn = c.setFavorite?.bind(c);
  const toggleFavoriteFn = c.toggleFavorite?.bind(c);
  const listFavoritesFn = c.listFavorites?.bind(c);
  const listFavoriteKeysFn = c.listFavoriteKeys?.bind(c);

  return {
    addSource: (input) => c.addSource(input),
    addSourceFromLink: (input) => c.addSourceFromLink(input),
    async removeSource(id) {
      await flushPendingWrites();
      return c.removeSource(id);
    },
    importSource: (id, importOpts) => c.importSource(id, importOpts),
    listSources: () => c.listSources(),
    categories: (sourceId, kind) => c.categories(sourceId, kind),
    items: (categoryId, offset, limit) => c.items(categoryId, offset, limit),
    seasons: (seriesId) => c.seasons(seriesId),
    episodes: (seriesId, season) => c.episodes(seriesId, season),
    resolveStream: (itemKey) => c.resolveStream(itemKey),
    ...(c.importGuide ? { importGuide: c.importGuide.bind(c) } : {}),
    ...(c.allSourcesItems ? { allSourcesItems: c.allSourcesItems.bind(c) } : {}),
    ...(c.itemDetail ? { itemDetail: c.itemDetail.bind(c) } : {}),
    ...(c.search ? { search: c.search.bind(c) } : {}),
    ...(c.nowNext ? { nowNext: c.nowNext.bind(c) } : {}),
    ...(c.epgWindow ? { epgWindow: c.epgWindow.bind(c) } : {}),
    ...(c.epgSlice ? { epgSlice: c.epgSlice.bind(c) } : {}),
    ...(c.channelByNumber ? { channelByNumber: c.channelByNumber.bind(c) } : {}),
    ...(getProgressFn
      ? {
          getProgress: async (itemKey, profileId) => {
            await coalescer.flushKey(progressKey(itemKey, profileId));
            await coalescer.flushKey(watchedKey(itemKey, profileId));
            return getProgressFn(itemKey, profileId);
          },
        }
      : {}),
    ...(listContinueWatchingFn
      ? {
          listContinueWatching: async (limit, profileId) => {
            const p = normalizeProfile(profileId);
            await coalescer.flushPrefix(`progress:${p}:`);
            await coalescer.flushPrefix(`watched:${p}:`);
            return listContinueWatchingFn(limit, profileId);
          },
        }
      : {}),
    ...(listProgressByKeysFn
      ? {
          listProgressByKeys: async (itemKeys, profileId) => {
            if (coalescer.pendingCount() > 0 || coalescer.inFlightCount() > 0) {
              for (const itemKey of itemKeys) {
                await coalescer.flushKey(progressKey(itemKey, profileId));
                await coalescer.flushKey(watchedKey(itemKey, profileId));
              }
            }
            return listProgressByKeysFn(itemKeys, profileId);
          },
        }
      : {}),
    ...(toggleFavoriteFn
      ? {
          toggleFavorite: async (input) => {
            await coalescer.flushKey(favKey(input.itemKey, input.profileId));
            return toggleFavoriteFn(input);
          },
        }
      : {}),
    ...(listFavoritesFn
      ? {
          listFavorites: async (limit, profileId) => {
            await coalescer.flushPrefix(`fav:${normalizeProfile(profileId)}:`);
            return listFavoritesFn(limit, profileId);
          },
        }
      : {}),
    ...(listFavoriteKeysFn
      ? {
          listFavoriteKeys: async (profileId) => {
            await coalescer.flushPrefix(`fav:${normalizeProfile(profileId)}:`);
            return listFavoriteKeysFn(profileId);
          },
        }
      : {}),
    ...(saveProgressFn
      ? {
          saveProgress: (input) => {
            const prevWatched = coalescer.triggerKey(watchedKey(input.itemKey, input.profileId));
            return coalescer.schedule(progressKey(input.itemKey, input.profileId), async () => {
              if (prevWatched !== undefined) await prevWatched;
              return saveProgressFn(input);
            });
          },
        }
      : {}),
    ...(setWatchedFn
      ? {
          setWatched: (itemKey, watched, profileId) => {
            const prevProgress = coalescer.triggerKey(progressKey(itemKey, profileId));
            return coalescer.schedule(watchedKey(itemKey, profileId), async () => {
              if (prevProgress !== undefined) await prevProgress;
              return setWatchedFn(itemKey, watched, profileId);
            });
          },
        }
      : {}),
    ...(clearProgressFn
      ? {
          clearProgress: async (itemKey, profileId) => {
            await coalescer.flushKey(progressKey(itemKey, profileId));
            await coalescer.flushKey(watchedKey(itemKey, profileId));
            return clearProgressFn(itemKey, profileId);
          },
        }
      : {}),
    ...(setFavoriteFn
      ? {
          setFavorite: (input, active) =>
            coalescer.schedule(favKey(input.itemKey, input.profileId), () =>
              setFavoriteFn(input, active),
            ),
        }
      : {}),
    flushPendingWrites,
    async close() {
      await flushPendingWrites();
      coalescer.dispose();
      await c.close();
    },
  };
}
