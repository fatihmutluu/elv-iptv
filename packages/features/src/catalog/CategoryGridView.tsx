import type { AlphabetBucket, CatalogService, ItemRow, ItemSortOrder } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import {
  AlphabetJumpRail,
  TvFocusAnchor,
  TvScrollEdgeFade,
  useContextMenu,
  useI18n,
  useKeyInterpreter,
  useTheme,
} from '@elv/ui-kit';
import {
  type MutableRefObject,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  View,
  VirtualizedList,
} from 'react-native';
import {
  type CatalogLayoutMetrics,
  type DetailTarget,
  type DisplayCategory,
  detailTargetFromItem,
  useRouteActive,
} from '../shared';
import { GridHeaderBar, GridRowView } from './CategoryGridRow';
import {
  ALPHABET_RAIL_MIN_ITEMS,
  chunkRowItems,
  clampGridFocus,
  computeRowCount,
  type GridFocusPosition,
  resolveActiveAlphabetLetter,
  stepAlphabetRailLetter,
} from './catalog-model';
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

/** Live item count and A–Z buckets reported to parent TV navigation (`#407`). */
export interface CategoryGridMeta {
  readonly itemCount: number;
  readonly alphabetBuckets?: readonly AlphabetBucket[];
}

/** Synchronous handle exposed to parent TV navigation for O(1) 2D grid & A–Z rail activation. */
export interface CategoryGridAccess extends CategoryGridMeta {
  readonly getItem: (index: number) => ItemRow | undefined;
  readonly selectLetter?: (letter: string, offset: number) => void;
}

function StandaloneGridTvKeyBridge({
  onEvent,
}: {
  readonly onEvent: Parameters<typeof useKeyInterpreter>[0];
}): ReactElement {
  const routeActive = useRouteActive();
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="catalog-grid-tv-focus-anchor" hasTVPreferredFocus={routeActive} />;
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
  readonly focusedAlphabetLetter?: string | null;
  readonly alphabetBuckets?: readonly AlphabetBucket[];
  readonly onBack: () => void;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly favoriteKeys?: ReadonlySet<string>;
  readonly watchedOverrides?: ReadonlyMap<string, boolean>;
  readonly onQuickPlay?: (item: ItemRow, categoryId: string) => void;
  readonly onQuickToggleFavorite?: (item: ItemRow) => void;
  readonly onQuickToggleWatched?: (item: ItemRow, currentWatched: boolean) => void;
  readonly onGridMetaChange?: (meta: CategoryGridMeta) => void;
  readonly gridAccessRef?: MutableRefObject<CategoryGridAccess>;
  readonly onJumpToGridPos?: (pos: GridFocusPosition) => void;
  /** Optional sort order (`'default'` or `'alpha'` via `sort_title`). */
  readonly sortBy?: ItemSortOrder;
  readonly groupVersions?: boolean;
  readonly onToggleSort?: () => void;
  /** Optional top padding applied to the virtualized list content container. */
  readonly contentPaddingTop?: number;
  /** Optional top border width on the virtualized list container for scroll math alignment. */
  readonly borderTopWidth?: number;
}

/**
 * Responsive O(1)-memory row-virtualized Category Grid.
 * Uses `createPagedListSource` (`pageSize = 180`, `maxPages = 8`) with deterministic `VirtualizedList`
 * row layouts on pointer/touch, a strict bounded `[windowStart, windowEnd]` TV viewport, and an A–Z
 * `AlphabetJumpRail` (`#407`) when `sortBy === 'alpha'` and `total >= 40`.
 */
