import type {
  BrowseKind,
  CatalogService,
  CategoryRow,
  FavoriteRow,
  ItemRow,
  SourceRow,
  WatchProgressRow,
} from '@elv/data';
import { useEffect, useRef } from 'react';
import {
  batchLoadProgressByKeys,
  buildSharedDisplayCategories,
  type CatalogUiCache,
  LIVE_CHANNEL_ROWS_CAP,
  MAX_CATALOG_RAIL_ITEMS,
} from '../shared';

const HOME_CONTINUE_LIMIT = 16;
const HOME_FAVORITES_LIMIT = 24;
const HOME_LIVE_LIMIT = 12;
const HOME_VOD_LIMIT = 18;
const MAX_HOME_SOURCES = 3;
const CATALOG_CONTINUE_LIMIT = 24;
const PREWARM_CATALOG_RAILS = 4;
const MAX_LIVE_FAVORITES = 200;

/** Inputs for {@link runCatalogPrewarm}. */
export interface RunCatalogPrewarmOptions {
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly uiCache: CatalogUiCache;
  readonly isCancelled: () => boolean;
  /** Optional active tab hint so background tabs warm first while the visible tab loads itself. */
  readonly activeTab?: string;
  /** Whether multi-version movie grouping is enabled for the Movies discovery cache (`#404`). */
  readonly groupVodVersions?: boolean;
}

