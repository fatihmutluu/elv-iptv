import type { ItemRow, NowNextEntry } from '@elv/data';
import type { LogoBackdropModePref } from '@elv/domain';
import {
  ArtworkImage,
  IconButton,
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
import { SourceBadgePill } from './SourceBadgePill';
import { formatChannelDisplayName, type SourceBadgeInfo } from './source-badge';

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
  readonly favoriteAdd: string;
  readonly favoriteRemove: string;
  readonly logoBackdropMode?: LogoBackdropModePref;
  readonly cleanChannelTitles?: boolean;
}

function tileSurfaceStyle(
  theme: Theme,
  shared: LiveGridShared,
  isActive: boolean,
  focused: boolean,
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
    transform: [{ scale: focused ? theme.focus.cardScale : 1 }],
  };
}

/** Memoized Live TV channel tile with zero inline closures, 1-click favorite toggle, and live Now/Next progress bar. */
export const ChannelGridTile = memo(function ChannelGridTileInner(p: {
  readonly item: ItemRow | undefined;
  readonly itemIndex: number;
  readonly nowNext: NowNextEntry | undefined;
  readonly nowMs: number;
  readonly shared: LiveGridShared;
  readonly isActive: boolean;
  readonly isFavorite: boolean;
  readonly focused: boolean;
  readonly sourceBadge?: SourceBadgeInfo | null;
  readonly onWatchChannel: (channel: ItemRow, index: number) => void;
  readonly onToggleFavorite?: (channel: ItemRow) => void;
}): ReactElement {
  const theme = useTheme();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'transform, border-color, background-color, opacity');
  const handlePress = useCallback(() => {
    if (p.item) p.onWatchChannel(p.item, p.itemIndex);
  }, [p.item, p.itemIndex, p.onWatchChannel]);
  const handleToggleFavorite = useCallback(() => {
    if (p.item) p.onToggleFavorite?.(p.item);
  }, [p.item, p.onToggleFavorite]);

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

  const displayName = formatChannelDisplayName(p.item.name, p.shared.cleanChannelTitles ?? false);
  const nowProg = p.nowNext?.now ?? null;
  const nextProg = p.nowNext?.next ?? null;
  const ratio = nowProg ? computeProgramProgress(nowProg.start, nowProg.stop, p.nowMs) : 0;
  const pct = `${Math.round(ratio * 100)}%` as const;

  return (
    <View
      style={[styles.tile, tileSurfaceStyle(theme, p.shared, p.isActive, p.focused), transition]}
    >
      <View style={styles.tileContentRow}>
        <Pressable
          testID={`live-channel-card-${p.itemIndex}`}
          accessibilityRole="button"
          accessibilityLabel={formatLiveTitle({ num: p.item.num, name: displayName })}
          accessibilityState={{ selected: p.isActive }}
          focusable={!p.shared.isTv}
          onPress={handlePress}
          style={({ pressed }) => [styles.tileBody, { opacity: pressed ? 0.86 : 1 }, cursor]}
        >
          <ArtworkImage
            uri={p.item.logo}
            label={displayName}
            maxDecodePx={160}
            resizeMode="contain"
            logoBackdropMode={p.shared.logoBackdropMode ?? 'plate'}
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
                {displayName}
              </Text>
              <SourceBadgePill
                badge={p.sourceBadge}
                testID={`live-channel-source-badge-${p.itemIndex}`}
              />
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
        </Pressable>
        {p.onToggleFavorite ? (
          <View style={styles.favSlot}>
            <IconButton
              testID={`live-channel-fav-${p.itemIndex}`}
              icon={p.isFavorite ? 'starFilled' : 'star'}
              active={p.isFavorite}
              accessibilityLabel={p.isFavorite ? p.shared.favoriteRemove : p.shared.favoriteAdd}
              focusable={!p.shared.isTv}
              onPress={handleToggleFavorite}
            />
          </View>
        ) : null}
      </View>
      <View style={[styles.progressTrack, { backgroundColor: theme.colors.subtleHighlight }]}>
        <View
          testID={`live-channel-progress-${p.itemIndex}`}
          style={[styles.progressFill, { backgroundColor: theme.colors.accent, width: pct }]}
        />
      </View>
    </View>
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
  readonly favoriteKeys?: ReadonlySet<string>;
  readonly sourceBadges?: ReadonlyMap<string, SourceBadgeInfo>;
  readonly focusedCol: number | null;
  readonly onWatchChannel: (channel: ItemRow, index: number) => void;
  readonly onToggleFavorite?: (channel: ItemRow) => void;
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
            isFavorite={item !== undefined && (p.favoriteKeys?.has(item.key) ?? false)}
            focused={p.shared.isTv && p.focusedCol === colIdx}
            sourceBadge={item ? (p.sourceBadges?.get(item.sourceId) ?? null) : null}
            onWatchChannel={p.onWatchChannel}
            {...(p.onToggleFavorite !== undefined ? { onToggleFavorite: p.onToggleFavorite } : {})}
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
  tileContentRow: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  tileBody: {
    flex: 1,
    height: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 12,
    paddingRight: 8,
    paddingVertical: 10,
    gap: 12,
  },
  favSlot: { paddingRight: 8, flexShrink: 0, justifyContent: 'center', alignItems: 'center' },
  logo: { width: 48, height: 48, flexShrink: 0 },
  tileMeta: { flex: 1, minWidth: 0, gap: 3 },
  tileHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  progressTrack: { height: 3, width: '100%' },
  progressFill: { height: 3 },
});
