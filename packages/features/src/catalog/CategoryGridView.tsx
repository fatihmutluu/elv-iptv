import type { CatalogService, ItemRow, ItemSortOrder } from '@elv/data';
import { TvScrollEdgeFade, useI18n, useTheme } from '@elv/ui-kit';
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
  View,
  VirtualizedList,
} from 'react-native';
import type { CatalogLayoutMetrics, DetailTarget, DisplayCategory } from '../shared';
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

/** Live item count reported to parent TV navigation. */
export interface CategoryGridMeta {
  readonly itemCount: number;
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
  readonly refreshToken: number;
  readonly userStateVersion: number;
  readonly layout: CatalogLayoutMetrics;
  readonly backFocused: boolean;
  readonly sortFocused?: boolean;
  readonly focusedGridPos: GridFocusPosition | null;
  readonly onBack: () => void;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly favoriteKeys?: ReadonlySet<string>;
  readonly watchedOverrides?: ReadonlyMap<string, boolean>;
  readonly onQuickPlay?: (item: ItemRow, categoryId: string) => void;
  readonly onQuickToggleFavorite?: (item: ItemRow) => void;
  readonly onQuickToggleWatched?: (item: ItemRow, currentWatched: boolean) => void;
  readonly onGridMetaChange?: (meta: CategoryGridMeta) => void;
  readonly gridAccessRef?: MutableRefObject<CategoryGridAccess>;
  /** Optional sort order (`'default'` or `'alpha'` via `sort_title`). */
  readonly sortBy?: ItemSortOrder;
  readonly onToggleSort?: () => void;
  /** Optional top padding applied to the virtualized list content container. */
  readonly contentPaddingTop?: number;
  /** Optional top border width on the virtualized list container for scroll math alignment. */
  readonly borderTopWidth?: number;
}

/**
 * Responsive O(1)-memory row-virtualized Category Grid.
 * Uses `createPagedListSource` (`pageSize = 180`, `maxPages = 8`) with deterministic `VirtualizedList`
 * row layouts on pointer/touch and a strict bounded `[windowStart, windowEnd]` TV viewport.
 */