export function CategoryGridView(props: CategoryGridViewProps): ReactElement {
  const { kind, category, catalog, refreshToken, userStateVersion, layout } = props;
  const { focusedGridPos, onOpenDetail, onGridMetaChange, gridAccessRef, onJumpToGridPos } = props;
  const contentPaddingTop = props.contentPaddingTop ?? 0;
  const borderTopWidth = props.borderTopWidth ?? 0;
  const sortBy = props.sortBy ?? 'default';
  const theme = useTheme();
  const i18n = useI18n();
  const contextMenu = useContextMenu();
  const cols = layout.gridColumns;

  const gridData = useCategoryGridData({
    kind,
    category,
    catalog,
    refreshToken,
    userStateVersion,
    cols,
    visibleGridRows: layout.visibleGridRows,
    sortBy,
    ...(props.groupVersions !== undefined ? { groupVersions: props.groupVersions } : {}),
  });

  const listRef = useRef<InstanceType<typeof VirtualizedList>>(null);
  const scrollOffsetRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const lastScrollBucketRef = useRef(-1);
  const visibleWindowRef = useRef({ startRow: 0, endRow: layout.visibleGridRows + 2 });

  const [topVisibleRow, setTopVisibleRow] = useState(0);
  const [selectedLetterOverride, setSelectedLetterOverride] = useState<string | null>(null);
  const [standaloneGridPos, setStandaloneGridPos] = useState<GridFocusPosition>(
    () => focusedGridPos ?? { row: 0, col: 0 },
  );
  const [standaloneFocusedLetter, setStandaloneFocusedLetter] = useState<string | null>(null);

  const isStandaloneTv = layout.isTv && onGridMetaChange === undefined;
  const effectiveFocusedGridPos = isStandaloneTv
    ? standaloneFocusedLetter !== null
      ? null
      : standaloneGridPos
    : focusedGridPos;
  const effectiveFocusedLetter = isStandaloneTv
    ? standaloneFocusedLetter
    : (props.focusedAlphabetLetter ?? null);

  useEffect(() => {
    if (focusedGridPos !== null) {
      setStandaloneGridPos(focusedGridPos);
    }
  }, [focusedGridPos]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset scroll offset only when category changes
  useEffect(() => {
    scrollOffsetRef.current = 0;
    setTopVisibleRow(0);
    setSelectedLetterOverride(null);
    setStandaloneFocusedLetter(null);
  }, [category.row.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: invalidate scroll bucket on category or grid resize
  useEffect(() => {
    lastScrollBucketRef.current = -1;
    visibleWindowRef.current = { startRow: 0, endRow: layout.visibleGridRows + 2 };
  }, [category.row.id, cols, layout.visibleGridRows]);

  const effectiveBuckets = props.alphabetBuckets ?? gridData.alphabetBuckets;
  const availableBuckets = useMemo(
    () => effectiveBuckets.filter((b) => b.count > 0),
    [effectiveBuckets],
  );
  const showAlphabetRail =
    sortBy === 'alpha' &&
    gridData.itemCount >= ALPHABET_RAIL_MIN_ITEMS &&
    availableBuckets.length > 0;

  useEffect(() => {
    if (!showAlphabetRail) {
      setSelectedLetterOverride(null);
      setStandaloneFocusedLetter(null);
    }
  }, [showAlphabetRail]);

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
  const tvAnchorPos = isStandaloneTv ? standaloneGridPos : focusedGridPos;
  const tvFocusRow = tvAnchorPos?.row ?? 0;
  const tvWindowStart =
    rowCount <= maxMountedRows ? 0 : Math.max(0, Math.min(rowCount - maxMountedRows, tvFocusRow));
  const tvWindowEnd = Math.min(rowCount - 1, tvWindowStart + maxMountedRows - 1);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pageVersion and progressResetToken re-hydrate visible rows when pages land or user state changes
  useEffect(() => {
    if (!gridData.pagedSource) return;
    if (layout.isTv) {
      gridData.pagedSource.prefetch(Math.max(0, tvWindowStart) * cols, (tvWindowEnd + 3) * cols);
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

  const handleSelectLetter = useCallback(
    (letter: string, offset: number) => {
      if (gridData.itemCount <= 0) return;
      const safeOffset = Math.max(
        0,
        Math.min(gridData.itemCount - 1, Number.isFinite(offset) ? Math.floor(offset) : 0),
      );
      const targetPos = clampGridFocus(
        Math.floor(safeOffset / cols),
        safeOffset % cols,
        gridData.itemCount,
        cols,
      );
      const targetRow = targetPos.row;
      const endRow = Math.max(
        targetRow,
        Math.min(Math.max(0, rowCount - 1), targetRow + layout.visibleGridRows + 2),
      );
      visibleWindowRef.current = { startRow: targetRow, endRow };
      lastScrollBucketRef.current = Math.floor(targetRow / SCROLL_QUANTUM);
      setTopVisibleRow(targetRow);
      setSelectedLetterOverride(letter.trim().toUpperCase());
      setStandaloneGridPos(targetPos);
      onJumpToGridPos?.(targetPos);

      gridData.pagedSource?.prefetch(
        targetRow * cols,
        Math.min(gridData.itemCount, (endRow + 2) * cols),
      );
      gridData.hydrateProgressRange(targetRow, endRow);

      if (!layout.isTv) {
        const targetScrollOffset = computeVirtualGridScrollOffset({
          rowIndex: targetRow,
          rowStride: layout.gridRowHeight,
          paddingTop: contentPaddingTop,
          borderTopWidth,
          viewportHeight: viewportHeightRef.current,
          currentOffset: scrollOffsetRef.current,
          align: 'start',
        });
        scrollOffsetRef.current = targetScrollOffset;
        if (typeof listRef.current?.scrollToIndex === 'function') {
          listRef.current.scrollToIndex({ index: targetRow, animated: false });
        } else {
          listRef.current?.scrollToOffset?.({ offset: targetScrollOffset, animated: false });
        }
      }
    },
    [
      borderTopWidth,
      cols,
      contentPaddingTop,
      gridData.hydrateProgressRange,
      gridData.itemCount,
      gridData.pagedSource,
      layout.gridRowHeight,
      layout.isTv,
      layout.visibleGridRows,
      onJumpToGridPos,
      rowCount,
    ],
  );

  if (gridAccessRef) {
    gridAccessRef.current = {
      itemCount: gridData.itemCount,
      alphabetBuckets: availableBuckets,
      getItem: gridData.getItemAt,
      selectLetter: handleSelectLetter,
    };
  }

  useEffect(() => {
    onGridMetaChange?.({ itemCount: gridData.itemCount, alphabetBuckets: availableBuckets });
  }, [availableBuckets, gridData.itemCount, onGridMetaChange]);

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
      setTopVisibleRow(topRow);
      setSelectedLetterOverride(null);
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

  const activeOffset = layout.isTv
    ? tvAnchorPos !== null
      ? tvAnchorPos.row * cols + tvAnchorPos.col
      : 0
    : (topVisibleRow + 1) * cols - 1;
  const activeLetter = useMemo(
    () => selectedLetterOverride ?? resolveActiveAlphabetLetter(availableBuckets, activeOffset),
    [activeOffset, availableBuckets, selectedLetterOverride],
  );

  const handleStandaloneTvKey = useCallback(
    (event: KeyEvent): boolean => {
      const count = gridData.itemCount;
      const isNav = event.kind === 'press' || event.kind === 'repeat';

      if (standaloneFocusedLetter !== null) {
        if (event.kind === 'press' && (event.key === 'left' || event.key === 'back')) {
          setStandaloneFocusedLetter(null);
          return true;
        }
        if (event.kind === 'press' && event.key === 'select') {
          const norm = standaloneFocusedLetter.trim().toUpperCase();
          const bucket =
            availableBuckets.find((b) => b.letter.trim().toUpperCase() === norm) ??
            availableBuckets[0];
          if (bucket) {
            handleSelectLetter(bucket.letter, bucket.offset);
          }
          setStandaloneFocusedLetter(null);
          return true;
        }
        if (!isNav) return false;
        if (event.key === 'up' || event.key === 'down') {
          const next = stepAlphabetRailLetter(availableBuckets, standaloneFocusedLetter, event.key);
          if (next !== null) setStandaloneFocusedLetter(next);
          return true;
        }
        return event.key === 'right';
      }

      if (event.kind === 'press' && event.key === 'back') {
        props.onBack();
        return true;
      }
      if (count <= 0) return false;

      if (event.kind === 'press' && event.key === 'select') {
        const idx = standaloneGridPos.row * cols + standaloneGridPos.col;
        const item = gridData.getItemAt(idx);
        const target = item ? detailTargetFromItem(item, category.row.id) : undefined;
        if (target) onOpenDetail(target);
        return true;
      }
      if (!isNav) return false;

      if (event.key === 'left') {
        if (standaloneGridPos.col > 0) {
          setSelectedLetterOverride(null);
          setStandaloneGridPos({ row: standaloneGridPos.row, col: standaloneGridPos.col - 1 });
        }
        return true;
      }
      if (event.key === 'right') {
        const rowItems = Math.min(cols, count - standaloneGridPos.row * cols);
        if (standaloneGridPos.col + 1 < rowItems) {
          setSelectedLetterOverride(null);
          setStandaloneGridPos({ row: standaloneGridPos.row, col: standaloneGridPos.col + 1 });
        } else if (showAlphabetRail) {
          const initial = activeLetter ?? availableBuckets[0]?.letter ?? null;
          if (initial !== null) setStandaloneFocusedLetter(initial);
        }
        return true;
      }
      if (event.key === 'down') {
        if (standaloneGridPos.row + 1 < rowCount) {
          setSelectedLetterOverride(null);
          setStandaloneGridPos(
            clampGridFocus(standaloneGridPos.row + 1, standaloneGridPos.col, count, cols),
          );
        }
        return true;
      }
      if (event.key === 'up') {
        if (standaloneGridPos.row > 0) {
          setSelectedLetterOverride(null);
          setStandaloneGridPos(
            clampGridFocus(standaloneGridPos.row - 1, standaloneGridPos.col, count, cols),
          );
        }
        return true;
      }
      return false;
    },
    [
      activeLetter,
      availableBuckets,
      category.row.id,
      cols,
      gridData,
      handleSelectLetter,
      onOpenDetail,
      props.onBack,
      rowCount,
      showAlphabetRail,
      standaloneFocusedLetter,
      standaloneGridPos,
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
      {isStandaloneTv && !contextMenu.isOpen ? (
        <StandaloneGridTvKeyBridge onEvent={handleStandaloneTvKey} />
      ) : null}
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

      <View style={styles.bodyWrap}>
        {layout.isTv ? (
          <View testID="catalog-grid-tv-viewport" style={styles.tvViewport}>
            {tvWindowRows.map((row) => {
              const isFocusedRow = effectiveFocusedGridPos?.row === row.rowIndex;
              return (
                <View key={row.rowIndex} style={isFocusedRow ? styles.focusedRowLayer : undefined}>
                  <GridRowView
                    rowIndex={row.rowIndex}
                    items={row.items}
                    focusedCol={isFocusedRow ? effectiveFocusedGridPos.col : null}
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

        {showAlphabetRail ? (
          <View
            pointerEvents="box-none"
            style={[
              styles.alphabetRailOverlay,
              { right: Math.max(4, Math.floor(layout.padX / 4)) },
            ]}
          >
            <AlphabetJumpRail
              buckets={availableBuckets}
              activeLetter={activeLetter}
              focusedLetter={effectiveFocusedLetter}
              onSelectLetter={handleSelectLetter}
              isTv={layout.isTv}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  bodyWrap: { flex: 1, position: 'relative' },
  listFlex: { flex: 1 },
  tvViewport: { flex: 1, overflow: 'hidden', position: 'relative' },
  edgeFadeLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 1 },
  focusedRowLayer: { zIndex: 2 },
  alphabetRailOverlay: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
});
