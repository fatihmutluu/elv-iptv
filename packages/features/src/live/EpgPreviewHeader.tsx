import type { ItemRow, ProgrammeRow } from '@elv/data';
import type { LogoBackdropModePref } from '@elv/domain';
import {
  ArtworkImage,
  CtaButton,
  IconButton,
  MicroPill,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  useViewport,
  webCursorPointer,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback, useMemo, useState } from 'react';
import {
  type LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { EpgDateTab } from './epg-date-tabs';
import { computeEpgClockPillLayout, formatClockTime } from './live-model';
import {
  formatChannelDisplayName,
  type ProgrammeBadgeKind,
  resolveProgrammeBadges,
} from './source-badge';

function previewBadgeKey(kind: ProgrammeBadgeKind) {
  if (kind === 'live') return 'epg.badge.live' as const;
  if (kind === 'premiere') return 'epg.badge.premiere' as const;
  return 'epg.badge.new' as const;
}

function previewBadgeTone(kind: ProgrammeBadgeKind): 'live' | 'accent' | 'neutral' {
  if (kind === 'live') return 'live';
  if (kind === 'premiere') return 'accent';
  return 'neutral';
}

/** Props of {@link EpgPreviewHeader}. */
export interface EpgPreviewHeaderProps {
  readonly channel: ItemRow | undefined;
  readonly channelIndex: number;
  readonly programme: ProgrammeRow | null;
  readonly nowMs: number;
  readonly refreshingGuide: boolean;
  readonly isTv: boolean;
  readonly isPortrait: boolean;
  readonly isFavorite?: boolean;
  readonly focusedAction?: 'watch' | 'favorite' | 'refresh' | null;
  readonly logoBackdropMode?: LogoBackdropModePref;
  readonly cleanChannelTitles?: boolean;
  readonly onWatchChannel: (channel: ItemRow, channelIndex: number) => void;
  readonly onToggleFavorite?: (channel: ItemRow) => void;
  readonly onRefreshGuide: () => void;
}

/**
 * Compact Cinema Quietude focused-channel preview card (`#56`) anchored above the EPG timeline.
 */
export const EpgPreviewHeader = memo(function EpgPreviewHeaderInner(
  props: EpgPreviewHeaderProps,
): ReactElement {
  const { channel, channelIndex, programme, nowMs, refreshingGuide, isTv, isPortrait } = props;
  const { isFavorite = false, focusedAction = null, onWatchChannel, onToggleFavorite } = props;
  const { logoBackdropMode = 'plate', cleanChannelTitles = false, onRefreshGuide } = props;
  const theme = useTheme();
  const i18n = useI18n();

  const handleWatch = useCallback(() => {
    if (channel) onWatchChannel(channel, channelIndex);
  }, [channel, channelIndex, onWatchChannel]);
  const handleToggleFavorite = useCallback(() => {
    if (channel) onToggleFavorite?.(channel);
  }, [channel, onToggleFavorite]);

  const channelDisplayName = channel
    ? formatChannelDisplayName(channel.name, cleanChannelTitles)
    : '';
  const isLiveProgramme = programme !== null && programme.start <= nowMs && programme.stop > nowMs;
  const timeRangeLabel =
    programme !== null
      ? `${formatClockTime(programme.start)} – ${formatClockTime(programme.stop)}`
      : null;
  const heading = programme?.title ?? (channel ? channelDisplayName : i18n.t('epg.title'));
  const description =
    programme?.description?.trim() || programme?.subTitle?.trim() || i18n.t('epg.noGuideData');
  const tileWidth = isPortrait ? 124 : isTv ? 200 : 176;

  const actions = (
    <View style={styles.actionsRow}>
      <CtaButton
        testID="epg-watch-now"
        variant="primary"
        icon="play"
        label={i18n.t('epg.watchNow')}
        disabled={!channel}
        focusable={!isTv}
        focused={focusedAction === 'watch'}
        onPress={handleWatch}
        style={styles.ctaButton}
      />
      {onToggleFavorite ? (
        <IconButton
          testID="epg-favorite-toggle"
          icon={isFavorite ? 'starFilled' : 'star'}
          active={isFavorite}
          accessibilityLabel={i18n.t(isFavorite ? 'live.favoriteRemove' : 'live.favoriteAdd')}
          disabled={!channel}
          focusable={!isTv}
          focused={focusedAction === 'favorite'}
          onPress={handleToggleFavorite}
        />
      ) : null}
      <CtaButton
        testID="epg-refresh-guide"
        variant="secondary"
        icon="refresh"
        label={i18n.t(refreshingGuide ? 'epg.refreshingGuide' : 'epg.refreshGuide')}
        disabled={refreshingGuide || !channel}
        focusable={!isTv}
        focused={focusedAction === 'refresh'}
        onPress={onRefreshGuide}
        style={styles.ctaButton}
      />
    </View>
  );

  return (
    <View
      testID="epg-preview-header"
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.bgSurface,
          borderBottomColor: theme.colors.surfaceBorder,
          paddingHorizontal: isPortrait ? theme.spacing.sm : theme.spacing.md,
          paddingVertical: isPortrait ? theme.spacing.sm : theme.spacing.sm + 2,
          flexDirection: isPortrait ? 'column' : 'row',
          gap: isPortrait ? theme.spacing.sm : theme.spacing.md,
        },
      ]}
    >
      <View style={[styles.topRow, isPortrait ? styles.topRowPortrait : styles.topRowLandscape]}>
        <View style={[styles.previewColumn, { width: tileWidth }]}>
          <View style={styles.tileWrapper}>
            <ArtworkImage
              testID="epg-preview-artwork"
              uri={channel?.logo}
              label={channel ? channelDisplayName : i18n.t('epg.title')}
              aspectRatio={16 / 9}
              resizeMode="contain"
              logoBackdropMode={logoBackdropMode}
              maxDecodePx={240}
              borderRadius={theme.radius.card}
              style={styles.tileArt}
            />
            <View style={styles.liveBadgeAnchor} pointerEvents="none">
              <MicroPill
                testID="epg-preview-live-pill"
                label={i18n.t('ui.liveBadge')}
                tone="live"
              />
            </View>
          </View>
          <View style={styles.channelIdentity}>
            {channel?.num !== null && channel?.num !== undefined ? (
              <Text
                numberOfLines={1}
                style={[
                  theme.typography.caption,
                  TABULAR_NUMS_STYLE,
                  { color: theme.colors.textMuted },
                ]}
              >
                {channel.num}
              </Text>
            ) : null}
            <Text
              numberOfLines={1}
              style={[
                theme.typography.caption,
                styles.channelName,
                { color: theme.colors.textPrimary },
              ]}
            >
              {channelDisplayName}
            </Text>
          </View>
        </View>

        <View style={styles.detailsColumn}>
          <View style={styles.metaRow}>
            <Text
              numberOfLines={1}
              style={[
                theme.typography.h2,
                styles.programTitle,
                { color: theme.colors.textPrimary },
              ]}
            >
              {heading}
            </Text>
            {timeRangeLabel !== null ? (
              <MicroPill testID="epg-preview-time-pill" label={timeRangeLabel} tone="neutral" />
            ) : null}
            {isLiveProgramme ? (
              <MicroPill testID="epg-preview-on-air" label={i18n.t('epg.onAirBadge')} tone="live" />
            ) : null}
            {resolveProgrammeBadges(programme?.flags).map((b) => (
              <MicroPill
                key={b}
                testID={`epg-preview-badge-${b}`}
                label={i18n.t(previewBadgeKey(b))}
                tone={previewBadgeTone(b)}
              />
            ))}
          </View>
          <Text
            numberOfLines={2}
            style={[
              theme.typography.body,
              styles.description,
              { color: theme.colors.textSecondary },
            ]}
          >
            {description}
          </Text>
          {!isPortrait ? actions : null}
        </View>
      </View>

      {isPortrait ? actions : null}
    </View>
  );
});

