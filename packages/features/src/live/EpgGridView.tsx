import type { CatalogService, ItemRow, ProgrammeRow } from '@elv/data';
import type { EpgRowDensity, EpgTimeSpanHoursPref, LogoBackdropModePref } from '@elv/domain';
import {
  TvFocusAnchor,
  TvScrollEdgeFade,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useViewport,
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
  type DisplayCategory,
  type PagedListSource,
  useActiveEffect,
  useRouteActive,
} from '../shared';
import { EpgChannelRow } from './EpgChannelRow';
import { EpgDateTabStrip, EpgPreviewHeader, EpgTimeRuler } from './EpgPreviewHeader';
import { EpgProgrammeDetailModal } from './EpgProgrammeDetailModal';
import { buildEpgDateTabs, type EpgDateTab, localDayKey } from './epg-date-tabs';
import { LiveContextMenu } from './LiveContextMenu';
import {
  buildEpgRulerTicks,
  computeNowLineRatio,
  EPG_VISIBLE_SPAN_MS,
  resolveEpgRowHeight,
} from './live-model';
import type { SourceBadgeInfo } from './source-badge';
import { EMPTY_PROGRAMMES, useEpgTimeCursor, useEpgWindowData } from './useEpgWindowData';

const LIVE_CLOCK_TICK_MS = 30_000;
const SCROLL_QUANTUM = 3;

function EpgTvKeyBridge({
  onEvent,
}: {
  readonly onEvent: Parameters<typeof useKeyInterpreter>[0];
}): ReactElement {
  const routeActive = useRouteActive();
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="epg-tv-focus-anchor" hasTVPreferredFocus={routeActive} />;
}

/** Props of {@link EpgGridView}. */
export interface EpgGridViewProps {
  readonly catalog: CatalogService;
  readonly category: DisplayCategory;
  readonly channelSource: PagedListSource<ItemRow>;
  readonly sourceVersion: number;
  readonly refreshToken: number;
  readonly nowMs?: number;
  readonly favoriteKeys?: ReadonlySet<string>;
  readonly onWatchChannel: (channel: ItemRow, index: number) => void;
  readonly onToggleFavorite?: (channel: ItemRow) => void;
  readonly onJumpPreviousChannel?: () => void;
  readonly onHideChannel?: (channel: ItemRow) => void;
  readonly onGuideRefreshed?: () => void;
  readonly onEdgeTop?: () => void;
  readonly onFocusSidebar?: () => void;
  readonly isActiveScope?: boolean;
  readonly activeChannelKey?: string | null;
  readonly epgTimeSpanHours?: EpgTimeSpanHoursPref;
  readonly epgRowDensity?: EpgRowDensity;
  readonly epgGenreTints?: boolean;
  readonly epgShowClock?: boolean;
  readonly logoBackdropMode?: LogoBackdropModePref;
  readonly sourceBadges?: ReadonlyMap<string, SourceBadgeInfo>;
  readonly cleanChannelTitles?: boolean;
  /** Optional observer called when focused cursor position commits (used by EPG proof gate `#6`). */
  readonly onCursorCommit?: (cursor: {
    readonly focusedRow: number;
    readonly focusedSlotIndex: number;
    readonly windowStartMs: number;
    readonly focusedChannelKey: string | null;
  }) => void;
}

/**
 * Cinema Quietude 1,000-Channel × 7-Day Virtualized XMLTV EPG Grid (`#6`, `#56`, `#250`).
 * Combines a focused-channel preview header, sticky 30m time ruler with live `Now` accent line,
 * O(1) windowed TV viewport / `VirtualizedList` channel matrix, stale-while-revalidate bounded
 * LRU TTL programme caching, and 10-ft TV 2D D-pad time-cursor & toolbar navigation.
 */
