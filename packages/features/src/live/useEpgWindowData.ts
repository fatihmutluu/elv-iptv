import { type CatalogService, MAX_EPG_WINDOW_KEYS, type ProgrammeRow } from '@elv/data';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type CachedEpgProgramEntry, useCatalogUiCache } from '../shared';
import { computeDayJumpWindowStart } from './epg-date-tabs';
import {
  type BoundedTtlCache,
  createBoundedTtlCache,
  EPG_CACHE_MAX_ENTRIES,
  EPG_CACHE_TTL_MS,
  EPG_FETCH_BUFFER_MS,
  EPG_PAN_STEP_MS,
  EPG_VISIBLE_SPAN_MS,
  floorToEpgSlot,
} from './live-model';

/** Shared empty programme slice avoiding fresh `[]` allocations on unloaded rows. */
export const EMPTY_PROGRAMMES: readonly ProgrammeRow[] = [];

type CachedProgrammeEntry = CachedEpgProgramEntry;

/** Options for {@link useEpgWindowData}. */
export interface UseEpgWindowDataOptions {
  readonly catalog: CatalogService;
  readonly categoryId: string;
  readonly refreshToken: number;
  readonly nowMs: number;
  readonly spanMs?: number;
  readonly onGuideRefreshed?: () => void;
}

/** Windowed EPG state and bounded LRU TTL hydration handle returned by {@link useEpgWindowData}. */
export interface EpgWindowData {
  readonly windowStartMs: number;
  readonly isAtLiveWindow: boolean;
  readonly refreshingGuide: boolean;
  readonly version: number;
  readonly panEarlier: () => void;
  readonly panLater: () => void;
  readonly jumpToLive: () => void;
  readonly jumpToDay: (dayStartMs: number) => void;
  readonly hydrateChannels: (channelKeys: readonly string[]) => void;
  readonly getProgrammes: (channelKey: string) => readonly ProgrammeRow[];
  readonly refreshGuide: (sourceId: string) => Promise<void>;
}

/**
 * Manages the horizontal EPG time window (`windowStartMs`), stale-while-revalidate bounded LRU
 * programme cache (`EPG_CACHE_MAX_ENTRIES` / `EPG_CACHE_TTL_MS`), chunked
 * `<= MAX_EPG_WINDOW_KEYS` hydration with monotonic generation guards, and XMLTV guide refresh
 * (`#6`, `#250`).
 */
