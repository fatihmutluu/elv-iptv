import type { CatalogService, CategoryRow, ItemRow, SourceRow, WatchProgressRow } from '@elv/data';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  batchLoadProgressByKeys,
  buildSharedDisplayCategories,
  type DisplayCategory,
} from '../shared';
import {
  CATEGORY_LOAD_BATCH,
  type CatalogTabMemory,
  EMPTY_CATALOG_MEMORY,
  MAX_CONCURRENT_RAIL_QUERIES,
  RAIL_ITEM_LIMIT,
} from './catalog-model';

/**
 * Controlled-or-uncontrolled tab memory state helper preserving category selection, watch filter,
 * and progressive batch count across tab switches.
 */
export function useCatalogTabMemory(
  memory: CatalogTabMemory | undefined,
  onMemoryChange: ((next: CatalogTabMemory) => void) | undefined,
): {
  readonly memory: CatalogTabMemory;
  readonly updateMemory: (patch: Partial<CatalogTabMemory>) => void;
} {
  const [localMemory, setLocalMemory] = useState<CatalogTabMemory>(
    () => memory ?? EMPTY_CATALOG_MEMORY,
  );
  const activeMemory = onMemoryChange && memory !== undefined ? memory : localMemory;
  const activeMemoryRef = useRef(activeMemory);
  activeMemoryRef.current = activeMemory;

  const updateMemory = useCallback(
    (patch: Partial<CatalogTabMemory>) => {
      const next: CatalogTabMemory = { ...activeMemoryRef.current, ...patch };
      activeMemoryRef.current = next;
      setLocalMemory(next);
      onMemoryChange?.(next);
    },
    [onMemoryChange],
  );

  return useMemo(() => ({ memory: activeMemory, updateMemory }), [activeMemory, updateMemory]);
}

/** Options for {@link useCatalogDiscovery}. */
export interface UseCatalogDiscoveryOptions {
  readonly kind: 'movie' | 'series';
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly refreshToken: number;
  readonly userStateVersion?: number;
  readonly selectedCategoryId: string | null;
  readonly visibleCategoryCount: number;
  readonly onVisibleCategoryCountChange: (nextCount: number) => void;
  readonly onClearStaleCategory?: () => void;
}

/** Memoized discovery state returned by {@link useCatalogDiscovery}. */
export interface CatalogDiscoveryState {
  readonly categories: readonly DisplayCategory[];
  readonly visibleCategories: readonly DisplayCategory[];
  readonly railItemsByCategoryId: ReadonlyMap<string, readonly ItemRow[]>;
  readonly loadingRailIds: ReadonlySet<string>;
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly loadingCategories: boolean;
  readonly hasLoadedCategories: boolean;
  readonly hasMoreCategories: boolean;
  readonly loadMoreCategories: () => void;
}

const EMPTY_ITEMS_MAP: ReadonlyMap<string, readonly ItemRow[]> = new Map();
const EMPTY_PROGRESS_MAP: ReadonlyMap<string, WatchProgressRow> = new Map();
const EMPTY_LOADING_SET: ReadonlySet<string> = new Set();

/**
 * Loads Movies or Series categories across configured sources and progressively hydrates preview
 * rails (`LIMIT 18` per category, `<= 4` concurrent queries) plus batched watch progress without
 * N+1 queries. Guards every async write with monotonic generation refs.
 */
