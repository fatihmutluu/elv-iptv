import type { ItemRow, ProgrammeRow } from '@elv/data';
import type { LogoBackdropModePref } from '@elv/domain';
import {
  ArtworkImage,
  hexToRgba,
  SkeletonBox,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  computeProgramProgress,
  type EpgPositionedSlot,
  formatClockTime,
  layoutEpgSlots,
} from './live-model';
import { SourceBadgePill } from './SourceBadgePill';
import {
  formatChannelDisplayName,
  resolveEpgGenreTint,
  type SourceBadgeInfo,
} from './source-badge';

type SelectCellHandler = (
  rowIndex: number,
  slotIndex: number,
  channel: ItemRow,
  programme: ProgrammeRow | null,
) => void;

interface EpgSlotCellProps {
  readonly rowIndex: number;
  readonly slotIndex: number;
  readonly channel: ItemRow;
  readonly displayName: string;
  readonly slot: EpgPositionedSlot;
  readonly nowMs: number;
  readonly isTv: boolean;
  readonly isSelected: boolean;
  readonly epgGenreTints: boolean;
  readonly focusBorderWidth: number;
  readonly onSelectCell: SelectCellHandler;
}

const EpgSlotCell = memo(function EpgSlotCellInner({
  rowIndex,
  slotIndex,
  channel,
  displayName,
  slot,
  nowMs,
  isTv,
  isSelected,
  epgGenreTints,
  focusBorderWidth,
  onSelectCell,
}: EpgSlotCellProps): ReactElement {
  const theme = useTheme();
  const handlePress = useCallback(() => {
    onSelectCell(rowIndex, slotIndex, channel, slot.programme);
  }, [channel, onSelectCell, rowIndex, slot.programme, slotIndex]);

  const progressRatio = slot.isLive
    ? computeProgramProgress(slot.programme.start, slot.programme.stop, nowMs)
    : 0;
  const genreTint =
    epgGenreTints && !isSelected && !slot.isLive
      ? resolveEpgGenreTint(slot.programme, theme)
      : null;
  const bgColor = isSelected
    ? theme.colors.focusFill
    : slot.isLive
      ? theme.colors.accentTint
      : genreTint !== null
        ? hexToRgba(genreTint.accentColor, 0.12)
        : theme.colors.bgCard;
  const borderColor = isSelected
    ? theme.colors.focusRingColor
    : slot.isLive
      ? theme.colors.accent
      : theme.colors.surfaceBorder;

  return (
    <View
      style={[
        styles.slotAnchor,
        { left: `${slot.leftRatio * 100}%`, width: `${slot.widthRatio * 100}%` },
      ]}
    >
      <Pressable
        testID={`epg-cell-${rowIndex}-${slotIndex}`}
        focusable={!isTv}
        accessibilityRole="button"
        accessibilityLabel={`${displayName}, ${slot.programme.title}`}
        accessibilityState={{ selected: isSelected }}
        onPress={handlePress}
        style={[
          styles.slotCard,
          {
            backgroundColor: bgColor,
            borderColor,
            borderWidth: isSelected ? focusBorderWidth : 1,
            ...(genreTint !== null
              ? { borderLeftWidth: 3, borderLeftColor: genreTint.accentColor }
              : {}),
            borderRadius: theme.radius.button,
          },
          webCursorPointer(),
          webTransition(theme, 'background-color, border-color'),
        ]}
      >
        <Text
          numberOfLines={1}
          style={[theme.typography.caption, styles.slotTitle, { color: theme.colors.textPrimary }]}
        >
          {slot.programme.title}
        </Text>
        <Text
          numberOfLines={1}
          style={[
            theme.typography.micro,
            TABULAR_NUMS_STYLE,
            { color: theme.colors.textSecondary },
          ]}
        >
          {`${formatClockTime(slot.programme.start)} – ${formatClockTime(slot.programme.stop)}`}
        </Text>
        {slot.isLive ? (
          <View
            testID={`epg-cell-progress-track-${rowIndex}-${slotIndex}`}
            style={[styles.progressTrack, { backgroundColor: theme.colors.subtleHighlight }]}
          >
            <View
              testID={`epg-cell-progress-${rowIndex}-${slotIndex}`}
              style={[
                styles.progressFill,
                {
                  width: `${Math.round(progressRatio * 100)}%`,
                  backgroundColor: theme.colors.accent,
                },
              ]}
            />
          </View>
        ) : null}
      </Pressable>
    </View>
  );
});

