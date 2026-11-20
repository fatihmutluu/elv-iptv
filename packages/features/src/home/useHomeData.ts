import {
  type BrowseKind,
  type CatalogService,
  type CategoryRow,
  DEFAULT_PROFILE_ID,
  type FavoriteRow,
  type ItemRow,
  type SourceRow,
  type UserItemKind,
  type WatchProgressRow,
} from '@elv/data';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const HOME_CONTINUE_LIMIT = 16;
const HOME_FAVORITES_LIMIT = 24;
const HOME_LIVE_LIMIT = 12;
const HOME_MOVIES_LIMIT = 18;
const HOME_SERIES_LIMIT = 18;
const MAX_SOURCES_TO_PROBE = 3;

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

interface HomeSnapshot {
  readonly continueWatching: readonly WatchProgressRow[];
  readonly favorites: readonly FavoriteRow[];
  readonly favoriteKeys: ReadonlySet<string>;
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly liveCategory: CategoryRow | null;
  readonly liveItems: readonly ItemRow[];
  readonly movies: readonly ItemRow[];
  readonly series: readonly ItemRow[];
}

const EMPTY_SNAPSHOT: HomeSnapshot = {
  continueWatching: [],
  favorites: [],
  favoriteKeys: new Set<string>(),
  progressByKey: new Map<string, WatchProgressRow>(),
  liveCategory: null,
  liveItems: [],
  movies: [],
  series: [],
};

/** Bounded Home dataset and live optimistic user-state mutations returned by {@link useHomeData}. */
export interface HomeDataState extends HomeSnapshot {
  readonly loading: boolean;
  readonly hasLoaded: boolean;
  readonly toggleMyList: (target: ToggleMyListTarget) => Promise<void>;
  readonly toggleWatched: (target: ToggleWatchedTarget, nextWatched: boolean) => Promise<void>;
}

function pickFirstCategory(lists: readonly (readonly CategoryRow[])[]): CategoryRow | null {
  let fallback: CategoryRow | null = null;
  for (const list of lists) {
    for (const cat of list) {
      if (fallback === null) fallback = cat;
      if (cat.itemCount > 0) return cat;
    }
  }
  return fallback;
}

async function fetchKindCategories(
  catalog: CatalogService,
  sources: readonly SourceRow[],
  kind: BrowseKind,
): Promise<CategoryRow | null> {
  const lists = await Promise.all(
    sources
      .slice(0, MAX_SOURCES_TO_PROBE)
      .map((source) => catalog.categories(source.id, kind).catch(() => [] as CategoryRow[])),
  );
  return pickFirstCategory(lists);
}

/**
 * Loads strictly bounded Home rail pages (`<= 24` rows per rail) in parallel with cancellation
 * protection and exposes optimistic `toggleMyList` and `toggleWatched` mutations backed by
 * SQLite (`#14`).
 */
