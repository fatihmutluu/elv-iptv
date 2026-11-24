import type { ItemRow, ProgrammeRow } from '@elv/data';
import type { LogoBackdropModePref } from '@elv/domain';
import {
  ArtworkImage,
  hexToRgba,
  Icon,
  MicroPill,
  SkeletonBox,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback, useMemo } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { buildReminderKey, isPastCatchupEligible } from './catchup-reminder-model';
import {
  computeProgramProgress,
  type EpgPositionedSlot,
  formatClockTime,
  layoutEpgSlots,
} from './live-model';
import { SourceBadgePill } from './SourceBadgePill';
import {
  formatChannelDisplayName,
  type ProgrammeBadgeKind,
  resolveEpgGenreTint,
  resolveProgrammeBadges,
  type SourceBadgeInfo,
} from './source-badge';

const MIN_BADGE_WIDTH_RATIO = 0.14;
const MIN_TIME_WIDTH_RATIO = 0.08;
const LONG_PRESS_DELAY_MS = 450;

function cellBadgeKey(kind: ProgrammeBadgeKind) {
  if (kind === 'live') return 'epg.badge.live' as const;
  if (kind === 'premiere') return 'epg.badge.premiere' as const;
  return 'epg.badge.new' as const;
}

function cellBadgeTone(kind: ProgrammeBadgeKind): 'live' | 'accent' | 'neutral' {
  if (kind === 'live') return 'live';
  if (kind === 'premiere') return 'accent';
  return 'neutral';
}

type SelectCellHandler = (
  rowIndex: number,
  slotIndex: number,
  channel: ItemRow,
  programme: ProgrammeRow | null,
) => void;

