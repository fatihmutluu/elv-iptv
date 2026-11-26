import type {
  CatalogService,
  FavoriteRow,
  RatingRow,
  RatingValue,
  SeriesUnplayedSummary,
  WatchProgressRow,
} from '@elv/data';
import type { DownloadRecord } from '@elv/domain';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HydratedVodCollection } from '../shared';
import {
  type DownloadedSeriesGroup,
  deriveSeriesKeyFromEpisodeRecord,
  groupDownloadedSeries,
  type LibraryCardItem,
  type LibrarySubTab,
} from './library-model';

/** Options for {@link useLibraryData}. */
export interface UseLibraryDataOptions {
  readonly catalog: CatalogService;
  readonly refreshToken: number;
  readonly userStateVersion: number;
  readonly activeTab: LibrarySubTab;
  readonly isPlaybackActive: boolean;
  readonly completedEpisodes: readonly DownloadRecord[];
}

/** Reactive Library data state and optimistic mutations. */
export interface LibraryDataState {
  readonly favorites: readonly FavoriteRow[];
  readonly ratings: readonly RatingRow[];
  readonly watchedMovies: readonly WatchProgressRow[];
  readonly watchedSeries: readonly WatchProgressRow[];
  readonly collections: readonly HydratedVodCollection[];
  readonly favoriteKeys: ReadonlySet<string>;
  readonly ratingMap: ReadonlyMap<string, RatingValue>;
  readonly watchedKeys: ReadonlySet<string>;
  readonly downloadedSeriesGroups: readonly DownloadedSeriesGroup[];
  readonly toggleFavorite: (item: LibraryCardItem) => Promise<void>;
  readonly setRating: (item: LibraryCardItem, value: RatingValue | null) => Promise<void>;
  readonly toggleWatched: (item: LibraryCardItem, currentWatched: boolean) => Promise<void>;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_UNPLAYED: ReadonlyMap<string, SeriesUnplayedSummary> = new Map();

/** Loads Library tabs (Following, Likes, Watched, Collections, Downloads series totals) with optimistic mutations. */
export function useLibraryData({
  catalog,
  refreshToken,
  userStateVersion,
  activeTab,
  isPlaybackActive,
  completedEpisodes,
}: UseLibraryDataOptions): LibraryDataState {
  const [favorites, setFavorites] = useState<readonly FavoriteRow[]>([]);
  const [ratings, setRatings] = useState<readonly RatingRow[]>([]);
  const [watchedMovies, setWatchedMovies] = useState<readonly WatchProgressRow[]>([]);
  const [watchedSeries, setWatchedSeries] = useState<readonly WatchProgressRow[]>([]);
  const [collections, setCollections] = useState<readonly HydratedVodCollection[]>([]);
  const [newEpisodeSeriesKeys, setNewEpisodeSeriesKeys] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [unplayedBySeriesKey, setUnplayedBySeriesKey] =
    useState<ReadonlyMap<string, SeriesUnplayedSummary>>(EMPTY_UNPLAYED);

  const mountedRef = useRef(true);
  const refreshedExtraSeriesKeysRef = useRef<Set<string>>(new Set());
  const prevCatalogRef = useRef(catalog);
  if (prevCatalogRef.current !== catalog) {
    prevCatalogRef.current = catalog;
    refreshedExtraSeriesKeysRef.current.clear();
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken and userStateVersion trigger fresh catalog reads
  useEffect(() => {
    let cancelled = false;

    const loadAll = async (): Promise<void> => {
      const [favs, rats, wMovies, wSeries, newEps, rawCols] = await Promise.all([
        catalog.listFavorites?.(200).catch(() => []) ?? Promise.resolve([]),
        catalog.listRatings?.({ limit: 200 }).catch(() => []) ?? Promise.resolve([]),
        catalog.listWatched?.(100, undefined, { kind: 'movie' }).catch(() => []) ??
          Promise.resolve([]),
        catalog.listWatched?.(100, undefined, { kind: 'series' }).catch(() => []) ??
          Promise.resolve([]),
        catalog.listMyListNewEpisodes?.().catch(() => []) ?? Promise.resolve([]),
        catalog.listCollections?.().catch(() => []) ?? Promise.resolve([]),
      ]);

      if (cancelled || !mountedRef.current) return;
      setFavorites(favs);
      setRatings(rats);
      setWatchedMovies(wMovies);
      setWatchedSeries(wSeries);
      setNewEpisodeSeriesKeys(new Set(newEps.map((r) => r.seriesKey)));

      if (rawCols.length === 0 || !catalog.listCollectionItems) {
        setCollections([]);
        return;
      }

      const hydrated = await Promise.all(
        rawCols.map(async (collection) => {
          const items = (await catalog.listCollectionItems?.(collection.id).catch(() => [])) ?? [];
          return { collection, items };
        }),
      );
      if (cancelled || !mountedRef.current) return;
      setCollections(hydrated.filter((h) => h.items.length > 0));
    };

    void loadAll();
    return () => {
      cancelled = true;
    };
  }, [catalog, refreshToken, userStateVersion]);

  const knownSeriesByTitle = useMemo(() => {
    const map = new Map<string, string>();
    for (const fav of favorites) {
      if (fav.kind === 'series') {
        map.set(`${fav.sourceId}|${fav.title.trim().toLowerCase()}`, fav.itemKey);
      }
    }
    for (const w of watchedSeries) {
      map.set(`${w.sourceId}|${w.title.trim().toLowerCase()}`, w.itemKey);
    }
    for (const r of ratings) {
      if (r.kind === 'series') {
        map.set(`${r.sourceId}|${r.title.trim().toLowerCase()}`, r.itemKey);
      }
    }
    return map;
  }, [favorites, ratings, watchedSeries]);

  const downloadedSeriesKeys = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const ep of completedEpisodes) {
      const key = deriveSeriesKeyFromEpisodeRecord(ep, knownSeriesByTitle);
      if (key !== null && !seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    }
    return out;
  }, [completedEpisodes, knownSeriesByTitle]);

