import type { CatalogService, ItemRow, RatingValue, SourceRow, WatchProgressRow } from '@elv/data';
import { DEFAULT_ELV_MODE_PREFERENCES, type ElvModePreferences } from '@elv/domain';
import { useContextMenu, useI18n, useTheme, useViewport } from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type ScrollView, StyleSheet, View } from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import {
  computeCatalogLayout,
  type DetailTarget,
  detailTargetFromItem,
  isElvFeatureActive,
  presentElvCatalogItems,
  useCardQuickActionsState,
  useCatalogUiCache,
  useElvEnrichmentForKeys,
} from '../shared';
import { AmbientBackdrop } from '../shared/AmbientBackdrop';
import {
  CatalogEmptyState,
  CatalogFilterHeader,
  CatalogSkeleton,
  CatalogTvKeyBridge,
} from './CatalogChrome';
import { CatalogQuickFilterGrid } from './CatalogQuickFilterGrid';
import { CatalogRailsBody } from './CatalogRailsBody';
import {
  type CategoryGridAccess,
  type CategoryGridMeta,
  CategoryGridView,
} from './CategoryGridView';
import {
  ALPHABET_RAIL_MIN_ITEMS,
  buildCatalogNavRows,
  type CatalogNavRowId,
  type CatalogQuickFilter,
  type CatalogRailNavEntry,
  type CatalogTabMemory,
  detailTargetFromProgress,
} from './catalog-model';
import { useCatalogDiscovery, useCatalogTabMemory } from './useCatalogDiscovery';
import { useTvCatalogNavigation } from './useTvCatalogNavigation';

/** Props of {@link CatalogDiscoveryScreen}. */
export interface CatalogDiscoveryScreenProps {
  readonly kind: 'movie' | 'series';
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly refreshToken: number;
  readonly userStateVersion?: number;
  readonly memory?: CatalogTabMemory;
  readonly onMemoryChange?: (next: CatalogTabMemory) => void;
  readonly onPlay?: (target: PlayTarget) => void;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onOpenSources: () => void;
  readonly onFocusTopNav?: () => void;
  readonly isActiveScope?: boolean;
  readonly groupVersions?: boolean;
  /** Opt-in ELV Mode quick filter tab slot (`#508`, defaults to `false` until Wave E1/E2). */
  readonly showElvPicks?: boolean;
  /** Active ELV Mode display & merging preferences (`#511`). */
  readonly elvPreferences?: ElvModePreferences;
}

/**
 * Cinema Quietude Movies & Series Discovery screen (`UI_UX_PHILOSOPHY.md` §1–§4).
 * Presents an editorial underline category bar over a top `16:9` Continue Watching rail, bounded
 * horizontal `2:3` poster peek rails with progressive batch loading, and O(1)-memory
 * row-virtualized `CategoryGridView` drill-down.
 */
