import type {
  CatalogService,
  ItemRow,
  ItemSortOrder,
  SeriesUnplayedSummary,
  WatchProgressRow,
} from '@elv/data';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  batchLoadProgressByKeys,
  createPagedListSource,
  type DisplayCategory,
  type PagedListSource,
  useCatalogUiCache,
  useSeriesUnplayedCounts,
} from '../shared';
import { GRID_MAX_PAGES, GRID_PAGE_SIZE } from './catalog-model';

/** Options for {@link useCategoryGridData}. */
export interface UseCategoryGridDataOptions {
  readonly kind?: 'movie' | 'series';
  readonly category: DisplayCategory;
  readonly catalog: CatalogService;
  readonly refreshToken: number;
  readonly userStateVersion: number;
  readonly cols: number;
  readonly visibleGridRows: number;
  readonly sortBy?: ItemSortOrder;
}

/** O(1)-paged grid data state returned by {@link useCategoryGridData}. */
export interface CategoryGridDataState {
  readonly pagedSource: PagedListSource<ItemRow> | null;
  readonly pageVersion: number;
  readonly progressResetToken: number;
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly unplayedBySeriesKey: ReadonlyMap<string, SeriesUnplayedSummary>;
  readonly itemCount: number;
  readonly getItemAt: (index: number) => ItemRow | undefined;
  readonly hydrateProgressRange: (startRow: number, endRow: number) => void;
}

/**
 * Manages O(1)-memory `PagedListSource` pagination and deduped visible-window watch-progress
 * hydration for {@link CategoryGridView}. Hydrates page 0 synchronously from `CatalogUiCache` and
 * keeps previously visible rows rendered while switching to an uncached category (`#445`).
 */