  const downloadedSeriesKeysSig = downloadedSeriesKeys.join(',');

  // biome-ignore lint/correctness/useExhaustiveDependencies: downloadedSeriesKeysSig tracks the exact key set
  useEffect(() => {
    if (downloadedSeriesKeys.length === 0 || !catalog.listSeriesUnplayedCounts) {
      setUnplayedBySeriesKey(EMPTY_UNPLAYED);
      return;
    }
    let cancelled = false;
    void catalog
      .listSeriesUnplayedCounts(downloadedSeriesKeys)
      .then((rows) => {
        if (cancelled || !mountedRef.current) return;
        const next = new Map<string, SeriesUnplayedSummary>();
        for (const r of rows) next.set(r.seriesKey, r);
        setUnplayedBySeriesKey(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [catalog, downloadedSeriesKeysSig, refreshToken, userStateVersion]);

  // Polite background refresh of downloaded series episode totals when visiting Downloads tab while idle.
  // biome-ignore lint/correctness/useExhaustiveDependencies: downloadedSeriesKeysSig tracks exact key list
  useEffect(() => {
    if (
      activeTab !== 'downloads' ||
      isPlaybackActive ||
      downloadedSeriesKeys.length === 0 ||
      !catalog.refreshMyListNewEpisodes
    ) {
      return;
    }
    const keysToRefresh = downloadedSeriesKeys.filter(
      (key) => !refreshedExtraSeriesKeysRef.current.has(key),
    );
    if (keysToRefresh.length === 0) return;

    let cancelled = false;
    void catalog
      .refreshMyListNewEpisodes(undefined, { extraSeriesKeys: keysToRefresh })
      .then(async (res) => {
        if (cancelled || !mountedRef.current || !res.ok) return;
        for (const key of keysToRefresh) {
          refreshedExtraSeriesKeysRef.current.add(key);
        }
        const [counts, newEps] = await Promise.all([
          catalog.listSeriesUnplayedCounts?.(downloadedSeriesKeys).catch(() => []) ??
            Promise.resolve([]),
          catalog.listMyListNewEpisodes?.().catch(() => []) ?? Promise.resolve([]),
        ]);
        if (cancelled || !mountedRef.current) return;
        if (counts.length > 0) {
          const next = new Map<string, SeriesUnplayedSummary>();
          for (const r of counts) next.set(r.seriesKey, r);
          setUnplayedBySeriesKey(next);
        }
        setNewEpisodeSeriesKeys(new Set(newEps.map((r) => r.seriesKey)));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeTab, catalog, downloadedSeriesKeysSig, isPlaybackActive]);

  const downloadedSeriesGroups = useMemo(
    () =>
      groupDownloadedSeries(completedEpisodes, {
        unplayedBySeriesKey,
        newEpisodeSeriesKeys,
        knownSeriesByTitle,
      }),
    [completedEpisodes, knownSeriesByTitle, newEpisodeSeriesKeys, unplayedBySeriesKey],
  );

  const favoriteKeys = useMemo(() => new Set(favorites.map((f) => f.itemKey)), [favorites]);

  const ratingMap = useMemo(() => {
    const map = new Map<string, RatingValue>();
    for (const r of ratings) map.set(r.itemKey, r.value);
    return map;
  }, [ratings]);

  const watchedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const w of watchedMovies) set.add(w.itemKey);
    for (const w of watchedSeries) set.add(w.itemKey);
    return set;
  }, [watchedMovies, watchedSeries]);

  const favoritesRef = useRef(favorites);
  favoritesRef.current = favorites;
  const ratingsRef = useRef(ratings);
  ratingsRef.current = ratings;
  const watchedMoviesRef = useRef(watchedMovies);
  watchedMoviesRef.current = watchedMovies;
  const watchedSeriesRef = useRef(watchedSeries);
  watchedSeriesRef.current = watchedSeries;

  const toggleFavorite = useCallback(
    async (item: LibraryCardItem) => {
      const prev = favoritesRef.current;
      const isFav = prev.some((f) => f.itemKey === item.itemKey);
      const nextFav = !isFav;
      const optimistic: readonly FavoriteRow[] = nextFav
        ? [
            {
              profileId: 'default',
              sourceId: item.sourceId,
              itemKey: item.itemKey,
              kind: item.kind,
              title: item.title,
              logo: item.imageUri,
              year: item.year ?? null,
              rating: item.rating ?? null,
              addedAt: Date.now(),
            },
            ...prev,
          ]
        : prev.filter((f) => f.itemKey !== item.itemKey);
      setFavorites(optimistic);

      const input = {
        sourceId: item.sourceId,
        itemKey: item.itemKey,
        kind: item.kind,
        title: item.title,
        logo: item.imageUri,
        year: item.year ?? null,
        rating: item.rating ?? null,
      };
      try {
        const res = catalog.setFavorite
          ? await catalog.setFavorite(input, nextFav)
          : await catalog.toggleFavorite?.(input);
        if (res && !res.ok && mountedRef.current) setFavorites(prev);
      } catch {
        if (mountedRef.current) setFavorites(prev);
      }
    },
    [catalog],
  );

  const setRating = useCallback(
    async (item: LibraryCardItem, value: RatingValue | null) => {
      if (item.kind !== 'movie' && item.kind !== 'series') return;
      const prev = ratingsRef.current;
      const without = prev.filter((r) => r.itemKey !== item.itemKey);
      const optimistic: readonly RatingRow[] =
        value === null
          ? without
          : [
              {
                profileId: 'default',
                sourceId: item.sourceId,
                itemKey: item.itemKey,
                kind: item.kind,
                value,
                title: item.title,
                logo: item.imageUri,
                year: item.year ?? null,
                rating: item.rating ?? null,
                updatedAt: Date.now(),
              },
              ...without,
            ];
      setRatings(optimistic);

      if (!catalog.setRating) return;
      try {
        const res = await catalog.setRating(
          {
            sourceId: item.sourceId,
            itemKey: item.itemKey,
            kind: item.kind,
            title: item.title,
            logo: item.imageUri,
            year: item.year ?? null,
            rating: item.rating ?? null,
          },
          value,
        );
        if (!res.ok && mountedRef.current) setRatings(prev);
      } catch {
        if (mountedRef.current) setRatings(prev);
      }
    },
    [catalog],
  );

  const toggleWatched = useCallback(
    async (item: LibraryCardItem, currentWatched: boolean) => {
      if (item.kind !== 'movie' && item.kind !== 'series') return;
      const nextWatched = !currentWatched;
      const prevMovies = watchedMoviesRef.current;
      const prevSeries = watchedSeriesRef.current;

      if (item.kind === 'movie') {
        if (nextWatched) {
          setWatchedMovies([
            {
              profileId: 'default',
              sourceId: item.sourceId,
              itemKey: item.itemKey,
              kind: 'movie',
              title: item.title,
              subtitle: item.subtitle ?? null,
              logo: item.imageUri,
              seriesKey: null,
              season: null,
              episode: null,
              positionMs: 0,
              durationMs: 0,
              watched: true,
              updatedAt: Date.now(),
            },
            ...prevMovies.filter((w) => w.itemKey !== item.itemKey),
          ]);
        } else {
          setWatchedMovies(prevMovies.filter((w) => w.itemKey !== item.itemKey));
        }
      } else if (nextWatched) {
        setWatchedSeries([
          {
            profileId: 'default',
            sourceId: item.sourceId,
            itemKey: item.itemKey,
            kind: 'series',
            title: item.title,
            subtitle: item.subtitle ?? null,
            logo: item.imageUri,
            seriesKey: null,
            season: null,
            episode: null,
            positionMs: 0,
            durationMs: 0,
            watched: true,
            updatedAt: Date.now(),
          },
          ...prevSeries.filter((w) => w.itemKey !== item.itemKey),
        ]);
      } else {
        setWatchedSeries(prevSeries.filter((w) => w.itemKey !== item.itemKey));
      }

      if (!catalog.setWatched) return;
      try {
        const res = await catalog.setWatched(item.itemKey, nextWatched);
        if (!res.ok && mountedRef.current) {
          setWatchedMovies(prevMovies);
          setWatchedSeries(prevSeries);
        }
      } catch {
        if (mountedRef.current) {
          setWatchedMovies(prevMovies);
          setWatchedSeries(prevSeries);
        }
      }
    },
    [catalog],
  );

  return {
    favorites,
    ratings,
    watchedMovies,
    watchedSeries,
    collections,
    favoriteKeys,
    ratingMap,
    watchedKeys,
    downloadedSeriesGroups,
    toggleFavorite,
    setRating,
    toggleWatched,
  };
}
