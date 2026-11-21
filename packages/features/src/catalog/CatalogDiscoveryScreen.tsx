import type { CatalogService, SourceRow } from '@elv/data';
import { useI18n, useTheme, useViewport } from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type ScrollView, StyleSheet, View } from 'react-native';
import {
  computeCatalogLayout,
  type DetailTarget,
  detailTargetFromItem,
  type WatchStatusFilter,
} from '../shared';
import {
  CatalogEmptyState,
  CatalogFilterHeader,
  CatalogSkeleton,
  CatalogTvKeyBridge,
} from './CatalogChrome';
import { CatalogRailsBody } from './CatalogRailsBody';
import {
  type CategoryGridAccess,
  type CategoryGridMeta,
  CategoryGridView,
} from './CategoryGridView';
import {
  buildCatalogNavRows,
  type CatalogNavRowId,
  type CatalogRailNavEntry,
  type CatalogTabMemory,
  filterCatalogItems,
  WATCH_STATUS_FILTERS,
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
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onOpenSources: () => void;
  readonly onFocusTopNav?: () => void;
  readonly isActiveScope?: boolean;
}

/**
 * Cinema Quietude Movies & Series Discovery screen (`UI_UX_PHILOSOPHY.md` §1–§4).
 * Presents category and watch-status `FilterChip` bars over bounded horizontal `2:3` poster peek
 * rails with progressive batch loading and O(1)-memory row-virtualized `CategoryGridView` drill-down.
 */
