import { type CatalogService, MAX_NOW_NEXT_KEYS, type NowNextEntry } from '@elv/data';
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

/**
 * Bounded in-memory Now/Next TTL cache (`#250`) backed by {@link CatalogUiCache} when mounted
 * inside `AppShell` so switching Live sub-modes or tabs never drops EPG Now/Next data (`#445`).
 */
export function useLiveNowNext(opts: {
  readonly catalog: CatalogService;
  readonly refreshToken: number;
  readonly nowRef: MutableRefObject<() => number>;
}): {
  readonly byKey: ReadonlyMap<string, NowNextEntry>;
  readonly version: number;
  readonly hydrateNowNext: (channelKeys: readonly string[]) => void;
} {
  const { catalog, refreshToken, nowRef } = opts;
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
  const cacheRef = useRef({
    inFlight: new Set<string>(),
    gen: 0,
  });
  const prevDepsRef = useRef({ catalog, refreshToken });

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    const prev = prevDepsRef.current;
    if (prev.catalog === catalog && prev.refreshToken === refreshToken) return;
    prevDepsRef.current = { catalog, refreshToken };
    cacheRef.current.gen += 1;
    getTtl().clear();
    cacheRef.current.inFlight.clear();
    setState((prevState) => ({ byKey: new Map(), version: prevState.version + 1 }));
  }, [catalog, getTtl, refreshToken]);

  const hydrateNowNext = useCallback(
    (channelKeys: readonly string[]) => {
      const fetchNowNext = catalog.nowNext;
      if (!fetchNowNext || channelKeys.length === 0) return;
      const nowMs = nowRef.current();
      const ttl = getTtl();
      const { inFlight, gen } = cacheRef.current;
      const missing: string[] = [];
      const seen = new Set<string>();
      for (const key of channelKeys) {
        if (!seen.has(key) && !inFlight.has(key) && ttl.get(key, nowMs) === undefined) {
          seen.add(key);
          missing.push(key);
        }
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
          })
          .catch(() => undefined)
          .finally(() => {
            for (const key of chunk) inFlight.delete(key);
          });
      }
    },
    [catalog, getTtl, nowRef],
  );

  return { byKey: state.byKey, version: state.version, hydrateNowNext };
}
