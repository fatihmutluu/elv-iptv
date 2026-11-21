import type { CatalogService, ItemRow } from '@elv/data';
import { CtaButton, useI18n, useTheme } from '@elv/ui-kit';
import {
  type MutableRefObject,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  Text,
  View,
  VirtualizedList,
} from 'react-native';
import type {
  CatalogLayoutMetrics,
  DetailTarget,
  DisplayCategory,
  WatchStatusFilter,
} from '../shared';
import { GridHeaderBar, GridRowView } from './CategoryGridRow';
import { chunkRowItems, computeRowCount, type GridFocusPosition } from './catalog-model';
import { useCategoryGridData } from './useCategoryGridData';
import {
  computeVirtualGridRowFromOffset,
  computeVirtualGridScrollOffset,
} from './virtual-grid-math';

const SCROLL_QUANTUM = 3;

interface VirtualGridRowItem {
  readonly rowIndex: number;
  readonly items: readonly (ItemRow | undefined)[];
}

/** Live item count and empty-filter state reported to parent TV navigation. */
export interface CategoryGridMeta {
  readonly itemCount: number;
  readonly isFilterEmpty: boolean;
}

/** Synchronous handle exposed to parent TV navigation for O(1) 2D grid activation. */
export interface CategoryGridAccess extends CategoryGridMeta {
  readonly getItem: (index: number) => ItemRow | undefined;
}

/** Props of {@link CategoryGridView}. */
export interface CategoryGridViewProps {
  readonly kind: 'movie' | 'series';
  readonly category: DisplayCategory;
  readonly catalog: CatalogService;
  readonly watchFilter: WatchStatusFilter;
  readonly refreshToken: number;
  readonly userStateVersion: number;
  readonly layout: CatalogLayoutMetrics;
  readonly backFocused: boolean;
  readonly filterResetFocused: boolean;
  readonly focusedGridPos: GridFocusPosition | null;
  readonly onBack: () => void;
  readonly onResetFilter: () => void;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onGridMetaChange?: (meta: CategoryGridMeta) => void;
  readonly gridAccessRef?: MutableRefObject<CategoryGridAccess>;
  /** Optional top padding applied to the virtualized list content container. */
  readonly contentPaddingTop?: number;
  /** Optional top border width on the virtualized list container for scroll math alignment. */
  readonly borderTopWidth?: number;
}

/**
 * Full 5-column (Landscape) / 3-column (Portrait) O(1)-memory row-virtualized Category Grid.
 * Uses `createPagedListSource` (`pageSize = 180`, `maxPages = 8`) with deterministic `VirtualizedList`
 * row layouts on pointer/touch and a strict bounded `[windowStart, windowEnd]` TV viewport.
 */