export function CatalogDiscoveryScreen({
  kind,
  catalog,
  sources,
  refreshToken,
  userStateVersion = 0,
  memory,
  onMemoryChange,
  onOpenDetail,
  onOpenSources,
  onFocusTopNav,
  isActiveScope = true,
}: CatalogDiscoveryScreenProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const layout = useMemo(() => computeCatalogLayout(viewport, theme), [theme, viewport]);

  const { memory: activeMemory, updateMemory } = useCatalogTabMemory(memory, onMemoryChange);

  const handleSelectCategory = useCallback(
    (categoryId: string | null) => updateMemory({ selectedCategoryId: categoryId }),
    [updateMemory],
  );
  const handleSelectAllCategories = useCallback(
    () => handleSelectCategory(null),
    [handleSelectCategory],
  );
  const handleVisibleCategoryCountChange = useCallback(
    (nextCount: number) => updateMemory({ visibleCategoryCount: nextCount }),
    [updateMemory],
  );

  const discovery = useCatalogDiscovery({
    kind,
    catalog,
    sources,
    refreshToken,
    userStateVersion,
    selectedCategoryId: activeMemory.selectedCategoryId,
    visibleCategoryCount: activeMemory.visibleCategoryCount,
    onVisibleCategoryCountChange: handleVisibleCategoryCountChange,
    onClearStaleCategory: handleSelectAllCategories,
  });

  const selectedCategory = useMemo(
    () =>
      activeMemory.selectedCategoryId === null
        ? null
        : (discovery.categories.find((c) => c.row.id === activeMemory.selectedCategoryId) ?? null),
    [activeMemory.selectedCategoryId, discovery.categories],
  );

  const isGridMode = selectedCategory !== null;
  const watchFilter = activeMemory.watchFilter;

  const { filteredRailItems, railEntries, isDiscoveryFilterEmpty } = useMemo(() => {
    const map = new Map<string, ReturnType<typeof filterCatalogItems>>();
    const entries: CatalogRailNavEntry[] = [];
    for (let i = 0; i < discovery.visibleCategories.length; i++) {
      const cat = discovery.visibleCategories[i];
      if (!cat) continue;
      const raw = discovery.railItemsByCategoryId.get(cat.row.id) ?? [];
      const filtered = filterCatalogItems(raw, discovery.progressByKey, watchFilter);
      map.set(cat.row.id, filtered);
      if (filtered.length > 0) entries.push({ catIndex: i, count: filtered.length + 1 });
    }
    const empty =
      !isGridMode &&
      watchFilter !== 'all' &&
      discovery.visibleCategories.length > 0 &&
      discovery.loadingRailIds.size === 0 &&
      entries.length === 0;
    return { filteredRailItems: map, railEntries: entries, isDiscoveryFilterEmpty: empty };
  }, [
    discovery.loadingRailIds.size,
    discovery.progressByKey,
    discovery.railItemsByCategoryId,
    discovery.visibleCategories,
    isGridMode,
    watchFilter,
  ]);

  const [gridMeta, setGridMeta] = useState<CategoryGridMeta>({
    itemCount: 0,
    isFilterEmpty: false,
  });
  const gridAccessRef = useRef<CategoryGridAccess>({
    itemCount: 0,
    isFilterEmpty: false,
    getItem: () => undefined,
  });

  const handleSelectWatchFilter = useCallback(
    (nextFilter: WatchStatusFilter) => updateMemory({ watchFilter: nextFilter }),
    [updateMemory],
  );
  const handleResetFilter = useCallback(() => updateMemory({ watchFilter: 'all' }), [updateMemory]);

  const scrollViewRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const railYRef = useRef<Map<number, number>>(new Map());
  const recordRailY = useCallback((catIndex: number, y: number) => {
    railYRef.current.set(catIndex, y);
  }, []);

  const isInitialLoading = discovery.loadingCategories && !discovery.hasLoadedCategories;
  const hasSources = sources.length > 0;
  const hasCategories = discovery.categories.length > 0;

  const effectiveGridItemCount =
    watchFilter === 'all' ? (selectedCategory?.row.itemCount ?? 0) : gridMeta.itemCount;
  const effectiveGridFilterEmpty = watchFilter !== 'all' && gridMeta.isFilterEmpty;

  const navRows = useMemo(
    () =>
      buildCatalogNavRows({
        isLoading: isInitialLoading,
        hasSources,
        hasCategories,
        categoryChipCount: hasCategories ? discovery.categories.length + 1 : 0,
        statusChipCount: hasCategories ? WATCH_STATUS_FILTERS.length : 0,
        railEntries,
        hasLoadMore: !isGridMode && discovery.hasMoreCategories,
        isGridMode,
        isFilterEmpty: isGridMode ? effectiveGridFilterEmpty : isDiscoveryFilterEmpty,
      }),
    [
      discovery.categories.length,
      discovery.hasMoreCategories,
      effectiveGridFilterEmpty,
      hasCategories,
      hasSources,
      isDiscoveryFilterEmpty,
      isGridMode,
      isInitialLoading,
      railEntries,
    ],
  );

  const handleActivateRow = useCallback(
    (rowId: CatalogNavRowId, colIndex: number) => {
      if (rowId === 'empty') return onOpenSources();
      if (rowId === 'gridBack') return handleSelectCategory(null);
      if (rowId === 'filterReset') return handleResetFilter();
      if (rowId === 'loadMore') return discovery.loadMoreCategories();
      if (rowId === 'catChips') {
        if (colIndex === 0) return handleSelectCategory(null);
        const cat = discovery.categories[colIndex - 1];
        if (cat) handleSelectCategory(cat.row.id);
        return;
      }
      if (rowId === 'statusChips') {
        const filter = WATCH_STATUS_FILTERS[colIndex];
        if (filter) handleSelectWatchFilter(filter);
        return;
      }
      if (rowId.startsWith('rail-')) {
        const cat = discovery.visibleCategories[Number(rowId.slice(5))];
        if (!cat) return;
        const items = filteredRailItems.get(cat.row.id) ?? [];
        if (colIndex === items.length) return handleSelectCategory(cat.row.id);
        const item = items[colIndex];
        if (!item) return;
        const target = detailTargetFromItem(item, cat.row.id);
        if (target) onOpenDetail(target);
      }
    },
    [
      discovery,
      filteredRailItems,
      handleResetFilter,
      handleSelectCategory,
      handleSelectWatchFilter,
      onOpenDetail,
      onOpenSources,
    ],
  );

  const handleActivateGridItem = useCallback(
    (itemIndex: number) => {
      if (!selectedCategory) return;
      const item = gridAccessRef.current.getItem(itemIndex);
      if (!item) return;
      const target = detailTargetFromItem(item, selectedCategory.row.id);
      if (target) onOpenDetail(target);
    },
    [onOpenDetail, selectedCategory],
  );

  const handleFocusRow = useCallback(
    (rowId: CatalogNavRowId) => {
      if (rowId === 'catChips' || rowId === 'statusChips') {
        scrollViewRef.current?.scrollTo({ y: 0, animated: !theme.reduceMotion });
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

  const tvNav = useTvCatalogNavigation({
    isTv: layout.isTv,
    isActiveScope,
    isGridMode,
    rows: navRows,
    gridColumns: layout.gridColumns,
    gridItemCount: effectiveGridItemCount,
    isGridFilterEmpty: effectiveGridFilterEmpty,
    onActivateRow: handleActivateRow,
    onActivateGridItem: handleActivateGridItem,
    onExitGrid: handleSelectAllCategories,
    onFocusRow: handleFocusRow,
    ...(onFocusTopNav !== undefined ? { onFocusTopNav } : {}),
  });

  const screenTitle = i18n.t(kind === 'movie' ? 'catalog.moviesTitle' : 'catalog.seriesTitle');

  return (
    <View
      testID={`catalog-screen-${kind}`}
      style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}
    >
      {layout.isTv && isActiveScope ? (
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
            watchFilter={watchFilter}
            focusedCatChipIndex={tvNav.focusedRowId === 'catChips' ? tvNav.focusedCol : null}
            focusedStatusChipIndex={tvNav.focusedRowId === 'statusChips' ? tvNav.focusedCol : null}
            onSelectAllCategories={handleSelectAllCategories}
            onSelectCategory={handleSelectCategory}
            onSelectWatchFilter={handleSelectWatchFilter}
          />

          {selectedCategory !== null ? (
            <CategoryGridView
              kind={kind}
              category={selectedCategory}
              catalog={catalog}
              watchFilter={watchFilter}
              refreshToken={refreshToken}
              userStateVersion={userStateVersion}
              layout={layout}
              backFocused={tvNav.focusedRowId === 'gridBack'}
              filterResetFocused={tvNav.focusedRowId === 'filterReset'}
              focusedGridPos={tvNav.focusedGridPos}
              onBack={handleSelectAllCategories}
              onResetFilter={handleResetFilter}
              onOpenDetail={onOpenDetail}
              onGridMetaChange={setGridMeta}
              gridAccessRef={gridAccessRef}
            />
          ) : isDiscoveryFilterEmpty ? (
            <CatalogEmptyState
              testID="catalog-filter-empty"
              description={i18n.t('catalog.emptyFilter')}
              layout={layout}
              ctaLabel={i18n.t('catalog.clearFilter')}
              ctaTestID="catalog-filter-reset"
              ctaFocused={tvNav.focusedRowId === 'filterReset'}
              onPressCta={handleResetFilter}
            />
          ) : (
            <CatalogRailsBody
              scrollRef={scrollViewRef}
              layout={layout}
              safeBottomInset={viewport.safeArea.bottom}
              visibleCategories={discovery.visibleCategories}
              filteredRailItems={filteredRailItems}
              loadedRailItems={discovery.railItemsByCategoryId}
              loadingRailIds={discovery.loadingRailIds}
              progressByKey={discovery.progressByKey}
              hasMoreCategories={discovery.hasMoreCategories}
              focusedRowId={tvNav.focusedRowId}
              focusedCol={tvNav.focusedCol}
              onOpenDetail={onOpenDetail}
              onSeeAll={handleSelectCategory}
              onLoadMore={discovery.loadMoreCategories}
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
