import type {
  CatalogService,
  FavoriteRow,
  ItemRow,
  MyListNewEpisodeRow,
  NowNextEntry,
  SeriesUnplayedSummary,
  SourceRow,
  UserItemKind,
  WatchProgressRow,
} from '@elv/data';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  batchLoadProgressByKeys,
  type CachedHomeSnapshot,
  type HydratedVodCollection,
  mergeHydratedCollections,
  useCatalogUiCache,
  useProfile,
  useSeriesUnplayedCounts,
} from '../shared';
import {
  applyHomeFavUpdate,
  applyHomeRemoveContinueWatching,
  applyHomeRemoveNewEpisode,
  applyHomeRestoreNewEpisode,
  applyHomeWatchedUpdate,
  collectUnifiedLiveKeys,
  EMPTY_HOME_SNAPSHOT,
  fetchHomeKindCategory,
  fetchHydratedCollections,
  mergeOptimisticHomeSnapshot,
  releaseInFlightKey,
} from './home-data-helpers';
import type { HomeRailEntry } from './home-model';

const HOME_CONTINUE_LIMIT = 16;
const HOME_NEW_EPISODES_LIMIT = 24;
const HOME_RECENT_CHANNELS_LIMIT = 20;
const HOME_FAVORITES_LIMIT = 250;
const HOME_LIVE_LIMIT = 12;
const HOME_MOVIES_LIMIT = 18;
const HOME_SERIES_LIMIT = 18;

/** Options for {@link useHomeData}. */
export interface UseHomeDataOptions {
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly refreshToken: number;
  readonly userStateVersion?: number;
  readonly isPlaybackActive?: boolean;
  readonly routeActive?: boolean;
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
  readonly nowNextByKey: ReadonlyMap<string, NowNextEntry>;
  readonly unplayedBySeriesKey: ReadonlyMap<string, SeriesUnplayedSummary>;
  readonly watchedOverrides: ReadonlyMap<string, boolean>;
  readonly refreshCollections: () => Promise<void>;
  readonly toggleMyList: (target: ToggleMyListTarget) => Promise<void>;
  readonly toggleWatched: (target: ToggleWatchedTarget, nextWatched: boolean) => Promise<void>;
  readonly removeFromContinueWatching: (itemKey: string) => Promise<void>;
  readonly dismissNewEpisode: (episodeKey: string) => Promise<void>;
  readonly markNewEpisodeWatched: (entry: HomeRailEntry) => Promise<void>;
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
  isPlaybackActive = false,
  routeActive = true,
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
  const [nowNextByKey, setNowNextByKey] = useState<ReadonlyMap<string, NowNextEntry>>(
    () => new Map(),
  );
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
  const newEpInFlightRef = useRef(new Map<string, number>());
  const newEpRefreshRunIdRef = useRef(0);
  const newEpRefreshInFlightRef = useRef(0);
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
      setNowNextByKey(new Map());
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
          newEpisodeRows,
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
          catalog.listMyListNewEpisodes?.(HOME_NEW_EPISODES_LIMIT).catch(() => []) ??
            Promise.resolve([] as MyListNewEpisodeRow[]),
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
        const liveKeys = collectUnifiedLiveKeys(favRows, recentChannelRows, liveRows);
        const [nextProgress, nowNextRows] = await Promise.all([
          keySet.size > 0
            ? batchLoadProgressByKeys(catalog, Array.from(keySet)).catch(
                () => new Map<string, WatchProgressRow>(),
              )
            : Promise.resolve(new Map<string, WatchProgressRow>()),
          liveKeys.length > 0 && typeof catalog.nowNext === 'function'
            ? catalog.nowNext(liveKeys, Date.now()).catch(() => [] as NowNextEntry[])
            : Promise.resolve([] as NowNextEntry[]),
        ]);
        if (cancelled) return;
        for (const row of cwRows) nextProgress.set(row.itemKey, row);
        const nextNowNext = new Map<string, NowNextEntry>();
        for (const entry of nowNextRows) nextNowNext.set(entry.channelKey, entry);
        setNowNextByKey(nextNowNext);