export function CategoryGridView(props: CategoryGridViewProps): ReactElement {
  const { kind, category, catalog, refreshToken, userStateVersion, layout } = props;
  const { focusedGridPos, onOpenDetail, onGridMetaChange, gridAccessRef } = props;
  const contentPaddingTop = props.contentPaddingTop ?? 0;
  const borderTopWidth = props.borderTopWidth ?? 0;
  const theme = useTheme();
  const i18n = useI18n();
  const cols = layout.gridColumns;

  const gridData = useCategoryGridData({
    kind,
    category,
    catalog,
    refreshToken,
    userStateVersion,
    cols,
    visibleGridRows: layout.visibleGridRows,
    ...(props.sortBy !== undefined ? { sortBy: props.sortBy } : {}),
  });

  const listRef = useRef<InstanceType<typeof VirtualizedList>>(null);
  const scrollOffsetRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const lastScrollBucketRef = useRef(-1);
  const visibleWindowRef = useRef({ startRow: 0, endRow: layout.visibleGridRows + 2 });

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset scroll offset only when category changes
  useEffect(() => {
    scrollOffsetRef.current = 0;
  }, [category.row.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: invalidate scroll bucket on category or grid resize
  useEffect(() => {
    lastScrollBucketRef.current = -1;
    visibleWindowRef.current = { startRow: 0, endRow: layout.visibleGridRows + 2 };
  }, [category.row.id, cols, layout.visibleGridRows]);

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
    if (!gridData.pagedSource) return;
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
      getItem: gridData.getItemAt,
    };
  }

  useEffect(() => {
    onGridMetaChange?.({ itemCount: gridData.itemCount });
  }, [gridData.itemCount, onGridMetaChange]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = Math.max(0, event.nativeEvent.contentOffset.y);
      scrollOffsetRef.current = y;
      const measuredHeight = event.nativeEvent.layoutMeasurement?.height;
      if (typeof measuredHeight === 'number' && measuredHeight > 0) {
        viewportHeightRef.current = measuredHeight;
      }
      if (!gridData.pagedSource) return;
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
      gridData.pagedSource,
      layout.gridRowHeight,
      layout.visibleGridRows,
    ],
  );

  const watchedLabel = i18n.t('home.watchedBadge');
  const backLabel = i18n.t(kind === 'movie' ? 'catalog.backToMovies' : 'catalog.backToSeries');
  const countLabel = i18n.t('catalog.itemsCount', { count: gridData.itemCount });

  const getItemCount = useCallback(() => rowCount, [rowCount]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pageVersion refreshes chunked row items when LRU pages arrive
  const getRowData = useCallback(
    (_data: unknown, rowIndex: number): VirtualGridRowItem => ({
      rowIndex,
      items: gridData.pagedSource ? chunkRowItems(gridData.pagedSource, rowIndex, cols) : [],
    }),
    [cols, gridData.pageVersion, gridData.pagedSource],
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
      ...(props.favoriteKeys !== undefined ? { favoriteKeys: props.favoriteKeys } : {}),
      ...(props.watchedOverrides !== undefined ? { watchedOverrides: props.watchedOverrides } : {}),
      unplayedBySeriesKey: gridData.unplayedBySeriesKey,
      watchedLabel,
      layout,
      onOpenDetail,
      ...(props.onQuickPlay !== undefined ? { onQuickPlay: props.onQuickPlay } : {}),
      ...(props.onQuickToggleFavorite !== undefined
        ? { onQuickToggleFavorite: props.onQuickToggleFavorite }
        : {}),
      ...(props.onQuickToggleWatched !== undefined
        ? { onQuickToggleWatched: props.onQuickToggleWatched }
        : {}),
    }),
    [
      category.row.id,
      cols,
      gridData.progressByKey,
      gridData.unplayedBySeriesKey,
      layout,
      onOpenDetail,
      props.favoriteKeys,
      props.onQuickPlay,
      props.onQuickToggleFavorite,
      props.onQuickToggleWatched,
      props.watchedOverrides,
      watchedLabel,
    ],
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
      unplayedBySeriesKey: gridData.unplayedBySeriesKey,
      favoriteKeys: props.favoriteKeys,
      watchedOverrides: props.watchedOverrides,
    }),
    [
      cols,
      gridData.pageVersion,
      gridData.progressByKey,
      gridData.unplayedBySeriesKey,
      props.favoriteKeys,
      props.watchedOverrides,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: pageVersion refreshes memoized TV row slices when LRU pages arrive
  const tvWindowRows = useMemo<readonly VirtualGridRowItem[]>(() => {
    if (!layout.isTv || rowCount <= 0) return [];
    const out: VirtualGridRowItem[] = [];
    for (let r = tvWindowStart; r <= tvWindowEnd; r++) {
      out.push({
        rowIndex: r,
        items: gridData.pagedSource ? chunkRowItems(gridData.pagedSource, r, cols) : [],
      });
    }
    return out;
  }, [
    cols,
    gridData.pageVersion,
    gridData.pagedSource,
    layout.isTv,
    rowCount,
    tvWindowEnd,
    tvWindowStart,
  ]);

  return (
    <View testID="catalog-grid" style={styles.root}>
      <GridHeaderBar
        backLabel={backLabel}
        categoryLabel={category.label}
        countLabel={countLabel}
        layout={layout}
        backFocused={props.backFocused}
        {...(props.sortFocused !== undefined ? { sortFocused: props.sortFocused } : {})}
        onBack={props.onBack}
        {...(props.sortBy !== undefined ? { sortBy: props.sortBy } : {})}
        {...(props.onToggleSort !== undefined ? { onToggleSort: props.onToggleSort } : {})}
      />

      {layout.isTv ? (
        <View testID="catalog-grid-tv-viewport" style={styles.tvViewport}>
          {tvWindowRows.map((row) => {
            const isFocusedRow = focusedGridPos?.row === row.rowIndex;
            return (
              <View key={row.rowIndex} style={isFocusedRow ? styles.focusedRowLayer : undefined}>
                <GridRowView
                  rowIndex={row.rowIndex}
                  items={row.items}
                  focusedCol={isFocusedRow ? focusedGridPos.col : null}
                  {...rowCommonProps}
                />
              </View>
            );
          })}
          <View pointerEvents="none" style={styles.edgeFadeLayer}>
            <TvScrollEdgeFade
              testID="catalog-grid-edge-fade"
              showTop={tvWindowStart > 0}
              showBottom={tvWindowEnd < rowCount - 1}
            />
          </View>
        </View>
      ) : (
        <VirtualizedList
          ref={listRef}
          testID="catalog-grid-list"
          style={styles.listFlex}
          data={gridData.pagedSource}
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
  tvViewport: { flex: 1, overflow: 'hidden', position: 'relative' },
  edgeFadeLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 1 },
  focusedRowLayer: { zIndex: 2 },
});