export function CategoryGridView(props: CategoryGridViewProps): ReactElement {
  const { kind, category, catalog, watchFilter, refreshToken, userStateVersion, layout } = props;
  const { focusedGridPos, onOpenDetail, onGridMetaChange, gridAccessRef } = props;
  const contentPaddingTop = props.contentPaddingTop ?? 0;
  const borderTopWidth = props.borderTopWidth ?? 0;
  const theme = useTheme();
  const i18n = useI18n();
  const cols = layout.gridColumns;

  const gridData = useCategoryGridData({
    category,
    catalog,
    watchFilter,
    refreshToken,
    userStateVersion,
    cols,
    visibleGridRows: layout.visibleGridRows,
  });

  const listRef = useRef<InstanceType<typeof VirtualizedList>>(null);
  const scrollOffsetRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const lastScrollBucketRef = useRef(-1);
  const visibleWindowRef = useRef({ startRow: 0, endRow: layout.visibleGridRows + 2 });

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset scroll offset only when source/filter changes
  useEffect(() => {
    scrollOffsetRef.current = 0;
  }, [category.row.id, watchFilter]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: invalidate scroll bucket on source, filter, or grid resize
  useEffect(() => {
    lastScrollBucketRef.current = -1;
    visibleWindowRef.current = { startRow: 0, endRow: layout.visibleGridRows + 2 };
  }, [category.row.id, cols, layout.visibleGridRows, watchFilter]);

  const handleListLayout = useCallback((event: LayoutChangeEvent) => {
    if (event.nativeEvent.layout.height > 0) {
      viewportHeightRef.current = event.nativeEvent.layout.height;
    }
  }, []);

  useEffect(() => {
    if (layout.isTv || focusedGridPos === null) return;
    const offset = computeVirtualGridScrollOffset({
      rowIndex: focusedGridPos.row,
      rowStride: layout.gridRowHeight,
      paddingTop: contentPaddingTop,
      borderTopWidth,
      viewportHeight: viewportHeightRef.current,
      currentOffset: scrollOffsetRef.current,
      align: 'nearest',
    });
    listRef.current?.scrollToOffset?.({ offset, animated: false });
  }, [borderTopWidth, contentPaddingTop, focusedGridPos, layout.gridRowHeight, layout.isTv]);

  const rowCount = computeRowCount(gridData.itemCount, cols);
  const maxMountedRows = layout.visibleGridRows + 2;
  const tvFocusRow = focusedGridPos?.row ?? 0;
  const tvWindowStart =
    rowCount <= maxMountedRows
      ? 0
      : Math.max(0, Math.min(rowCount - maxMountedRows, tvFocusRow - 1));
  const tvWindowEnd = Math.min(rowCount - 1, tvWindowStart + maxMountedRows - 1);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pageVersion and progressResetToken re-hydrate visible rows when pages land or user state changes
  useEffect(() => {
    if (!gridData.isAllFilter || !gridData.pagedSource) return;
    if (layout.isTv) {
      gridData.pagedSource.prefetch(
        Math.max(0, tvWindowStart - 2) * cols,
        (tvWindowEnd + 4) * cols,
      );
      gridData.hydrateProgressRange(tvWindowStart, tvWindowEnd);
    } else {
      const { startRow, endRow } = visibleWindowRef.current;
      gridData.hydrateProgressRange(startRow, endRow);
    }
  }, [
    cols,
    gridData.hydrateProgressRange,
    gridData.isAllFilter,
    gridData.pageVersion,
    gridData.pagedSource,
    gridData.progressResetToken,
    layout.isTv,
    tvWindowEnd,
    tvWindowStart,
  ]);

  if (gridAccessRef) {
    gridAccessRef.current = {
      itemCount: gridData.itemCount,
      isFilterEmpty: gridData.isFilterEmpty,
      getItem: gridData.getItemAt,
    };
  }

  useEffect(() => {
    onGridMetaChange?.({ itemCount: gridData.itemCount, isFilterEmpty: gridData.isFilterEmpty });
  }, [gridData.isFilterEmpty, gridData.itemCount, onGridMetaChange]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = Math.max(0, event.nativeEvent.contentOffset.y);
      scrollOffsetRef.current = y;
      const measuredHeight = event.nativeEvent.layoutMeasurement?.height;
      if (typeof measuredHeight === 'number' && measuredHeight > 0) {
        viewportHeightRef.current = measuredHeight;
      }
      if (!gridData.isAllFilter || !gridData.pagedSource) return;
      const topRow = computeVirtualGridRowFromOffset({
        scrollOffset: y,
        rowStride: layout.gridRowHeight,
        paddingTop: contentPaddingTop,
        borderTopWidth,
      });
      const bucket = Math.floor(topRow / SCROLL_QUANTUM);
      if (bucket === lastScrollBucketRef.current) return;
      lastScrollBucketRef.current = bucket;
      const endRow = topRow + layout.visibleGridRows + 2;
      visibleWindowRef.current = { startRow: topRow, endRow };
      gridData.pagedSource.prefetch(Math.max(0, topRow - 2) * cols, (endRow + 2) * cols);
      gridData.hydrateProgressRange(topRow, endRow);
    },
    [
      borderTopWidth,
      cols,
      contentPaddingTop,
      gridData.hydrateProgressRange,
      gridData.isAllFilter,
      gridData.pagedSource,
      layout.gridRowHeight,
      layout.visibleGridRows,
    ],
  );

  const watchedLabel = i18n.t('home.watchedBadge');
  const backLabel = i18n.t(kind === 'movie' ? 'catalog.backToMovies' : 'catalog.backToSeries');
  const countLabel = i18n.t('catalog.itemsCount', { count: gridData.itemCount });

  const activeSource = gridData.isAllFilter ? gridData.pagedSource : gridData.filteredItems;
  const getItemCount = useCallback(() => rowCount, [rowCount]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pageVersion refreshes chunked row items when LRU pages arrive
  const getRowData = useCallback(
    (_data: unknown, rowIndex: number): VirtualGridRowItem => ({
      rowIndex,
      items: activeSource ? chunkRowItems(activeSource, rowIndex, cols) : [],
    }),
    [activeSource, cols, gridData.pageVersion],
  );
  const keyExtractor = useCallback(
    (row: unknown, index: number) =>
      `grid-row-${(row as VirtualGridRowItem | undefined)?.rowIndex ?? index}`,
    [],
  );
  const getItemLayout = useCallback(
    (_data: unknown, index: number) => ({
      length: layout.gridRowHeight,
      offset: computeVirtualGridScrollOffset({
        rowIndex: index,
        rowStride: layout.gridRowHeight,
        paddingTop: contentPaddingTop,
        borderTopWidth,
      }),
      index,
    }),
    [borderTopWidth, contentPaddingTop, layout.gridRowHeight],
  );

  const rowCommonProps = useMemo(
    () => ({
      columns: cols,
      categoryId: category.row.id,
      progressByKey: gridData.progressByKey,
      watchedLabel,
      layout,
      onOpenDetail,
    }),
    [category.row.id, cols, gridData.progressByKey, layout, onOpenDetail, watchedLabel],
  );

  const renderRow = useCallback(
    ({ item }: { item: unknown }) => {
      const row = item as VirtualGridRowItem;
      return (
        <GridRowView
          rowIndex={row.rowIndex}
          items={row.items}
          focusedCol={null}
          {...rowCommonProps}
        />
      );
    },
    [rowCommonProps],
  );

  const extraData = useMemo(
    () => ({
      cols,
      pageVersion: gridData.pageVersion,
      progressByKey: gridData.progressByKey,
      filteredItems: gridData.filteredItems,
    }),
    [cols, gridData.filteredItems, gridData.pageVersion, gridData.progressByKey],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: pageVersion refreshes memoized TV row slices when LRU pages arrive
  const tvWindowRows = useMemo<readonly VirtualGridRowItem[]>(() => {
    if (!layout.isTv || rowCount <= 0) return [];
    const out: VirtualGridRowItem[] = [];
    for (let r = tvWindowStart; r <= tvWindowEnd; r++) {
      out.push({
        rowIndex: r,
        items: activeSource ? chunkRowItems(activeSource, r, cols) : [],
      });
    }
    return out;
  }, [activeSource, cols, gridData.pageVersion, layout.isTv, rowCount, tvWindowEnd, tvWindowStart]);

  return (
    <View testID="catalog-grid" style={styles.root}>
      <GridHeaderBar
        backLabel={backLabel}
        categoryLabel={category.label}
        countLabel={countLabel}
        layout={layout}
        backFocused={props.backFocused}
        onBack={props.onBack}
      />

      {gridData.loadingFiltered ? (
        <View testID="catalog-grid-loading" style={styles.listFlex}>
          {[0, 1].map((rowIdx) => (
            <GridRowView
              key={rowIdx}
              rowIndex={rowIdx}
              items={Array.from({ length: cols }, () => undefined)}
              focusedCol={null}
              {...rowCommonProps}
            />
          ))}
        </View>
      ) : gridData.isFilterEmpty ? (
        <View
          testID="catalog-filter-empty"
          style={[styles.emptyFilter, { paddingHorizontal: layout.padX }]}
        >
          <Text
            style={[
              theme.typography.body,
              { color: theme.colors.textSecondary, textAlign: 'center' },
            ]}
          >
            {i18n.t('catalog.emptyFilter')}
          </Text>
          <View style={styles.emptyAction}>
            <CtaButton
              testID="catalog-filter-reset"
              label={i18n.t('catalog.clearFilter')}
              focusable={!layout.isTv}
              focused={props.filterResetFocused}
              onPress={props.onResetFilter}
            />
          </View>
        </View>
      ) : layout.isTv ? (
        <View testID="catalog-grid-tv-viewport" style={styles.tvViewport}>
          {tvWindowRows.map((row) => (
            <GridRowView
              key={row.rowIndex}
              rowIndex={row.rowIndex}
              items={row.items}
              focusedCol={focusedGridPos?.row === row.rowIndex ? focusedGridPos.col : null}
              {...rowCommonProps}
            />
          ))}
        </View>
      ) : (
        <VirtualizedList
          ref={listRef}
          testID="catalog-grid-list"
          style={styles.listFlex}
          data={activeSource}
          extraData={extraData}
          getItemCount={getItemCount}
          getItem={getRowData}
          keyExtractor={keyExtractor}
          getItemLayout={getItemLayout}
          renderItem={renderRow}
          windowSize={5}
          initialNumToRender={layout.visibleGridRows + 2}
          maxToRenderPerBatch={4}
          onLayout={handleListLayout}
          onScroll={handleScroll}
          scrollEventThrottle={32}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingTop: contentPaddingTop,
            paddingBottom: theme.spacing.xl,
            ...(borderTopWidth > 0 ? { borderTopWidth } : {}),
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  listFlex: { flex: 1 },
  tvViewport: { flex: 1, overflow: 'hidden' },
  emptyFilter: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 48 },
  emptyAction: { marginTop: 16 },
});