export function EpgGridView(p: EpgGridViewProps): ReactElement {
  const { catalog, category, channelSource, sourceVersion, refreshToken, nowMs, favoriteKeys } = p;
  const {
    onWatchChannel,
    onToggleFavorite,
    onJumpPreviousChannel,
    onHideChannel,
    onGuideRefreshed,
    onEdgeTop,
    onFocusSidebar,
    isActiveScope = true,
    activeChannelKey = null,
    onCursorCommit,
  } = p;
  const {
    epgTimeSpanHours,
    epgRowDensity = 'comfortable',
    epgGenreTints = true,
    epgShowClock = true,
    logoBackdropMode = 'plate',
    sourceBadges,
    cleanChannelTitles = false,
  } = p;
  const visibleSpanMs =
    epgTimeSpanHours !== undefined ? epgTimeSpanHours * 3_600_000 : EPG_VISIBLE_SPAN_MS;
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();

  const isTv = viewport.inputModality === 'tv';
  const isPortrait = viewport.orientation === 'portrait';
  const rowHeight = resolveEpgRowHeight(epgRowDensity, isTv, theme.fontScale);
  const channelColWidth = isPortrait ? 116 : isTv ? 200 : 176;
  const visibleRows = Math.max(
    4,
    Math.min(10, Math.floor(Math.max(240, viewport.height - (isPortrait ? 320 : 280)) / rowHeight)),
  );
  const maxMountedRows = visibleRows + 2;

  const [clockMs, setClockMs] = useState(() => nowMs ?? Date.now());
  useActiveEffect(() => {
    if (nowMs !== undefined) return;
    setClockMs(Date.now());
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
    spanMs: visibleSpanMs,
    onGuideRefreshed,
  });

  const channelCount = channelSource.count();
  const refreshSourceIdRef = useRef(category.row.sourceId);
  const handleRefreshGuide = useCallback(
    () => void epgData.refreshGuide(refreshSourceIdRef.current),
    [epgData.refreshGuide],
  );

  const [detailModal, setDetailModal] = useState<{
    readonly channel: ItemRow;
    readonly index: number;
    readonly programme: ProgrammeRow;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    readonly channel: ItemRow;
    readonly index: number;
    readonly programme: ProgrammeRow | null;
  } | null>(null);

  const dateTabs = useMemo(() => buildEpgDateTabs(activeNowMs, i18n), [activeNowMs, i18n]);
  const activeDayKey = useMemo(() => localDayKey(epgData.windowStartMs), [epgData.windowStartMs]);
  const dateTabsRef = useRef(dateTabs);
  dateTabsRef.current = dateTabs;
  const handleJumpToDayRef = useRef<(dayStartMs: number) => void>(() => undefined);

  const handleSelectDateTabIndex = useCallback((offsetIdx: number) => {
    const tab = dateTabsRef.current[offsetIdx];
    if (tab) handleJumpToDayRef.current(tab.dayStartMs);
  }, []);

  const handleOpenProgrammeDetail = useCallback(
    (channel: ItemRow, index: number, programme: ProgrammeRow) => {
      setContextMenu(null);
      setDetailModal({ channel, index, programme });
    },
    [],
  );
  const handleOpenContextMenu = useCallback(
    (channel: ItemRow, index: number, programme: ProgrammeRow | null) => {
      setDetailModal(null);
      setContextMenu({ channel, index, programme });
    },
    [],
  );

  const cursor = useEpgTimeCursor({
    categoryId: category.row.id,
    channelSource,
    channelCount,
    maxMountedRows,
    activeNowMs,
    activeChannelKey,
    sourceVersion: effectiveSourceVersion,
    spanMs: visibleSpanMs,
    epgData,
    dateTabCount: dateTabs.length,
    onSelectDateTab: handleSelectDateTabIndex,
    onWatchChannel,
    onOpenProgrammeDetail: handleOpenProgrammeDetail,
    onOpenContextMenu: handleOpenContextMenu,
    ...(onJumpPreviousChannel !== undefined ? { onJumpPreviousChannel } : {}),
    ...(onToggleFavorite !== undefined ? { onToggleFavorite } : {}),
    onRefreshGuide: handleRefreshGuide,
    onEdgeTop,
    ...(onFocusSidebar !== undefined ? { onFocusSidebar } : {}),
  });
  handleJumpToDayRef.current = cursor.handleJumpToDay;
  refreshSourceIdRef.current = cursor.focusedChannel?.sourceId ?? category.row.sourceId;

  const handleSelectDateTab = useCallback(
    (tab: EpgDateTab) => {
      cursor.handleJumpToDay(tab.dayStartMs);
    },
    [cursor.handleJumpToDay],
  );

  const listRef = useRef<InstanceType<typeof VirtualizedList> | null>(null);
  const lastScrollBucketRef = useRef(-1);
  const visibleRangeRef = useRef({ start: 0, end: maxMountedRows - 1 });
  const prevCategoryIdRef = useRef(category.row.id);
  const lastAutoScrolledRowRef = useRef<number | null>(null);

  useEffect(() => {
    const categoryChanged = prevCategoryIdRef.current !== category.row.id;
    prevCategoryIdRef.current = category.row.id;
    lastScrollBucketRef.current = -1;
    visibleRangeRef.current = { start: 0, end: maxMountedRows - 1 };
    if (categoryChanged) {
      lastAutoScrolledRowRef.current = null;
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
    }
  }, [category.row.id, maxMountedRows]);

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

  useEffect(() => {
    const targetRow = cursor.autoFocusedRow;
    if (targetRow === null || lastAutoScrolledRowRef.current === targetRow) return;
    lastAutoScrolledRowRef.current = targetRow;
    if (!isTv) {
      const topRow = Math.max(0, targetRow - Math.floor(visibleRows / 2));
      const endRow = Math.min(Math.max(0, channelCount - 1), topRow + maxMountedRows - 1);
      visibleRangeRef.current = { start: topRow, end: endRow };
      listRef.current?.scrollToOffset({ offset: topRow * rowHeight, animated: false });
      hydrateRange(topRow, endRow);
    }
  }, [
    channelCount,
    cursor.autoFocusedRow,
    hydrateRange,
    isTv,
    maxMountedRows,
    rowHeight,
    visibleRows,
  ]);

  useEffect(() => {
    onCursorCommit?.({
      focusedRow: cursor.focusedRow,
      focusedSlotIndex: cursor.focusedSlotIndex,
      windowStartMs: epgData.windowStartMs,
      focusedChannelKey: cursor.focusedChannel?.key ?? null,
    });
  }, [
    cursor.focusedChannel?.key,
    cursor.focusedRow,
    cursor.focusedSlotIndex,
    epgData.windowStartMs,
    onCursorCommit,
  ]);

  const tvWindowStart =
    channelCount <= maxMountedRows
      ? 0
      : Math.max(0, Math.min(channelCount - maxMountedRows, cursor.focusedRow - 1));
  const tvWindowEnd =
    channelCount <= 0 ? -1 : Math.min(channelCount - 1, tvWindowStart + maxMountedRows - 1);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeNowMs triggers background stale-while-revalidate refresh on 30s ticks; effectiveSourceVersion and epgData.version re-hydrate as pages land or guide refreshes
  useEffect(() => {
    if (isTv) hydrateRange(tvWindowStart, tvWindowEnd);
    else hydrateRange(visibleRangeRef.current.start, visibleRangeRef.current.end);
  }, [
    activeNowMs,
    effectiveSourceVersion,
    epgData.version,
    epgData.windowStartMs,
    hydrateRange,
    isTv,
    tvWindowEnd,
    tvWindowStart,
    visibleSpanMs,
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
    () => buildEpgRulerTicks(epgData.windowStartMs, visibleSpanMs),
    [epgData.windowStartMs, visibleSpanMs],
  );
  const nowLineRatio = useMemo(
    () => computeNowLineRatio(epgData.windowStartMs, visibleSpanMs, activeNowMs),
    [activeNowMs, epgData.windowStartMs, visibleSpanMs],
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
          spanMs={visibleSpanMs}
          nowMs={activeNowMs}
          channelColWidth={channelColWidth}
          rowHeight={rowHeight}
          isTv={false}
          isFocusedRow={entry.index === cursor.focusedRow}
          focusedSlotIndex={entry.index === cursor.focusedRow ? cursor.focusedSlotIndex : 0}
          logoBackdropMode={logoBackdropMode}
          sourceBadge={entry.channel ? (sourceBadges?.get(entry.channel.sourceId) ?? null) : null}
          cleanChannelTitles={cleanChannelTitles}
          epgGenreTints={epgGenreTints}
          onSelectCell={cursor.handleSelectCell}
          onOpenContextMenu={handleOpenContextMenu}
        />
      );
    },
    [
      activeNowMs,
      channelColWidth,
      cleanChannelTitles,
      cursor.focusedRow,
      cursor.focusedSlotIndex,
      cursor.handleSelectCell,
      epgData.getProgrammes,
      epgData.windowStartMs,
      epgGenreTints,
      handleOpenContextMenu,
      logoBackdropMode,
      rowHeight,
      sourceBadges,
      visibleSpanMs,
    ],
  );
  const extraData = useMemo(
    () => ({
      effectiveSourceVersion,
      epgVersion: epgData.version,
      windowStartMs: epgData.windowStartMs,
      visibleSpanMs,
      focusedRow: cursor.focusedRow,
      focusedSlotIndex: cursor.focusedSlotIndex,
      epgGenreTints,
      logoBackdropMode,
      sourceBadges,
      cleanChannelTitles,
    }),
    [
      cleanChannelTitles,
      cursor.focusedRow,
      cursor.focusedSlotIndex,
      effectiveSourceVersion,
      epgData.version,
      epgData.windowStartMs,
      epgGenreTints,
      logoBackdropMode,
      sourceBadges,
      visibleSpanMs,
    ],
  );

  const tvToolbarAction = isTv && isActiveScope ? cursor.focusedToolbarAction : null;
  const previewFocusedAction =
    tvToolbarAction === 'watch' || tvToolbarAction === 'favorite' || tvToolbarAction === 'refresh'
      ? tvToolbarAction
      : null;
  const rulerFocusedButton =
    tvToolbarAction === 'earlier' || tvToolbarAction === 'jump' || tvToolbarAction === 'later'
      ? tvToolbarAction
      : null;
  const isTvGridFocused = isTv && isActiveScope && cursor.focusedArea === 'grid';
  const focusedDateTabIndex =
    isTv && isActiveScope && cursor.focusedArea === 'dateTabs' ? cursor.focusedDateTabIndex : null;
  const anyOverlayOpen = detailModal !== null || contextMenu !== null;

  return (
    <View testID="live-epg-view" style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}>
      {isTv && isActiveScope && !anyOverlayOpen ? (
        <EpgTvKeyBridge onEvent={cursor.handleTvKey} />
      ) : null}

      <EpgPreviewHeader
        channel={cursor.focusedChannel}
        channelIndex={cursor.focusedRow}
        programme={cursor.focusedProgramme}
        nowMs={activeNowMs}
        refreshingGuide={epgData.refreshingGuide}
        isTv={isTv}
        isPortrait={isPortrait}
        isFavorite={
          cursor.focusedChannel !== undefined &&
          (favoriteKeys?.has(cursor.focusedChannel.key) ?? false)
        }
        focusedAction={previewFocusedAction}
        logoBackdropMode={logoBackdropMode}
        cleanChannelTitles={cleanChannelTitles}
        onWatchChannel={onWatchChannel}
        {...(onToggleFavorite !== undefined ? { onToggleFavorite } : {})}
        onRefreshGuide={handleRefreshGuide}
      />

      <EpgDateTabStrip
        tabs={dateTabs}
        activeDayKey={activeDayKey}
        isTv={isTv}
        isPortrait={isPortrait}
        focusedTabIndex={focusedDateTabIndex}
        onSelectTab={handleSelectDateTab}
      />

      <EpgTimeRuler
        categoryLabel={category.label}
        rulerTicks={rulerTicks}
        channelColWidth={channelColWidth}
        isTv={isTv}
        isPortrait={isPortrait}
        jumpHighlighted={!epgData.isAtLiveWindow}
        showClock={epgShowClock}
        nowMs={activeNowMs}
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
              const isFocusedRow = isTvGridFocused && rowIdx === cursor.focusedRow;
              return (
                <View key={rowIdx} style={isFocusedRow ? styles.focusedRowLayer : undefined}>
                  <EpgChannelRow
                    rowIndex={rowIdx}
                    channel={ch}
                    programmes={ch ? epgData.getProgrammes(ch.key) : EMPTY_PROGRAMMES}
                    windowStartMs={epgData.windowStartMs}
                    spanMs={visibleSpanMs}
                    nowMs={activeNowMs}
                    channelColWidth={channelColWidth}
                    rowHeight={rowHeight}
                    isTv
                    isFocusedRow={isFocusedRow}
                    focusedSlotIndex={isFocusedRow ? cursor.focusedSlotIndex : 0}
                    logoBackdropMode={logoBackdropMode}
                    sourceBadge={ch ? (sourceBadges?.get(ch.sourceId) ?? null) : null}
                    cleanChannelTitles={cleanChannelTitles}
                    epgGenreTints={epgGenreTints}
                    onSelectCell={cursor.handleSelectCell}
                    onOpenContextMenu={handleOpenContextMenu}
                  />
                </View>
              );
            })}
            <View pointerEvents="none" style={styles.edgeFadeLayer}>
              <TvScrollEdgeFade
                testID="epg-grid-edge-fade"
                showTop={tvWindowStart > 0}
                showBottom={tvWindowEnd >= 0 && tvWindowEnd < channelCount - 1}
              />
            </View>
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

      <EpgProgrammeDetailModal
        visible={detailModal !== null}
        channel={detailModal?.channel ?? null}
        channelIndex={detailModal?.index ?? 0}
        programme={detailModal?.programme ?? null}
        nowMs={activeNowMs}
        isFavorite={detailModal !== null && (favoriteKeys?.has(detailModal.channel.key) ?? false)}
        isTv={isTv}
        cleanChannelTitles={cleanChannelTitles}
        onTuneChannel={onWatchChannel}
        {...(onToggleFavorite !== undefined ? { onToggleFavorite } : {})}
        onClose={() => setDetailModal(null)}
      />

      <LiveContextMenu
        visible={contextMenu !== null}
        channel={contextMenu?.channel ?? null}
        channelIndex={contextMenu?.index ?? 0}
        programme={contextMenu?.programme ?? null}
        isFavorite={contextMenu !== null && (favoriteKeys?.has(contextMenu.channel.key) ?? false)}
        isTv={isTv}
        cleanChannelTitles={cleanChannelTitles}
        onPlay={onWatchChannel}
        {...(onToggleFavorite !== undefined ? { onToggleFavorite } : {})}
        onShowProgrammeDetails={handleOpenProgrammeDetail}
        {...(onHideChannel !== undefined ? { onHideChannel } : {})}
        onClose={() => setContextMenu(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  matrixWrap: { flex: 1, position: 'relative' },
  tvViewport: { flex: 1, overflow: 'hidden', position: 'relative' },
  edgeFadeLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 1 },
  focusedRowLayer: { zIndex: 2 },
  listFlex: { flex: 1 },
  nowOverlay: { position: 'absolute', top: 0, bottom: 0, right: 0, direction: 'ltr' },
  nowLine: { position: 'absolute', top: 0, bottom: 0, width: 2 },
});
