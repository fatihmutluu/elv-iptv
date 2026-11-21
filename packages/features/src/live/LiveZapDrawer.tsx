import type { ItemRow, NowNextEntry } from '@elv/data';
import {
  ArtworkImage,
  SkeletonBox,
  TABULAR_NUMS_STYLE,
  type Theme,
  useI18n,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
  VirtualizedList,
} from 'react-native';
import type { CatalogLayoutMetrics, PagedListSource } from '../shared';
import { formatLiveTitle } from './live-model';

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

function zapRowStyle(
  theme: Theme,
  rowHeight: number,
  isTouch: boolean,
  isActive: boolean,
  focused: boolean,
  pressed: boolean,
): ViewStyle {
  return {
    height: rowHeight,
    minHeight: isTouch ? 44 : 40,
    backgroundColor: isActive
      ? theme.colors.accentTint
      : focused
        ? theme.colors.focusFill
        : 'transparent',
    borderLeftWidth: isActive ? 3 : 0,
    borderLeftColor: isActive ? theme.colors.accent : 'transparent',
    borderWidth: focused ? theme.focus.ringWidth : 0,
    borderColor: focused ? theme.colors.focusRingColor : 'transparent',
    opacity: pressed ? 0.84 : 1,
  };
}

const ZapChannelRow = memo(function ZapChannelRowInner(p: {
  readonly index: number;
  readonly item: ItemRow | undefined;
  readonly nowTitle: string | null;
  readonly noProgramLabel: string;
  readonly rowHeight: number;
  readonly isActive: boolean;
  readonly isTv: boolean;
  readonly isTouch: boolean;
  readonly focused: boolean;
  readonly onSelectChannel: (channel: ItemRow, index: number) => void;
}): ReactElement {
  const theme = useTheme();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, opacity');
  const handlePress = useCallback(() => {
    if (p.item) p.onSelectChannel(p.item, p.index);
  }, [p.index, p.item, p.onSelectChannel]);

  if (!p.item) {
    return (
      <View style={[styles.zapRow, { height: p.rowHeight }]}>
        <SkeletonBox width={34} height={34} borderRadius={theme.radius.button} />
        <View style={styles.zapRowText}>
          <SkeletonBox width="70%" height={12} borderRadius={theme.radius.button} />
          <SkeletonBox width="50%" height={10} borderRadius={theme.radius.button} />
        </View>
      </View>
    );
  }

  return (
    <Pressable
      testID={`live-zap-row-${p.index}`}
      accessibilityRole="button"
      accessibilityLabel={formatLiveTitle(p.item)}
      accessibilityState={{ selected: p.isActive }}
      focusable={!p.isTv}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.zapRow,
        zapRowStyle(theme, p.rowHeight, p.isTouch, p.isActive, p.focused, pressed),
        cursor,
        transition,
      ]}
    >
      <ArtworkImage
        uri={p.item.logo}
        label={p.item.name}
        maxDecodePx={96}
        resizeMode="contain"
        logoBackdrop
        borderRadius={theme.radius.button}
        style={styles.zapLogo}
      />
      <View style={styles.zapRowText}>
        <View style={styles.zapTitleRow}>
          {p.item.num !== null && p.item.num !== undefined ? (
            <Text
              numberOfLines={1}
              style={[
                theme.typography.caption,
                TABULAR_NUMS_STYLE,
                {
                  color: p.isActive ? theme.colors.textPrimary : theme.colors.textMuted,
                  fontWeight: '700',
                },
              ]}
            >
              {p.item.num}
            </Text>
          ) : null}
          <Text
            numberOfLines={1}
            style={[theme.typography.title, styles.flex1, { color: theme.colors.textPrimary }]}
          >
            {p.item.name}
          </Text>
        </View>
        <Text
          numberOfLines={1}
          style={[
            theme.typography.caption,
            { color: p.nowTitle ? theme.colors.textSecondary : theme.colors.textMuted },
          ]}
        >
          {p.nowTitle ?? p.noProgramLabel}
        </Text>
      </View>
    </Pressable>
  );
});

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
  readonly hydrateNowNext: (channelKeys: readonly string[]) => void;
  readonly onSelectChannel: (channel: ItemRow, index: number) => void;
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
    hydrateNowNext,
    onSelectChannel,
  } = p;
  const theme = useTheme();
  const i18n = useI18n();
  const zapRowHeight = layout.isTouch ? 58 : 54;
  const lastBucketRef = useRef(-1);
  const zapVisibleRef = useRef({ start: 0, end: 12 });

  const itemCount = channelSource?.count() ?? 0;
  const tvFocus = Math.max(0, focusedZapIndex ?? 0);
  const tvWindowStart =
    itemCount <= TV_ZAP_WINDOW_SIZE
      ? 0
      : Math.max(0, Math.min(itemCount - TV_ZAP_WINDOW_SIZE, tvFocus - TV_ZAP_LEAD_ROWS));
  const tvWindowEnd = Math.min(itemCount - 1, tvWindowStart + TV_ZAP_WINDOW_SIZE - 1);

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
      return (
        <ZapChannelRow
          key={slot.index}
          index={slot.index}
          item={row}
          nowTitle={row ? (nowNextByKey.get(row.key)?.now?.title ?? null) : null}
          noProgramLabel={noProgramLabel}
          rowHeight={zapRowHeight}
          isActive={row !== undefined && row.key === activeChannelKey}
          isTv={layout.isTv}
          isTouch={layout.isTouch}
          focused={layout.isTv && focusedZapIndex === slot.index}
          onSelectChannel={onSelectChannel}
        />
      );
    },
    [
      activeChannelKey,
      focusedZapIndex,
      layout.isTouch,
      layout.isTv,
      noProgramLabel,
      nowNextByKey,
      onSelectChannel,
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
    () => ({ sourceVersion, nowNextVersion, activeChannelKey, focusedZapIndex }),
    [activeChannelKey, focusedZapIndex, nowNextVersion, sourceVersion],
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
  tvViewport: { flex: 1, overflow: 'hidden' },
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
  zapRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, gap: 10 },
  zapLogo: { width: 34, height: 34, flexShrink: 0 },
  zapRowText: { flex: 1, gap: 2 },
  zapTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
