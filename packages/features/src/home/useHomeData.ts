import type {
  CatalogService,
  FavoriteRow,
  ItemRow,
  SeriesUnplayedSummary,
  SourceRow,
  UserItemKind,
  WatchProgressRow,
} from '@elv/data';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type CachedHomeSnapshot,
  type HydratedVodCollection,
  mergeHydratedCollections,
  useCatalogUiCache,
  useProfile,
  useSeriesUnplayedCounts,
} from '../shared';
import {
  applyHomeFavUpdate,
  applyHomeWatchedUpdate,
  EMPTY_HOME_SNAPSHOT,
  fetchHomeKindCategory,
  mergeOptimisticHomeSnapshot,
  releaseInFlightKey,
} from './home-data-helpers';

const HOME_CONTINUE_LIMIT = 16;
const HOME_RECENT_CHANNELS_LIMIT = 20;
const HOME_FAVORITES_LIMIT = 24;
const HOME_LIVE_LIMIT = 12;
const HOME_MOVIES_LIMIT = 18;
const HOME_SERIES_LIMIT = 18;
const HOME_COLLECTIONS_LIMIT = 20;

async function fetchHydratedCollections(
  catalog: CatalogService,
): Promise<readonly HydratedVodCollection[] | null> {
  if (
    typeof catalog.listCollections !== 'function' ||
    typeof catalog.listCollectionItems !== 'function'
  ) {
    return [];
  }
  try {
    const cols = await catalog.listCollections();
    const bounded = cols.slice(0, HOME_COLLECTIONS_LIMIT);
    return await Promise.all(
      bounded.map(async (collection) => ({
        collection,
        items:
          (await catalog.listCollectionItems?.(collection.id).catch(() => [] as ItemRow[])) ?? [],
      })),
    );
  } catch {
    return null;
  }
}

/** Options for {@link useHomeData}. */
export interface UseHomeDataOptions {
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly refreshToken: number;
  readonly userStateVersion?: number;
}

interface ToggleMyListTarget {
  readonly sourceId: string;
  readonly itemKey: string;
  readonly kind: UserItemKind;
  readonly title: string;
  readonly logo?: string | null;
  readonly year?: number | null;
  readonly rating?: number | null;
}

interface ToggleWatchedTarget {
  readonly sourceId: string;
  readonly itemKey: string;
  readonly kind: UserItemKind;
  readonly title: string;
  readonly subtitle?: string | null;
  readonly logo?: string | null;
  readonly durationMs?: number;
}

type HomeSnapshot = CachedHomeSnapshot;

/** Bounded Home dataset and live optimistic user-state mutations returned by {@link useHomeData}. */
export interface HomeDataState extends HomeSnapshot {
  readonly loading: boolean;
  readonly hasLoaded: boolean;
  readonly collections: readonly HydratedVodCollection[];
  readonly unplayedBySeriesKey: ReadonlyMap<string, SeriesUnplayedSummary>;
  readonly watchedOverrides: ReadonlyMap<string, boolean>;
  readonly refreshCollections: () => Promise<void>;
  readonly toggleMyList: (target: ToggleMyListTarget) => Promise<void>;
  readonly toggleWatched: (target: ToggleWatchedTarget, nextWatched: boolean) => Promise<void>;
}

/**
 * Loads strictly bounded Home rail pages (`<= 24` rows per rail) in parallel with cancellation
 * protection, `CatalogUiCache` synchronous hydration (`#445`), and committed-baseline optimistic
 * `toggleMyList` / `toggleWatched` mutations (`#14`, `#230`).
 */
