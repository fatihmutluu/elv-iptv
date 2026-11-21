import type { CatalogService, ItemRow, WatchProgressRow } from '@elv/data';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  batchLoadProgressByKeys,
  createPagedListSource,
  type DisplayCategory,
  type PagedListSource,
} from '../shared';
import { GRID_MAX_PAGES, GRID_PAGE_SIZE } from './catalog-model';

/** Options for {@link useCategoryGridData}. */
export interface UseCategoryGridDataOptions {
  readonly category: DisplayCategory;
  readonly catalog: CatalogService;
  readonly refreshToken: number;
  readonly userStateVersion: number;
  readonly cols: number;
  readonly visibleGridRows: number;
}

/** O(1)-paged grid data state returned by {@link useCategoryGridData}. */
export interface CategoryGridDataState {
  readonly pagedSource: PagedListSource<ItemRow> | null;
  readonly pageVersion: number;
  readonly progressResetToken: number;
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly itemCount: number;
  readonly getItemAt: (index: number) => ItemRow | undefined;
  readonly hydrateProgressRange: (startRow: number, endRow: number) => void;
}

/**
 * Manages O(1)-memory `PagedListSource` pagination and deduped visible-window watch-progress
 * hydration for {@link CategoryGridView}.
 */
export function useCategoryGridData({
  category,
  catalog,
  refreshToken,
  userStateVersion,
  cols,
  visibleGridRows,
}: UseCategoryGridDataOptions): CategoryGridDataState {
  const [pagedSource, setPagedSource] = useState<PagedListSource<ItemRow> | null>(null);
  const [pageVersion, setPageVersion] = useState(0);
  const [progressResetToken, setProgressResetToken] = useState(0);
  const [progressByKey, setProgressByKey] = useState<ReadonlyMap<string, WatchProgressRow>>(
    () => new Map(),
  );

  const pagedSourceRef = useRef<PagedListSource<ItemRow> | null>(null);
  const fetchedKeysRef = useRef<Set<string>>(new Set());
  const progressGenRef = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken intentionally recreates paged source
  useEffect(() => {
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
  }, [catalog, category.row.id, category.row.itemCount, cols, refreshToken, visibleGridRows]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset triggers
  useEffect(() => {
    progressGenRef.current += 1;
    fetchedKeysRef.current = new Set();
    setProgressByKey(new Map());
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

  const itemCount = category.row.itemCount;

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
    ],
  );
}
