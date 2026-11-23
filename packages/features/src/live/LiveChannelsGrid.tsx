import type {
  AlphabetBucket,
  CatalogService,
  ItemRow,
  ItemSortOrder,
  NowNextEntry,
  ProgrammeRow,
} from '@elv/data';
import type { LogoBackdropModePref } from '@elv/domain';
import type { KeyEvent } from '@elv/focus-core';
import {
  AlphabetJumpRail,
  TvFocusAnchor,
  TvScrollEdgeFade,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useViewport,
  type ViewportInfo,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  View,
  VirtualizedList,
} from 'react-native';
import {
  type CatalogLayoutMetrics,
  type PagedListSource,
  useBrowseFocusMemory,
  useRouteActive,
} from '../shared';
import { ChannelGridRow, type LiveGridShared, LiveGridSortToolbar } from './LiveChannelTile';
import {
  LIVE_ALPHABET_RAIL_MIN_ITEMS,
  resolveLiveAlphabetLetter,
  stepLiveAlphabetLetter,
} from './live-model';
import type { SourceBadgeInfo } from './source-badge';

const SCROLL_QUANTUM = 2;
const EMPTY_BUCKETS: readonly AlphabetBucket[] = [];

interface ChannelRowData {
  readonly rowIndex: number;
  readonly items: readonly (ItemRow | undefined)[];
}

/** Computes responsive Live Channels grid columns (`3` Landscape/TV/Desktop, `2` Tablet-P, `1` Phone-P). */
export function computeLiveGridColumns(viewport: ViewportInfo): number {
  if (
    viewport.orientation === 'portrait' &&
    viewport.formFactor !== 'tv' &&
    viewport.formFactor !== 'desktop'
  ) {
    return viewport.formFactor === 'tablet' ? 2 : 1;
  }
  return 3;
}

function sliceChannelRow(
  source: PagedListSource<ItemRow>,
  rowIndex: number,
  cols: number,
): readonly (ItemRow | undefined)[] {
  const end = Math.min(source.count(), (rowIndex + 1) * cols);
  const out: (ItemRow | undefined)[] = [];
  for (let i = rowIndex * cols; i < end; i++) out.push(source.get(i));
  return out;
}

function syncChannelWindow(
  source: PagedListSource<ItemRow>,
  startRow: number,
  endRow: number,
  cols: number,
  hydrateNowNext: (keys: readonly string[]) => void,
  exactStart = false,
): void {
  const prefetchStart = exactStart
    ? Math.max(0, startRow) * cols
    : Math.max(0, startRow - 1) * cols;
  source.prefetch(prefetchStart, (endRow + 2) * cols);
  const from = Math.max(0, startRow * cols);
  const to = Math.min(source.count(), (endRow + 1) * cols);
  const keys: string[] = [];
  for (let i = from; i < to; i++) {
    const item = source.get(i);
    if (item) keys.push(item.key);
  }
  if (keys.length > 0) hydrateNowNext(keys);
}

function TvChannelsKeyBridge({
  onEvent,
}: {
  readonly onEvent: Parameters<typeof useKeyInterpreter>[0];
}): ReactElement {
  const routeActive = useRouteActive();
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="live-channels-tv-focus-anchor" hasTVPreferredFocus={routeActive} />;
}

/** Props of {@link LiveChannelsGrid}. */
export interface LiveChannelsGridProps {
  readonly channelSource: PagedListSource<ItemRow> | null;
  readonly sourceVersion: number;
  readonly nowNextByKey: ReadonlyMap<string, NowNextEntry>;
  readonly nowNextVersion: number;
  readonly activeChannelKey: string | null;
  readonly favoriteKeys?: ReadonlySet<string>;
  readonly layout: CatalogLayoutMetrics;
  readonly hydrateNowNext: (channelKeys: readonly string[]) => void;
  readonly onWatchChannel: (channel: ItemRow, index: number) => void;
  readonly onToggleFavorite?: (channel: ItemRow) => void;
  readonly onOpenContextMenu?: (
    channel: ItemRow,
    index: number,
    programme: ProgrammeRow | null,
  ) => void;
  readonly onJumpPreviousChannel?: () => void;
  readonly onEdgeTop?: () => void;
  readonly isActiveScope?: boolean;
  readonly logoBackdropMode?: LogoBackdropModePref;
  readonly sourceBadges?: ReadonlyMap<string, SourceBadgeInfo>;
  readonly cleanChannelTitles?: boolean;
  /** Optional sort order (`'default'` or `'alpha'` via `sort_title`, `#407`). */
  readonly sortBy?: ItemSortOrder;
  readonly onToggleSort?: () => void;
  readonly sortFocused?: boolean;
  readonly alphabetBuckets?: readonly AlphabetBucket[];
  readonly catalog?: CatalogService;
  readonly categoryId?: string;
  readonly sourceId?: string;
  readonly collapseVariants?: boolean;
  /** Injectable epoch clock in milliseconds for live progress bars (defaults to `() => Date.now()`). */
  readonly now?: () => number;
}