export function CatalogDiscoveryScreen({
  kind,
  catalog,
  sources,
  refreshToken,
  userStateVersion = 0,
  memory,
  onMemoryChange,
  onPlay,
  onOpenDetail,
  onOpenSources,
  onFocusTopNav,
  isActiveScope = true,
  groupVersions = false,
  showElvPicks = false,
  elvPreferences,
}: CatalogDiscoveryScreenProps): ReactElement {
  const elvPrefs = elvPreferences ?? DEFAULT_ELV_MODE_PREFERENCES;
  const elvNeedsEnrichment =
    isElvFeatureActive(elvPrefs, 'elvEnrichMetadata') ||
    isElvFeatureActive(elvPrefs, 'elvMergeVersions');
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const contextMenu = useContextMenu();
  const uiCache = useCatalogUiCache();
  const layout = useMemo(
    () => computeCatalogLayout(viewport, theme, theme.fontScale),
    [theme, viewport],
  );

  const { memory: activeMemory, updateMemory } = useCatalogTabMemory(memory, onMemoryChange);
  const rawQuickFilter = activeMemory.quickFilter ?? 'all';
  const quickFilter: CatalogQuickFilter =
    rawQuickFilter === 'mylist'
      ? 'mylist'
      : showElvPicks && rawQuickFilter === 'elvPicks'
        ? 'elvPicks'
        : 'all';
  const quickChipCount = showElvPicks ? 3 : 2;

  const handleSelectCategory = useCallback(
    (categoryId: string | null) =>
      updateMemory({
        selectedCategoryId: categoryId,
        ...(categoryId !== null ? { quickFilter: 'all' } : {}),
      }),
    [updateMemory],
  );
  const handleSelectQuickFilter = useCallback(
    (nextFilter: CatalogQuickFilter) =>
      updateMemory({ quickFilter: nextFilter, selectedCategoryId: null }),
    [updateMemory],
  );
  const handleSelectAllCategories = useCallback(
    () => updateMemory({ selectedCategoryId: null, quickFilter: 'all' }),
    [updateMemory],
  );
  const handleVisibleCategoryCountChange = useCallback(
    (nextCount: number) => updateMemory({ visibleCategoryCount: nextCount }),
    [updateMemory],
  );
  const sortBy = activeMemory.sortBy ?? 'default';
  const handleToggleSort = useCallback(
    () => updateMemory({ sortBy: sortBy === 'alpha' ? 'default' : 'alpha' }),
    [sortBy, updateMemory],
  );

  const discovery = useCatalogDiscovery({
    kind,
    catalog,
    sources,
    refreshToken,
    userStateVersion,
    selectedCategoryId: activeMemory.selectedCategoryId,
    visibleCategoryCount: activeMemory.visibleCategoryCount,
    sortBy,
    groupVersions,
    onVisibleCategoryCountChange: handleVisibleCategoryCountChange,
    onClearStaleCategory: handleSelectAllCategories,
  });

  const quickActionsState = useCardQuickActionsState({
    catalog,
    refreshToken,
    userStateVersion,
  });

  const handleQuickPlay = useCallback(
    (item: ItemRow, categoryId: string) => {
      if (item.kind === 'movie' && onPlay) {
        onPlay({
          itemKey: item.key,
          sourceId: item.sourceId,
          title: item.name,
          kind: 'vod',
          itemKind: 'movie',
          ...(item.logo !== null ? { logo: item.logo } : {}),
        });
        return;
      }
      const target = detailTargetFromItem(item, categoryId);
      if (target) onOpenDetail(target);
    },
    [onOpenDetail, onPlay],
  );
  const handleQuickToggleFavorite = useCallback(
    async (item: ItemRow): Promise<boolean> => {
      const ok = await quickActionsState.toggleFavorite(item);
      if (ok) uiCache?.clearHome?.();
      return ok;
    },
    [quickActionsState.toggleFavorite, uiCache],
  );
  const handleQuickToggleWatched = useCallback(
    (item: ItemRow, currentWatched: boolean) => {
      void quickActionsState.toggleWatched(item, currentWatched).then((ok) => {
        if (ok) uiCache?.clearHome?.();
      });
    },
    [quickActionsState.toggleWatched, uiCache],
  );
  const handleQuickToggleRating = useCallback(
    (item: ItemRow, next: RatingValue) => {
      void quickActionsState.toggleRating(item, next);
    },
    [quickActionsState.toggleRating],
  );
  const handleResumeContinue = useCallback(
    (row: WatchProgressRow) => {
      if (onPlay && (row.kind === 'movie' || row.kind === 'episode')) {
        onPlay({
          itemKey: row.itemKey,
          sourceId: row.sourceId,
          title: row.title,
          kind: 'vod',
          itemKind: row.kind,
          startPositionMs: row.positionMs,
          ...(row.logo !== null ? { logo: row.logo } : {}),
          ...(row.subtitle !== null ? { subtitle: row.subtitle } : {}),
          ...(row.seriesKey !== null ? { seriesKey: row.seriesKey } : {}),
          ...(row.season !== null ? { season: row.season } : {}),
          ...(row.episode !== null ? { episode: row.episode } : {}),
        });
        return;
      }
      onOpenDetail(detailTargetFromProgress(row, kind));
    },
    [kind, onOpenDetail, onPlay],
  );
  const handleHideContinue = useCallback(
    (row: WatchProgressRow) => {
      const removed = discovery.removeContinueItem(row.itemKey);
      if (!catalog.clearProgress) {
        uiCache?.clearHome?.();
        return;
      }
      void catalog
        .clearProgress(row.itemKey)
        .then((res) => {
          if (res.ok) {
            uiCache?.clearHome?.();
          } else if (removed) {
            discovery.restoreContinueItem(removed);
          }
        })
        .catch(() => {
          if (removed) discovery.restoreContinueItem(removed);
        });
    },
    [catalog, discovery.removeContinueItem, discovery.restoreContinueItem, uiCache],
  );
  const handleMarkContinueWatched = useCallback(
    (row: WatchProgressRow) => {
      const removed = discovery.removeContinueItem(row.itemKey);
      if (row.kind === 'episode') {
        const persist =
          typeof catalog.setWatched === 'function'
            ? catalog.setWatched(row.itemKey, true)
            : typeof catalog.saveProgress === 'function'
              ? catalog.saveProgress({
                  sourceId: row.sourceId,
                  itemKey: row.itemKey,
                  kind: 'episode',
                  title: row.title,
                  subtitle: row.subtitle,
                  logo: row.logo,
                  seriesKey: row.seriesKey,
                  season: row.season,
                  episode: row.episode,
                  positionMs: row.durationMs,
                  durationMs: row.durationMs,
                  watched: true,
                })
              : null;
        if (!persist) {
          uiCache?.clearHome?.();
          discovery.refreshContinueWatching();
          return;
        }
        void persist
          .then((res) => {
            if (res.ok) {
              uiCache?.clearHome?.();
              discovery.refreshContinueWatching();
            } else if (removed) {
              discovery.restoreContinueItem(removed);
            }
          })
          .catch(() => {
            if (removed) discovery.restoreContinueItem(removed);
          });
        return;
      }
      const item: ItemRow = {
        id: 0,
        key: row.itemKey,
        sourceId: row.sourceId,
        providerId: null,
        kind: row.kind === 'movie' ? 'movie' : 'series',
        name: row.title,
        logo: row.logo,
        num: null,
        year: null,
        rating: null,
      };
      void quickActionsState
        .toggleWatched(item, false)
        .then((ok) => {
          if (ok) {
            uiCache?.clearHome?.();
          } else if (removed) {
            discovery.restoreContinueItem(removed);
          }
        })
        .catch(() => {
          if (removed) discovery.restoreContinueItem(removed);
        });
    },
    [
      catalog,
      discovery.refreshContinueWatching,
      discovery.removeContinueItem,
      discovery.restoreContinueItem,
      quickActionsState.toggleWatched,
      uiCache,
    ],
  );

  const selectedCategory = useMemo(
    () =>
      activeMemory.selectedCategoryId === null
        ? null
        : (discovery.categories.find((c) => c.row.id === activeMemory.selectedCategoryId) ?? null),
    [activeMemory.selectedCategoryId, discovery.categories],
  );

  const isCategoryGridMode = selectedCategory !== null;
  const isQuickFilterGridMode = selectedCategory === null && quickFilter !== 'all';
  const isGridMode = isCategoryGridMode || isQuickFilterGridMode;

  const visibleRailKeys = useMemo(() => {
    if (!elvNeedsEnrichment) return [] as string[];
    const keys: string[] = [];
    for (const cat of discovery.visibleCategories) {
      const rows = discovery.railItemsByCategoryId.get(cat.row.id);
      if (!rows) continue;
      for (const item of rows) keys.push(item.key);
    }
    return keys;
  }, [discovery.railItemsByCategoryId, discovery.visibleCategories, elvNeedsEnrichment]);

  const elvEnrichment = useElvEnrichmentForKeys(catalog, visibleRailKeys, {
    enabled: elvNeedsEnrichment,
    lang: i18n.locale,
    catalogRevision: refreshToken,
  });

  const presentedRailItemsByCategoryId = useMemo<ReadonlyMap<string, readonly ItemRow[]>>(() => {
    if (!elvNeedsEnrichment) {
      return discovery.railItemsByCategoryId;
    }
    const next = new Map<string, readonly ItemRow[]>();
    for (const [catId, rows] of discovery.railItemsByCategoryId) {
      next.set(
        catId,
        presentElvCatalogItems(rows, elvEnrichment.enrichmentByKey, elvPrefs, i18n.locale, {
          isKeyLookupPending: elvEnrichment.isKeyLookupPending,
        }),
      );
    }
    return next;
  }, [
    discovery.railItemsByCategoryId,
    elvEnrichment.enrichmentByKey,
    elvEnrichment.isKeyLookupPending,
    elvNeedsEnrichment,
    elvPrefs,
    i18n.locale,
  ]);

  const railEntries = useMemo<CatalogRailNavEntry[]>(() => {
    const entries: CatalogRailNavEntry[] = [];
    for (let i = 0; i < discovery.visibleCategories.length; i++) {
      const cat = discovery.visibleCategories[i];
      if (!cat) continue;
      const items = presentedRailItemsByCategoryId.get(cat.row.id) ?? [];
      if (items.length > 0) entries.push({ catIndex: i, count: items.length + 1 });
    }
    return entries;
  }, [discovery.visibleCategories, presentedRailItemsByCategoryId]);

  const [gridMeta, setGridMeta] = useState<CategoryGridMeta>({ itemCount: 0 });
  const gridAccessRef = useRef<CategoryGridAccess>({
    itemCount: 0,
    getItem: () => undefined,
  });

  const scrollViewRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const continueYRef = useRef<number | undefined>(undefined);
  const railYRef = useRef<Map<number, number>>(new Map());
  const recordContinueY = useCallback((y: number) => {
    continueYRef.current = y;
  }, []);
  const recordRailY = useCallback((catIndex: number, y: number) => {
    railYRef.current.set(catIndex, y);
  }, []);

  const isInitialLoading = discovery.loadingCategories && !discovery.hasLoadedCategories;
  const hasSources = sources.length > 0;
  const hasCategories = discovery.categories.length > 0;

  const effectiveGridItemCount = isCategoryGridMode
    ? (selectedCategory?.row.itemCount ?? gridMeta.itemCount)
    : isQuickFilterGridMode
      ? gridMeta.itemCount
      : 0;

  const navRows = useMemo(
    () =>
      buildCatalogNavRows({
        isLoading: isInitialLoading,
        hasSources,
        hasCategories,
        categoryChipCount: hasCategories ? discovery.categories.length + quickChipCount : 0,
        continueCount: !isGridMode && quickFilter === 'all' ? discovery.continueItems.length : 0,
        railEntries: quickFilter === 'all' ? railEntries : [],
        hasLoadMore: !isGridMode && quickFilter === 'all' && discovery.hasMoreCategories,
        isGridMode,
        gridHeaderCount: isCategoryGridMode ? 2 : 0,
      }),
    [
      discovery.categories.length,
      discovery.continueItems.length,
      discovery.hasMoreCategories,
      hasCategories,
      hasSources,
      isCategoryGridMode,
      isGridMode,
      isInitialLoading,
      quickChipCount,
      quickFilter,
      railEntries,
    ],
  );

  const handleActivateRow = useCallback(
    (rowId: CatalogNavRowId, colIndex: number) => {
      if (rowId === 'empty') return onOpenSources();
      if (rowId === 'gridBack') {
        return colIndex === 1 ? handleToggleSort() : handleSelectCategory(null);
      }
      if (rowId === 'loadMore') return discovery.loadMoreCategories();
      if (rowId === 'catChips') {
        if (colIndex === 0) return handleSelectQuickFilter('all');
        if (colIndex === 1) return handleSelectQuickFilter('mylist');
        if (showElvPicks && colIndex === 2) return handleSelectQuickFilter('elvPicks');
        const cat = discovery.categories[colIndex - quickChipCount];
        if (cat) handleSelectCategory(cat.row.id);
        return;
      }
      if (rowId === 'continue') {
        const row = discovery.continueItems[colIndex];
        if (row) onOpenDetail(detailTargetFromProgress(row, kind));
        return;
      }
      if (rowId.startsWith('rail-')) {
        const cat = discovery.visibleCategories[Number(rowId.slice(5))];
        if (!cat) return;
        const items = presentedRailItemsByCategoryId.get(cat.row.id) ?? [];
        if (colIndex === items.length) return handleSelectCategory(cat.row.id);
        const item = items[colIndex];
        if (!item) return;
        const target = detailTargetFromItem(item, cat.row.id);
        if (target) onOpenDetail(target);
      }
    },
    [
      discovery,
      handleSelectCategory,
      handleSelectQuickFilter,
      handleToggleSort,
      kind,
      onOpenDetail,
      onOpenSources,
      presentedRailItemsByCategoryId,
      quickChipCount,
      showElvPicks,
    ],
  );

  const handleActivateGridItem = useCallback(
    (itemIndex: number) => {
      if (!isGridMode) return;
      const item = gridAccessRef.current.getItem(itemIndex);
      if (!item) return;
      const target = detailTargetFromItem(item, selectedCategory?.row.id);
      if (target) onOpenDetail(target);
    },
    [isGridMode, onOpenDetail, selectedCategory],
  );

  const handleFocusRow = useCallback(
    (rowId: CatalogNavRowId) => {
      if (rowId === 'catChips') {
        scrollViewRef.current?.scrollTo({ y: 0, animated: !theme.reduceMotion });
      } else if (rowId === 'continue') {
        const y = continueYRef.current ?? 0;
        scrollViewRef.current?.scrollTo({
          y: Math.max(0, y - 16),
          animated: !theme.reduceMotion,
        });
      } else if (rowId === 'loadMore') {
        scrollViewRef.current?.scrollToEnd({ animated: !theme.reduceMotion });
      } else if (rowId.startsWith('rail-')) {
        const y = railYRef.current.get(Number(rowId.slice(5)));
        if (y !== undefined) {
          scrollViewRef.current?.scrollTo({
            y: Math.max(0, y - 16),
            animated: !theme.reduceMotion,
          });
        }
      }
    },
    [theme.reduceMotion],
  );

  const handleSelectAlphabetLetter = useCallback((letter: string, offset: number) => {
    gridAccessRef.current.selectLetter?.(letter, offset);
  }, []);

  const activeAlphabetBuckets =
    isCategoryGridMode && sortBy === 'alpha' && effectiveGridItemCount >= ALPHABET_RAIL_MIN_ITEMS
      ? (gridMeta.alphabetBuckets ?? [])
      : [];

  const tvNav = useTvCatalogNavigation({
    focusMemoryKey: kind,
    isTv: layout.isTv,
    isActiveScope,
    isGridMode,
    rows: navRows,
    gridColumns: layout.gridColumns,
    gridItemCount: effectiveGridItemCount,
    alphabetBuckets: activeAlphabetBuckets,
    onActivateRow: handleActivateRow,
    onActivateGridItem: handleActivateGridItem,
    onSelectAlphabetLetter: handleSelectAlphabetLetter,
    onExitGrid: handleSelectAllCategories,
    onFocusRow: handleFocusRow,
    ...(onFocusTopNav !== undefined ? { onFocusTopNav } : {}),
  });

  const screenTitle = i18n.t(kind === 'movie' ? 'catalog.moviesTitle' : 'catalog.seriesTitle');
  const ambientTarget = useMemo<{
    readonly key: string;
    readonly uri: string | null;
    readonly title: string;
  } | null>(() => {
    if (!layout.isTv) return null;
    if (isGridMode && tvNav.focusedGridPos !== null && gridMeta.itemCount > 0) {
      const gridIndex = tvNav.focusedGridPos.row * layout.gridColumns + tvNav.focusedGridPos.col;
      const item = gridAccessRef.current.getItem(gridIndex);
      if (item) return { key: item.key, uri: item.logo, title: item.name };
      return null;
    }
    if (tvNav.focusedRowId === 'continue' && tvNav.focusedCol !== null) {
      const row = discovery.continueItems[tvNav.focusedCol];
      if (row) return { key: row.itemKey, uri: row.logo, title: row.title };
      return null;
    }
    if (tvNav.focusedRowId?.startsWith('rail-') && tvNav.focusedCol !== null) {
      const cat = discovery.visibleCategories[Number(tvNav.focusedRowId.slice(5))];
      if (!cat) return null;
      const items = presentedRailItemsByCategoryId.get(cat.row.id);
      const item = items?.[tvNav.focusedCol];
      if (item) return { key: item.key, uri: item.logo, title: item.name };
    }
    return null;
  }, [
    discovery.continueItems,
    discovery.visibleCategories,
    gridMeta.itemCount,
    isGridMode,
    layout.gridColumns,
    layout.isTv,
    presentedRailItemsByCategoryId,
    tvNav.focusedCol,
    tvNav.focusedGridPos,
    tvNav.focusedRowId,
  ]);

  return (
    <View
      testID={`catalog-screen-${kind}`}
      style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}
    >
      {layout.isTv ? (
        <AmbientBackdrop
          testID={`catalog-ambient-backdrop-${kind}`}
          backdropKey={ambientTarget?.key ?? null}
          uri={ambientTarget?.uri ?? null}
          title={ambientTarget?.title ?? ''}
        />
      ) : null}
      {layout.isTv && isActiveScope && !contextMenu.isOpen ? (
        <CatalogTvKeyBridge kind={kind} onEvent={tvNav.handleTvKey} />
      ) : null}

      {isInitialLoading ? (
        <CatalogSkeleton layout={layout} />
      ) : !hasSources ? (
        <CatalogEmptyState
          testID="catalog-empty-sources"
          title={screenTitle}
          description={i18n.t('browse.emptyNoSources')}
          layout={layout}
          ctaLabel={i18n.t('browse.openSources')}
          ctaTestID="catalog-open-sources"
          ctaFocused={tvNav.focusedRowId === 'empty'}
          onPressCta={onOpenSources}
        />
      ) : !hasCategories ? (
        <CatalogEmptyState
          testID="catalog-empty-categories"
          title={screenTitle}
          description={i18n.t('browse.emptyCategories')}
          layout={layout}
        />
      ) : (
        <View style={styles.root}>
          <CatalogFilterHeader
            screenTitle={screenTitle}
            layout={layout}
            categories={discovery.categories}
            selectedCategoryId={selectedCategory?.row.id ?? null}
            quickFilter={quickFilter}
            showElvPicks={showElvPicks}
            focusedCatChipIndex={tvNav.focusedRowId === 'catChips' ? tvNav.focusedCol : null}
            onSelectCategory={handleSelectCategory}
            onSelectQuickFilter={handleSelectQuickFilter}
          />

          {selectedCategory !== null ? (
            <CategoryGridView
              kind={kind}
              category={selectedCategory}
              catalog={catalog}
              refreshToken={refreshToken}
              userStateVersion={userStateVersion}
              layout={layout}
              backFocused={tvNav.focusedRowId === 'gridBack' && tvNav.focusedCol === 0}
              sortFocused={tvNav.focusedRowId === 'gridBack' && tvNav.focusedCol === 1}
              focusedGridPos={tvNav.focusedGridPos}
              focusedAlphabetLetter={tvNav.focusedAlphabetLetter}
              sortBy={sortBy}
              groupVersions={groupVersions}
              elvPreferences={elvPrefs}
              onToggleSort={handleToggleSort}
              onBack={handleSelectAllCategories}
              onOpenDetail={onOpenDetail}
              onJumpToGridPos={tvNav.jumpToGridPos}
              favoriteKeys={quickActionsState.favoriteKeys}
              watchedOverrides={quickActionsState.watchedOverrides}
              ratingByKey={quickActionsState.ratingByKey}
              onQuickPlay={handleQuickPlay}
              onQuickToggleFavorite={handleQuickToggleFavorite}
              onQuickToggleWatched={handleQuickToggleWatched}
              onQuickToggleRating={handleQuickToggleRating}
              onGridMetaChange={setGridMeta}
              gridAccessRef={gridAccessRef}
            />
          ) : quickFilter !== 'all' ? (
            <CatalogQuickFilterGrid
              kind={kind}
              filter={quickFilter}
              catalog={catalog}
              refreshToken={refreshToken}
              userStateVersion={userStateVersion}
              layout={layout}
              safeBottomInset={viewport.safeArea.bottom}
              progressByKey={discovery.progressByKey}
              unplayedBySeriesKey={discovery.unplayedBySeriesKey}
              favoriteKeys={quickActionsState.favoriteKeys}
              watchedOverrides={quickActionsState.watchedOverrides}
              ratingByKey={quickActionsState.ratingByKey}
              focusedGridPos={tvNav.focusedGridPos}
              onGridMetaChange={setGridMeta}
              gridAccessRef={gridAccessRef}
              onOpenDetail={onOpenDetail}
              onQuickPlay={handleQuickPlay}
              onQuickToggleFavorite={handleQuickToggleFavorite}
              onQuickToggleWatched={handleQuickToggleWatched}
              onQuickToggleRating={handleQuickToggleRating}
            />
          ) : (
            <CatalogRailsBody
              kind={kind}
              scrollRef={scrollViewRef}
              layout={layout}
              safeBottomInset={viewport.safeArea.bottom}
              continueItems={discovery.continueItems}
              visibleCategories={discovery.visibleCategories}
              loadedRailItems={presentedRailItemsByCategoryId}
              loadingRailIds={discovery.loadingRailIds}
              progressByKey={discovery.progressByKey}
              favoriteKeys={quickActionsState.favoriteKeys}
              watchedOverrides={quickActionsState.watchedOverrides}
              ratingByKey={quickActionsState.ratingByKey}
              unplayedBySeriesKey={discovery.unplayedBySeriesKey}
              hasMoreCategories={discovery.hasMoreCategories}
              focusedRowId={tvNav.focusedRowId}
              focusedCol={tvNav.focusedCol}
              onOpenDetail={onOpenDetail}
              onResumeContinue={handleResumeContinue}
              onHideContinue={handleHideContinue}
              onMarkContinueWatched={handleMarkContinueWatched}
              onQuickPlay={handleQuickPlay}
              onQuickToggleFavorite={handleQuickToggleFavorite}
              onQuickToggleWatched={handleQuickToggleWatched}
              onQuickToggleRating={handleQuickToggleRating}
              onSeeAll={handleSelectCategory}
              onLoadMore={discovery.loadMoreCategories}
              onLayoutContinueY={recordContinueY}
              onLayoutRailY={recordRailY}
            />
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
