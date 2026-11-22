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
import { computeCatalogLayout, type DetailTarget, detailTargetFromItem } from '../shared';
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
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onOpenSources: () => void;
  readonly onFocusTopNav?: () => void;
  readonly isActiveScope?: boolean;
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

  const railEntries = useMemo<CatalogRailNavEntry[]>(() => {
    const entries: CatalogRailNavEntry[] = [];
    for (let i = 0; i < discovery.visibleCategories.length; i++) {
      const cat = discovery.visibleCategories[i];
      if (!cat) continue;
      const items = discovery.railItemsByCategoryId.get(cat.row.id) ?? [];
      if (items.length > 0) entries.push({ catIndex: i, count: items.length + 1 });
    }
    return entries;
  }, [discovery.railItemsByCategoryId, discovery.visibleCategories]);

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

  const effectiveGridItemCount = selectedCategory?.row.itemCount ?? gridMeta.itemCount;

  const navRows = useMemo(
    () =>
      buildCatalogNavRows({
        isLoading: isInitialLoading,
        hasSources,
        hasCategories,
        categoryChipCount: hasCategories ? discovery.categories.length + 1 : 0,
        continueCount: !isGridMode ? discovery.continueItems.length : 0,
        railEntries,
        hasLoadMore: !isGridMode && discovery.hasMoreCategories,
        isGridMode,
        gridHeaderCount: 2,
      }),
    [
      discovery.categories.length,
      discovery.continueItems.length,
      discovery.hasMoreCategories,
      hasCategories,
      hasSources,
      isGridMode,
      isInitialLoading,
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
        if (colIndex === 0) return handleSelectCategory(null);
        const cat = discovery.categories[colIndex - 1];
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
        const items = discovery.railItemsByCategoryId.get(cat.row.id) ?? [];
        if (colIndex === items.length) return handleSelectCategory(cat.row.id);
        const item = items[colIndex];
        if (!item) return;
        const target = detailTargetFromItem(item, cat.row.id);
        if (target) onOpenDetail(target);
      }
    },
    [discovery, handleSelectCategory, handleToggleSort, kind, onOpenDetail, onOpenSources],
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

  const tvNav = useTvCatalogNavigation({
    focusMemoryKey: kind,
    isTv: layout.isTv,
    isActiveScope,
    isGridMode,
    rows: navRows,
    gridColumns: layout.gridColumns,
    gridItemCount: effectiveGridItemCount,
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
            focusedCatChipIndex={tvNav.focusedRowId === 'catChips' ? tvNav.focusedCol : null}
            onSelectCategory={handleSelectCategory}
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
              sortBy={sortBy}
              onToggleSort={handleToggleSort}
              onBack={handleSelectAllCategories}
              onOpenDetail={onOpenDetail}
              onGridMetaChange={setGridMeta}
              gridAccessRef={gridAccessRef}
            />
          ) : (
            <CatalogRailsBody
              kind={kind}
              scrollRef={scrollViewRef}
              layout={layout}
              safeBottomInset={viewport.safeArea.bottom}
              continueItems={discovery.continueItems}
              visibleCategories={discovery.visibleCategories}
              loadedRailItems={discovery.railItemsByCategoryId}
              loadingRailIds={discovery.loadingRailIds}
              progressByKey={discovery.progressByKey}
              hasMoreCategories={discovery.hasMoreCategories}
              focusedRowId={tvNav.focusedRowId}
              focusedCol={tvNav.focusedCol}
              onOpenDetail={onOpenDetail}
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
