import type {
  CatalogService,
  CategoryRow,
  ItemRow,
  ItemSortOrder,
  SeriesUnplayedSummary,
  SourceRow,
  WatchProgressRow,
} from '@elv/data';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  batchLoadProgressByKeys,
  buildSharedDisplayCategories,
  type DisplayCategory,
  useCatalogUiCache,
  useSeriesUnplayedCounts,
} from '../shared';
import {
  CATALOG_CONTINUE_LIMIT,
  CATEGORY_LOAD_BATCH,
  filterContinueWatchingForCatalog,
  MAX_CONCURRENT_RAIL_QUERIES,
  RAIL_ITEM_LIMIT,
} from './catalog-model';

export { useCatalogTabMemory } from './useCatalogTabMemory';

/** Options for {@link useCatalogDiscovery}. */
export interface UseCatalogDiscoveryOptions {
  readonly kind: 'movie' | 'series';
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly refreshToken: number;
  readonly userStateVersion?: number;
  readonly selectedCategoryId: string | null;
  readonly visibleCategoryCount: number;
  readonly sortBy?: ItemSortOrder;
  readonly groupVersions?: boolean;
  readonly onVisibleCategoryCountChange: (nextCount: number) => void;
  readonly onClearStaleCategory?: () => void;
}

/** Memoized discovery state returned by {@link useCatalogDiscovery}. */
export interface CatalogDiscoveryState {
  readonly categories: readonly DisplayCategory[];
  readonly visibleCategories: readonly DisplayCategory[];
  readonly continueItems: readonly WatchProgressRow[];
  readonly railItemsByCategoryId: ReadonlyMap<string, readonly ItemRow[]>;
  readonly loadingRailIds: ReadonlySet<string>;
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly unplayedBySeriesKey: ReadonlyMap<string, SeriesUnplayedSummary>;
  readonly loadingCategories: boolean;
  readonly hasLoadedCategories: boolean;
  readonly hasMoreCategories: boolean;
  readonly loadMoreCategories: () => void;
  readonly removeContinueItem: (itemKey: string) => WatchProgressRow | undefined;
  readonly restoreContinueItem: (row: WatchProgressRow) => void;
  readonly refreshContinueWatching: () => void;
}

const EMPTY_ITEMS_MAP: ReadonlyMap<string, readonly ItemRow[]> = new Map();
const EMPTY_PROGRESS_MAP: ReadonlyMap<string, WatchProgressRow> = new Map();
const EMPTY_LOADING_SET: ReadonlySet<string> = new Set();

/**
 * Loads Movies or Series categories across configured sources and progressively hydrates preview
 * rails (`LIMIT 18` per category, `<= 4` concurrent queries) plus batched watch progress without
 * N+1 queries. Hydrates synchronously from `CatalogUiCache` and preserves rendered data across
 * background refreshes (`#445`).
 */