/** Options for {@link useCatalogPrewarm}. */
export interface UseCatalogPrewarmOptions {
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly catalogRevision: number;
  readonly locale?: string;
  readonly profileKey?: string;
  readonly elvKey?: string;
  readonly uiCache: CatalogUiCache;
  readonly activeTab?: string;
  readonly enabled?: boolean;
  readonly groupVodVersions?: boolean;
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

function fallbackLiveItem(fav: FavoriteRow, idx: number): ItemRow {
  return {
    id: idx + 1,
    key: fav.itemKey,
    kind: 'live',
    sourceId: fav.sourceId,
    providerId: fav.itemKey,
    name: fav.title,
    logo: fav.logo,
    rating: fav.rating,
    year: fav.year,
    num: null,
  };
}

function filterContinueByKind(
  rows: readonly WatchProgressRow[],
  kind: 'movie' | 'series',
): readonly WatchProgressRow[] {
  return rows.filter((row) =>
    kind === 'movie' ? row.kind === 'movie' : row.kind === 'series' || row.kind === 'episode',
  );
}

/**
 * Cancellable background prewarm pass populating Home, Live, Movies, and Series slices inside
 * {@link CatalogUiCache} without double-fetching already-warm slices for the same revision (`#445`).
 */
export async function runCatalogPrewarm({
  catalog,
  sources,
  uiCache,
  isCancelled,
  activeTab,
  groupVodVersions = false,
}: RunCatalogPrewarmOptions): Promise<void> {
  if (sources.length === 0 || isCancelled()) return;

  const targetRevision = uiCache.getRevision();
  const targetLocale = uiCache.getLocale();
  const targetProfileKey = uiCache.getProfileKey?.() ?? 'default:0';
  const targetElvKey = uiCache.getElvKey?.() ?? 'elv:0';
  const stillValid = (): boolean =>
    !isCancelled() &&
    uiCache.getRevision() === targetRevision &&
    uiCache.getLocale() === targetLocale &&
    (uiCache.getProfileKey?.() ?? 'default:0') === targetProfileKey &&
    (uiCache.getElvKey?.() ?? 'elv:0') === targetElvKey;

  const readySources = sources.filter((s) => !s.needsImport);
  if (readySources.length === 0) return;
  const activeSources = readySources;

  let continuePromise: Promise<readonly WatchProgressRow[]> | null = null;
  let favKeysPromise: Promise<readonly string[]> | null = null;
  let favRowsPromise: Promise<readonly FavoriteRow[]> | null = null;

  const getContinue = (): Promise<readonly WatchProgressRow[]> => {
    continuePromise ??=
      catalog.listContinueWatching?.(CATALOG_CONTINUE_LIMIT).catch(() => []) ?? Promise.resolve([]);
    return continuePromise;
  };
  const getFavKeys = (): Promise<readonly string[]> => {
    favKeysPromise ??= catalog.listFavoriteKeys?.().catch(() => []) ?? Promise.resolve([]);
    return favKeysPromise;
  };
  const getFavRows = (): Promise<readonly FavoriteRow[]> => {
    favRowsPromise ??=
      catalog.listFavorites?.(MAX_LIVE_FAVORITES).catch(() => []) ?? Promise.resolve([]);
    return favRowsPromise;
  };

  const categoriesCache = new Map<BrowseKind, Map<string, readonly CategoryRow[]>>();
  const loadKindCategories = async (
    kind: BrowseKind,
    list: readonly SourceRow[],
  ): Promise<Map<string, readonly CategoryRow[]>> => {
    const existing = categoriesCache.get(kind);
    if (existing !== undefined && list.every((s) => existing.has(s.id))) return existing;
    const catOpts = kind === 'movie' && groupVodVersions ? { groupVersions: true } : undefined;
    const entries = await Promise.all(
      list.map(
        async (source) =>
          [
            source.id,
            await catalog.categories(source.id, kind, catOpts).catch(() => [] as CategoryRow[]),
          ] as const,
      ),
    );
    const bySource = new Map<string, readonly CategoryRow[]>(entries);
    categoriesCache.set(kind, bySource);
    return bySource;
  };

  const warmHome = async (): Promise<void> => {
    if (!stillValid() || uiCache.getHome() !== null) return;
    const probeSources = activeSources.slice(0, MAX_HOME_SOURCES);
    const [cwAll, recentChannels, favAll, favKeys, liveMap, movieMap, seriesMap] =
      await Promise.all([
        getContinue(),
        catalog.listRecentChannels?.(20).catch(() => [] as ItemRow[]) ??
          Promise.resolve([] as ItemRow[]),
        getFavRows(),
        getFavKeys(),
        loadKindCategories('live', probeSources),
        loadKindCategories('movie', probeSources),
        loadKindCategories('series', probeSources),
      ]);
    if (!stillValid() || uiCache.getHome() !== null) return;

    const firstLive = pickFirstCategory([...liveMap.values()]);
    const firstMovie = pickFirstCategory([...movieMap.values()]);
    const firstSeries = pickFirstCategory([...seriesMap.values()]);

    const [liveItems, movies, series] = await Promise.all([
      firstLive
        ? catalog.items(firstLive.id, 0, HOME_LIVE_LIMIT).catch(() => [] as ItemRow[])
        : Promise.resolve([] as ItemRow[]),
      firstMovie
        ? catalog.items(firstMovie.id, 0, HOME_VOD_LIMIT).catch(() => [] as ItemRow[])
        : Promise.resolve([] as ItemRow[]),
      firstSeries
        ? catalog.items(firstSeries.id, 0, HOME_VOD_LIMIT).catch(() => [] as ItemRow[])
        : Promise.resolve([] as ItemRow[]),
    ]);
    if (!stillValid() || uiCache.getHome() !== null) return;

    const cwRows = cwAll.slice(0, HOME_CONTINUE_LIMIT);
    const favRows = favAll.slice(0, HOME_FAVORITES_LIMIT);
    const keySet = new Set<string>([
      ...movies.map((m) => m.key),
      ...series.map((s) => s.key),
      ...favRows.map((f) => f.itemKey),
    ]);
    const extraProgress =
      keySet.size > 0 && catalog.listProgressByKeys
        ? await catalog.listProgressByKeys(Array.from(keySet)).catch(() => [])
        : [];
    if (!stillValid() || uiCache.getHome() !== null) return;

    const progressByKey = new Map<string, WatchProgressRow>();
    for (const row of extraProgress) progressByKey.set(row.itemKey, row);
    for (const row of cwRows) progressByKey.set(row.itemKey, row);

    const favoriteKeys = new Set<string>(favKeys);
    for (const row of favRows) favoriteKeys.add(row.itemKey);

    uiCache.setHome({
      continueWatching: cwRows,
      favorites: favRows,
      favoriteKeys,
      progressByKey,
      liveCategory: firstLive,
      liveItems,
      recentChannels,
      movies,
      series,
    });
  };

  const warmLive = async (): Promise<void> => {
    if (!stillValid()) return;
    const cachedLive = uiCache.getLive();
    if (!cachedLive?.hasLoadedCategories) {
      const liveMap = await loadKindCategories('live', activeSources);
      if (!stillValid()) return;
      const displayCats = buildSharedDisplayCategories(activeSources, liveMap);
      if (!uiCache.getLive()?.hasLoadedCategories) {
        uiCache.setLiveCategories(displayCats);
      }
      const firstCat = displayCats[0];
      if (
        firstCat &&
        firstCat.row.itemCount > 0 &&
        !uiCache.getLiveFirstChannels(firstCat.row.id)
      ) {
        const rows = await catalog
          .items(firstCat.row.id, 0, LIVE_CHANNEL_ROWS_CAP)
          .catch(() => [] as ItemRow[]);
        if (stillValid()) uiCache.setLiveFirstChannels(firstCat.row.id, rows);
      }
    }
    if (!stillValid() || uiCache.getLive()?.hasLoadedFavorites) return;
    const [rawKeys, rawRows] = await Promise.all([getFavKeys(), getFavRows()]);
    if (!stillValid() || uiCache.getLive()?.hasLoadedFavorites) return;
    const readyIds = new Set(activeSources.map((s) => s.id));
    const liveFavs = rawRows.filter((r) => r.kind === 'live' && readyIds.has(r.sourceId));
    const resolved = await Promise.all(
      liveFavs.map(async (fav, idx): Promise<ItemRow | null> => {
        if (!catalog.itemDetail) return fallbackLiveItem(fav, idx);
        const detail = await catalog.itemDetail(fav.itemKey).catch(() => null);
        return detail && detail.kind === 'live' ? detail : null;
      }),
    );
    if (!stillValid() || uiCache.getLive()?.hasLoadedFavorites) return;
    const nextChannels: ItemRow[] = [];
    const seen = new Set<string>();
    for (const ch of resolved) {
      if (ch && !seen.has(ch.key)) {
        seen.add(ch.key);
        nextChannels.push(ch);
      }
    }
    const nextKeys = new Set<string>(rawKeys);
    for (const ch of nextChannels) nextKeys.add(ch.key);
    uiCache.setLiveFavorites(nextKeys, nextChannels);
  };

  const warmCatalogKind = async (kind: 'movie' | 'series'): Promise<void> => {
    const effectiveGroupVersions = kind === 'movie' && groupVodVersions;
    const cacheOpts = effectiveGroupVersions ? { groupVersions: true } : undefined;
    if (!stillValid() || uiCache.getCatalog(kind, cacheOpts) !== null) return;
    const [catMap, cwAll] = await Promise.all([
      loadKindCategories(kind, activeSources),
      getContinue(),
    ]);
    if (!stillValid() || uiCache.getCatalog(kind, cacheOpts) !== null) return;

    const categories = buildSharedDisplayCategories(activeSources, catMap);
    const topCats = categories.slice(0, PREWARM_CATALOG_RAILS);
    const railEntries = await Promise.all(
      topCats.map(async (cat) => {
        const rows = await catalog
          .items(cat.row.id, 0, MAX_CATALOG_RAIL_ITEMS, cacheOpts)
          .catch(() => [] as ItemRow[]);
        return [cat.row.id, rows] as const;
      }),
    );
    if (!stillValid() || uiCache.getCatalog(kind, cacheOpts) !== null) return;

    const railItemsByCategoryId = new Map<string, readonly ItemRow[]>(railEntries);
    const keys: string[] = [];
    for (const [, rows] of railEntries) {
      for (const item of rows) keys.push(item.key);
    }
    const progressByKey =
      keys.length > 0
        ? await batchLoadProgressByKeys(catalog, keys).catch(
            () => new Map<string, WatchProgressRow>(),
          )
        : new Map<string, WatchProgressRow>();
    if (!stillValid() || uiCache.getCatalog(kind, cacheOpts) !== null) return;

    uiCache.setCatalog(kind, {
      categories,
      continueItems: filterContinueByKind(cwAll, kind),
      railItemsByCategoryId,
      progressByKey,
      ...(effectiveGroupVersions ? { groupVersions: true } : {}),
    });
  };

  if (activeTab !== 'home') await warmHome();
  await warmLive();
  await warmCatalogKind('movie');
  await warmCatalogKind('series');
  if (activeTab === 'home') await warmHome();
}

/**
 * Triggers a non-blocking cancellable {@link runCatalogPrewarm} whenever sources are available
 * and `catalogRevision` advances (`#445`).
 */
export function useCatalogPrewarm({
  catalog,
  sources,
  catalogRevision,
  locale,
  profileKey,
  elvKey,
  uiCache,
  activeTab,
  enabled = true,
  groupVodVersions = false,
}: UseCatalogPrewarmOptions): void {
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  // biome-ignore lint/correctness/useExhaustiveDependencies: catalogRevision, locale, profileKey, and elvKey trigger fresh prewarm after invalidation
  useEffect(() => {
    if (!enabled || sources.length === 0) return undefined;
    let cancelled = false;
    void Promise.resolve()
      .then(() =>
        runCatalogPrewarm({
          catalog,
          sources,
          uiCache,
          isCancelled: () => cancelled,
          groupVodVersions,
          ...(activeTabRef.current !== undefined ? { activeTab: activeTabRef.current } : {}),
        }),
      )
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    catalog,
    catalogRevision,
    elvKey,
    enabled,
    groupVodVersions,
    locale,
    profileKey,
    sources,
    uiCache,
  ]);
}