type ContextMenuCellHandler = (
  channel: ItemRow,
  rowIndex: number,
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
  readonly hasReminder: boolean;
  readonly onSelectCell: SelectCellHandler;
  readonly onOpenContextMenu?: ContextMenuCellHandler;
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
  hasReminder,
  onSelectCell,
  onOpenContextMenu,
}: EpgSlotCellProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const handlePress = useCallback(() => {
    onSelectCell(rowIndex, slotIndex, channel, slot.programme);
  }, [channel, onSelectCell, rowIndex, slot.programme, slotIndex]);
  const handleLongPress = useCallback(() => {
    onOpenContextMenu?.(channel, rowIndex, slot.programme);
  }, [channel, onOpenContextMenu, rowIndex, slot.programme]);

  const isWeb = (Platform.OS as string) === 'web';
  const webContextProps =
    isWeb && onOpenContextMenu !== undefined
      ? ({
          onContextMenu: (e?: { preventDefault?: () => void }) => {
            e?.preventDefault?.();
            onOpenContextMenu(channel, rowIndex, slot.programme);
          },
        } as Record<string, unknown>)
      : undefined;

  const prog = slot.programme;
  const isGap = slot.isGap || prog === null;
  const progressRatio =
    !isGap && slot.isLive ? computeProgramProgress(prog.start, prog.stop, nowMs) : 0;
  const genreTint =
    !isGap && epgGenreTints && !isSelected && !slot.isLive
      ? resolveEpgGenreTint(prog, theme)
      : null;
  const badges =
    !isGap && slot.widthRatio >= MIN_BADGE_WIDTH_RATIO ? resolveProgrammeBadges(prog.flags) : [];
  const hasCatchup = !isGap && isPastCatchupEligible(channel, prog, nowMs);
  const showCatchupPill = hasCatchup && slot.widthRatio >= MIN_TIME_WIDTH_RATIO;
  const showCatchupDot = hasCatchup && !showCatchupPill;
  const showTime = slot.widthRatio >= MIN_TIME_WIDTH_RATIO;
  const bgColor = isSelected
    ? theme.colors.focusFill
    : isGap
      ? theme.colors.bgSurface
      : slot.isLive
        ? theme.colors.accentTint
        : genreTint !== null
          ? hexToRgba(genreTint.accentColor, 0.12)
          : theme.colors.bgCard;
  const borderColor = isSelected
    ? theme.colors.focusRingColor
    : !isGap && slot.isLive
      ? theme.colors.accent
      : theme.colors.surfaceBorder;
  const titleText = isGap ? i18n.t('epg.noInfoGap') : prog.title;

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
        accessibilityLabel={`${displayName}, ${titleText}`}
        accessibilityState={{ selected: isSelected }}
        onPress={handlePress}
        {...(onOpenContextMenu !== undefined
          ? { onLongPress: handleLongPress, delayLongPress: LONG_PRESS_DELAY_MS }
          : {})}
        {...webContextProps}
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
        <View style={styles.slotTitleRow}>
          {slot.clippedStart ? (
            <Text
              testID={`epg-cell-clipped-${rowIndex}-${slotIndex}`}
              style={[
                theme.typography.caption,
                styles.clippedMarker,
                { color: theme.colors.accent },
              ]}
            >
              ‹
            </Text>
          ) : null}
          <Text
            numberOfLines={1}
            style={[
              theme.typography.caption,
              styles.slotTitle,
              {
                color: isGap ? theme.colors.textMuted : theme.colors.textPrimary,
                fontWeight: isGap ? '400' : '600',
              },
            ]}
          >
            {titleText}
          </Text>
          {badges.length > 0 || hasCatchup || hasReminder ? (
            <View style={styles.cellBadges}>
              {showCatchupPill ? (
                <MicroPill
                  testID={`epg-cell-catchup-${rowIndex}-${slotIndex}`}
                  label={i18n.t('epg.catchupBadge')}
                  tone="accent"
                  dot
                />
              ) : showCatchupDot ? (
                <View
                  testID={`epg-cell-catchup-${rowIndex}-${slotIndex}`}
                  accessibilityLabel={i18n.t('epg.catchupBadge')}
                  style={[styles.catchupDot, { backgroundColor: theme.colors.accent }]}
                />
              ) : null}
              {hasReminder ? (
                <View
                  testID={`epg-cell-reminder-${rowIndex}-${slotIndex}`}
                  accessibilityLabel={i18n.t('epg.reminderScheduled')}
                  style={[
                    styles.reminderBadge,
                    {
                      backgroundColor: theme.colors.accentTint,
                      borderColor: theme.colors.accent,
                      borderRadius: theme.radius.pill,
                    },
                  ]}
                >
                  <Icon name="bell" size={11} color={theme.colors.accent} />
                </View>
              ) : null}
              {badges.slice(0, 2).map((b) => (
                <MicroPill
                  key={b}
                  testID={`epg-cell-badge-${rowIndex}-${slotIndex}-${b}`}
                  label={i18n.t(cellBadgeKey(b))}
                  tone={cellBadgeTone(b)}
                />
              ))}
            </View>
          ) : null}
        </View>
        {showTime && !isGap ? (
          <Text
            numberOfLines={1}
            style={[
              theme.typography.micro,
              TABULAR_NUMS_STYLE,
              { color: theme.colors.textSecondary },
            ]}
          >
            {`${formatClockTime(prog.start)} – ${formatClockTime(prog.stop)}`}
          </Text>
        ) : null}
        {!isGap && slot.isLive ? (
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
  readonly scheduledReminderKeys?: ReadonlySet<string>;
  readonly onSelectCell: SelectCellHandler;
  readonly onOpenContextMenu?: ContextMenuCellHandler;
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
  scheduledReminderKeys,
  onSelectCell,
  onOpenContextMenu,
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
  const handleRowContext = useCallback(() => {
    if (!channel) return;
    onOpenContextMenu?.(channel, rowIndex, slots[0]?.programme ?? null);
  }, [channel, onOpenContextMenu, rowIndex, slots]);
  const isWeb = (Platform.OS as string) === 'web';
  const rowWebContextProps =
    isWeb && channel && onOpenContextMenu !== undefined
      ? ({
          onContextMenu: (e?: { preventDefault?: () => void }) => {
            e?.preventDefault?.();
            onOpenContextMenu(channel, rowIndex, slots[0]?.programme ?? null);
          },
        } as Record<string, unknown>)
      : undefined;

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
        {...(onOpenContextMenu !== undefined
          ? { onLongPress: handleRowContext, delayLongPress: LONG_PRESS_DELAY_MS }
          : {})}
        {...rowWebContextProps}
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
            {...(onOpenContextMenu !== undefined
              ? { onLongPress: handleRowContext, delayLongPress: LONG_PRESS_DELAY_MS }
              : {})}
            {...rowWebContextProps}
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
          slots.map((slot, slotIdx) => {
            const hasReminder =
              !slot.isGap &&
              slot.programme !== null &&
              slot.programme.start > nowMs &&
              (scheduledReminderKeys?.has(buildReminderKey(channel.key, slot.programme.start)) ??
                false);
            return (
              <EpgSlotCell
                key={slot.id}
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
                hasReminder={hasReminder}
                onSelectCell={onSelectCell}
                {...(onOpenContextMenu !== undefined ? { onOpenContextMenu } : {})}
              />
            );
          })
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
  slotTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0 },
  clippedMarker: { fontWeight: '700', flexShrink: 0 },
  slotTitle: { flex: 1, fontWeight: '600', minWidth: 0 },
  cellBadges: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 },
  catchupDot: { width: 7, height: 7, borderRadius: 999 },
  reminderBadge: {
    width: 20,
    height: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