export function useEpgWindowData({
  catalog,
  categoryId,
  refreshToken,
  nowMs,
  spanMs = EPG_VISIBLE_SPAN_MS,
  onGuideRefreshed,
}: UseEpgWindowDataOptions): EpgWindowData {
  const [windowStartMs, setWindowStartMs] = useState(() => floorToEpgSlot(nowMs));
  const [refreshingGuide, setRefreshingGuide] = useState(false);
  const [version, setVersion] = useState(0);

  const uiCache = useCatalogUiCache();
  // Use MAX_SAFE_INTEGER TTL inside BoundedTtlCache so render reads never destructively evict;
  // freshness against EPG_CACHE_TTL_MS is checked in hydrateChannels (stale-while-revalidate).
  const localCacheRef = useRef<BoundedTtlCache<CachedProgrammeEntry> | null>(null);
  if (!uiCache && localCacheRef.current === null) {
    localCacheRef.current = createBoundedTtlCache<CachedProgrammeEntry>(
      EPG_CACHE_MAX_ENTRIES,
      Number.MAX_SAFE_INTEGER,
    );
  }
  const activeCache =
    uiCache?.epgWindow ?? (localCacheRef.current as BoundedTtlCache<CachedProgrammeEntry>);
  const cacheRef = useRef<BoundedTtlCache<CachedProgrammeEntry>>(activeCache);
  cacheRef.current = activeCache;
  const inFlightRef = useRef(new Set<string>());
  const genRef = useRef(0);
  const mountedRef = useRef(true);
  const refreshingRef = useRef(false);

  const windowStartRef = useRef(windowStartMs);
  windowStartRef.current = windowStartMs;
  const propsRef = useRef({ catalog, nowMs, spanMs, onGuideRefreshed });
  propsRef.current = { catalog, nowMs, spanMs, onGuideRefreshed };
  const prevDepsRef = useRef({ categoryId, refreshToken });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      genRef.current += 1;
      inFlightRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const prev = prevDepsRef.current;
    if (prev.categoryId === categoryId && prev.refreshToken === refreshToken) return;
    const refreshed = prev.refreshToken !== refreshToken;
    prevDepsRef.current = { categoryId, refreshToken };
    genRef.current += 1;
    inFlightRef.current.clear();
    if (refreshed) {
      cacheRef.current.clear();
      setVersion((v) => v + 1);
    }
  }, [categoryId, refreshToken]);

  const commitWindowStart = useCallback((nextStartMs: number) => {
    const floored = Math.max(0, floorToEpgSlot(nextStartMs));
    if (floored === windowStartRef.current) return;
    windowStartRef.current = floored;
    genRef.current += 1;
    inFlightRef.current.clear();
    setWindowStartMs(floored);
  }, []);

  const panEarlier = useCallback(
    () => commitWindowStart(windowStartRef.current - EPG_PAN_STEP_MS),
    [commitWindowStart],
  );
  const panLater = useCallback(
    () => commitWindowStart(windowStartRef.current + EPG_PAN_STEP_MS),
    [commitWindowStart],
  );
  const jumpToLive = useCallback(
    () => commitWindowStart(floorToEpgSlot(propsRef.current.nowMs)),
    [commitWindowStart],
  );
  const jumpToDay = useCallback(
    (dayStartMs: number) =>
      commitWindowStart(
        computeDayJumpWindowStart(dayStartMs, propsRef.current.nowMs, windowStartRef.current),
      ),
    [commitWindowStart],
  );

  const hydrateChannels = useCallback((channelKeys: readonly string[]) => {
    const epgWindow = propsRef.current.catalog.epgWindow;
    if (!epgWindow || channelKeys.length === 0) return;

    const currentStart = windowStartRef.current;
    const currentSpan = propsRef.current.spanMs;
    const now = propsRef.current.nowMs;
    const seen = new Set<string>();
    const missing: string[] = [];

    for (const key of channelKeys) {
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      const cacheKey = `${key}|${currentStart}|${currentSpan}`;
      if (inFlightRef.current.has(cacheKey)) continue;
      const hit = cacheRef.current.get(cacheKey, 0);
      if (hit !== undefined && now - hit.storedAt <= EPG_CACHE_TTL_MS) continue;
      missing.push(key);
    }
    if (missing.length === 0) return;

    const reqGen = genRef.current;
    const toMs = currentStart + currentSpan + EPG_FETCH_BUFFER_MS;

    for (let offset = 0; offset < missing.length; offset += MAX_EPG_WINDOW_KEYS) {
      const chunk = missing.slice(offset, offset + MAX_EPG_WINDOW_KEYS);
      const chunkCacheKeys = chunk.map((k) => `${k}|${currentStart}|${currentSpan}`);
      for (const ck of chunkCacheKeys) inFlightRef.current.add(ck);

      void epgWindow(chunk, currentStart, toMs)
        .then((rowsByChannel) => {
          for (const ck of chunkCacheKeys) inFlightRef.current.delete(ck);
          if (!mountedRef.current || genRef.current !== reqGen) return;
          const storedAt = propsRef.current.nowMs;
          for (const chKey of chunk) {
            cacheRef.current.set(
              `${chKey}|${currentStart}|${currentSpan}`,
              { rows: rowsByChannel[chKey] ?? EMPTY_PROGRAMMES, storedAt },
              0,
            );
          }
          setVersion((v) => v + 1);
        })
        .catch(() => {
          for (const ck of chunkCacheKeys) inFlightRef.current.delete(ck);
        });
    }
  }, []);

  const getProgrammes = useCallback((channelKey: string): readonly ProgrammeRow[] => {
    if (channelKey.length === 0) return EMPTY_PROGRAMMES;
    return (
      cacheRef.current.get(`${channelKey}|${windowStartRef.current}|${propsRef.current.spanMs}`, 0)
        ?.rows ?? EMPTY_PROGRAMMES
    );
  }, []);

  const refreshGuide = useCallback(async (sourceId: string): Promise<void> => {
    const importGuide = propsRef.current.catalog.importGuide;
    if (refreshingRef.current || !importGuide || sourceId.length === 0) return;
    refreshingRef.current = true;
    setRefreshingGuide(true);
    try {
      const result = await importGuide(sourceId);
      if (!mountedRef.current || !result.ok) return;
      genRef.current += 1;
      cacheRef.current.clear();
      inFlightRef.current.clear();
      setVersion((v) => v + 1);
      propsRef.current.onGuideRefreshed?.();
    } finally {
      refreshingRef.current = false;
      if (mountedRef.current) setRefreshingGuide(false);
    }
  }, []);

  const isAtLiveWindow = windowStartMs === floorToEpgSlot(nowMs);

  return useMemo<EpgWindowData>(
    () => ({
      windowStartMs,
      isAtLiveWindow,
      refreshingGuide,
      version,
      panEarlier,
      panLater,
      jumpToLive,
      jumpToDay,
      hydrateChannels,
      getProgrammes,
      refreshGuide,
    }),
    [
      getProgrammes,
      hydrateChannels,
      isAtLiveWindow,
      jumpToDay,
      jumpToLive,
      panEarlier,
      panLater,
      refreshGuide,
      refreshingGuide,
      version,
      windowStartMs,
    ],
  );
}

export {
  type UseEpgTimeCursorOptions,
  useEpgTimeCursor,
} from './useEpgTimeCursor';