export function useCatalogDiscovery({
  kind,
  catalog,
  sources,
  refreshToken,
  userStateVersion = 0,
  selectedCategoryId,
  visibleCategoryCount,
  onVisibleCategoryCountChange,
  onClearStaleCategory,
}: UseCatalogDiscoveryOptions): CatalogDiscoveryState {
  const [categories, setCategories] = useState<readonly DisplayCategory[]>([]);
  const [loadingCategories, setLoadingCategories] = useState(() => sources.length > 0);
  const [hasLoadedCategories, setHasLoadedCategories] = useState(false);
  const [railItemsByCategoryId, setRailItemsByCategoryId] =
    useState<ReadonlyMap<string, readonly ItemRow[]>>(EMPTY_ITEMS_MAP);
  const [loadingRailIds, setLoadingRailIds] = useState<ReadonlySet<string>>(EMPTY_LOADING_SET);
  const [progressByKey, setProgressByKey] =
    useState<ReadonlyMap<string, WatchProgressRow>>(EMPTY_PROGRESS_MAP);

  const catGenRef = useRef(0);
  const railGenRef = useRef(0);
  const railItemsRef = useRef<Map<string, readonly ItemRow[]>>(new Map());
  const loadedRailIdsRef = useRef<Set<string>>(new Set());

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken intentionally triggers fresh category reads
  useEffect(() => {
    catGenRef.current += 1;
    railGenRef.current += 1;
    const gen = catGenRef.current;

    railItemsRef.current = new Map();
    loadedRailIdsRef.current = new Set();
    setRailItemsByCategoryId(EMPTY_ITEMS_MAP);
    setLoadingRailIds(EMPTY_LOADING_SET);
    setProgressByKey(EMPTY_PROGRESS_MAP);

    if (sources.length === 0) {
      setCategories([]);
      setLoadingCategories(false);
      setHasLoadedCategories(true);
      return () => {
        catGenRef.current += 1;
        railGenRef.current += 1;
      };
    }

    setLoadingCategories(true);
    setHasLoadedCategories(false);

    const readySources = sources.filter((s) => !s.needsImport);
    const activeSources = readySources.length > 0 ? readySources : sources;

    const loadCategories = async () => {
      try {
        const perSource = await Promise.all(
          activeSources.map(async (source) => {
            const rows = await catalog.categories(source.id, kind).catch(() => [] as CategoryRow[]);
            return [source.id, rows] as const;
          }),
        );
        if (catGenRef.current !== gen) return;
        const bySource = new Map<string, readonly CategoryRow[]>(perSource);
        setCategories(buildSharedDisplayCategories(activeSources, bySource));
      } finally {
        if (catGenRef.current === gen) {
          setLoadingCategories(false);
          setHasLoadedCategories(true);
        }
      }
    };

    void loadCategories();

    return () => {
      catGenRef.current += 1;
      railGenRef.current += 1;
    };
  }, [catalog, kind, refreshToken, sources]);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: userStateVersion and refreshToken intentionally trigger progress hydration
  useEffect(() => {
    if (selectedCategoryExists || visibleCategories.length === 0) return undefined;

    railGenRef.current += 1;
    const gen = railGenRef.current;
    const missing = visibleCategories.filter((cat) => !loadedRailIdsRef.current.has(cat.row.id));

    const run = async () => {
      if (missing.length > 0) {
        setLoadingRailIds(new Set(missing.map((cat) => cat.row.id)));
        const fetched = new Map<string, readonly ItemRow[]>();
        let cursor = 0;
        const workerCount = Math.min(MAX_CONCURRENT_RAIL_QUERIES, missing.length);

        const workers = Array.from({ length: workerCount }, async () => {
          while (cursor < missing.length) {
            const idx = cursor++;
            const target = missing[idx];
            if (!target || railGenRef.current !== gen) return;
            const rows = await catalog
              .items(target.row.id, 0, RAIL_ITEM_LIMIT)
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
      }

      const loadedKeys: string[] = [];
      for (const cat of visibleCategories) {
        const rows = railItemsRef.current.get(cat.row.id);
        if (!rows) continue;
        for (const item of rows) loadedKeys.push(item.key);
      }

      if (loadedKeys.length === 0) {
        if (railGenRef.current === gen) setProgressByKey(EMPTY_PROGRESS_MAP);
        return;
      }

      const nextProgress = await batchLoadProgressByKeys(catalog, loadedKeys).catch(
        () => new Map<string, WatchProgressRow>(),
      );
      if (railGenRef.current !== gen) return;
      setProgressByKey(nextProgress);
    };

    void run();

    return () => {
      railGenRef.current += 1;
    };
  }, [catalog, refreshToken, selectedCategoryExists, userStateVersion, visibleCategories]);

  const hasMoreCategories = categories.length > visibleCategories.length;

  const loadMoreCategories = useCallback(() => {
    const next = Math.min(categories.length, visibleCategoryCount + CATEGORY_LOAD_BATCH);
    if (next > visibleCategoryCount) {
      onVisibleCategoryCountChange(next);
    }
  }, [categories.length, onVisibleCategoryCountChange, visibleCategoryCount]);

  return useMemo<CatalogDiscoveryState>(
    () => ({
      categories,
      visibleCategories,
      railItemsByCategoryId,
      loadingRailIds,
      progressByKey,
      loadingCategories,
      hasLoadedCategories,
      hasMoreCategories,
      loadMoreCategories,
    }),
    [
      categories,
      hasLoadedCategories,
      hasMoreCategories,
      loadMoreCategories,
      loadingCategories,
      loadingRailIds,
      progressByKey,
      railItemsByCategoryId,
      visibleCategories,
    ],
  );
}