export function useHomeData({
  catalog,
  sources,
  refreshToken,
  userStateVersion = 0,
}: UseHomeDataOptions): HomeDataState {
  const uiCache = useCatalogUiCache();
  const { activeProfileId } = useProfile();
  const activeProfileIdRef = useRef(activeProfileId);
  activeProfileIdRef.current = activeProfileId;
  const initialCached = sources.length > 0 ? (uiCache?.getHome()?.snapshot ?? null) : null;

  const [loading, setLoading] = useState(() => sources.length > 0 && initialCached === null);
  const [hasLoaded, setHasLoaded] = useState(() => initialCached !== null);
  const [snap, setSnap] = useState<HomeSnapshot>(() => initialCached ?? EMPTY_HOME_SNAPSHOT);
  const [collections, setCollections] = useState<readonly HydratedVodCollection[]>([]);
  const [watchedOverrides, setWatchedOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const [unplayedTick, setUnplayedTick] = useState(0);

  const mountedRef = useRef(true);
  const hasLoadedRef = useRef(initialCached !== null);
  const snapRef = useRef(snap);
  const collectionsRef = useRef(collections);
  collectionsRef.current = collections;
  const prevProfileIdRef = useRef(activeProfileId);
  const watchedOverridesRef = useRef(watchedOverrides);
  watchedOverridesRef.current = watchedOverrides;
  const uiCacheRef = useRef(uiCache);
  uiCacheRef.current = uiCache;
  const favGenByKeyRef = useRef(new Map<string, number>());
  const favInFlightRef = useRef(new Map<string, number>());
  const committedFavRef = useRef(
    new Map<string, { inList: boolean; row: FavoriteRow | undefined }>(),
  );
  const watchedGenByKeyRef = useRef(new Map<string, number>());
  const watchedInFlightRef = useRef(new Map<string, number>());
  const committedWatchedRef = useRef(
    new Map<
      string,
      {
        row: WatchProgressRow | undefined;
        cwRow: WatchProgressRow | undefined;
        override: boolean | undefined;
      }
    >(),
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (prevProfileIdRef.current !== activeProfileId) {
      prevProfileIdRef.current = activeProfileId;
      collectionsRef.current = [];
      setCollections([]);
    }
  }, [activeProfileId]);

  const refreshCollections = useCallback(async () => {
    const fetched = await fetchHydratedCollections(catalog);
    if (!mountedRef.current) return;
    const next = mergeHydratedCollections(fetched, collectionsRef.current);
    collectionsRef.current = next;
    setCollections(next);
  }, [catalog]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken, userStateVersion, and activeProfileId intentionally trigger fresh bounded reads
  useEffect(() => {
    setWatchedOverrides((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map<string, boolean>();
      for (const [k, v] of prev) {
        if ((watchedInFlightRef.current.get(k) ?? 0) > 0) next.set(k, v);
      }
      watchedOverridesRef.current = next;
      return next;
    });
    if (sources.length === 0) {
      snapRef.current = EMPTY_HOME_SNAPSHOT;
      setSnap(EMPTY_HOME_SNAPSHOT);
      collectionsRef.current = [];
      setCollections([]);
      setLoading(false);
      hasLoadedRef.current = true;
      setHasLoaded(true);
      return undefined;
    }

    let cancelled = false;
    if (!hasLoadedRef.current) setLoading(true);
    const readySources = sources.filter((s) => !s.needsImport);
    const activeSources = readySources.length > 0 ? readySources : sources;

    const run = async () => {
      try {
        const [
          cwRows,
          recentChannelRows,
          favRows,
          favKeys,
          firstLive,
          firstMovie,
          firstSeries,
          hydratedCollections,
        ] = await Promise.all([
          catalog.listContinueWatching?.(HOME_CONTINUE_LIMIT).catch(() => []) ??
            Promise.resolve([] as WatchProgressRow[]),
          catalog.listRecentChannels?.(HOME_RECENT_CHANNELS_LIMIT).catch(() => []) ??
            Promise.resolve([] as ItemRow[]),
          catalog.listFavorites?.(HOME_FAVORITES_LIMIT).catch(() => []) ??
            Promise.resolve([] as FavoriteRow[]),
          catalog.listFavoriteKeys?.().catch(() => []) ?? Promise.resolve([] as string[]),
          fetchHomeKindCategory(catalog, activeSources, 'live'),
          fetchHomeKindCategory(catalog, activeSources, 'movie'),
          fetchHomeKindCategory(catalog, activeSources, 'series'),
          fetchHydratedCollections(catalog),
        ]);
        if (cancelled) return;

        const nextCollections = mergeHydratedCollections(
          hydratedCollections,
          collectionsRef.current,
        );
        collectionsRef.current = nextCollections;
        setCollections(nextCollections);

        const [liveRows, movieRows, seriesRows] = await Promise.all([
          firstLive
            ? catalog.items(firstLive.id, 0, HOME_LIVE_LIMIT).catch(() => [] as ItemRow[])
            : Promise.resolve([] as ItemRow[]),
          firstMovie
            ? catalog
                .items(firstMovie.id, 0, HOME_MOVIES_LIMIT, { excludeWatched: true })
                .catch(() => [] as ItemRow[])
            : Promise.resolve([] as ItemRow[]),
          firstSeries
            ? catalog
                .items(firstSeries.id, 0, HOME_SERIES_LIMIT, { excludeWatched: true })
                .catch(() => [] as ItemRow[])
            : Promise.resolve([] as ItemRow[]),
        ]);
        if (cancelled) return;

        const keySet = new Set<string>([
          ...movieRows.map((m) => m.key),
          ...seriesRows.map((s) => s.key),
          ...favRows.map((f) => f.itemKey),
          ...nextCollections.flatMap((c) => c.items.map((item) => item.key)),
        ]);
        const extraProgress =
          keySet.size > 0 && catalog.listProgressByKeys
            ? await catalog.listProgressByKeys(Array.from(keySet)).catch(() => [])
            : [];
        if (cancelled) return;

        const nextProgress = new Map<string, WatchProgressRow>();
        for (const row of extraProgress) nextProgress.set(row.itemKey, row);
        for (const row of cwRows) nextProgress.set(row.itemKey, row);

        const nextFavKeys = new Set<string>(favKeys);
        for (const row of favRows) nextFavKeys.add(row.itemKey);

        const fetchedSnap: HomeSnapshot = {
          continueWatching: cwRows,
          favorites: favRows,
          favoriteKeys: nextFavKeys,
          progressByKey: nextProgress,
          liveCategory: firstLive,
          liveItems: liveRows,
          recentChannels: recentChannelRows,
          movies: movieRows,
          series: seriesRows,
        };
        const mergedSnap = mergeOptimisticHomeSnapshot(
          fetchedSnap,
          snapRef.current,
          favInFlightRef.current,
          watchedInFlightRef.current,
        );
        snapRef.current = mergedSnap;
        uiCacheRef.current?.setHome(mergedSnap);
        setSnap(mergedSnap);
      } finally {
        if (!cancelled) {
          hasLoadedRef.current = true;
          setHasLoaded(true);
          setLoading(false);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, catalog, sources, refreshToken, userStateVersion]);

  const applyFavState = useCallback(
    (itemKey: string, inList: boolean, row: FavoriteRow | undefined) => {
      const nextSync = applyHomeFavUpdate(snapRef.current, itemKey, inList, row);
      snapRef.current = nextSync;
      uiCacheRef.current?.setHome(nextSync);
      setSnap((prev) => {
        const next = applyHomeFavUpdate(prev, itemKey, inList, row);
        snapRef.current = next;
        uiCacheRef.current?.setHome(next);
        return next;
      });
    },
    [],
  );

  const toggleMyList = useCallback(
    async (target: ToggleMyListTarget): Promise<void> => {
      const key = target.itemKey;
      const gen = (favGenByKeyRef.current.get(key) ?? 0) + 1;
      favGenByKeyRef.current.set(key, gen);
      const activeInFlight = favInFlightRef.current.get(key) ?? 0;
      if (activeInFlight === 0) {
        committedFavRef.current.set(key, {
          inList: snapRef.current.favoriteKeys.has(key),
          row: snapRef.current.favorites.find((f) => f.itemKey === key),
        });
      }
      favInFlightRef.current.set(key, activeInFlight + 1);

      const nextFav = !snapRef.current.favoriteKeys.has(key);
      const addedRow: FavoriteRow = {
        profileId: activeProfileIdRef.current,
        sourceId: target.sourceId,
        itemKey: key,
        kind: target.kind,
        title: target.title,
        logo: target.logo ?? null,
        year: target.year ?? null,
        rating: target.rating ?? null,
        addedAt: Date.now(),
      };
      applyFavState(key, nextFav, addedRow);
      const favInput = {
        sourceId: target.sourceId,
        itemKey: key,
        kind: target.kind,
        title: target.title,
        logo: target.logo ?? null,
        year: target.year ?? null,
        rating: target.rating ?? null,
      };
      if (!catalog.setFavorite && !catalog.toggleFavorite) {
        committedFavRef.current.set(key, { inList: nextFav, row: nextFav ? addedRow : undefined });
        releaseInFlightKey(favInFlightRef.current, key);
        return;
      }
      try {
        const res = catalog.setFavorite
          ? await catalog.setFavorite(favInput, nextFav)
          : await catalog.toggleFavorite?.(favInput);
        if (!mountedRef.current || !res) return;
        if (res.ok) {
          committedFavRef.current.set(key, {
            inList: res.value,
            row: res.value ? addedRow : undefined,
          });
        } else if (favGenByKeyRef.current.get(key) === gen) {
          const base = committedFavRef.current.get(key);
          applyFavState(key, base?.inList ?? false, base?.row);
        }
      } catch {
        if (mountedRef.current && favGenByKeyRef.current.get(key) === gen) {
          const base = committedFavRef.current.get(key);
          applyFavState(key, base?.inList ?? false, base?.row);
        }
      } finally {
        releaseInFlightKey(favInFlightRef.current, key);
      }
    },
    [applyFavState, catalog],
  );

  const applyWatchedState = useCallback(
    (
      itemKey: string,
      row: WatchProgressRow | undefined,
      restoreCw: WatchProgressRow | undefined,
    ) => {
      const nextSync = applyHomeWatchedUpdate(snapRef.current, itemKey, row, restoreCw);
      snapRef.current = nextSync;
      uiCacheRef.current?.setHome(nextSync);
      setSnap((prev) => {
        const next = applyHomeWatchedUpdate(prev, itemKey, row, restoreCw);
        snapRef.current = next;
        uiCacheRef.current?.setHome(next);
        return next;
      });
    },
    [],
  );

  const setWatchedOverrideForKey = useCallback((itemKey: string, value: boolean | undefined) => {
    setWatchedOverrides((prev) => {
      const next = new Map(prev);
      if (value === undefined) next.delete(itemKey);
      else next.set(itemKey, value);
      watchedOverridesRef.current = next;
      return next;
    });
  }, []);

  const toggleWatched = useCallback(
    async (target: ToggleWatchedTarget, nextWatched: boolean): Promise<void> => {
      const key = target.itemKey;
      const gen = (watchedGenByKeyRef.current.get(key) ?? 0) + 1;
      watchedGenByKeyRef.current.set(key, gen);
      const existing = snapRef.current.progressByKey.get(key);
      const prevCwRow = snapRef.current.continueWatching.find((r) => r.itemKey === key);
      const prevOverride = watchedOverridesRef.current.get(key);
      const activeInFlight = watchedInFlightRef.current.get(key) ?? 0;
      if (activeInFlight === 0) {
        committedWatchedRef.current.set(key, {
          row: existing,
          cwRow: prevCwRow,
          override: prevOverride,
        });
      }
      watchedInFlightRef.current.set(key, activeInFlight + 1);

      const durationMs = target.durationMs ?? 0;
      const nextRow: WatchProgressRow = existing
        ? {
            ...existing,
            watched: nextWatched,
            positionMs: nextWatched ? existing.positionMs : 0,
            updatedAt: Date.now(),
          }
        : {
            profileId: activeProfileIdRef.current,
            sourceId: target.sourceId,
            itemKey: key,
            kind: target.kind,
            title: target.title,
            subtitle: target.subtitle ?? null,
            logo: target.logo ?? null,
            seriesKey: null,
            season: null,
            episode: null,
            positionMs: nextWatched ? durationMs : 0,
            durationMs,
            watched: nextWatched,
            updatedAt: Date.now(),
          };
      applyWatchedState(key, nextRow, undefined);
      setWatchedOverrideForKey(key, nextWatched);

      const useSave = existing === undefined && nextWatched && catalog.saveProgress !== undefined;
      if (!useSave && !catalog.setWatched) {
        committedWatchedRef.current.set(key, {
          row: nextRow,
          cwRow: undefined,
          override: nextWatched,
        });
        releaseInFlightKey(watchedInFlightRef.current, key);
        return;
      }
      try {
        const res = useSave
          ? await catalog.saveProgress?.({
              sourceId: target.sourceId,
              itemKey: key,
              kind: target.kind,
              title: target.title,
              subtitle: target.subtitle ?? null,
              logo: target.logo ?? null,
              positionMs: durationMs,
              durationMs,
              watched: true,
            })
          : await catalog.setWatched?.(key, nextWatched);
        if (!mountedRef.current || !res) return;
        if (res.ok) {
          committedWatchedRef.current.set(key, {
            row: nextRow,
            cwRow: undefined,
            override: nextWatched,
          });
          if (target.kind === 'series') setUnplayedTick((t) => t + 1);
        } else if (watchedGenByKeyRef.current.get(key) === gen) {
          const base = committedWatchedRef.current.get(key);
          applyWatchedState(key, base?.row, base?.cwRow);
          setWatchedOverrideForKey(key, base?.override);
        }
      } catch {
        if (mountedRef.current && watchedGenByKeyRef.current.get(key) === gen) {
          const base = committedWatchedRef.current.get(key);
          applyWatchedState(key, base?.row, base?.cwRow);
          setWatchedOverrideForKey(key, base?.override);
        }
      } finally {
        releaseInFlightKey(watchedInFlightRef.current, key);
      }
    },
    [applyWatchedState, catalog, setWatchedOverrideForKey],
  );

  const homeSeriesKeys = useMemo(() => {
    const keys: string[] = [];
    for (const row of snap.series) keys.push(row.key);
    for (const fav of snap.favorites) {
      if (fav.kind === 'series') keys.push(fav.itemKey);
    }
    for (const col of collections) {
      for (const item of col.items) {
        if (item.kind === 'series') keys.push(item.key);
      }
    }
    return keys;
  }, [collections, snap.favorites, snap.series]);

  const unplayedBySeriesKey = useSeriesUnplayedCounts(
    catalog,
    homeSeriesKeys,
    refreshToken + userStateVersion + unplayedTick,
  );

  return useMemo<HomeDataState>(
    () => ({
      loading,
      hasLoaded,
      ...snap,
      collections,
      unplayedBySeriesKey,
      watchedOverrides,
      refreshCollections,
      toggleMyList,
      toggleWatched,
    }),
    [
      collections,
      hasLoaded,
      loading,
      refreshCollections,
      snap,
      toggleMyList,
      toggleWatched,
      unplayedBySeriesKey,
      watchedOverrides,
    ],
  );
}