        const nextFavKeys = new Set<string>(favKeys);
        for (const row of favRows) nextFavKeys.add(row.itemKey);

        const fetchedSnap: HomeSnapshot = {
          continueWatching: cwRows,
          newEpisodes: newEpisodeRows,
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
          newEpInFlightRef.current,
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: userStateVersion and activeProfileId re-trigger cooldown-gated background checks
  useEffect(() => {
    if (
      !routeActive ||
      isPlaybackActive ||
      sources.length === 0 ||
      typeof catalog.refreshMyListNewEpisodes !== 'function'
    ) {
      return undefined;
    }
    if (newEpRefreshInFlightRef.current !== 0) return undefined;
    const runId = newEpRefreshRunIdRef.current + 1;
    newEpRefreshRunIdRef.current = runId;
    newEpRefreshInFlightRef.current = runId;

    let cancelled = false;
    void catalog
      .refreshMyListNewEpisodes()
      .then(async (res) => {
        if (cancelled || !mountedRef.current || !res.ok || res.value.newlyDetectedCount <= 0) {
          return;
        }
        const fresh = await catalog
          .listMyListNewEpisodes?.(HOME_NEW_EPISODES_LIMIT)
          .catch(() => null);
        if (cancelled || !mountedRef.current || fresh === null || fresh === undefined) return;
        const filtered = fresh.filter(
          (row) => (newEpInFlightRef.current.get(row.episodeKey) ?? 0) <= 0,
        );
        const nextSync: HomeSnapshot = { ...snapRef.current, newEpisodes: filtered };
        snapRef.current = nextSync;
        uiCacheRef.current?.setHome(nextSync);
        setSnap((prev) => {
          const next: HomeSnapshot = { ...prev, newEpisodes: filtered };
          snapRef.current = next;
          uiCacheRef.current?.setHome(next);
          return next;
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (newEpRefreshInFlightRef.current === runId) newEpRefreshInFlightRef.current = 0;
      });

    return () => {
      cancelled = true;
      if (newEpRefreshInFlightRef.current === runId) newEpRefreshInFlightRef.current = 0;
    };
  }, [
    activeProfileId,
    catalog,
    isPlaybackActive,
    refreshToken,
    routeActive,
    sources.length,
    userStateVersion,
  ]);

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

  const removeFromContinueWatching = useCallback(
    async (itemKey: string): Promise<void> => {
      const prevRow = snapRef.current.progressByKey.get(itemKey);
      const prevCwRow = snapRef.current.continueWatching.find((r) => r.itemKey === itemKey);
      const nextSync = applyHomeRemoveContinueWatching(snapRef.current, itemKey);
      snapRef.current = nextSync;
      uiCacheRef.current?.setHome(nextSync);
      setSnap((prev) => {
        const next = applyHomeRemoveContinueWatching(prev, itemKey);
        snapRef.current = next;
        uiCacheRef.current?.setHome(next);
        return next;
      });
      if (typeof catalog.clearProgress !== 'function') return;
      try {
        const res = await catalog.clearProgress(itemKey);
        if (!mountedRef.current) return;
        if (!res.ok) {
          applyWatchedState(itemKey, prevRow, prevCwRow);
        }
      } catch {
        if (mountedRef.current) {
          applyWatchedState(itemKey, prevRow, prevCwRow);
        }
      }
    },
    [applyWatchedState, catalog],
  );

  const removeNewEpisodeOptimistic = useCallback((episodeKey: string) => {
    const nextSync = applyHomeRemoveNewEpisode(snapRef.current, episodeKey);
    snapRef.current = nextSync;
    uiCacheRef.current?.setHome(nextSync);
    setSnap((prev) => {
      const next = applyHomeRemoveNewEpisode(prev, episodeKey);
      snapRef.current = next;
      uiCacheRef.current?.setHome(next);
      return next;
    });
  }, []);

  const restoreNewEpisode = useCallback((row: MyListNewEpisodeRow | undefined) => {
    if (row === undefined) return;
    const nextSync = applyHomeRestoreNewEpisode(snapRef.current, row);
    snapRef.current = nextSync;
    uiCacheRef.current?.setHome(nextSync);
    setSnap((prev) => {
      const next = applyHomeRestoreNewEpisode(prev, row);
      snapRef.current = next;
      uiCacheRef.current?.setHome(next);
      return next;
    });
  }, []);

  const dismissNewEpisode = useCallback(
    async (episodeKey: string): Promise<void> => {
      const prevRow = (snapRef.current.newEpisodes ?? []).find((r) => r.episodeKey === episodeKey);
      newEpInFlightRef.current.set(episodeKey, (newEpInFlightRef.current.get(episodeKey) ?? 0) + 1);
      removeNewEpisodeOptimistic(episodeKey);
      if (typeof catalog.dismissMyListNewEpisode !== 'function') {
        releaseInFlightKey(newEpInFlightRef.current, episodeKey);
        return;
      }
      try {
        const res = await catalog.dismissMyListNewEpisode(episodeKey);
        if (!mountedRef.current) return;
        if (!res.ok) restoreNewEpisode(prevRow);
      } catch {
        if (mountedRef.current) restoreNewEpisode(prevRow);
      } finally {
        releaseInFlightKey(newEpInFlightRef.current, episodeKey);
      }
    },
    [catalog, removeNewEpisodeOptimistic, restoreNewEpisode],
  );

  const markNewEpisodeWatched = useCallback(
    async (entry: HomeRailEntry): Promise<void> => {
      const episodeKey = entry.itemKey;
      const prevRow = (snapRef.current.newEpisodes ?? []).find((r) => r.episodeKey === episodeKey);
      newEpInFlightRef.current.set(episodeKey, (newEpInFlightRef.current.get(episodeKey) ?? 0) + 1);
      removeNewEpisodeOptimistic(episodeKey);
      if (typeof catalog.setWatched !== 'function' && typeof catalog.saveProgress !== 'function') {
        releaseInFlightKey(newEpInFlightRef.current, episodeKey);
        return;
      }
      try {
        const res =
          typeof catalog.setWatched === 'function'
            ? await catalog.setWatched(episodeKey, true)
            : await catalog.saveProgress?.({
                sourceId: entry.sourceId,
                itemKey: episodeKey,
                kind: 'episode',
                title: entry.title,
                subtitle: entry.subtitle ?? null,
                logo: entry.posterUri ?? entry.backdropUri ?? null,
                seriesKey: entry.seriesKey ?? null,
                season: entry.season ?? null,
                episode: entry.episode ?? null,
                positionMs: 0,
                durationMs: 0,
                watched: true,
              });
        if (!mountedRef.current || !res) return;
        if (res.ok) {
          setUnplayedTick((t) => t + 1);
        } else {
          restoreNewEpisode(prevRow);
        }
      } catch {
        if (mountedRef.current) restoreNewEpisode(prevRow);
      } finally {
        releaseInFlightKey(newEpInFlightRef.current, episodeKey);
      }
    },
    [catalog, removeNewEpisodeOptimistic, restoreNewEpisode],
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
      nowNextByKey,
      unplayedBySeriesKey,
      watchedOverrides,
      refreshCollections,
      toggleMyList,
      toggleWatched,
      removeFromContinueWatching,
      dismissNewEpisode,
      markNewEpisodeWatched,
    }),
    [
      collections,
      dismissNewEpisode,
      hasLoaded,
      loading,
      markNewEpisodeWatched,
      nowNextByKey,
      refreshCollections,
      removeFromContinueWatching,
      snap,
      toggleMyList,
      toggleWatched,
      unplayedBySeriesKey,
      watchedOverrides,
    ],
  );
}
