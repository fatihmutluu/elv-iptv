import type { CatalogService, ItemRow } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import { TvFocusAnchor, useKeyInterpreter, useTheme, useViewport } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  View,
  VirtualizedList,
} from 'react-native';
import type { DisplayCategory, PagedListSource } from '../shared';
import { EpgChannelRow } from './EpgChannelRow';
import { EpgPreviewHeader, EpgTimeRuler } from './EpgPreviewHeader';
import { buildEpgRulerTicks, computeNowLineRatio, EPG_VISIBLE_SPAN_MS } from './live-model';
import { EMPTY_PROGRAMMES, useEpgTimeCursor, useEpgWindowData } from './useEpgWindowData';

const LIVE_CLOCK_TICK_MS = 30_000;
const SCROLL_QUANTUM = 3;

function EpgTvKeyBridge({
  onEvent,
}: {
  readonly onEvent: (event: KeyEvent) => void;
}): ReactElement {
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="epg-tv-focus-anchor" />;
}

/** Props of {@link EpgGridView}. */
export interface EpgGridViewProps {
  readonly catalog: CatalogService;
  readonly category: DisplayCategory;
  readonly channelSource: PagedListSource<ItemRow>;
  readonly sourceVersion: number;
  readonly refreshToken: number;
  readonly nowMs?: number;
  readonly onWatchChannel: (channel: ItemRow, index: number) => void;
  readonly onGuideRefreshed?: () => void;
  readonly onEdgeTop?: () => void;
  readonly isActiveScope?: boolean;
}

/**
 * Cinema Quietude 1,000-Channel × 7-Day Virtualized XMLTV EPG Grid (`#6`, `#56`, `#250`).
 * Combines a focused-channel preview header, sticky 30m time ruler with live `Now` accent line,
 * O(1) windowed TV viewport / `VirtualizedList` channel matrix, stale-while-revalidate bounded
 * LRU TTL programme caching, and 10-ft TV 2D D-pad time-cursor & toolbar navigation.
 */