/** Props of {@link EpgChannelRow}. */
export interface EpgChannelRowProps {
  readonly rowIndex: number;
  readonly channel: ItemRow | undefined;
  readonly programmes: readonly ProgrammeRow[];
  readonly windowStartMs: number;
  readonly spanMs: number;
  readonly nowMs: number;
  readonly channelColWidth: number;
  readonly rowHeight: number;
  readonly isTv: boolean;
  readonly isFocusedRow: boolean;
  readonly focusedSlotIndex: number;
  readonly logoBackdropMode?: LogoBackdropModePref;
  readonly sourceBadge?: SourceBadgeInfo | null;
  readonly cleanChannelTitles?: boolean;
  readonly epgGenreTints?: boolean;
  readonly onSelectCell: SelectCellHandler;
}

/**
 * Memoized single channel row in the Cinema Quietude EPG matrix (`#6`).
 * Renders zero-CLS tonal `SkeletonBox` placeholders for unloaded channel slots and clipped
 * `[0, 1]` proportional programme cells with live `accent` progress bars and crisp TV focus rings.
 */
export const EpgChannelRow = memo(function EpgChannelRowInner({
  rowIndex,
  channel,
  programmes,
  windowStartMs,
  spanMs,
  nowMs,
  channelColWidth,
  rowHeight,
  isTv,
  isFocusedRow,
  focusedSlotIndex,
  logoBackdropMode = 'plate',
  sourceBadge = null,
  cleanChannelTitles = false,
  epgGenreTints = true,
  onSelectCell,
}: EpgChannelRowProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  const slots = useMemo(
    () => layoutEpgSlots(programmes, windowStartMs, spanMs, nowMs),
    [nowMs, programmes, spanMs, windowStartMs],
  );

  const handleChannelPress = useCallback(() => {
    if (!channel) return;
    onSelectCell(rowIndex, 0, channel, slots[0]?.programme ?? null);
  }, [channel, onSelectCell, rowIndex, slots]);

  const handleEmptyPress = useCallback(() => {
    if (!channel) return;
    onSelectCell(rowIndex, 0, channel, null);
  }, [channel, onSelectCell, rowIndex]);

  if (!channel) {
    return (
      <View
        testID={`epg-row-skeleton-${rowIndex}`}
        style={[styles.row, { height: rowHeight, borderBottomColor: theme.colors.surfaceBorder }]}
      >
        <View
          style={[
            styles.channelCol,
            { width: channelColWidth, borderRightColor: theme.colors.surfaceBorder },
          ]}
        >
          <SkeletonBox width={28} height={28} borderRadius={theme.radius.button} />
          <SkeletonBox width="62%" height={14} borderRadius={theme.radius.button} />
        </View>
        <View style={styles.trackSkeleton}>
          <SkeletonBox width="44%" height={rowHeight - 12} borderRadius={theme.radius.button} />
          <SkeletonBox width="52%" height={rowHeight - 12} borderRadius={theme.radius.button} />
        </View>
      </View>
    );
  }

  const displayName = formatChannelDisplayName(channel.name, cleanChannelTitles);
  const focusBorderWidth = isTv ? theme.focus.ringWidth : 1.5;
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color');

  return (
    <View
      testID={`epg-row-${rowIndex}`}
      style={[
        styles.row,
        {
          height: rowHeight,
          borderBottomColor: theme.colors.surfaceBorder,
          backgroundColor: isFocusedRow ? theme.colors.subtleHighlight : 'transparent',
        },
      ]}
    >
      <Pressable
        testID={`epg-channel-cell-${rowIndex}`}
        focusable={!isTv}
        accessibilityRole="button"
        accessibilityLabel={displayName}
        onPress={handleChannelPress}
        style={[
          styles.channelCol,
          {
            width: channelColWidth,
            borderRightColor: theme.colors.surfaceBorder,
            backgroundColor: isFocusedRow ? theme.colors.accentTint : theme.colors.bgSurface,
          },
          cursor,
        ]}
      >
        {channel.num !== null && channel.num !== undefined ? (
          <Text
            numberOfLines={1}
            style={[
              theme.typography.caption,
              TABULAR_NUMS_STYLE,
              styles.channelNum,
              { color: theme.colors.textMuted },
            ]}
          >
            {channel.num}
          </Text>
        ) : null}
        <ArtworkImage
          uri={channel.logo}
          label={displayName}
          maxDecodePx={96}
          resizeMode="contain"
          logoBackdropMode={logoBackdropMode}
          borderRadius={theme.radius.button}
          style={styles.channelLogo}
        />
        <Text
          numberOfLines={1}
          style={[
            theme.typography.caption,
            styles.channelName,
            { color: theme.colors.textPrimary },
          ]}
        >
          {displayName}
        </Text>
        <SourceBadgePill badge={sourceBadge} testID={`epg-source-badge-${rowIndex}`} />
      </Pressable>

      <View testID={`epg-row-track-${rowIndex}`} style={styles.track}>
        {slots.length === 0 ? (
          <Pressable
            testID={`epg-cell-${rowIndex}-0`}
            focusable={!isTv}
            accessibilityRole="button"
            accessibilityLabel={`${displayName}, ${i18n.t('epg.noGuideData')}`}
            accessibilityState={{ selected: isFocusedRow && focusedSlotIndex === 0 }}
            onPress={handleEmptyPress}
            style={[
              styles.emptySlot,
              {
                borderRadius: theme.radius.button,
                backgroundColor:
                  isFocusedRow && focusedSlotIndex === 0
                    ? theme.colors.focusFill
                    : theme.colors.bgCard,
                borderWidth: isFocusedRow && focusedSlotIndex === 0 ? focusBorderWidth : 1,
                borderColor:
                  isFocusedRow && focusedSlotIndex === 0
                    ? theme.colors.focusRingColor
                    : theme.colors.surfaceBorder,
              },
              cursor,
              transition,
            ]}
          >
            <Text
              numberOfLines={1}
              style={[theme.typography.caption, { color: theme.colors.textMuted }]}
            >
              {i18n.t('epg.noGuideData')}
            </Text>
          </Pressable>
        ) : (
          slots.map((slot, slotIdx) => (
            <EpgSlotCell
              key={`${slot.programme.guideId}-${slot.programme.start}-${slot.programme.stop}`}
              rowIndex={rowIndex}
              slotIndex={slotIdx}
              channel={channel}
              displayName={displayName}
              slot={slot}
              nowMs={nowMs}
              isTv={isTv}
              isSelected={isFocusedRow && focusedSlotIndex === slotIdx}
              epgGenreTints={epgGenreTints}
              focusBorderWidth={focusBorderWidth}
              onSelectCell={onSelectCell}
            />
          ))
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    direction: 'ltr',
    alignItems: 'stretch',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  channelCol: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    gap: 6,
    borderRightWidth: StyleSheet.hairlineWidth,
    flexShrink: 0,
  },
  channelNum: { minWidth: 24, textAlign: 'right' },
  channelLogo: { width: 28, height: 28, flexShrink: 0 },
  channelName: { flex: 1, fontWeight: '600' },
  track: { flex: 1, position: 'relative', overflow: 'hidden', direction: 'ltr' },
  trackSkeleton: {
    flex: 1,
    flexDirection: 'row',
    direction: 'ltr',
    alignItems: 'center',
    paddingHorizontal: 6,
    gap: 6,
  },
  slotAnchor: { position: 'absolute', top: 4, bottom: 4, paddingHorizontal: 2 },
  slotCard: {
    flex: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  slotTitle: { fontWeight: '600' },
  emptySlot: {
    position: 'absolute',
    top: 4,
    bottom: 4,
    left: 2,
    right: 2,
    paddingHorizontal: 10,
    justifyContent: 'center',
  },
  progressTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    direction: 'ltr',
  },
  progressFill: { height: '100%' },
});
