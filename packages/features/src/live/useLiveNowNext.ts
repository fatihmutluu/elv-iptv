import {
  type CatalogService,
  createShortEpgQueue,
  MAX_NOW_NEXT_KEYS,
  type NowNextEntry,
  type ShortEpgQueue,
} from '@elv/data';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { useCatalogUiCache } from '../shared';
import {
  type BoundedTtlCache,
  createBoundedTtlCache,
  EPG_CACHE_MAX_ENTRIES,
  indexNowNext,
} from './live-model';

function mergeNowNextBatch(
  prev: ReadonlyMap<string, NowNextEntry>,
  chunk: readonly string[],
  entries: readonly NowNextEntry[],
  ttl: BoundedTtlCache<NowNextEntry>,
  settledAt: number,
): Map<string, NowNextEntry> {
  const byKey = indexNowNext(entries);
  const next = new Map(prev);
  for (const key of chunk) {
    const entry = byKey.get(key) ?? { channelKey: key, now: null, next: null };
    ttl.set(key, entry, settledAt);
    next.delete(key);
    next.set(key, entry);
  }
  while (next.size > EPG_CACHE_MAX_ENTRIES) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

function mergeShortEpgUpdates(
  prev: ReadonlyMap<string, NowNextEntry>,
  updates: ReadonlyMap<string, NowNextEntry | null>,
  ttl: BoundedTtlCache<NowNextEntry>,
  settledAt: number,
): Map<string, NowNextEntry> | null {
  let changed = false;
  const next = new Map(prev);
  for (const [key, entry] of updates) {
    if (entry === null || (entry.now === null && entry.next === null)) continue;
    ttl.set(key, entry, settledAt);
    next.delete(key);
    next.set(key, entry);
    changed = true;
  }
  if (!changed) return null;
  while (next.size > EPG_CACHE_MAX_ENTRIES) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

/**
 * Bounded in-memory Now/Next TTL cache (`#250`) backed by {@link CatalogUiCache} when mounted
 * inside `AppShell` so switching Live sub-modes or tabs never drops EPG Now/Next data (`#445`).
 * Optionally wires a bounded LIFO short-EPG queue (`#217`) via `fetchShortEpg` so rapid scrolling
 * populates currently visible rows first in coalesced 150 ms batches.
 */
export function useLiveNowNext(opts: {
  readonly catalog: CatalogService;
  readonly refreshToken: number;
  readonly nowRef: MutableRefObject<() => number>;
  readonly fetchShortEpg?: (itemKey: string) => Promise<NowNextEntry | null>;
}): {
  readonly byKey: ReadonlyMap<string, NowNextEntry>;
  readonly version: number;
  readonly hydrateNowNext: (channelKeys: readonly string[]) => void;
} {
  const { catalog, refreshToken, nowRef, fetchShortEpg } = opts;
  const uiCache = useCatalogUiCache();
  const localTtlRef = useRef<BoundedTtlCache<NowNextEntry> | null>(null);
  const getTtl = useCallback((): BoundedTtlCache<NowNextEntry> => {
    if (uiCache) return uiCache.nowNext;
    localTtlRef.current ??= createBoundedTtlCache<NowNextEntry>();
    return localTtlRef.current;
  }, [uiCache]);

  const [state, setState] = useState(() => ({
    byKey: (uiCache?.getNowNextSnapshot(nowRef.current()) ??
      new Map<string, NowNextEntry>()) as ReadonlyMap<string, NowNextEntry>,
    version: 0,
  }));

  const aliveRef = useRef(true);
  const fetchShortEpgRef = useRef(fetchShortEpg);
  fetchShortEpgRef.current = fetchShortEpg;

  const shortEpgQueueRef = useRef<ShortEpgQueue<NowNextEntry | null> | null>(null);
  const cacheRef = useRef({
    inFlight: new Set<string>(),
    gen: 0,
  });
  const prevDepsRef = useRef({ catalog, refreshToken });

  const getShortEpgQueue = useCallback((): ShortEpgQueue<NowNextEntry | null> => {
    if (shortEpgQueueRef.current === null) {
      const createdGen = cacheRef.current.gen;
      shortEpgQueueRef.current = createShortEpgQueue<NowNextEntry | null>({
        now: () => nowRef.current(),
        fetchEntry: (itemKey) => {
          const fn = fetchShortEpgRef.current;
          return fn ? fn(itemKey) : Promise.resolve(null);
        },
        onBatch: (updates) => {
          if (!aliveRef.current || cacheRef.current.gen !== createdGen) return;
          const settledAt = nowRef.current();
          const ttl = getTtl();
          setState((prev) => {
            const merged = mergeShortEpgUpdates(prev.byKey, updates, ttl, settledAt);
            return merged === null ? prev : { byKey: merged, version: prev.version + 1 };
          });
        },
      });
    }
    return shortEpgQueueRef.current;
  }, [getTtl, nowRef]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      shortEpgQueueRef.current?.dispose();
      shortEpgQueueRef.current = null;
    };
  }, []);

  useEffect(() => {
    const prev = prevDepsRef.current;
    if (prev.catalog === catalog && prev.refreshToken === refreshToken) return;
    prevDepsRef.current = { catalog, refreshToken };
    cacheRef.current.gen += 1;
    getTtl().clear();
    cacheRef.current.inFlight.clear();
    shortEpgQueueRef.current?.dispose();
    shortEpgQueueRef.current = null;
    setState((prevState) => ({ byKey: new Map(), version: prevState.version + 1 }));
  }, [catalog, getTtl, refreshToken]);

  const hydrateNowNext = useCallback(
    (channelKeys: readonly string[]) => {
      if (channelKeys.length === 0) return;
      const fetchNowNext = catalog.nowNext;
      const nowMs = nowRef.current();
      const ttl = getTtl();
      const { inFlight, gen } = cacheRef.current;

      if (!fetchNowNext) {
        if (fetchShortEpgRef.current === undefined) return;
        const queue = getShortEpgQueue();
        for (const key of channelKeys) {
          const cached = ttl.get(key, nowMs);
          if (cached === undefined || (cached.now === null && cached.next === null)) {
            queue.enqueue(key);
          }
        }
        return;
      }

      const missing: string[] = [];
      const seen = new Set<string>();
      const promoteShortEpg: string[] = [];
      for (const key of channelKeys) {
        if (seen.has(key) || inFlight.has(key)) continue;
        seen.add(key);
        const cached = ttl.get(key, nowMs);
        if (cached === undefined) {
          missing.push(key);
        } else if (
          fetchShortEpgRef.current !== undefined &&
          cached.now === null &&
          cached.next === null
        ) {
          promoteShortEpg.push(key);
        }
      }
      if (promoteShortEpg.length > 0 && fetchShortEpgRef.current !== undefined) {
        const queue = getShortEpgQueue();
        for (const key of promoteShortEpg) queue.enqueue(key);
      }
      for (let i = 0; i < missing.length; i += MAX_NOW_NEXT_KEYS) {
        const chunk = missing.slice(i, i + MAX_NOW_NEXT_KEYS);
        for (const key of chunk) inFlight.add(key);
        void fetchNowNext(chunk, nowMs)
          .then((entries) => {
            if (!aliveRef.current || cacheRef.current.gen !== gen) return;
            const settledAt = nowRef.current();
            setState((prev) => ({
              byKey: mergeNowNextBatch(prev.byKey, chunk, entries, ttl, settledAt),
              version: prev.version + 1,
            }));
            if (fetchShortEpgRef.current !== undefined) {
              const byKey = indexNowNext(entries);
              const queue = getShortEpgQueue();
              for (const key of chunk) {
                const entry = byKey.get(key);
                if (entry === undefined || (entry.now === null && entry.next === null)) {
                  queue.enqueue(key);
                }
              }
            }
          })
          .catch(() => undefined)
          .finally(() => {
            for (const key of chunk) inFlight.delete(key);
          });
      }
    },
    [catalog, getShortEpgQueue, getTtl, nowRef],
  );

  return { byKey: state.byKey, version: state.version, hydrateNowNext };
}