export function EpgGridView({
  catalog,
  category,
  channelSource,
  sourceVersion,
  refreshToken,
  nowMs,
  onWatchChannel,
  onGuideRefreshed,
  onEdgeTop,
  isActiveScope = true,
}: EpgGridViewProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();

  const isTv = viewport.inputModality === 'tv';
  const isPortrait = viewport.orientation === 'portrait';
  const rowHeight = isTv ? 68 : 60;
  const channelColWidth = isPortrait ? 116 : isTv ? 200 : 176;
  const visibleRows = Math.max(
    4,
    Math.min(10, Math.floor(Math.max(240, viewport.height - (isPortrait ? 320 : 280)) / rowHeight)),
  );
  const maxMountedRows = visibleRows + 2;

  const [clockMs, setClockMs] = useState(() => nowMs ?? Date.now());
  useEffect(() => {
    if (nowMs !== undefined) return;
    const timer = setInterval(() => setClockMs(Date.now()), LIVE_CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [nowMs]);
  const activeNowMs = nowMs ?? clockMs;

  const [localPageVersion, setLocalPageVersion] = useState(0);
  useEffect(() => channelSource.onChange(() => setLocalPageVersion((v) => v + 1)), [channelSource]);
  const effectiveSourceVersion = sourceVersion + localPageVersion;

  const epgData = useEpgWindowData({
    catalog,
    categoryId: category.row.id,
    refreshToken,
    nowMs: activeNowMs,
    onGuideRefreshed,
  });

  const channelCount = channelSource.count();
  const refreshSourceIdRef = useRef(category.row.sourceId);
  const handleRefreshGuide = useCallback(() => {
    void epgData.refreshGuide(refreshSourceIdRef.current);
  }, [epgData.refreshGuide]);

  const cursor = useEpgTimeCursor({
    categoryId: category.row.id,
    channelSource,
    channelCount,
    maxMountedRows,
    activeNowMs,
    epgData,
    onWatchChannel,
    onRefreshGuide: handleRefreshGuide,
    onEdgeTop,
  });
  refreshSourceIdRef.current = cursor.focusedChannel?.sourceId ?? category.row.sourceId;

  const listRef = useRef<InstanceType<typeof VirtualizedList> | null>(null);
  const lastScrollBucketRef = useRef(-1);
  const visibleRangeRef = useRef({ start: 0, end: maxMountedRows - 1 });
  const prevCategoryIdRef = useRef(category.row.id);

  useEffect(() => {
    const categoryChanged = prevCategoryIdRef.current !== category.row.id;
    prevCategoryIdRef.current = category.row.id;
    lastScrollBucketRef.current = -1;
    visibleRangeRef.current = { start: 0, end: maxMountedRows - 1 };
    if (categoryChanged) {
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
    }
  }, [category.row.id, maxMountedRows]);

  const tvWindowStart =
    channelCount <= maxMountedRows
      ? 0
      : Math.max(0, Math.min(channelCount - maxMountedRows, cursor.focusedRow - 1));
  const tvWindowEnd =
    channelCount <= 0 ? -1 : Math.min(channelCount - 1, tvWindowStart + maxMountedRows - 1);

  const hydrateRange = useCallback(
    (startRow: number, endRow: number) => {
      if (channelCount <= 0) return;
      const from = Math.max(0, startRow);
      const to = Math.min(channelCount - 1, endRow);
      if (to < from) return;
      channelSource.prefetch(from, to + 1);
      const keys: string[] = [];
      for (let i = from; i <= to; i++) {
        const ch = channelSource.get(i);
        if (ch) keys.push(ch.key);
      }
      if (keys.length > 0) epgData.hydrateChannels(keys);
    },
    [channelCount, channelSource, epgData.hydrateChannels],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeNowMs triggers background stale-while-revalidate refresh on 30s ticks; effectiveSourceVersion and epgData.version re-hydrate as pages land or guide refreshes
  useEffect(() => {
    if (isTv) {
      hydrateRange(tvWindowStart, tvWindowEnd);
    } else {
      const { start, end } = visibleRangeRef.current;
      hydrateRange(start, end);
    }
  }, [
    activeNowMs,
    effectiveSourceVersion,
    epgData.version,
    epgData.windowStartMs,
    hydrateRange,
    isTv,
    tvWindowEnd,
    tvWindowStart,
  ]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const topRow = Math.floor(Math.max(0, event.nativeEvent.contentOffset.y) / rowHeight);
      const bucket = Math.floor(topRow / SCROLL_QUANTUM);
      if (bucket === lastScrollBucketRef.current) return;
      lastScrollBucketRef.current = bucket;
      const endRow = topRow + maxMountedRows - 1;
      visibleRangeRef.current = { start: topRow, end: endRow };
      hydrateRange(Math.max(0, topRow - 2), endRow + 2);
    },
    [hydrateRange, maxMountedRows, rowHeight],
  );

  const rulerTicks = useMemo(
    () => buildEpgRulerTicks(epgData.windowStartMs, EPG_VISIBLE_SPAN_MS),
    [epgData.windowStartMs],
  );
  const nowLineRatio = useMemo(
    () => computeNowLineRatio(epgData.windowStartMs, EPG_VISIBLE_SPAN_MS, activeNowMs),
    [activeNowMs, epgData.windowStartMs],
  );
  const tvRowIndices = useMemo(() => {
    if (!isTv || tvWindowEnd < tvWindowStart) return [];
    const out: number[] = [];
    for (let r = tvWindowStart; r <= tvWindowEnd; r++) out.push(r);
    return out;
  }, [isTv, tvWindowEnd, tvWindowStart]);

  const getItemCount = useCallback(() => channelCount, [channelCount]);
  const getItem = useCallback(
    (_data: unknown, index: number) => ({ index, channel: channelSource.get(index) }),
    [channelSource],
  );
  const keyExtractor = useCallback(
    (item: unknown, index: number) => `epg-vrow-${(item as { index?: number })?.index ?? index}`,
    [],
  );
  const getItemLayout = useCallback(
    (_data: unknown, index: number) => ({ length: rowHeight, offset: rowHeight * index, index }),
    [rowHeight],
  );
  const renderRow = useCallback(
    ({ item }: { item: unknown }) => {
      const entry = item as { index: number; channel: ItemRow | undefined };
      return (
        <EpgChannelRow
          rowIndex={entry.index}
          channel={entry.channel}
          programmes={entry.channel ? epgData.getProgrammes(entry.channel.key) : EMPTY_PROGRAMMES}
          windowStartMs={epgData.windowStartMs}
          spanMs={EPG_VISIBLE_SPAN_MS}
          nowMs={activeNowMs}
          channelColWidth={channelColWidth}
          rowHeight={rowHeight}
          isTv={false}
          isFocusedRow={entry.index === cursor.focusedRow}
          focusedSlotIndex={entry.index === cursor.focusedRow ? cursor.focusedSlotIndex : 0}
          onSelectCell={cursor.handleSelectCell}
        />
      );
    },
    [
      activeNowMs,
      channelColWidth,
      cursor.focusedRow,
      cursor.focusedSlotIndex,
      cursor.handleSelectCell,
      epgData.getProgrammes,
      epgData.windowStartMs,
      rowHeight,
    ],
  );
  const extraData = useMemo(
    () => ({
      effectiveSourceVersion,
      epgVersion: epgData.version,
      windowStartMs: epgData.windowStartMs,
      focusedRow: cursor.focusedRow,
      focusedSlotIndex: cursor.focusedSlotIndex,
    }),
    [
      cursor.focusedRow,
      cursor.focusedSlotIndex,
      effectiveSourceVersion,
      epgData.version,
      epgData.windowStartMs,
    ],
  );

  const tvToolbarAction = isTv && isActiveScope ? cursor.focusedToolbarAction : null;
  const previewFocusedAction =
    tvToolbarAction === 'watch' || tvToolbarAction === 'refresh' ? tvToolbarAction : null;
  const rulerFocusedButton =
    tvToolbarAction === 'earlier' || tvToolbarAction === 'jump' || tvToolbarAction === 'later'
      ? tvToolbarAction
      : null;
  const isTvGridFocused = isTv && isActiveScope && cursor.focusedArea === 'grid';

  return (
    <View testID="live-epg-view" style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}>
      {isTv && isActiveScope ? <EpgTvKeyBridge onEvent={cursor.handleTvKey} /> : null}

      <EpgPreviewHeader
        channel={cursor.focusedChannel}
        channelIndex={cursor.focusedRow}
        programme={cursor.focusedProgramme}
        nowMs={activeNowMs}
        refreshingGuide={epgData.refreshingGuide}
        isTv={isTv}
        isPortrait={isPortrait}
        focusedAction={previewFocusedAction}
        onWatchChannel={onWatchChannel}
        onRefreshGuide={handleRefreshGuide}
      />

      <EpgTimeRuler
        categoryLabel={category.label}
        rulerTicks={rulerTicks}
        channelColWidth={channelColWidth}
        isTv={isTv}
        isPortrait={isPortrait}
        jumpHighlighted={!epgData.isAtLiveWindow}
        focusedButton={rulerFocusedButton}
        onPanEarlier={cursor.handlePanEarlier}
        onJumpToLive={cursor.handleJumpToLive}
        onPanLater={cursor.handlePanLater}
      />

      <View testID="epg-matrix" style={styles.matrixWrap}>
        {isTv ? (
          <View testID="epg-tv-viewport" style={styles.tvViewport}>
            {tvRowIndices.map((rowIdx) => {
              const ch = channelSource.get(rowIdx);
              return (
                <EpgChannelRow
                  key={rowIdx}
                  rowIndex={rowIdx}
                  channel={ch}
                  programmes={ch ? epgData.getProgrammes(ch.key) : EMPTY_PROGRAMMES}
                  windowStartMs={epgData.windowStartMs}
                  spanMs={EPG_VISIBLE_SPAN_MS}
                  nowMs={activeNowMs}
                  channelColWidth={channelColWidth}
                  rowHeight={rowHeight}
                  isTv
                  isFocusedRow={isTvGridFocused && rowIdx === cursor.focusedRow}
                  focusedSlotIndex={
                    isTvGridFocused && rowIdx === cursor.focusedRow ? cursor.focusedSlotIndex : 0
                  }
                  onSelectCell={cursor.handleSelectCell}
                />
              );
            })}
          </View>
        ) : (
          <VirtualizedList
            ref={listRef}
            testID="epg-list"
            style={styles.listFlex}
            data={channelSource}
            extraData={extraData}
            getItemCount={getItemCount}
            getItem={getItem}
            keyExtractor={keyExtractor}
            getItemLayout={getItemLayout}
            renderItem={renderRow}
            windowSize={5}
            initialNumToRender={maxMountedRows}
            maxToRenderPerBatch={4}
            onScroll={handleScroll}
            scrollEventThrottle={32}
            showsVerticalScrollIndicator={false}
          />
        )}

        {nowLineRatio !== null ? (
          <View pointerEvents="none" style={[styles.nowOverlay, { left: channelColWidth }]}>
            <View
              testID="epg-now-line"
              style={[
                styles.nowLine,
                { left: `${nowLineRatio * 100}%`, backgroundColor: theme.colors.accent },
              ]}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  matrixWrap: { flex: 1, position: 'relative' },
  tvViewport: { flex: 1, overflow: 'hidden' },
  listFlex: { flex: 1 },
  nowOverlay: { position: 'absolute', top: 0, bottom: 0, right: 0 },
  nowLine: { position: 'absolute', top: 0, bottom: 0, width: 2 },
});