export function useCatalogDiscovery({
  kind,
  catalog,
  sources,
  refreshToken,
  userStateVersion = 0,
  selectedCategoryId,
  visibleCategoryCount,
  sortBy = 'default',
  groupVersions = false,
  onVisibleCategoryCountChange,
  onClearStaleCategory,
}: UseCatalogDiscoveryOptions): CatalogDiscoveryState {
  const effectiveGroupVersions = kind === 'movie' && groupVersions;
  const uiCache = useCatalogUiCache();
  const initialCached =
    sources.length > 0
      ? (uiCache?.getCatalog(kind, { groupVersions: effectiveGroupVersions }) ?? null)
      : null;

  const [categories, setCategories] = useState<readonly DisplayCategory[]>(
    () => initialCached?.categories ?? [],
  );
  const [continueItems, setContinueItems] = useState<readonly WatchProgressRow[]>(
    () => initialCached?.continueItems ?? [],
  );
  const [loadingCategories, setLoadingCategories] = useState(
    () => sources.length > 0 && initialCached === null,
  );
  const [hasLoadedCategories, setHasLoadedCategories] = useState(() => initialCached !== null);
  const [railItemsByCategoryId, setRailItemsByCategoryId] = useState<
    ReadonlyMap<string, readonly ItemRow[]>
  >(() => initialCached?.railItemsByCategoryId ?? EMPTY_ITEMS_MAP);
  const [loadingRailIds, setLoadingRailIds] = useState<ReadonlySet<string>>(EMPTY_LOADING_SET);
  const [progressByKey, setProgressByKey] = useState<ReadonlyMap<string, WatchProgressRow>>(
    () => initialCached?.progressByKey ?? EMPTY_PROGRESS_MAP,
  );
  const [railRefreshTick, setRailRefreshTick] = useState(0);
  const [continueRefreshTick, setContinueRefreshTick] = useState(0);

  const catGenRef = useRef(0);
  const continueGenRef = useRef(0);
  const railGenRef = useRef(0);
  const hasLoadedRef = useRef(initialCached !== null);
  const lastRefreshTokenRef = useRef(refreshToken);
  const lastSortByRef = useRef<ItemSortOrder>(sortBy);
  const lastGroupVersionsRef = useRef<boolean>(effectiveGroupVersions);
  const uiCacheRef = useRef(uiCache);
  uiCacheRef.current = uiCache;

  const categoriesRef = useRef(categories);
  categoriesRef.current = categories;
  const continueItemsRef = useRef(continueItems);
  continueItemsRef.current = continueItems;
  const progressByKeyRef = useRef(progressByKey);
  progressByKeyRef.current = progressByKey;
  const railItemsRef = useRef<Map<string, readonly ItemRow[]>>(
    new Map(initialCached?.railItemsByCategoryId ?? []),
  );
  const loadedRailIdsRef = useRef<Set<string>>(
    new Set(initialCached?.railItemsByCategoryId.keys() ?? []),
  );

  const syncCache = useCallback(
    (overrides?: {
      categories?: readonly DisplayCategory[];
      continueItems?: readonly WatchProgressRow[];
      railItemsByCategoryId?: ReadonlyMap<string, readonly ItemRow[]>;
      progressByKey?: ReadonlyMap<string, WatchProgressRow>;
    }) => {
      const nextCats = overrides?.categories ?? categoriesRef.current;
      const nextCw = overrides?.continueItems ?? continueItemsRef.current;
      const nextRails = overrides?.railItemsByCategoryId ?? railItemsRef.current;
      const nextProg = overrides?.progressByKey ?? progressByKeyRef.current;
      uiCacheRef.current?.setCatalog(kind, {
        categories: nextCats,
        continueItems: nextCw,
        railItemsByCategoryId: nextRails,
        progressByKey: nextProg,
        ...(effectiveGroupVersions ? { groupVersions: true } : {}),
      });
    },
    [effectiveGroupVersions, kind],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken, userStateVersion, and continueRefreshTick trigger fresh continue-watching reads
  useEffect(() => {
    continueGenRef.current += 1;
    const gen = continueGenRef.current;
    if (sources.length === 0 || !catalog.listContinueWatching) {
      continueItemsRef.current = [];
      setContinueItems([]);
      return undefined;
    }
    void catalog
      .listContinueWatching(CATALOG_CONTINUE_LIMIT)
      .then((rows) => {
        if (continueGenRef.current !== gen) return;
        const filtered = filterContinueWatchingForCatalog(rows, kind);
        continueItemsRef.current = filtered;
        setContinueItems(filtered);
        if (hasLoadedRef.current) syncCache({ continueItems: filtered });
      })
      .catch(() => {
        if (continueGenRef.current === gen && !hasLoadedRef.current) {
          continueItemsRef.current = [];
          setContinueItems([]);
        }
      });
    return () => {
      continueGenRef.current += 1;
    };
  }, [
    catalog,
    continueRefreshTick,
    kind,
    refreshToken,
    sources.length,
    syncCache,
    userStateVersion,
  ]);

  useEffect(() => {
    catGenRef.current += 1;
    const gen = catGenRef.current;

    if (sources.length === 0) {
      railGenRef.current += 1;
      railItemsRef.current = new Map();
      loadedRailIdsRef.current = new Set();
      categoriesRef.current = [];
      progressByKeyRef.current = EMPTY_PROGRESS_MAP;
      hasLoadedRef.current = true;
      setRailItemsByCategoryId(EMPTY_ITEMS_MAP);
      setLoadingRailIds(EMPTY_LOADING_SET);
      setProgressByKey(EMPTY_PROGRESS_MAP);
      setCategories([]);
      setLoadingCategories(false);
      setHasLoadedCategories(true);
      return () => {
        catGenRef.current += 1;
        railGenRef.current += 1;
      };
    }

    const tokenBumped =
      lastRefreshTokenRef.current !== refreshToken ||
      lastGroupVersionsRef.current !== effectiveGroupVersions;
    lastRefreshTokenRef.current = refreshToken;
    lastGroupVersionsRef.current = effectiveGroupVersions;

    // Only show skeleton on cold start; keep previous categories & rails visible during refresh.
    if (!hasLoadedRef.current) {
      setLoadingCategories(true);
    }

    const readySources = sources.filter((s) => !s.needsImport);
    const activeSources = readySources.length > 0 ? readySources : sources;

    const loadCategories = async () => {
      try {
        const catOpts = effectiveGroupVersions ? { groupVersions: true } : undefined;
        const perSource = await Promise.all(
          activeSources.map(async (source) => {
            const rows = await catalog
              .categories(source.id, kind, catOpts)
              .catch(() => [] as CategoryRow[]);
            return [source.id, rows] as const;
          }),
        );
        if (catGenRef.current !== gen) return;
        const bySource = new Map<string, readonly CategoryRow[]>(perSource);
        const nextCategories = buildSharedDisplayCategories(activeSources, bySource);
        const validIds = new Set(nextCategories.map((c) => c.row.id));

        const prunedRails = new Map<string, readonly ItemRow[]>();
        for (const [catId, rows] of railItemsRef.current) {
          if (validIds.has(catId)) prunedRails.set(catId, rows);
        }
        railItemsRef.current = prunedRails;
        if (tokenBumped) {
          loadedRailIdsRef.current = new Set();
        } else {
          for (const id of [...loadedRailIdsRef.current]) {
            if (!validIds.has(id)) loadedRailIdsRef.current.delete(id);
          }
        }

        categoriesRef.current = nextCategories;
        hasLoadedRef.current = true;
        setCategories(nextCategories);
        setRailItemsByCategoryId(prunedRails);
        syncCache({ categories: nextCategories, railItemsByCategoryId: prunedRails });
        if (tokenBumped) setRailRefreshTick((t) => t + 1);
      } finally {
        if (catGenRef.current === gen) {
          hasLoadedRef.current = true;
          setLoadingCategories(false);
          setHasLoadedCategories(true);
        }
      }
    };

    void loadCategories();

    return () => {
      catGenRef.current += 1;
    };
  }, [catalog, effectiveGroupVersions, kind, refreshToken, sources, syncCache]);

  const visibleCategories = useMemo(
    () => categories.slice(0, Math.max(0, visibleCategoryCount)),
    [categories, visibleCategoryCount],
  );
  const selectedCategoryExists = useMemo(
    () =>
      selectedCategoryId !== null && categories.some((cat) => cat.row.id === selectedCategoryId),
    [categories, selectedCategoryId],
  );

  useEffect(() => {
    if (hasLoadedCategories && selectedCategoryId !== null && !selectedCategoryExists) {
      onClearStaleCategory?.();
    }
  }, [hasLoadedCategories, onClearStaleCategory, selectedCategoryExists, selectedCategoryId]);

  useEffect(() => {
    if (lastSortByRef.current === sortBy) return;
    lastSortByRef.current = sortBy;
    loadedRailIdsRef.current = new Set();
    setRailRefreshTick((t) => t + 1);
  }, [sortBy]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: railRefreshTick, userStateVersion, and refreshToken hydrate rails and progress
  useEffect(() => {
    if (selectedCategoryExists || visibleCategories.length === 0) return undefined;

    railGenRef.current += 1;
    const gen = railGenRef.current;
    const missing = visibleCategories.filter((cat) => !loadedRailIdsRef.current.has(cat.row.id));

    const run = async () => {
      if (missing.length > 0) {
        const coldMissing = missing.filter((cat) => !railItemsRef.current.has(cat.row.id));
        if (coldMissing.length > 0) {
          setLoadingRailIds(new Set(coldMissing.map((cat) => cat.row.id)));
        }
        const fetched = new Map<string, readonly ItemRow[]>();
        let cursor = 0;
        const workerCount = Math.min(MAX_CONCURRENT_RAIL_QUERIES, missing.length);

        const workers = Array.from({ length: workerCount }, async () => {
          while (cursor < missing.length) {
            const idx = cursor++;
            const target = missing[idx];
            if (!target || railGenRef.current !== gen) return;
            const itemOpts =
              sortBy === 'alpha' || effectiveGroupVersions
                ? {
                    ...(sortBy === 'alpha' ? { sortBy: 'alpha' as const } : {}),
                    ...(effectiveGroupVersions ? { groupVersions: true } : {}),
                  }
                : undefined;
            const rows = await catalog
              .items(target.row.id, 0, RAIL_ITEM_LIMIT, itemOpts)
              .catch(() => [] as ItemRow[]);
            if (railGenRef.current !== gen) return;
            fetched.set(target.row.id, rows);
          }
        });

        await Promise.all(workers);
        if (railGenRef.current !== gen) return;

        const nextItems = new Map(railItemsRef.current);
        for (const [catId, rows] of fetched) {
          nextItems.set(catId, rows);
          loadedRailIdsRef.current.add(catId);
        }
        railItemsRef.current = nextItems;
        setRailItemsByCategoryId(nextItems);
        setLoadingRailIds(EMPTY_LOADING_SET);
        if (sortBy === 'default') syncCache({ railItemsByCategoryId: nextItems });
      }

      const loadedKeys: string[] = [];
      for (const cat of visibleCategories) {
        const rows = railItemsRef.current.get(cat.row.id);
        if (!rows) continue;
        for (const item of rows) loadedKeys.push(item.key);
      }

      if (loadedKeys.length === 0) {
        if (railGenRef.current === gen) {
          progressByKeyRef.current = EMPTY_PROGRESS_MAP;
          setProgressByKey(EMPTY_PROGRESS_MAP);
        }
        return;
      }

      const nextProgress = await batchLoadProgressByKeys(catalog, loadedKeys).catch(
        () => new Map<string, WatchProgressRow>(),
      );
      if (railGenRef.current !== gen) return;
      progressByKeyRef.current = nextProgress;
      setProgressByKey(nextProgress);
      syncCache({ progressByKey: nextProgress });
    };

    void run();

    return () => {
      railGenRef.current += 1;
    };
  }, [
    catalog,
    effectiveGroupVersions,
    railRefreshTick,
    refreshToken,
    selectedCategoryExists,
    sortBy,
    syncCache,
    userStateVersion,
    visibleCategories,
  ]);

  const loadedSeriesKeys = useMemo(() => {
    if (kind !== 'series') return [] as string[];
    const keys: string[] = [];
    for (const cat of visibleCategories) {
      const rows = railItemsByCategoryId.get(cat.row.id);
      if (!rows) continue;
      for (const item of rows) {
        if (item.kind === 'series') keys.push(item.key);
      }
    }
    return keys;
  }, [kind, railItemsByCategoryId, visibleCategories]);

  const unplayedBySeriesKey = useSeriesUnplayedCounts(
    catalog,
    loadedSeriesKeys,
    refreshToken + userStateVersion + continueRefreshTick,
  );

  const hasMoreCategories = categories.length > visibleCategories.length;

  const loadMoreCategories = useCallback(() => {
    const next = Math.min(categories.length, visibleCategoryCount + CATEGORY_LOAD_BATCH);
    if (next > visibleCategoryCount) {
      onVisibleCategoryCountChange(next);
    }
  }, [categories.length, onVisibleCategoryCountChange, visibleCategoryCount]);

  const removeContinueItem = useCallback(
    (itemKey: string): WatchProgressRow | undefined => {
      const removed = continueItemsRef.current.find((row) => row.itemKey === itemKey);
      if (!removed) return undefined;
      const next = continueItemsRef.current.filter((row) => row.itemKey !== itemKey);
      continueItemsRef.current = next;
      setContinueItems(next);
      if (hasLoadedRef.current) syncCache({ continueItems: next });
      return removed;
    },
    [syncCache],
  );

  const restoreContinueItem = useCallback(
    (row: WatchProgressRow) => {
      if (continueItemsRef.current.some((entry) => entry.itemKey === row.itemKey)) return;
      const next = [row, ...continueItemsRef.current].sort((a, b) => b.updatedAt - a.updatedAt);
      continueItemsRef.current = next;
      setContinueItems(next);
      if (hasLoadedRef.current) syncCache({ continueItems: next });
    },
    [syncCache],
  );

  const refreshContinueWatching = useCallback(() => {
    setContinueRefreshTick((t) => t + 1);
  }, []);

  return useMemo<CatalogDiscoveryState>(
    () => ({
      categories,
      visibleCategories,
      continueItems,
      railItemsByCategoryId,
      loadingRailIds,
      progressByKey,
      unplayedBySeriesKey,
      loadingCategories,
      hasLoadedCategories,
      hasMoreCategories,
      loadMoreCategories,
      removeContinueItem,
      restoreContinueItem,
      refreshContinueWatching,
    }),
    [
      categories,
      continueItems,
      hasLoadedCategories,
      hasMoreCategories,
      loadMoreCategories,
      loadingCategories,
      loadingRailIds,
      progressByKey,
      railItemsByCategoryId,
      refreshContinueWatching,
      removeContinueItem,
      restoreContinueItem,
      unplayedBySeriesKey,
      visibleCategories,
    ],
  );
}