export function useHomeData({
  catalog,
  sources,
  refreshToken,
  userStateVersion = 0,
}: UseHomeDataOptions): HomeDataState {
  const [loading, setLoading] = useState(() => sources.length > 0);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [snap, setSnap] = useState<HomeSnapshot>(EMPTY_SNAPSHOT);

  const mountedRef = useRef(true);
  const hasLoadedRef = useRef(false);
  const snapRef = useRef(snap);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken and userStateVersion intentionally trigger fresh bounded reads
  useEffect(() => {
    if (sources.length === 0) {
      snapRef.current = EMPTY_SNAPSHOT;
      setSnap(EMPTY_SNAPSHOT);
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
        const [cwRows, favRows, favKeys, firstLive, firstMovie, firstSeries] = await Promise.all([
          catalog.listContinueWatching?.(HOME_CONTINUE_LIMIT).catch(() => []) ??
            Promise.resolve([] as WatchProgressRow[]),
          catalog.listFavorites?.(HOME_FAVORITES_LIMIT).catch(() => []) ??
            Promise.resolve([] as FavoriteRow[]),
          catalog.listFavoriteKeys?.().catch(() => []) ?? Promise.resolve([] as string[]),
          fetchKindCategories(catalog, activeSources, 'live'),
          fetchKindCategories(catalog, activeSources, 'movie'),
          fetchKindCategories(catalog, activeSources, 'series'),
        ]);
        if (cancelled) return;

        const [liveRows, movieRows, seriesRows] = await Promise.all([
          firstLive
            ? catalog.items(firstLive.id, 0, HOME_LIVE_LIMIT).catch(() => [] as ItemRow[])
            : Promise.resolve([] as ItemRow[]),
          firstMovie
            ? catalog.items(firstMovie.id, 0, HOME_MOVIES_LIMIT).catch(() => [] as ItemRow[])
            : Promise.resolve([] as ItemRow[]),
          firstSeries
            ? catalog.items(firstSeries.id, 0, HOME_SERIES_LIMIT).catch(() => [] as ItemRow[])
            : Promise.resolve([] as ItemRow[]),
        ]);
        if (cancelled) return;

        const keySet = new Set<string>([
          ...movieRows.map((m) => m.key),
          ...seriesRows.map((s) => s.key),
          ...favRows.map((f) => f.itemKey),
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

        const nextSnap: HomeSnapshot = {
          continueWatching: cwRows,
          favorites: favRows,
          favoriteKeys: nextFavKeys,
          progressByKey: nextProgress,
          liveCategory: firstLive,
          liveItems: liveRows,
          movies: movieRows,
          series: seriesRows,
        };
        snapRef.current = nextSnap;
        setSnap(nextSnap);
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
  }, [catalog, sources, refreshToken, userStateVersion]);

  const applyFavState = useCallback(
    (itemKey: string, inList: boolean, row: FavoriteRow | undefined) => {
      const update = (prev: HomeSnapshot): HomeSnapshot => {
        const nextKeys = new Set(prev.favoriteKeys);
        if (inList) nextKeys.add(itemKey);
        else nextKeys.delete(itemKey);
        const filtered = prev.favorites.filter((f) => f.itemKey !== itemKey);
        const nextFavs =
          inList && row !== undefined
            ? [row, ...filtered].slice(0, HOME_FAVORITES_LIMIT)
            : filtered;
        return { ...prev, favoriteKeys: nextKeys, favorites: nextFavs };
      };
      // Update ref synchronously before awaiting so rapid taps never double-toggle.
      snapRef.current = update(snapRef.current);
      setSnap((prev) => {
        const next = update(prev);
        snapRef.current = next;
        return next;
      });
    },
    [],
  );

  const toggleMyList = useCallback(
    async (target: ToggleMyListTarget): Promise<void> => {
      const wasInList = snapRef.current.favoriteKeys.has(target.itemKey);
      const prevRow = snapRef.current.favorites.find((f) => f.itemKey === target.itemKey);
      const addedRow: FavoriteRow = {
        profileId: DEFAULT_PROFILE_ID,
        sourceId: target.sourceId,
        itemKey: target.itemKey,
        kind: target.kind,
        title: target.title,
        logo: target.logo ?? null,
        year: target.year ?? null,
        rating: target.rating ?? null,
        addedAt: Date.now(),
      };
      applyFavState(target.itemKey, !wasInList, addedRow);
      if (!catalog.toggleFavorite) return;
      try {
        const res = await catalog.toggleFavorite({
          sourceId: target.sourceId,
          itemKey: target.itemKey,
          kind: target.kind,
          title: target.title,
          logo: target.logo ?? null,
          year: target.year ?? null,
          rating: target.rating ?? null,
        });
        if (mountedRef.current && !res.ok) applyFavState(target.itemKey, wasInList, prevRow);
      } catch {
        if (mountedRef.current) applyFavState(target.itemKey, wasInList, prevRow);
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
      const update = (prev: HomeSnapshot): HomeSnapshot => {
        const nextProg = new Map(prev.progressByKey);
        if (row !== undefined) nextProg.set(itemKey, row);
        else nextProg.delete(itemKey);
        const filtered = prev.continueWatching.filter((r) => r.itemKey !== itemKey);
        const nextCw =
          restoreCw !== undefined
            ? [restoreCw, ...filtered].sort((a, b) => b.updatedAt - a.updatedAt)
            : filtered;
        return { ...prev, progressByKey: nextProg, continueWatching: nextCw };
      };
      snapRef.current = update(snapRef.current);
      setSnap((prev) => {
        const next = update(prev);
        snapRef.current = next;
        return next;
      });
    },
    [],
  );

  const toggleWatched = useCallback(
    async (target: ToggleWatchedTarget, nextWatched: boolean): Promise<void> => {
      const existing = snapRef.current.progressByKey.get(target.itemKey);
      const prevCwRow = snapRef.current.continueWatching.find((r) => r.itemKey === target.itemKey);
      const durationMs = target.durationMs ?? 0;
      const nextRow: WatchProgressRow = existing
        ? {
            ...existing,
            watched: nextWatched,
            positionMs: nextWatched ? existing.positionMs : 0,
            updatedAt: Date.now(),
          }
        : {
            profileId: DEFAULT_PROFILE_ID,
            sourceId: target.sourceId,
            itemKey: target.itemKey,
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
      applyWatchedState(target.itemKey, nextRow, undefined);

      const useSave = existing === undefined && nextWatched && catalog.saveProgress !== undefined;
      if (!useSave && !catalog.setWatched) return;
      try {
        const res = useSave
          ? await catalog.saveProgress?.({
              sourceId: target.sourceId,
              itemKey: target.itemKey,
              kind: target.kind,
              title: target.title,
              subtitle: target.subtitle ?? null,
              logo: target.logo ?? null,
              positionMs: durationMs,
              durationMs,
              watched: true,
            })
          : await catalog.setWatched?.(target.itemKey, nextWatched);
        if (mountedRef.current && res && !res.ok) {
          applyWatchedState(target.itemKey, existing, prevCwRow);
        }
      } catch {
        if (mountedRef.current) applyWatchedState(target.itemKey, existing, prevCwRow);
      }
    },
    [applyWatchedState, catalog],
  );

  return useMemo<HomeDataState>(
    () => ({ loading, hasLoaded, ...snap, toggleMyList, toggleWatched }),
    [hasLoaded, loading, snap, toggleMyList, toggleWatched],
  );
}
