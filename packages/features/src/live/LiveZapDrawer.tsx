import type { ItemRow, NowNextEntry, ProgrammeRow } from '@elv/data';
import type { LogoBackdropModePref } from '@elv/domain';
import { TvScrollEdgeFade, useI18n, useTheme, webBackdropBlur } from '@elv/ui-kit';
import { memo, type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  StyleSheet,
  View,
  VirtualizedList,
} from 'react-native';
import type { CatalogLayoutMetrics, PagedListSource } from '../shared';
import { ZapChannelRow } from './LiveZapRow';
import { computeDragTargetIndex } from './live-favorite-reorder';
import type { SourceBadgeInfo } from './source-badge';

/** Width of the left-anchored Mini-Guide Zap Drawer on Landscape viewports (`UI_UX_PHILOSOPHY.md` §3). */
export const ZAP_DRAWER_WIDTH = 306;
const ZAP_SCROLL_QUANTUM = 3;
const TV_ZAP_WINDOW_SIZE = 11;
const TV_ZAP_LEAD_ROWS = 4;

interface ZapListSlot {
  readonly index: number;
  readonly item: ItemRow | undefined;
}

function syncZapWindow(
  source: PagedListSource<ItemRow>,
  start: number,
  end: number,
  hydrateNowNext: (keys: readonly string[]) => void,
): void {
  const total = source.count();
  source.prefetch(Math.max(0, start - 2), Math.min(total, end + 4));
  const limit = Math.min(total - 1, end);
  const keys: string[] = [];
  for (let i = Math.max(0, start); i <= limit; i++) {
    const ch = source.get(i);
    if (ch) keys.push(ch.key);
  }
  if (keys.length > 0) hydrateNowNext(keys);
}

/** Props of {@link LiveZapDrawer}. */
export interface LiveZapDrawerProps {
  readonly channelSource: PagedListSource<ItemRow> | null;
  readonly sourceVersion: number;
  readonly nowNextByKey: ReadonlyMap<string, NowNextEntry>;
  readonly nowNextVersion: number;
  readonly activeChannelKey: string | null;
  readonly focusedZapIndex: number | null;
  readonly layout: CatalogLayoutMetrics;
  /** When `true`, renders in flex flow on the left (HWND-safe on desktop) instead of `position: 'absolute'`. */
  readonly docked?: boolean;
  readonly logoBackdropMode?: LogoBackdropModePref;
  readonly sourceBadges?: ReadonlyMap<string, SourceBadgeInfo>;
  readonly cleanChannelTitles?: boolean;
  readonly hydrateNowNext: (channelKeys: readonly string[]) => void;
  readonly onSelectChannel: (channel: ItemRow, index: number) => void;
  readonly onReorderFavorite?: (fromIndex: number, toIndex: number) => void;
  readonly onOpenContextMenu?: (
    channel: ItemRow,
    index: number,
    programme: ProgrammeRow | null,
  ) => void;
}

interface DragPointerState {
  readonly startIndex: number;
  readonly targetIndex: number;
}

/**
 * Virtualized Mini-Guide Zap Drawer (`#48`): left-anchored drawer on Landscape (`306px`)
 * and inset slide-up sheet on Portrait.
 */
