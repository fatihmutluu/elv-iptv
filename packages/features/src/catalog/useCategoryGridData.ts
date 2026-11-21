import type { CatalogService, ItemRow, WatchProgressRow } from '@elv/data';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  batchLoadProgressByKeys,
  createPagedListSource,
  type DisplayCategory,
  type PagedListSource,
  type WatchStatusFilter,
} from '../shared';
import {
  FILTERED_GRID_LIMIT,
  filterCatalogItems,
  GRID_MAX_PAGES,
  GRID_PAGE_SIZE,
} from './catalog-model';

/** Options for {@link useCategoryGridData}. */
export interface UseCategoryGridDataOptions {
  readonly category: DisplayCategory;
  readonly catalog: CatalogService;
  readonly watchFilter: WatchStatusFilter;
  readonly refreshToken: number;
  readonly userStateVersion: number;
  readonly cols: number;
  readonly visibleGridRows: number;
}

/** O(1)-paged / bounded-filtered grid data state returned by {@link useCategoryGridData}. */
export interface CategoryGridDataState {
  readonly isAllFilter: boolean;
  readonly pagedSource: PagedListSource<ItemRow> | null;
  readonly pageVersion: number;
  readonly progressResetToken: number;
  readonly filteredItems: readonly ItemRow[];
  readonly loadingFiltered: boolean;
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly itemCount: number;
  readonly isFilterEmpty: boolean;
  readonly getItemAt: (index: number) => ItemRow | undefined;
  readonly hydrateProgressRange: (startRow: number, endRow: number) => void;
}

/**
 * Manages O(1)-memory `PagedListSource` pagination (`watchFilter === 'all'`), bounded filtered
 * queries (`watchFilter !== 'all'`), and deduped visible-window watch-progress hydration for
 * {@link CategoryGridView}.
 */
export function useCategoryGridData({
  category,
  catalog,
  watchFilter,
  refreshToken,
  userStateVersion,
  cols,
  visibleGridRows,
}: UseCategoryGridDataOptions): CategoryGridDataState {
  const isAllFilter = watchFilter === 'all';
  const [pagedSource, setPagedSource] = useState<PagedListSource<ItemRow> | null>(null);
  const [pageVersion, setPageVersion] = useState(0);
  const [progressResetToken, setProgressResetToken] = useState(0);
  const [filteredItems, setFilteredItems] = useState<readonly ItemRow[]>([]);
  const [loadingFiltered, setLoadingFiltered] = useState(false);
  const [progressByKey, setProgressByKey] = useState<ReadonlyMap<string, WatchProgressRow>>(
    () => new Map(),
  );

  const pagedSourceRef = useRef<PagedListSource<ItemRow> | null>(null);
  const fetchedKeysRef = useRef<Set<string>>(new Set());
  const progressGenRef = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken intentionally recreates paged source
  useEffect(() => {
    if (!isAllFilter) {
      pagedSourceRef.current = null;
      setPagedSource(null);
      return undefined;
    }
    let alive = true;
    const source = createPagedListSource<ItemRow>({
      count: category.row.itemCount,
      pageSize: GRID_PAGE_SIZE,
      maxPages: GRID_MAX_PAGES,
      loadPage: (offset, limit) => catalog.items(category.row.id, offset, limit),
    });
    const unsubscribe = source.onChange(() => {
      if (alive) setPageVersion((v) => v + 1);
    });
    pagedSourceRef.current = source;
    setPagedSource(source);
    source.prefetch(0, (visibleGridRows + 4) * cols);

    return () => {
      alive = false;
      unsubscribe();
      source.dispose();
      if (pagedSourceRef.current === source) pagedSourceRef.current = null;
    };
  }, [
    catalog,
    category.row.id,
    category.row.itemCount,
    cols,
    isAllFilter,
    refreshToken,
    visibleGridRows,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset triggers
  useEffect(() => {
    progressGenRef.current += 1;
    fetchedKeysRef.current = new Set();
    setProgressByKey(new Map());
    setProgressResetToken((t) => t + 1);
  }, [category.row.id, refreshToken, userStateVersion, watchFilter]);

  const hydrateProgressRange = useCallback(
    (startRow: number, endRow: number) => {
      const source = pagedSourceRef.current;
      if (!source) return;
      const total = source.count();
      const from = Math.max(0, startRow * cols);
      const to = Math.min(total, (endRow + 1) * cols);
      const missing: string[] = [];
      for (let i = from; i < to; i++) {
        const item = source.get(i);
        if (item && !fetchedKeysRef.current.has(item.key)) {
          fetchedKeysRef.current.add(item.key);
          missing.push(item.key);
        }
      }
      if (missing.length === 0) return;
      const gen = progressGenRef.current;
      void batchLoadProgressByKeys(catalog, missing)
        .then((loaded) => {
          if (progressGenRef.current !== gen || loaded.size === 0) return;
          setProgressByKey((prev) => {
            const next = new Map(prev);
            for (const [k, v] of loaded) next.set(k, v);
            return next;
          });
        })
        .catch(() => undefined);
    },
    [catalog, cols],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken and userStateVersion trigger fresh filtered reads
  useEffect(() => {
    if (isAllFilter) {
      setFilteredItems([]);
      setLoadingFiltered(false);
      return undefined;
    }
    let alive = true;
    setLoadingFiltered(true);
    const loadFiltered = async () => {
      try {
        const rows = await catalog
          .items(category.row.id, 0, FILTERED_GRID_LIMIT)
          .catch(() => [] as ItemRow[]);
        if (!alive) return;
        const progress = await batchLoadProgressByKeys(
          catalog,
          rows.map((r) => r.key),
        ).catch(() => new Map<string, WatchProgressRow>());
        if (!alive) return;
        setProgressByKey(progress);
        setFilteredItems(filterCatalogItems(rows, progress, watchFilter));
      } finally {
        if (alive) setLoadingFiltered(false);
      }
    };
    void loadFiltered();
    return () => {
      alive = false;
    };
  }, [catalog, category.row.id, isAllFilter, refreshToken, userStateVersion, watchFilter]);

  const itemCount = isAllFilter ? category.row.itemCount : filteredItems.length;
  const isFilterEmpty = !isAllFilter && !loadingFiltered && filteredItems.length === 0;

  const getItemAt = useCallback(
    (index: number): ItemRow | undefined =>
      isAllFilter ? pagedSource?.get(index) : filteredItems[index],
    [filteredItems, isAllFilter, pagedSource],
  );

  return useMemo<CategoryGridDataState>(
    () => ({
      isAllFilter,
      pagedSource,
      pageVersion,
      progressResetToken,
      filteredItems,
      loadingFiltered,
      progressByKey,
      itemCount,
      isFilterEmpty,
      getItemAt,
      hydrateProgressRange,
    }),
    [
      filteredItems,
      getItemAt,
      hydrateProgressRange,
      isAllFilter,
      isFilterEmpty,
      itemCount,
      loadingFiltered,
      pagedSource,
      pageVersion,
      progressByKey,
      progressResetToken,
    ],
  );
}