export function useCategoryGridData({
  kind = 'movie',
  category,
  catalog,
  refreshToken,
  userStateVersion,
  cols,
  visibleGridRows,
  sortBy = 'default',
}: UseCategoryGridDataOptions): CategoryGridDataState {
  const uiCache = useCatalogUiCache();
  const uiCacheRef = useRef(uiCache);
  uiCacheRef.current = uiCache;

  const buildSource = useCallback(
    (
      catId: string,
      count: number,
      initialPage0: readonly ItemRow[] | undefined,
      activeSortBy: ItemSortOrder,
    ): PagedListSource<ItemRow> =>
      createPagedListSource<ItemRow>({
        count,
        pageSize: GRID_PAGE_SIZE,
        maxPages: GRID_MAX_PAGES,
        ...(initialPage0 !== undefined ? { initialPage0 } : {}),
        loadPage: async (offset, limit) => {
          const rows = await catalog.items(
            catId,
            offset,
            limit,
            activeSortBy === 'alpha' ? { sortBy: 'alpha' } : undefined,
          );
          if (offset === 0 && rows.length > 0 && activeSortBy === 'default') {
            uiCacheRef.current?.setGridFirstPage(kind, catId, rows);
          }
          return rows;
        },
      }),
    [catalog, kind],
  );

  const initialSourceRef = useRef<{
    source: PagedListSource<ItemRow>;
    catId: string;
    count: number;
    refreshToken: number;
    catalog: CatalogService;
    sortBy: ItemSortOrder;
  } | null>(null);

  if (initialSourceRef.current === null) {
    const seeded =
      sortBy === 'default' ? uiCache?.getGridFirstPage(kind, category.row.id) : undefined;
    initialSourceRef.current = {
      source: buildSource(category.row.id, category.row.itemCount, seeded, sortBy),
      catId: category.row.id,
      count: category.row.itemCount,
      refreshToken,
      catalog,
      sortBy,
    };
  }

  const [pagedSource, setPagedSource] = useState<PagedListSource<ItemRow> | null>(
    () => initialSourceRef.current?.source ?? null,
  );
  const [pageVersion, setPageVersion] = useState(0);
  const [progressResetToken, setProgressResetToken] = useState(0);
  const [progressByKey, setProgressByKey] = useState<ReadonlyMap<string, WatchProgressRow>>(
    () => new Map(),
  );
  const [visibleSeriesKeys, setVisibleSeriesKeys] = useState<readonly string[]>(() => []);

  const pagedSourceRef = useRef<PagedListSource<ItemRow> | null>(
    initialSourceRef.current?.source ?? null,
  );
  const activeKeyRef = useRef({
    catId: category.row.id,
    count: category.row.itemCount,
    refreshToken,
    catalog,
    sortBy,
  });
  const unsubRef = useRef<(() => void) | null>(null);
  const fetchedKeysRef = useRef<Set<string>>(new Set());
  const progressGenRef = useRef(0);

  // Dispose active pagedSource on final unmount
  useEffect(() => {
    return () => {
      unsubRef.current?.();
      unsubRef.current = null;
      pagedSourceRef.current?.dispose();
      pagedSourceRef.current = null;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const catId = category.row.id;
    const count = category.row.itemCount;
    const sameActive =
      pagedSourceRef.current !== null &&
      activeKeyRef.current.catId === catId &&
      activeKeyRef.current.count === count &&
      activeKeyRef.current.refreshToken === refreshToken &&
      activeKeyRef.current.catalog === catalog &&
      activeKeyRef.current.sortBy === sortBy;

    const attachAndActivate = (next: PagedListSource<ItemRow>) => {
      if (pagedSourceRef.current && pagedSourceRef.current !== next) {
        unsubRef.current?.();
        pagedSourceRef.current.dispose();
      } else {
        unsubRef.current?.();
      }
      unsubRef.current = next.onChange(() => {
        if (alive) setPageVersion((v) => v + 1);
      });
      pagedSourceRef.current = next;
      activeKeyRef.current = { catId, count, refreshToken, catalog, sortBy };
      setPagedSource(next);
      setPageVersion((v) => v + 1);
      next.prefetch(0, (visibleGridRows + 4) * cols);
    };

    if (sameActive && pagedSourceRef.current) {
      unsubRef.current?.();
      unsubRef.current = pagedSourceRef.current.onChange(() => {
        if (alive) setPageVersion((v) => v + 1);
      });
      pagedSourceRef.current.prefetch(0, (visibleGridRows + 4) * cols);
      return () => {
        alive = false;
      };
    }

    const tokenBumped = activeKeyRef.current.refreshToken !== refreshToken;
    const cachedPage0 =
      tokenBumped || sortBy !== 'default'
        ? undefined
        : uiCacheRef.current?.getGridFirstPage(kind, catId);
    const keepPreviousWhileFetching =
      pagedSourceRef.current !== null && count > 0 && cachedPage0 === undefined;

    if (!keepPreviousWhileFetching) {
      attachAndActivate(buildSource(catId, count, cachedPage0, sortBy));
      return () => {
        alive = false;
      };
    }

    // Keep previously rendered rows visible while fetching fresh page 0 of the target category.
    void catalog
      .items(
        catId,
        0,
        Math.min(GRID_PAGE_SIZE, count),
        sortBy === 'alpha' ? { sortBy: 'alpha' } : undefined,
      )
      .then((rows) => {
        if (!alive) return;
        if (rows.length > 0 && sortBy === 'default') {
          uiCacheRef.current?.setGridFirstPage(kind, catId, rows);
        }
        attachAndActivate(buildSource(catId, count, rows, sortBy));
      })
      .catch(() => {
        if (alive) attachAndActivate(buildSource(catId, count, undefined, sortBy));
      });

    return () => {
      alive = false;
    };
  }, [
    buildSource,
    catalog,
    category.row.id,
    category.row.itemCount,
    cols,
    kind,
    refreshToken,
    sortBy,
    visibleGridRows,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset triggers
  useEffect(() => {
    progressGenRef.current += 1;
    fetchedKeysRef.current = new Set();
    setVisibleSeriesKeys([]);
    setProgressResetToken((t) => t + 1);
  }, [category.row.id, refreshToken, userStateVersion]);

  const hydrateProgressRange = useCallback(
    (startRow: number, endRow: number) => {
      const source = pagedSourceRef.current;
      if (!source) return;
      const total = source.count();
      const from = Math.max(0, startRow * cols);
      const to = Math.min(total, (endRow + 1) * cols);
      const missing: string[] = [];
      const windowSeriesKeys: string[] = [];
      for (let i = from; i < to; i++) {
        const item = source.get(i);
        if (!item) continue;
        if (kind === 'series' && item.kind === 'series') {
          windowSeriesKeys.push(item.key);
        }
        if (!fetchedKeysRef.current.has(item.key)) {
          fetchedKeysRef.current.add(item.key);
          missing.push(item.key);
        }
      }
      if (kind === 'series' && windowSeriesKeys.length > 0) {
        setVisibleSeriesKeys((prev) => {
          if (
            prev.length === windowSeriesKeys.length &&
            prev.every((k, idx) => k === windowSeriesKeys[idx])
          ) {
            return prev;
          }
          return windowSeriesKeys;
        });
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
    [catalog, cols, kind],
  );

  const unplayedBySeriesKey = useSeriesUnplayedCounts(
    catalog,
    kind === 'series' ? visibleSeriesKeys : [],
    refreshToken + userStateVersion,
  );

  const itemCount = pagedSource?.count() ?? category.row.itemCount;

  const getItemAt = useCallback(
    (index: number): ItemRow | undefined => pagedSource?.get(index),
    [pagedSource],
  );

  return useMemo<CategoryGridDataState>(
    () => ({
      pagedSource,
      pageVersion,
      progressResetToken,
      progressByKey,
      unplayedBySeriesKey,
      itemCount,
      getItemAt,
      hydrateProgressRange,
    }),
    [
      getItemAt,
      hydrateProgressRange,
      itemCount,
      pagedSource,
      pageVersion,
      progressByKey,
      progressResetToken,
      unplayedBySeriesKey,
    ],
  );
}