export const LiveZapDrawer = memo(function LiveZapDrawerInner(p: LiveZapDrawerProps): ReactElement {
  const {
    channelSource,
    sourceVersion,
    nowNextByKey,
    nowNextVersion,
    activeChannelKey,
    focusedZapIndex,
    layout,
    docked = false,
    logoBackdropMode = 'plate',
    sourceBadges,
    cleanChannelTitles = false,
    hydrateNowNext,
    onSelectChannel,
    onReorderFavorite,
    onOpenContextMenu,
  } = p;
  const theme = useTheme();
  const i18n = useI18n();
  const zapRowHeight = layout.isTouch ? 58 : 54;
  const lastBucketRef = useRef(-1);
  const zapVisibleRef = useRef({ start: 0, end: 12 });
  const [dragState, setDragState] = useState<DragPointerState | null>(null);
  const dragRef = useRef<{ startIndex: number; startY: number; targetIndex: number } | null>(null);
  const onReorderRef = useRef(onReorderFavorite);
  onReorderRef.current = onReorderFavorite;

  const itemCount = channelSource?.count() ?? 0;
  const reorderable = onReorderFavorite !== undefined && itemCount > 1;
  const tvFocus = Math.max(0, focusedZapIndex ?? 0);
  const tvWindowStart =
    itemCount <= TV_ZAP_WINDOW_SIZE
      ? 0
      : Math.max(0, Math.min(itemCount - TV_ZAP_WINDOW_SIZE, tvFocus - TV_ZAP_LEAD_ROWS));
  const tvWindowEnd = Math.min(itemCount - 1, tvWindowStart + TV_ZAP_WINDOW_SIZE - 1);

  const handleStartDrag = useCallback((index: number, clientY: number) => {
    dragRef.current = { startIndex: index, startY: clientY, targetIndex: index };
    setDragState({ startIndex: index, targetIndex: index });
  }, []);

  const handleMoveUp = useCallback((index: number) => {
    if (index > 0) onReorderRef.current?.(index, index - 1);
  }, []);

  const handleMoveDown = useCallback(
    (index: number) => {
      if (index < itemCount - 1) onReorderRef.current?.(index, index + 1);
    },
    [itemCount],
  );

  const isDraggingAny = dragState !== null;
  useEffect(() => {
    if (!isDraggingAny || (Platform.OS as string) !== 'web') return;
    const win = globalThis as {
      addEventListener?: (type: string, fn: (e: { clientY?: number }) => void) => void;
      removeEventListener?: (type: string, fn: (e: { clientY?: number }) => void) => void;
    };
    const onPointerMove = (e: { clientY?: number }) => {
      const cur = dragRef.current;
      if (!cur) return;
      const deltaY = (e.clientY ?? cur.startY) - cur.startY;
      const nextTarget = computeDragTargetIndex(cur.startIndex, deltaY, zapRowHeight, itemCount);
      if (nextTarget !== cur.targetIndex) {
        cur.targetIndex = nextTarget;
        setDragState({ startIndex: cur.startIndex, targetIndex: nextTarget });
      }
    };
    const finishDrag = (commit: boolean) => {
      const cur = dragRef.current;
      dragRef.current = null;
      setDragState(null);
      if (commit && cur && cur.targetIndex !== cur.startIndex) {
        onReorderRef.current?.(cur.startIndex, cur.targetIndex);
      }
    };
    const onPointerUp = () => finishDrag(true);
    const onPointerCancel = () => finishDrag(false);
    win.addEventListener?.('pointermove', onPointerMove);
    win.addEventListener?.('pointerup', onPointerUp);
    win.addEventListener?.('pointercancel', onPointerCancel);
    win.addEventListener?.('blur', onPointerCancel);
    return () => {
      win.removeEventListener?.('pointermove', onPointerMove);
      win.removeEventListener?.('pointerup', onPointerUp);
      win.removeEventListener?.('pointercancel', onPointerCancel);
      win.removeEventListener?.('blur', onPointerCancel);
    };
  }, [isDraggingAny, itemCount, zapRowHeight]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset zap hydration on channelSource change
  useEffect(() => {
    lastBucketRef.current = -1;
    zapVisibleRef.current = { start: 0, end: 12 };
  }, [channelSource]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: sourceVersion notifies when pages finish loading
  useEffect(() => {
    if (!channelSource || itemCount === 0) return;
    const start = layout.isTv ? tvWindowStart : zapVisibleRef.current.start;
    const end = layout.isTv ? tvWindowEnd : zapVisibleRef.current.end;
    syncZapWindow(channelSource, start, end, hydrateNowNext);
  }, [
    channelSource,
    hydrateNowNext,
    itemCount,
    layout.isTv,
    sourceVersion,
    tvWindowEnd,
    tvWindowStart,
  ]);

  const handleZapScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!channelSource) return;
      const top = Math.floor(Math.max(0, event.nativeEvent.contentOffset.y) / zapRowHeight);
      const bucket = Math.floor(top / ZAP_SCROLL_QUANTUM);
      if (bucket === lastBucketRef.current) return;
      lastBucketRef.current = bucket;
      const end = top + 12;
      zapVisibleRef.current = { start: top, end };
      syncZapWindow(channelSource, top, end, hydrateNowNext);
    },
    [channelSource, hydrateNowNext, zapRowHeight],
  );

  const getItemCount = useCallback(() => itemCount, [itemCount]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sourceVersion refreshes loaded channel rows
  const getZapItem = useCallback(
    (_d: unknown, index: number): ZapListSlot => ({ index, item: channelSource?.get(index) }),
    [channelSource, sourceVersion],
  );
  const zapKeyExtractor = useCallback(
    (s: unknown, idx: number) => `zap-${(s as ZapListSlot | undefined)?.index ?? idx}`,
    [],
  );
  const zapItemLayout = useCallback(
    (_d: unknown, index: number) => ({ length: zapRowHeight, offset: zapRowHeight * index, index }),
    [zapRowHeight],
  );

  const noProgramLabel = i18n.t('live.noProgramInfo');
  const renderSlot = useCallback(
    (slot: ZapListSlot) => {
      const row = slot.item;
      const isFocused = layout.isTv && focusedZapIndex === slot.index;
      const isDragging = dragState !== null && dragState.startIndex === slot.index;
      const dropIndicator: 'above' | 'below' | null =
        dragState !== null &&
        dragState.targetIndex !== dragState.startIndex &&
        dragState.targetIndex === slot.index
          ? dragState.targetIndex < dragState.startIndex
            ? 'above'
            : 'below'
          : null;
      return (
        <View key={slot.index} style={isFocused ? styles.focusedRowLayer : undefined}>
          <ZapChannelRow
            index={slot.index}
            item={row}
            nowTitle={row ? (nowNextByKey.get(row.key)?.now?.title ?? null) : null}
            nowProgramme={row ? (nowNextByKey.get(row.key)?.now ?? null) : null}
            noProgramLabel={noProgramLabel}
            rowHeight={zapRowHeight}
            isActive={row !== undefined && row.key === activeChannelKey}
            isTv={layout.isTv}
            isTouch={layout.isTouch}
            focused={isFocused}
            logoBackdropMode={logoBackdropMode}
            sourceBadge={row ? (sourceBadges?.get(row.sourceId) ?? null) : null}
            cleanChannelTitles={cleanChannelTitles}
            reorderable={reorderable}
            isDragging={isDragging}
            dropIndicator={dropIndicator}
            totalCount={itemCount}
            onStartDrag={handleStartDrag}
            onMoveUp={handleMoveUp}
            onMoveDown={handleMoveDown}
            onSelectChannel={onSelectChannel}
            {...(onOpenContextMenu !== undefined ? { onOpenContextMenu } : {})}
          />
        </View>
      );
    },
    [
      activeChannelKey,
      cleanChannelTitles,
      dragState,
      focusedZapIndex,
      handleMoveDown,
      handleMoveUp,
      handleStartDrag,
      itemCount,
      layout.isTouch,
      layout.isTv,
      logoBackdropMode,
      noProgramLabel,
      nowNextByKey,
      onOpenContextMenu,
      onSelectChannel,
      reorderable,
      sourceBadges,
      zapRowHeight,
    ],
  );
  const renderZapRow = useCallback(
    ({ item }: { item: unknown }) => renderSlot(item as ZapListSlot),
    [renderSlot],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: sourceVersion refreshes bounded TV rows as pages load
  const tvSlots = useMemo<readonly ZapListSlot[]>(() => {
    if (!layout.isTv || !channelSource || itemCount === 0) return [];
    const out: ZapListSlot[] = [];
    for (let i = tvWindowStart; i <= tvWindowEnd; i++) {
      out.push({ index: i, item: channelSource.get(i) });
    }
    return out;
  }, [channelSource, itemCount, layout.isTv, sourceVersion, tvWindowEnd, tvWindowStart]);

  const extraData = useMemo(
    () => ({
      sourceVersion,
      nowNextVersion,
      activeChannelKey,
      focusedZapIndex,
      logoBackdropMode,
      sourceBadges,
      cleanChannelTitles,
      dragState,
      reorderable,
    }),
    [
      activeChannelKey,
      cleanChannelTitles,
      dragState,
      focusedZapIndex,
      logoBackdropMode,
      nowNextVersion,
      reorderable,
      sourceBadges,
      sourceVersion,
    ],
  );

  const useDocked = docked;

  return (
    <View
      testID="live-zap-drawer"
      style={[
        useDocked
          ? styles.drawerDocked
          : layout.isPortrait
            ? styles.drawerPortrait
            : styles.drawerLandscape,
        !useDocked && !layout.isPortrait ? { left: layout.padX } : null,
        {
          backgroundColor: theme.colors.bgElevated,
          borderColor: theme.colors.glassBorder,
          borderRadius: useDocked ? 0 : theme.radius.modal,
        },
        useDocked ? undefined : webBackdropBlur(16),
      ]}
    >
      {!useDocked && layout.isPortrait ? (
        <View style={styles.grabWrap}>
          <View style={[styles.grabHandle, { backgroundColor: theme.colors.glassBorder }]} />
        </View>
      ) : null}
      {layout.isTv ? (
        <View testID="live-zap-tv-viewport" style={styles.tvViewport}>
          {tvSlots.map(renderSlot)}
          <View pointerEvents="none" style={styles.edgeFadeLayer}>
            <TvScrollEdgeFade
              testID="live-zap-edge-fade"
              showTop={tvWindowStart > 0}
              showBottom={tvWindowEnd < itemCount - 1}
              surfaceColor={theme.colors.bgElevated}
            />
          </View>
        </View>
      ) : (
        <VirtualizedList
          testID="live-zap-list"
          style={styles.flex1}
          data={channelSource}
          extraData={extraData}
          getItemCount={getItemCount}
          getItem={getZapItem}
          keyExtractor={zapKeyExtractor}
          getItemLayout={zapItemLayout}
          renderItem={renderZapRow}
          windowSize={5}
          initialNumToRender={10}
          maxToRenderPerBatch={6}
          onScroll={handleZapScroll}
          scrollEventThrottle={32}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  tvViewport: { flex: 1, overflow: 'hidden', position: 'relative' },
  edgeFadeLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 1 },
  focusedRowLayer: { zIndex: 2 },
  drawerDocked: { width: ZAP_DRAWER_WIDTH, borderRightWidth: 1, overflow: 'hidden' },
  drawerLandscape: {
    position: 'absolute',
    top: 64,
    bottom: 18,
    width: ZAP_DRAWER_WIDTH,
    borderWidth: 1,
    overflow: 'hidden',
    zIndex: 5,
  },
  drawerPortrait: {
    height: 240,
    marginHorizontal: 10,
    marginBottom: 10,
    borderWidth: 1,
    overflow: 'hidden',
    zIndex: 5,
  },
  grabWrap: { alignItems: 'center', paddingVertical: 6 },
  grabHandle: { width: 36, height: 4, borderRadius: 999 },
});
