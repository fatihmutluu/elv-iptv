import {
  type CatalogService,
  deduplicateCatalogPageByImdb,
  type ElvItemEnrichment,
  type ItemRow,
} from '@elv/data';
import type { ElvModePreferences } from '@elv/domain';
import { useCallback, useMemo } from 'react';
import {
  applyElvCardPresentation,
  isElvFeatureActive,
  type PagedListSource,
  presentElvCatalogItems,
  useElvEnrichmentForKeys,
} from '../shared';
import { chunkRowItems, GRID_PAGE_SIZE } from './catalog-model';

/** Options for {@link useCategoryGridElvPresentation}. */
export interface UseCategoryGridElvPresentationOptions {
  readonly catalog: CatalogService;
  readonly pagedSource: PagedListSource<ItemRow> | null;
  readonly rawItemCount: number;
  readonly pageVersion: number;
  readonly cols: number;
  readonly startRow: number;
  readonly endRow: number;
  readonly refreshToken: number;
  readonly elvPrefs: ElvModePreferences;
  readonly locale: string;
}

/** Deduplicated and ELV-presented grid accessors returned by {@link useCategoryGridElvPresentation} (`#511`). */
export interface CategoryGridElvPresentationState {
  readonly enrichmentByKey: ReadonlyMap<string, ElvItemEnrichment>;
  readonly resolvedKeys: ReadonlySet<string>;
  readonly effectiveItemCount: number;
  readonly getPresentedRowItems: (rowIndex: number) => readonly (ItemRow | undefined)[];
  readonly getPresentedItemAt: (index: number) => ItemRow | undefined;
}

/**
 * Applies ELV Mode zero-double-poster-fetch presentation (`elvEnrichMetadata`) and IMDb copy
 * deduplication (`elvMergeVersions`) to {@link CategoryGridView} while preserving O(1) paging (`#511`).
 */