/**
 * O(1)-memory row-virtualized Cinema Quietude Live Channels Grid (`#13`, `#407`) with `Channel order | A–Z`
 * sort toggle (`testID="live-grid-sort"`), A–Z `AlphabetJumpRail` (`testID="live-alphabet-rail"`),
 * live Now/Next schedule progress, deterministic `VirtualizedList` on pointer/touch, and 2D TV D-pad.
 */
export function LiveChannelsGrid(p: LiveChannelsGridProps): ReactElement {
  const { channelSource, sourceVersion, nowNextByKey, nowNextVersion, activeChannelKey, layout } =
    p;
  const {
    favoriteKeys,
    hydrateNowNext,
    onWatchChannel,
    onToggleFavorite,
    onOpenContextMenu,
    onJumpPreviousChannel,
    onEdgeTop,
  } = p;
  const {
    isActiveScope = false,
    logoBackdropMode = 'plate',
    sourceBadges,
    cleanChannelTitles = false,
    now,
  } = p;
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();

  const [localSortBy, setLocalSortBy] = useState<ItemSortOrder>(() => p.sortBy ?? 'default');
  const activeSortBy: ItemSortOrder = p.sortBy ?? localSortBy;
  const isAlpha = activeSortBy === 'alpha';

  const handleToggleSort = useCallback(() => {
    setLocalSortBy((prev) => ((p.sortBy ?? prev) === 'alpha' ? 'default' : 'alpha'));
    p.onToggleSort?.();
  }, [p.onToggleSort, p.sortBy]);

  const cols = computeLiveGridColumns(viewport);
  const safeFontScale = Number.isFinite(theme.fontScale) ? Math.max(1, theme.fontScale) : 1;
  const cardHeight = Math.round((layout.isTv ? 116 : layout.isTouch ? 108 : 102) * safeFontScale);
  const rowHeight = cardHeight + layout.gridGap;
  const usableHeight = Math.max(rowHeight * 2, viewport.height - layout.heroTopClearance - 120);
  const visibleRows = Math.max(3, Math.ceil(usableHeight / rowHeight));
  const maxMountedRows = visibleRows + 2;

  const shared = useMemo<LiveGridShared>(
    () => ({
      cols,
      cardHeight,
      rowHeight,
      gap: layout.gridGap,
      padX: layout.padX,
      isTv: layout.isTv,
      isTouch: layout.isTouch,
      liveBadge: i18n.t('ui.liveBadge'),
      upNext: i18n.t('live.upNext'),
      noProgram: i18n.t('live.noProgramInfo'),
      favoriteAdd: i18n.t('live.favoriteAdd'),
      favoriteRemove: i18n.t('live.favoriteRemove'),
      logoBackdropMode,
      cleanChannelTitles,
    }),
    [
      cardHeight,
      cleanChannelTitles,
      cols,
      i18n,
      layout.gridGap,
      layout.isTouch,
      layout.isTv,
      layout.padX,
      logoBackdropMode,
      rowHeight,
    ],
  );

  const focusMemory = useBrowseFocusMemory();
  const focusMemoryRef = useRef(focusMemory);
  focusMemoryRef.current = focusMemory;
  const itemCount = channelSource?.count() ?? 0;
  const rowCount = itemCount > 0 ? Math.ceil(itemCount / cols) : 0;
  const [focusPos, setFocusPos] = useState(() => {
    const saved = focusMemory?.get<{ row: number; col: number }>('live:channels');
    if (!saved || rowCount === 0) return saved ?? { row: 0, col: 0 };
    const row = Math.min(Math.max(0, saved.row), rowCount - 1);
    const maxCol = Math.max(0, Math.min(cols, itemCount - row * cols) - 1);
    return { row, col: Math.min(Math.max(0, saved.col), maxCol) };
  });
  const focusPosRef = useRef(focusPos);
  focusPosRef.current = focusPos;
  const commitFocusPos = useCallback((next: { row: number; col: number }) => {
    focusPosRef.current = next;
    setFocusPos(next);
    focusMemoryRef.current?.set('live:channels', next);
  }, []);

  const [topVisibleRow, setTopVisibleRow] = useState(0);
  const [selectedLetterOverride, setSelectedLetterOverride] = useState<string | null>(null);
  const [focusedLetter, setFocusedLetter] = useState<string | null>(null);
  const [standaloneSortFocused, setStandaloneSortFocused] = useState(false);
  const [fetchedBuckets, setFetchedBuckets] = useState<readonly AlphabetBucket[]>(EMPTY_BUCKETS);
  const alphabetGenRef = useRef(0);

  // Fetch alphabetIndex directly if LiveChannelsGrid is mounted standalone with a catalog (#407).
  useEffect(() => {
    if (p.alphabetBuckets !== undefined) return;
    const gen = ++alphabetGenRef.current;
    if (
      activeSortBy !== 'alpha' ||
      itemCount < LIVE_ALPHABET_RAIL_MIN_ITEMS ||
      !p.catalog?.alphabetIndex
    ) {
      setFetchedBuckets(EMPTY_BUCKETS);
      return;
    }
    void p.catalog
      .alphabetIndex({
        ...(p.sourceId !== undefined ? { sourceId: p.sourceId } : {}),
        kind: 'live',
        ...(p.categoryId !== undefined ? { categoryId: p.categoryId } : {}),
        ...(p.collapseVariants ? { collapseVariants: true } : {}),
      })
      .then((rows) => {
        if (gen !== alphabetGenRef.current) return;
        setFetchedBuckets(rows ?? EMPTY_BUCKETS);
      })
      .catch(() => {
        if (gen !== alphabetGenRef.current) return;
        setFetchedBuckets(EMPTY_BUCKETS);
      });
    return () => {
      alphabetGenRef.current += 1;
    };
  }, [
    activeSortBy,
    itemCount,
    p.alphabetBuckets,
    p.catalog,
    p.categoryId,
    p.collapseVariants,
    p.sourceId,
  ]);

  const effectiveBuckets = p.alphabetBuckets ?? fetchedBuckets;
  const availableBuckets = useMemo(
    () => effectiveBuckets.filter((b) => b.count > 0),
    [effectiveBuckets],
  );
  const showAlphabetRail =
    activeSortBy === 'alpha' &&
    itemCount >= LIVE_ALPHABET_RAIL_MIN_ITEMS &&
    availableBuckets.length > 0;

  useEffect(() => {
    if (!showAlphabetRail) {
      setFocusedLetter(null);
      setSelectedLetterOverride(null);
    }
  }, [showAlphabetRail]);

  const listRef = useRef<InstanceType<typeof VirtualizedList> | null>(null);
  const lastBucketRef = useRef(-1);
  const visibleWindowRef = useRef({ startRow: 0, endRow: visibleRows + 1 });
  const mountedSourceRef = useRef(channelSource);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset scroll & focus only when channelSource switches after mount
  useEffect(() => {
    lastBucketRef.current = -1;
    visibleWindowRef.current = { startRow: 0, endRow: visibleRows + 1 };
    setTopVisibleRow(0);
    setSelectedLetterOverride(null);
    setFocusedLetter(null);
    if (mountedSourceRef.current !== channelSource) {
      mountedSourceRef.current = channelSource;
      commitFocusPos({ row: 0, col: 0 });
    } else if (rowCount > 0) {
      const cur = focusPosRef.current;
      const row = Math.min(Math.max(0, cur.row), rowCount - 1);
      const maxCol = Math.max(0, Math.min(cols, itemCount - row * cols) - 1);
      const col = Math.min(Math.max(0, cur.col), maxCol);
      if (row !== cur.row || col !== cur.col) setFocusPos({ row, col });
    }
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [channelSource, cols, visibleRows]);

  const tvWindowStart =
    rowCount <= maxMountedRows ? 0 : Math.max(0, Math.min(rowCount - maxMountedRows, focusPos.row));
  const tvWindowEnd = Math.min(rowCount - 1, tvWindowStart + maxMountedRows - 1);

  // biome-ignore lint/correctness/useExhaustiveDependencies: sourceVersion re-hydrates Now/Next as pages land
  useEffect(() => {
    if (!channelSource || rowCount === 0) return;
    const startRow = layout.isTv ? tvWindowStart : visibleWindowRef.current.startRow;
    const endRow = layout.isTv ? tvWindowEnd : visibleWindowRef.current.endRow;
    syncChannelWindow(channelSource, startRow, endRow, cols, hydrateNowNext, true);
  }, [
    channelSource,
    cols,
    hydrateNowNext,
    layout.isTv,
    rowCount,
    sourceVersion,
    tvWindowEnd,
    tvWindowStart,
  ]);

  const handleSelectLetter = useCallback(
    (letter: string, offset: number) => {
      if (!channelSource || itemCount <= 0) return;
      const safeOffset = Math.max(
        0,
        Math.min(itemCount - 1, Number.isFinite(offset) ? Math.floor(offset) : 0),
      );
      const targetRow = Math.min(Math.max(0, rowCount - 1), Math.floor(safeOffset / cols));
      const maxCol = Math.max(0, Math.min(cols, itemCount - targetRow * cols) - 1);
      const targetCol = Math.min(maxCol, safeOffset % cols);
      const endRow = Math.max(targetRow, Math.min(rowCount - 1, targetRow + visibleRows + 1));

      visibleWindowRef.current = { startRow: targetRow, endRow };
      lastBucketRef.current = Math.floor(targetRow / SCROLL_QUANTUM);
      setTopVisibleRow(targetRow);
      setSelectedLetterOverride(letter.trim().toUpperCase());
      commitFocusPos({ row: targetRow, col: targetCol });

      syncChannelWindow(channelSource, targetRow, endRow, cols, hydrateNowNext, true);

      if (!layout.isTv) {
        if (typeof listRef.current?.scrollToIndex === 'function') {
          listRef.current.scrollToIndex({ index: targetRow, animated: false });
        } else {
          listRef.current?.scrollToOffset?.({ offset: targetRow * rowHeight, animated: false });
        }
      }
    },
    [
      channelSource,
      cols,
      commitFocusPos,
      hydrateNowNext,
      itemCount,
      layout.isTv,
      rowCount,
      rowHeight,
      visibleRows,
    ],
  );

  const activeOffset = layout.isTv
    ? focusPos.row * cols + focusPos.col
    : (topVisibleRow + 1) * cols - 1;
  const activeLetter = useMemo(
    () => selectedLetterOverride ?? resolveLiveAlphabetLetter(availableBuckets, activeOffset),
    [activeOffset, availableBuckets, selectedLetterOverride],
  );

  const handleTvKey = useCallback(
    (event: KeyEvent): boolean => {
      if (event.key === 'lastChannel' && event.kind === 'press') {
        onJumpPreviousChannel?.();
        return true;
      }

      const isNav = event.kind === 'press' || event.kind === 'repeat';

      if (focusedLetter !== null) {
        if (event.kind === 'press' && (event.key === 'left' || event.key === 'back')) {
          setFocusedLetter(null);
          return true;
        }
        if (event.kind === 'press' && event.key === 'select') {
          const norm = focusedLetter.trim().toUpperCase();
          const bucket =
            availableBuckets.find((b) => b.letter.trim().toUpperCase() === norm) ??
            availableBuckets[0];
          if (bucket) {
            handleSelectLetter(bucket.letter, bucket.offset);
          }
          setFocusedLetter(null);
          return true;
        }
        if (!isNav) return false;
        if (event.key === 'up' || event.key === 'down') {
          const next = stepLiveAlphabetLetter(availableBuckets, focusedLetter, event.key);
          if (next !== null) setFocusedLetter(next);
          return true;
        }
        return event.key === 'right';
      }

      if (standaloneSortFocused) {
        if (event.kind === 'press' && event.key === 'back') {
          setStandaloneSortFocused(false);
          return true;
        }
        if (event.kind === 'press' && event.key === 'select') {
          handleToggleSort();
          return true;
        }
        if (!isNav) return false;
        if (event.key === 'down') {
          setStandaloneSortFocused(false);
          return true;
        }
        return true;
      }

      if (event.key === 'back' && event.kind === 'press') {
        onEdgeTop?.();
        return true;
      }
      if (!channelSource || itemCount === 0) return false;
      const cur = focusPosRef.current;
      if (
        (event.kind === 'long' && event.key === 'select') ||
        (event.kind === 'press' && event.key === 'menu')
      ) {
        if (onOpenContextMenu === undefined) return false;
        const idx = cur.row * cols + cur.col;
        const hit = channelSource.get(idx);
        if (hit) {
          onOpenContextMenu(hit, idx, nowNextByKey.get(hit.key)?.now ?? null);
        } else {
          void channelSource
            .loadItem(idx)
            .then(
              (loaded) =>
                loaded && onOpenContextMenu(loaded, idx, nowNextByKey.get(loaded.key)?.now ?? null),
            );
        }
        return true;
      }
      if (!isNav) return false;
      if (event.key === 'up') {
        if (cur.row === 0) {
          if (onEdgeTop) onEdgeTop();
          else setStandaloneSortFocused(true);
        } else {
          setSelectedLetterOverride(null);
          commitFocusPos({ row: cur.row - 1, col: cur.col });
        }
        return true;
      }
      if (event.key === 'down') {
        const nextRow = Math.min(rowCount - 1, cur.row + 1);
        const maxCol = Math.max(0, Math.min(cols, itemCount - nextRow * cols) - 1);
        setSelectedLetterOverride(null);
        commitFocusPos({ row: nextRow, col: Math.min(cur.col, maxCol) });
        return true;
      }
      if (event.key === 'left') {
        setSelectedLetterOverride(null);
        commitFocusPos({ row: cur.row, col: Math.max(0, cur.col - 1) });
        return true;
      }
      if (event.key === 'right') {
        const maxCol = Math.max(0, Math.min(cols, itemCount - cur.row * cols) - 1);
        if (cur.col < maxCol) {
          setSelectedLetterOverride(null);
          commitFocusPos({ row: cur.row, col: cur.col + 1 });
        } else if (showAlphabetRail) {
          const initial = activeLetter ?? availableBuckets[0]?.letter ?? null;
          if (initial !== null) setFocusedLetter(initial);
        }
        return true;
      }
      if (event.key === 'select' && event.kind === 'press') {
        const idx = cur.row * cols + cur.col;
        const hit = channelSource.get(idx);
        if (hit) onWatchChannel(hit, idx);
        else
          void channelSource.loadItem(idx).then((loaded) => loaded && onWatchChannel(loaded, idx));
        return true;
      }
      return false;
    },
    [
      activeLetter,
      availableBuckets,
      channelSource,
      cols,
      commitFocusPos,
      focusedLetter,
      handleSelectLetter,
      handleToggleSort,
      itemCount,
      nowNextByKey,
      onEdgeTop,
      onJumpPreviousChannel,
      onOpenContextMenu,
      onWatchChannel,
      rowCount,
      showAlphabetRail,
      standaloneSortFocused,
    ],
  );

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!channelSource) return;
      const topRow = Math.floor(Math.max(0, event.nativeEvent.contentOffset.y) / rowHeight);
      setTopVisibleRow(topRow);
      setSelectedLetterOverride(null);
      const bucket = Math.floor(topRow / SCROLL_QUANTUM);
      if (bucket === lastBucketRef.current) return;
      lastBucketRef.current = bucket;
      const endRow = topRow + visibleRows + 1;
      visibleWindowRef.current = { startRow: topRow, endRow };
      syncChannelWindow(channelSource, topRow, endRow, cols, hydrateNowNext);
    },
    [channelSource, cols, hydrateNowNext, rowHeight, visibleRows],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh clock snapshot alongside schedule updates
  const nowMs = useMemo(() => (now ? now() : Date.now()), [now, nowNextVersion, sourceVersion]);
  const getItemCount = useCallback(() => rowCount, [rowCount]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sourceVersion refreshes row items when pages load
  const getRowData = useCallback(
    (_d: unknown, rowIndex: number): ChannelRowData => ({
      rowIndex,
      items: channelSource ? sliceChannelRow(channelSource, rowIndex, cols) : [],
    }),
    [channelSource, cols, sourceVersion],
  );
  const keyExtractor = useCallback(
    (row: unknown, idx: number) =>
      `live-row-${(row as ChannelRowData | undefined)?.rowIndex ?? idx}`,
    [],
  );
  const getItemLayout = useCallback(
    (_d: unknown, index: number) => ({ length: rowHeight, offset: rowHeight * index, index }),
    [rowHeight],
  );
  const renderRow = useCallback(
    ({ item }: { item: unknown }) => {
      const row = item as ChannelRowData;
      return (
        <ChannelGridRow
          rowIndex={row.rowIndex}
          items={row.items}
          shared={shared}
          nowNextByKey={nowNextByKey}
          nowMs={nowMs}
          activeChannelKey={activeChannelKey}
          {...(favoriteKeys !== undefined ? { favoriteKeys } : {})}
          {...(sourceBadges !== undefined ? { sourceBadges } : {})}
          focusedCol={null}
          onWatchChannel={onWatchChannel}
          {...(onToggleFavorite !== undefined ? { onToggleFavorite } : {})}
          {...(onOpenContextMenu !== undefined ? { onOpenContextMenu } : {})}
        />
      );
    },
    [
      activeChannelKey,
      favoriteKeys,
      nowMs,
      nowNextByKey,
      onOpenContextMenu,
      onToggleFavorite,
      onWatchChannel,
      shared,
      sourceBadges,
    ],
  );
  const extraData = useMemo(
    () => ({
      sourceVersion,
      nowNextVersion,
      activeChannelKey,
      favoriteKeys,
      sourceBadges,
      logoBackdropMode,
      cleanChannelTitles,
    }),
    [
      activeChannelKey,
      cleanChannelTitles,
      favoriteKeys,
      logoBackdropMode,
      nowNextVersion,
      sourceBadges,
      sourceVersion,
    ],
  );

  // Memoized TV row slices independent of `focusPos.col` so Left/Right preserves React.memo on sibling rows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sourceVersion refreshes TV row slices as pages arrive
  const tvWindowRows = useMemo<readonly ChannelRowData[]>(() => {
    if (!layout.isTv || !channelSource || rowCount === 0) return [];
    const out: ChannelRowData[] = [];
    for (let r = tvWindowStart; r <= tvWindowEnd; r++) {
      out.push({ rowIndex: r, items: sliceChannelRow(channelSource, r, cols) });
    }
    return out;
  }, [channelSource, cols, layout.isTv, rowCount, sourceVersion, tvWindowEnd, tvWindowStart]);

  const effectiveSortFocused = Boolean(p.sortFocused) || standaloneSortFocused;

  return (
    <View testID="live-channels-grid" style={styles.flex1}>
      {layout.isTv && isActiveScope ? <TvChannelsKeyBridge onEvent={handleTvKey} /> : null}

      <LiveGridSortToolbar
        isAlpha={isAlpha}
        isTv={layout.isTv}
        isTouch={layout.isTouch}
        padX={layout.padX}
        focused={effectiveSortFocused}
        onToggle={handleToggleSort}
      />

      <View style={styles.bodyWrap}>
        {layout.isTv ? (
          <View testID="live-channels-tv-viewport" style={styles.tvViewport}>
            {tvWindowRows.map((row) => {
              const isFocusedRow =
                isActiveScope &&
                focusedLetter === null &&
                !standaloneSortFocused &&
                focusPos.row === row.rowIndex;
              return (
                <View key={row.rowIndex} style={isFocusedRow ? styles.focusedRowLayer : undefined}>
                  <ChannelGridRow
                    rowIndex={row.rowIndex}
                    items={row.items}
                    shared={shared}
                    nowNextByKey={nowNextByKey}
                    nowMs={nowMs}
                    activeChannelKey={activeChannelKey}
                    {...(favoriteKeys !== undefined ? { favoriteKeys } : {})}
                    {...(sourceBadges !== undefined ? { sourceBadges } : {})}
                    focusedCol={isFocusedRow ? focusPos.col : null}
                    onWatchChannel={onWatchChannel}
                    {...(onToggleFavorite !== undefined ? { onToggleFavorite } : {})}
                    {...(onOpenContextMenu !== undefined ? { onOpenContextMenu } : {})}
                  />
                </View>
              );
            })}
            <View pointerEvents="none" style={styles.edgeFadeLayer}>
              <TvScrollEdgeFade
                testID="live-channels-edge-fade"
                showTop={tvWindowStart > 0}
                showBottom={tvWindowEnd < rowCount - 1}
              />
            </View>
          </View>
        ) : (
          <VirtualizedList
            ref={listRef}
            testID="live-channels-list"
            style={styles.flex1}
            data={channelSource}
            extraData={extraData}
            getItemCount={getItemCount}
            getItem={getRowData}
            keyExtractor={keyExtractor}
            getItemLayout={getItemLayout}
            renderItem={renderRow}
            windowSize={5}
            initialNumToRender={visibleRows + 2}
            maxToRenderPerBatch={4}
            onScroll={handleScroll}
            scrollEventThrottle={32}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingTop: 6, paddingBottom: theme.spacing.xl }}
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
              testID="live-alphabet-rail"
              buckets={availableBuckets}
              activeLetter={activeLetter}
              focusedLetter={layout.isTv && isActiveScope ? focusedLetter : null}
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
  flex1: { flex: 1 },
  bodyWrap: { flex: 1, position: 'relative' },
  tvViewport: { flex: 1, overflow: 'hidden', paddingTop: 6, position: 'relative' },
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
