import type { ItemRow, NowNextEntry } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import {
  TvFocusAnchor,
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
import type { CatalogLayoutMetrics, PagedListSource } from '../shared';
import { ChannelGridRow, type LiveGridShared } from './LiveChannelTile';

const SCROLL_QUANTUM = 2;

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
): void {
  source.prefetch(Math.max(0, startRow - 1) * cols, (endRow + 2) * cols);
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
  readonly onEvent: (e: KeyEvent) => void;
}): ReactElement {
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="live-channels-tv-focus-anchor" />;
}

/** Props of {@link LiveChannelsGrid}. */
export interface LiveChannelsGridProps {
  readonly channelSource: PagedListSource<ItemRow> | null;
  readonly sourceVersion: number;
  readonly nowNextByKey: ReadonlyMap<string, NowNextEntry>;
  readonly nowNextVersion: number;
  readonly activeChannelKey: string | null;
  readonly layout: CatalogLayoutMetrics;
  readonly hydrateNowNext: (channelKeys: readonly string[]) => void;
  readonly onWatchChannel: (channel: ItemRow, index: number) => void;
  readonly onEdgeTop?: () => void;
  readonly isActiveScope?: boolean;
  /** Injectable epoch clock in milliseconds for live progress bars (defaults to `() => Date.now()`). */
  readonly now?: () => number;
}

/**
 * O(1)-memory row-virtualized Cinema Quietude Live Channels Grid (`#13`) with live Now/Next
 * schedule progress, deterministic `VirtualizedList` on pointer/touch, and bounded 2D D-pad TV window.
 */
export function LiveChannelsGrid(p: LiveChannelsGridProps): ReactElement {
  const { channelSource, sourceVersion, nowNextByKey, nowNextVersion, activeChannelKey, layout } =
    p;
  const { hydrateNowNext, onWatchChannel, onEdgeTop, isActiveScope = false, now } = p;
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();

  const cols = computeLiveGridColumns(viewport);
  const cardHeight = layout.isTv ? 116 : layout.isTouch ? 108 : 102;
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
    }),
    [cardHeight, cols, i18n, layout.gridGap, layout.isTouch, layout.isTv, layout.padX, rowHeight],
  );

  const itemCount = channelSource?.count() ?? 0;
  const rowCount = itemCount > 0 ? Math.ceil(itemCount / cols) : 0;
  const [focusPos, setFocusPos] = useState({ row: 0, col: 0 });
  const focusPosRef = useRef(focusPos);
  focusPosRef.current = focusPos;
  const listRef = useRef<InstanceType<typeof VirtualizedList> | null>(null);
  const lastBucketRef = useRef(-1);
  const visibleWindowRef = useRef({ startRow: 0, endRow: visibleRows + 1 });

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset scroll & focus on channelSource change
  useEffect(() => {
    lastBucketRef.current = -1;
    visibleWindowRef.current = { startRow: 0, endRow: visibleRows + 1 };
    setFocusPos({ row: 0, col: 0 });
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [channelSource, cols, visibleRows]);

  const tvWindowStart =
    rowCount <= maxMountedRows
      ? 0
      : Math.max(0, Math.min(rowCount - maxMountedRows, focusPos.row - 1));
  const tvWindowEnd = Math.min(rowCount - 1, tvWindowStart + maxMountedRows - 1);

  // biome-ignore lint/correctness/useExhaustiveDependencies: sourceVersion re-hydrates Now/Next as pages land
  useEffect(() => {
    if (!channelSource || rowCount === 0) return;
    const startRow = layout.isTv ? tvWindowStart : visibleWindowRef.current.startRow;
    const endRow = layout.isTv ? tvWindowEnd : visibleWindowRef.current.endRow;
    syncChannelWindow(channelSource, startRow, endRow, cols, hydrateNowNext);
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

  const handleTvKey = useCallback(
    (event: KeyEvent) => {
      if ((event.kind !== 'press' && event.kind !== 'repeat') || !channelSource || itemCount === 0)
        return;
      const cur = focusPosRef.current;
      if (event.key === 'up') {
        if (cur.row === 0) onEdgeTop?.();
        else setFocusPos({ row: cur.row - 1, col: cur.col });
      } else if (event.key === 'down') {
        const nextRow = Math.min(rowCount - 1, cur.row + 1);
        const maxCol = Math.max(0, Math.min(cols, itemCount - nextRow * cols) - 1);
        setFocusPos({ row: nextRow, col: Math.min(cur.col, maxCol) });
      } else if (event.key === 'left') {
        setFocusPos({ row: cur.row, col: Math.max(0, cur.col - 1) });
      } else if (event.key === 'right') {
        const maxCol = Math.max(0, Math.min(cols, itemCount - cur.row * cols) - 1);
        setFocusPos({ row: cur.row, col: Math.min(maxCol, cur.col + 1) });
      } else if (event.key === 'back' && event.kind === 'press') {
        onEdgeTop?.();
      } else if (event.key === 'select' && event.kind === 'press') {
        const idx = cur.row * cols + cur.col;
        const hit = channelSource.get(idx);
        if (hit) onWatchChannel(hit, idx);
        else
          void channelSource.loadItem(idx).then((loaded) => loaded && onWatchChannel(loaded, idx));
      }
    },
    [channelSource, cols, itemCount, onEdgeTop, onWatchChannel, rowCount],
  );

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!channelSource) return;
      const topRow = Math.floor(Math.max(0, event.nativeEvent.contentOffset.y) / rowHeight);
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
          focusedCol={null}
          onWatchChannel={onWatchChannel}
        />
      );
    },
    [activeChannelKey, nowMs, nowNextByKey, onWatchChannel, shared],
  );
  const extraData = useMemo(
    () => ({ sourceVersion, nowNextVersion, activeChannelKey }),
    [activeChannelKey, nowNextVersion, sourceVersion],
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

  return (
    <View testID="live-channels-grid" style={styles.flex1}>
      {layout.isTv && isActiveScope ? <TvChannelsKeyBridge onEvent={handleTvKey} /> : null}
      {layout.isTv ? (
        <View testID="live-channels-tv-viewport" style={styles.tvViewport}>
          {tvWindowRows.map((row) => (
            <ChannelGridRow
              key={row.rowIndex}
              rowIndex={row.rowIndex}
              items={row.items}
              shared={shared}
              nowNextByKey={nowNextByKey}
              nowMs={nowMs}
              activeChannelKey={activeChannelKey}
              focusedCol={isActiveScope && focusPos.row === row.rowIndex ? focusPos.col : null}
              onWatchChannel={onWatchChannel}
            />
          ))}
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
    </View>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  tvViewport: { flex: 1, overflow: 'hidden', paddingTop: 6 },
});