/** Props of {@link EpgDateTabStrip}. */
export interface EpgDateTabStripProps {
  readonly tabs: readonly EpgDateTab[];
  readonly activeDayKey: string;
  readonly isTv: boolean;
  readonly isPortrait: boolean;
  readonly focusedTabIndex: number | null;
  readonly onSelectTab: (tab: EpgDateTab) => void;
}

/** Multi-day DST-safe editorial underline date tab strip rendered above the 30-min EPG ruler (`#395`). */
export const EpgDateTabStrip = memo(function EpgDateTabStripInner({
  tabs,
  activeDayKey,
  isTv,
  isPortrait,
  focusedTabIndex,
  onSelectTab,
}: EpgDateTabStripProps): ReactElement {
  const theme = useTheme();
  const cursor = webCursorPointer();
  return (
    <View
      testID="epg-date-tabs"
      accessibilityRole="tablist"
      style={[
        styles.dateStripWrap,
        {
          backgroundColor: theme.colors.bgSurface,
          borderBottomColor: theme.colors.surfaceBorder,
          paddingHorizontal: isPortrait ? theme.spacing.sm : theme.spacing.md,
        },
      ]}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.dateStripRow}
      >
        {tabs.map((tab, idx) => {
          const selected = tab.dayKey === activeDayKey;
          const focused = isTv && focusedTabIndex === idx;
          return (
            <Pressable
              key={tab.dayKey}
              testID={`epg-date-tab-${tab.offsetDays}`}
              accessibilityRole="tab"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected }}
              focusable={!isTv}
              onPress={() => onSelectTab(tab)}
              style={[
                styles.dateTab,
                {
                  borderBottomColor: selected ? theme.colors.accent : 'transparent',
                  backgroundColor: focused ? theme.colors.focusFill : 'transparent',
                  borderColor: focused ? theme.colors.focusRingColor : 'transparent',
                  borderWidth: focused ? theme.focus.ringWidth : 0,
                  borderRadius: focused ? theme.radius.button : 0,
                },
                cursor,
              ]}
            >
              <Text
                numberOfLines={1}
                style={[
                  theme.typography.caption,
                  TABULAR_NUMS_STYLE,
                  {
                    color:
                      selected || focused ? theme.colors.textPrimary : theme.colors.textSecondary,
                    fontWeight: selected || focused ? '700' : '500',
                  },
                ]}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
});

/** Props of {@link EpgTimeRuler}. */
export interface EpgTimeRulerProps {
  readonly categoryLabel: string;
  readonly rulerTicks: readonly number[];
  readonly channelColWidth: number;
  readonly isTv: boolean;
  readonly isPortrait: boolean;
  readonly jumpHighlighted: boolean;
  readonly showClock?: boolean;
  readonly nowMs?: number;
  readonly nowLineRatio?: number | null;
  readonly focusedButton?: 'earlier' | 'jump' | 'later' | null;
  readonly onPanEarlier: () => void;
  readonly onJumpToLive: () => void;
  readonly onPanLater: () => void;
}

/**
 * Time navigation controls (`Earlier`, `Jump to live`, `Later`) and sticky 30-minute EPG time
 * ruler rendered directly above the virtualized channel matrix (`#6`).
 */
export const EpgTimeRuler = memo(function EpgTimeRulerInner(p: EpgTimeRulerProps): ReactElement {
  const { categoryLabel, rulerTicks, channelColWidth, isTv, isPortrait, jumpHighlighted } = p;
  const { showClock = true, nowMs, nowLineRatio = null, focusedButton = null } = p;
  const { onPanEarlier, onJumpToLive, onPanLater } = p;
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const cursor = webCursorPointer();
  const safeFontScale = Number.isFinite(theme.fontScale) ? Math.max(1, theme.fontScale) : 1;
  const rulerHeight = Math.round(32 * safeFontScale);
  const pillWidth = Math.round(52 * safeFontScale);
  const pillHeight = Math.round(22 * safeFontScale);
  const tickLabelWidth = Math.round(44 * safeFontScale);
  const tickLabelOffset = 8;
  const pillGap = Math.round(6 * safeFontScale);

  const [measuredTrackWidth, setMeasuredTrackWidth] = useState(0);
  const viewportWidth = viewport.width > 0 ? viewport.width : 1280;
  const fallbackTrackWidth = Math.max(160, viewportWidth - channelColWidth);
  const effectiveTrackWidth = measuredTrackWidth > 0 ? measuredTrackWidth : fallbackTrackWidth;
  const handleTrackLayout = useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    if (Number.isFinite(width) && width > 0) setMeasuredTrackWidth(width);
  }, []);

  const activeNowRatio = showClock && nowMs !== undefined ? nowLineRatio : null;
  const clockLayout = useMemo(
    () =>
      computeEpgClockPillLayout({
        trackWidth: effectiveTrackWidth,
        nowLineRatio: activeNowRatio,
        tickCount: rulerTicks.length,
        pillWidth,
        tickLabelWidth,
        tickLabelOffset,
        gap: pillGap,
      }),
    [effectiveTrackWidth, activeNowRatio, rulerTicks.length, pillWidth, tickLabelWidth, pillGap],
  );
  const liveClockText = nowMs !== undefined ? formatClockTime(nowMs) : '';

  const navButtons = [
    ['earlier', 'epg-pan-earlier', i18n.t('epg.earlier'), false, onPanEarlier],
    ['jump', 'epg-jump-now', i18n.t('epg.jumpToLive'), jumpHighlighted, onJumpToLive],
    ['later', 'epg-pan-later', i18n.t('epg.later'), false, onPanLater],
  ] as const;

  return (
    <>
      <View
        testID="epg-time-nav-bar"
        style={[
          styles.timeNavBar,
          {
            backgroundColor: theme.colors.bgSurface,
            borderBottomColor: theme.colors.surfaceBorder,
            paddingHorizontal: isPortrait ? theme.spacing.sm : theme.spacing.md,
          },
        ]}
      >
        {navButtons.map(([id, testID, label, highlighted, onPress]) => {
          const isFocused = focusedButton === id;
          const bg = isFocused
            ? theme.colors.focusFill
            : highlighted
              ? theme.colors.accentTint
              : theme.colors.chipBg;
          const border = isFocused
            ? theme.colors.focusRingColor
            : highlighted
              ? theme.colors.accent
              : theme.colors.chipBorder;
          return (
            <Pressable
              key={testID}
              testID={testID}
              focusable={!isTv}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={id === 'jump' ? { selected: highlighted } : undefined}
              onPress={onPress}
              style={[
                styles.navBtn,
                {
                  backgroundColor: bg,
                  borderColor: border,
                  borderWidth: isFocused ? theme.focus.ringWidth : 1,
                  borderRadius: theme.radius.button,
                },
                cursor,
              ]}
            >
              <Text
                style={[
                  theme.typography.caption,
                  {
                    color: theme.colors.textPrimary,
                    fontWeight: highlighted || isFocused ? '700' : '500',
                  },
                ]}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View
        testID="epg-time-ruler"
        style={[
          styles.rulerRow,
          {
            height: rulerHeight,
            backgroundColor: theme.colors.bgElevated,
            borderBottomColor: theme.colors.surfaceBorder,
          },
        ]}
      >
        <View
          style={[
            styles.rulerChannelCell,
            { width: channelColWidth, borderRightColor: theme.colors.surfaceBorder },
          ]}
        >
          <Text
            numberOfLines={1}
            style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
          >
            {categoryLabel}
          </Text>
        </View>
        <View testID="epg-ruler-track" style={styles.rulerTrack} onLayout={handleTrackLayout}>
          {rulerTicks.map((tickMs, idx) => {
            const hidden = clockLayout.hiddenTickIndices.has(idx);
            return (
              <View
                key={tickMs}
                style={[styles.rulerTickCell, { borderLeftColor: theme.colors.surfaceBorder }]}
              >
                <Text
                  testID={`epg-tick-${idx}`}
                  numberOfLines={1}
                  accessibilityElementsHidden={hidden}
                  importantForAccessibility={hidden ? 'no' : 'auto'}
                  style={[
                    theme.typography.caption,
                    TABULAR_NUMS_STYLE,
                    { color: theme.colors.textSecondary },
                    hidden ? styles.hiddenTickText : null,
                  ]}
                >
                  {formatClockTime(tickMs)}
                </Text>
              </View>
            );
          })}
          {showClock && clockLayout.visible ? (
            <View
              testID="epg-live-clock-badge"
              pointerEvents="none"
              style={[
                styles.clockPill,
                {
                  left: clockLayout.pillLeftPx,
                  top: Math.max(0, Math.round((rulerHeight - pillHeight) / 2)),
                  width: pillWidth,
                  height: pillHeight,
                  backgroundColor: theme.colors.accent,
                  borderRadius: theme.radius.pill,
                },
              ]}
            >
              <Text
                testID="epg-live-clock"
                numberOfLines={1}
                style={[
                  theme.typography.micro,
                  TABULAR_NUMS_STYLE,
                  styles.clockPillText,
                  { color: theme.colors.accentContrast },
                ]}
              >
                {liveClockText}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </>
  );
});

const styles = StyleSheet.create({
  container: { borderBottomWidth: StyleSheet.hairlineWidth },
  topRow: { flexDirection: 'row', alignItems: 'center' },
  topRowPortrait: { gap: 10 },
  topRowLandscape: { flex: 1, gap: 16 },
  previewColumn: { gap: 4, flexShrink: 0 },
  tileWrapper: { position: 'relative', width: '100%' },
  tileArt: { width: '100%' },
  liveBadgeAnchor: { position: 'absolute', top: 6, left: 6 },
  channelIdentity: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  channelName: { flex: 1, fontWeight: '600' },
  detailsColumn: { flex: 1, minWidth: 0, gap: 6 },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  programTitle: { flexShrink: 1 },
  description: { maxWidth: 720 },
  actionsRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  ctaButton: { minWidth: 40, minHeight: 40 },
  dateStripWrap: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dateStripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  dateTab: {
    minHeight: 38,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: 2,
    justifyContent: 'center',
  },
  timeNavBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingVertical: 4,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  navBtn: {
    minWidth: 40,
    minHeight: 40,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rulerRow: {
    flexDirection: 'row',
    direction: 'ltr',
    alignItems: 'center',
    height: 32,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rulerChannelCell: {
    height: '100%',
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  rulerTrack: {
    position: 'relative',
    flex: 1,
    flexDirection: 'row',
    direction: 'ltr',
    height: '100%',
  },
  rulerTickCell: {
    flex: 1,
    justifyContent: 'center',
    paddingLeft: 8,
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  hiddenTickText: { opacity: 0 },
  clockPill: {
    position: 'absolute',
    direction: 'ltr',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    zIndex: 4,
  },
  clockPillText: { fontWeight: '700' },
});
