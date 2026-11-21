import type { ItemRow, NowNextEntry } from '@elv/data';
import {
  ArtworkImage,
  MicroPill,
  SkeletonBox,
  TABULAR_NUMS_STYLE,
  type Theme,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { computeProgramProgress, formatLiveTitle } from './live-model';

const PAD_SLOTS = ['a', 'b'] as const;

/** Shared layout metrics and localized labels for {@link ChannelGridRow} and {@link ChannelGridTile}. */
export interface LiveGridShared {
  readonly cols: number;
  readonly cardHeight: number;
  readonly rowHeight: number;
  readonly gap: number;
  readonly padX: number;
  readonly isTv: boolean;
  readonly isTouch: boolean;
  readonly liveBadge: string;
  readonly upNext: string;
  readonly noProgram: string;
}

function tileSurfaceStyle(
  theme: Theme,
  shared: LiveGridShared,
  isActive: boolean,
  focused: boolean,
  pressed: boolean,
): ViewStyle {
  return {
    height: shared.cardHeight,
    ...(shared.isTouch ? { minHeight: 40 } : {}),
    backgroundColor: isActive ? theme.colors.accentTint : theme.colors.bgCard,
    borderRadius: theme.radius.card,
    borderWidth: focused ? theme.focus.ringWidth : 1,
    borderColor: focused
      ? theme.colors.focusRingColor
      : isActive
        ? theme.colors.accent
        : theme.colors.surfaceBorder,
    opacity: pressed ? 0.86 : 1,
    transform: [{ scale: focused ? theme.focus.cardScale : 1 }],
  };
}

/** Memoized Live TV channel tile with zero inline closures and live Now/Next progress bar. */
export const ChannelGridTile = memo(function ChannelGridTileInner(p: {
  readonly item: ItemRow | undefined;
  readonly itemIndex: number;
  readonly nowNext: NowNextEntry | undefined;
  readonly nowMs: number;
  readonly shared: LiveGridShared;
  readonly isActive: boolean;
  readonly focused: boolean;
  readonly onWatchChannel: (channel: ItemRow, index: number) => void;
}): ReactElement {
  const theme = useTheme();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'transform, border-color, background-color, opacity');
  const handlePress = useCallback(() => {
    if (p.item) p.onWatchChannel(p.item, p.itemIndex);
  }, [p.item, p.itemIndex, p.onWatchChannel]);

  if (!p.item) {
    return (
      <View
        testID={`live-channel-skeleton-${p.itemIndex}`}
        style={[styles.flex1, { height: p.shared.cardHeight }]}
      >
        <SkeletonBox width="100%" height={p.shared.cardHeight} borderRadius={theme.radius.card} />
      </View>
    );
  }

  const nowProg = p.nowNext?.now ?? null;
  const nextProg = p.nowNext?.next ?? null;
  const ratio = nowProg ? computeProgramProgress(nowProg.start, nowProg.stop, p.nowMs) : 0;
  const pct = `${Math.round(ratio * 100)}%` as const;

  return (
    <Pressable
      testID={`live-channel-card-${p.itemIndex}`}
      accessibilityRole="button"
      accessibilityLabel={formatLiveTitle(p.item)}
      accessibilityState={{ selected: p.isActive }}
      focusable={!p.shared.isTv}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.tile,
        tileSurfaceStyle(theme, p.shared, p.isActive, p.focused, pressed),
        cursor,
        transition,
      ]}
    >
      <View style={styles.tileBody}>
        <ArtworkImage
          uri={p.item.logo}
          label={p.item.name}
          maxDecodePx={160}
          resizeMode="contain"
          logoBackdrop
          borderRadius={theme.radius.button}
          style={styles.logo}
        />
        <View style={styles.tileMeta}>
          <View style={styles.tileHeader}>
            {p.item.num !== null && p.item.num !== undefined ? (
              <Text
                testID={`live-channel-num-${p.itemIndex}`}
                numberOfLines={1}
                style={[
                  theme.typography.caption,
                  TABULAR_NUMS_STYLE,
                  { color: theme.colors.textMuted, fontWeight: '700' },
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
            <MicroPill label={p.shared.liveBadge} tone="live" />
          </View>
          <Text
            testID={`live-channel-now-${p.itemIndex}`}
            numberOfLines={1}
            style={[
              theme.typography.body,
              {
                color: nowProg ? theme.colors.textPrimary : theme.colors.textMuted,
                fontWeight: nowProg ? '600' : '400',
              },
            ]}
          >
            {nowProg ? nowProg.title : p.shared.noProgram}
          </Text>
          {nextProg ? (
            <Text
              testID={`live-channel-next-${p.itemIndex}`}
              numberOfLines={1}
              style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
            >
              {`${p.shared.upNext}: ${nextProg.title}`}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={[styles.progressTrack, { backgroundColor: theme.colors.subtleHighlight }]}>
        <View
          testID={`live-channel-progress-${p.itemIndex}`}
          style={[styles.progressFill, { backgroundColor: theme.colors.accent, width: pct }]}
        />
      </View>
    </Pressable>
  );
});

/** Memoized fixed-height row of {@link ChannelGridTile} items for `LiveChannelsGrid`. */
export const ChannelGridRow = memo(function ChannelGridRowInner(p: {
  readonly rowIndex: number;
  readonly items: readonly (ItemRow | undefined)[];
  readonly shared: LiveGridShared;
  readonly nowNextByKey: ReadonlyMap<string, NowNextEntry>;
  readonly nowMs: number;
  readonly activeChannelKey: string | null;
  readonly focusedCol: number | null;
  readonly onWatchChannel: (channel: ItemRow, index: number) => void;
}): ReactElement {
  const padCount = Math.max(0, p.shared.cols - p.items.length);
  return (
    <View
      testID={`live-channel-row-${p.rowIndex}`}
      style={[
        styles.row,
        { height: p.shared.rowHeight, paddingHorizontal: p.shared.padX, gap: p.shared.gap },
      ]}
    >
      {p.items.map((item, colIdx) => {
        const itemIndex = p.rowIndex * p.shared.cols + colIdx;
        return (
          <ChannelGridTile
            key={item ? item.key : `slot-${itemIndex}`}
            item={item}
            itemIndex={itemIndex}
            nowNext={item ? p.nowNextByKey.get(item.key) : undefined}
            nowMs={p.nowMs}
            shared={p.shared}
            isActive={item !== undefined && item.key === p.activeChannelKey}
            focused={p.shared.isTv && p.focusedCol === colIdx}
            onWatchChannel={p.onWatchChannel}
          />
        );
      })}
      {PAD_SLOTS.slice(0, padCount).map((slot) => (
        <View key={`pad-${p.rowIndex}-${slot}`} style={styles.flex1} />
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  tile: { flex: 1, overflow: 'hidden', justifyContent: 'space-between' },
  tileBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 12,
  },
  logo: { width: 48, height: 48, flexShrink: 0 },
  tileMeta: { flex: 1, gap: 3 },
  tileHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  progressTrack: { height: 3, width: '100%' },
  progressFill: { height: 3 },
});