export function useCategoryGridElvPresentation({
  catalog,
  pagedSource,
  rawItemCount,
  pageVersion,
  cols,
  startRow,
  endRow,
  refreshToken,
  elvPrefs,
  locale,
}: UseCategoryGridElvPresentationOptions): CategoryGridElvPresentationState {
  const elvEnrichActive = isElvFeatureActive(elvPrefs, 'elvEnrichMetadata');
  const elvMergeActive = isElvFeatureActive(elvPrefs, 'elvMergeVersions');
  const elvActive = elvEnrichActive || elvMergeActive;

  // biome-ignore lint/correctness/useExhaustiveDependencies: pageVersion refreshes visible keys as pages arrive
  const visibleElvKeys = useMemo(() => {
    if (!elvActive || !pagedSource) return [] as string[];
    const keys: string[] = [];
    if (elvMergeActive && rawItemCount > 0 && rawItemCount <= GRID_PAGE_SIZE) {
      for (let i = 0; i < rawItemCount; i++) {
        const item = pagedSource.get(i);
        if (item !== undefined) keys.push(item.key);
      }
      return keys;
    }
    for (let r = startRow; r <= endRow; r++) {
      for (const item of chunkRowItems(pagedSource, r, cols)) {
        if (item !== undefined) keys.push(item.key);
      }
    }
    return keys;
  }, [cols, elvActive, elvMergeActive, endRow, pageVersion, pagedSource, rawItemCount, startRow]);

  const elvEnrichment = useElvEnrichmentForKeys(catalog, visibleElvKeys, {
    enabled: elvActive,
    lang: locale,
    catalogRevision: refreshToken,
  });

  // For single-page categories (<= GRID_PAGE_SIZE), deduplicate the entire loaded list cleanly
  // so merged IMDb copies compact without gaps and counts reflect deduplicated titles.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pageVersion refreshes loaded page items
  const singlePageDeduped = useMemo<readonly ItemRow[] | null>(() => {
    if (!elvMergeActive || !pagedSource || rawItemCount <= 0 || rawItemCount > GRID_PAGE_SIZE) {
      return null;
    }
    const loaded: ItemRow[] = [];
    for (let i = 0; i < rawItemCount; i++) {
      const item = pagedSource.get(i);
      if (item === undefined) return null;
      loaded.push(item);
    }
    return presentElvCatalogItems(loaded, elvEnrichment.enrichmentByKey, elvPrefs, locale, {
      isKeyLookupPending: elvEnrichment.isKeyLookupPending,
    });
  }, [
    elvEnrichment.enrichmentByKey,
    elvEnrichment.isKeyLookupPending,
    elvMergeActive,
    elvPrefs,
    locale,
    pageVersion,
    pagedSource,
    rawItemCount,
  ]);

  const formatSingleItem = useCallback(
    (item: ItemRow | undefined): ItemRow | undefined => {
      if (item === undefined || !elvEnrichActive) return item;
      return applyElvCardPresentation(
        item,
        elvEnrichment.enrichmentByKey.get(item.key),
        elvPrefs,
        locale,
        { pendingLookup: elvEnrichment.isKeyLookupPending(item.key) },
      );
    },
    [
      elvEnrichActive,
      elvEnrichment.enrichmentByKey,
      elvEnrichment.isKeyLookupPending,
      elvPrefs,
      locale,
    ],
  );

  // For multi-page categories (> GRID_PAGE_SIZE), compute the surviving keys for loaded pages
  // touching the visible window via deduplicateCatalogPageByImdb so duplicate copies are dropped.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pageVersion refreshes loaded page items
  const multiPageDedupedByKey = useMemo<ReadonlyMap<string, ItemRow> | null>(() => {
    if (
      singlePageDeduped !== null ||
      !elvMergeActive ||
      !pagedSource ||
      rawItemCount <= GRID_PAGE_SIZE
    ) {
      return null;
    }
    const firstPage = Math.max(0, Math.floor((startRow * cols) / GRID_PAGE_SIZE));
    const lastPage = Math.min(
      Math.floor(Math.max(0, rawItemCount - 1) / GRID_PAGE_SIZE),
      Math.floor(((endRow + 1) * cols) / GRID_PAGE_SIZE),
    );
    const out = new Map<string, ItemRow>();
    for (let page = firstPage; page <= lastPage; page++) {
      const pageStart = page * GRID_PAGE_SIZE;
      const pageEnd = Math.min(rawItemCount, pageStart + GRID_PAGE_SIZE);
      const loadedPage: ItemRow[] = [];
      for (let i = pageStart; i < pageEnd; i++) {
        const item = pagedSource.get(i);
        if (item !== undefined) loadedPage.push(item);
      }
      if (loadedPage.length === 0) continue;
      const deduped = deduplicateCatalogPageByImdb(
        loadedPage,
        elvEnrichment.enrichmentByKey,
        undefined,
        { replacePoster: elvEnrichActive },
      );
      for (const item of deduped) out.set(item.key, item);
    }
    return out;
  }, [
    cols,
    elvEnrichActive,
    elvEnrichment.enrichmentByKey,
    elvMergeActive,
    endRow,
    pageVersion,
    pagedSource,
    rawItemCount,
    singlePageDeduped,
    startRow,
  ]);

  const effectiveItemCount = singlePageDeduped !== null ? singlePageDeduped.length : rawItemCount;

  // biome-ignore lint/correctness/useExhaustiveDependencies: pageVersion refreshes chunked row items
  const getPresentedRowItems = useCallback(
    (rowIndex: number): readonly (ItemRow | undefined)[] => {
      if (singlePageDeduped !== null) {
        const start = rowIndex * cols;
        if (start >= singlePageDeduped.length) return [];
        const end = Math.min(singlePageDeduped.length, start + cols);
        return singlePageDeduped.slice(start, end);
      }
      if (!pagedSource) return [];
      const raw = chunkRowItems(pagedSource, rowIndex, cols);
      if (multiPageDedupedByKey !== null) {
        const out: (ItemRow | undefined)[] = [];
        for (const item of raw) {
          if (item === undefined) {
            out.push(undefined);
            continue;
          }
          const winner = multiPageDedupedByKey.get(item.key);
          if (winner !== undefined) {
            out.push(formatSingleItem(winner));
          }
        }
        return out;
      }
      if (!elvEnrichActive) return raw;
      return raw.map(formatSingleItem);
    },
    [
      cols,
      elvEnrichActive,
      formatSingleItem,
      multiPageDedupedByKey,
      pageVersion,
      pagedSource,
      singlePageDeduped,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: pageVersion refreshes indexed lookup
  const getPresentedItemAt = useCallback(
    (index: number): ItemRow | undefined => {
      if (singlePageDeduped !== null) return singlePageDeduped[index];
      return formatSingleItem(pagedSource?.get(index));
    },
    [formatSingleItem, pageVersion, pagedSource, singlePageDeduped],
  );

  return useMemo(
    () => ({
      enrichmentByKey: elvEnrichment.enrichmentByKey,
      resolvedKeys: elvEnrichment.resolvedKeys,
      effectiveItemCount,
      getPresentedRowItems,
      getPresentedItemAt,
    }),
    [
      effectiveItemCount,
      elvEnrichment.enrichmentByKey,
      elvEnrichment.resolvedKeys,
      getPresentedItemAt,
      getPresentedRowItems,
    ],
  );
}
