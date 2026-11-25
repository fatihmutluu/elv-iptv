import type { NowNextEntry } from '@elv/data';
import type { OsdTimeDisplayMode, TvClockMode } from '@elv/domain';
import type { AppI18n } from '@elv/i18n';
import type {
  ChapterInfo,
  MediaTracks,
  PlaybackClock,
  PlaybackService,
  PlaybackStatus,
  StreamVideoInfo,
} from '@elv/playback';
import { MicroPill, useSafeHoverBridge, useTheme, useViewport, webBackdropBlur } from '@elv/ui-kit';
import { type ReactElement, useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AmbientTvClock } from '../shared/AmbientTvClock';
import type { DescribedPlaybackFailure } from './errors';
import { OsdVolumeSlider } from './OsdVolumeSlider';
import { OsdButton, PLAYER_KEY_SHORTCUTS } from './PlayerOsdButton';
import { StreamBadgePills } from './PlayerOsdChrome';
import type { OsdTier } from './player-overlay-model';
import { formatPlaybackSpeed, type SettingsMenuView } from './settings-menu-nav';
import type { TvOsdAction } from './usePlayerControls';

/** Props shared by {@link PlayerOsd}, {@link PlayerOsdTopBar}, {@link PlayerOsdBottomBar}, and {@link DesktopCinemaBar}. */
export interface PlayerOsdProps {
  title: string;
  subtitle?: string | null | undefined;
  channelDigits?: string;
  statusLine: string;
  statusKind?: PlaybackStatus['kind'];
  osdTier?: OsdTier;
  overlayMode?: 'floating' | 'docked';
  isBuffering?: boolean;
  failure: DescribedPlaybackFailure | null;
  isVod: boolean;
  isCatchup?: boolean;
  liveTimeShiftSupported?: boolean;
  timeShiftUnavailableVisible?: boolean;
  isPausedOrEnded: boolean;
  canZap: boolean;
  hasTracks: boolean;
  hasPreviousChannel?: boolean;
  isChannelPreview?: boolean;
  hasNextEpisodeAction?: boolean;
  canLock?: boolean;
  showRetry: boolean;
  isTv: boolean;
  isDesktop?: boolean;
  muted?: boolean;
  volume?: number;
  isFullscreen?: boolean;
  alwaysOnTop?: boolean;
  playbackSpeed?: number;
  chapters?: readonly ChapterInfo[] | undefined;
  timeDisplayMode?: OsdTimeDisplayMode | undefined;
  videoInfo?: StreamVideoInfo | undefined;
  tracks?: MediaTracks;
  nowNext?: NowNextEntry | null | undefined;
  /** Wall-clock Unix epoch timestamp in ms for Live EPG programme progress (defaults to `Date.now()`). */
  nowMs?: number | undefined;
  wallClock?: (() => number) | undefined;
  /** Ambient TV clock visibility preference (`#416`). */
  tvClockMode?: TvClockMode | undefined;
  /** Suppresses `player-next-episode-pill` TV focus highlight when `NextEpisodeBanner` is already visible. */
  nextEpisodeBannerVisible?: boolean;
  tvOsdFocused: boolean;
  tvScrubberFocused?: boolean;
  tvOsdAction: TvOsdAction;
  tracksOpen: boolean;
  settingsOpen?: boolean;
  settingsView?: SettingsMenuView;
  infoOpen?: boolean;
  channelListOpen?: boolean;
  previewPositionMs?: number | undefined;
  i18n: AppI18n;
  service: PlaybackService | null;
  clock: PlaybackClock;
  onExit: () => void;
  onTogglePlayPause: () => void;
  onSeekBack: () => void;
  onSeekForward: () => void;
  onSeekRatio: (ratio: number) => void;
  onScrubbingChange?: (scrubbing: boolean) => void;
  onCycleTimeDisplayMode?: () => void;
  onFineScrubHaptic?: (kind: 'tier' | 'origin') => void;
  onOpenTracks: () => void;
  onOpenSettings?: () => void;
  onOpenSpeed?: () => void;
  onToggleResizeMode?: () => void;
  onToggleInfo?: () => void;
  onToggleChannelList?: () => void;
  onPlayNextEpisode?: () => void;
  onPrevChapter?: () => void;
  onNextChapter?: () => void;
  onToggleMute?: () => void;
  onSetVolume?: (volume: number) => void;
  onToggleFullscreen?: () => void;
  onToggleAlwaysOnTop?: () => void;
  onMinimizeToMiniPlayer?: () => void;
  onEnterPip?: () => void;
  onEnterMultiView?: () => void;
  onPopoutPlayer?: () => void;
  onLock?: () => void;
  onJumpPreviousChannel?: () => void;
  onJumpToLiveEdge?: () => void;
  onBackToLive?: () => void;
  onPrev: () => void;
  onNext: () => void;
  onRetry: () => void;
}

/**
 * Strips a duplicated episode suffix from `title` when `subtitle` already identifies the episode
 * (e.g. `title = "Northern Signal — E1 · Opening Signal"`, `subtitle = "S1 E1 · Opening Signal"` -> `"Northern Signal"`).
 */
export function deduplicateOsdTitle(title: string, subtitle: string | null): string {
  if (subtitle === null || subtitle.trim().length === 0) return title;
  const subLower = subtitle.trim().toLowerCase();
  const sepIdx = title.indexOf(' — ');
  const dashIdx = sepIdx >= 0 ? sepIdx : title.indexOf(' - ');
  if (dashIdx <= 0) return title;
  const base = title.slice(0, dashIdx).trim();
  const suffix = title.slice(dashIdx + 3).trim();
  if (
    base.length > 0 &&
    suffix.length > 0 &&
    (suffix.toLowerCase() === subLower ||
      (suffix.includes('·') &&
        (subLower.includes(suffix.toLowerCase()) || suffix.toLowerCase().includes(subLower))))
  ) {
    return base;
  }
  return title;
}

/**
 * Unified borderless Minimalist Cinema top bar (`Product Decision #40`):
 * bare `×` close + bold stacked Title/Subtitle left; bare icon strip right (`Subtitles`,
 * `Audio/Volume` popover on desktop, `Aspect`, `Fullscreen`, `1×`, `⋮`). Portrait phone caps
 * top-right icons to `Subtitles`, `Lock`, `⋮`.
 */
export function PlayerOsdTopBar(p: PlayerOsdProps & { readonly docked?: boolean }): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();

  const {
    i18n,
    isTv,
    isVod,
    service,
    settingsOpen = false,
    muted = false,
    volume = 100,
    isFullscreen = false,
    playbackSpeed = 1,
  } = p;
  const isDesktop = p.isDesktop ?? viewport.formFactor === 'desktop';
  const isPortraitPhone = viewport.formFactor === 'phone' && viewport.orientation === 'portrait';
  const volumeBridge = useSafeHoverBridge({
    disabled: !isDesktop || isPortraitPhone || p.onSetVolume === undefined,
  });
  const handleVolumeDragStateChange = useCallback(
    (dragging: boolean) => {
      volumeBridge.setLocked(dragging);
    },
    [volumeBridge.setLocked],
  );
  const isFocused = (action: TvOsdAction): boolean =>
    isTv && p.tvOsdFocused && p.tvOsdAction === action;

  const trimmedSubtitle = p.subtitle?.trim();
  const showStatus = p.statusKind !== 'playing' && p.statusLine.trim().length > 0;
  const nowProg = !isVod ? (p.nowNext?.now ?? null) : null;
  const topSubtitle =
    nowProg !== null
      ? `${i18n.t('player.nowPlaying')} · ${nowProg.title}`
      : trimmedSubtitle !== undefined && trimmedSubtitle.length > 0
        ? trimmedSubtitle
        : null;
  const displayTitle = deduplicateOsdTitle(p.title, topSubtitle);
  const safeFontScale = Number.isFinite(theme.fontScale) ? theme.fontScale : 1;
  const titleFontSize = Math.round((isTv ? 28 : isPortraitPhone ? 20 : 24) * safeFontScale);
  const titleFontFamily = theme.typography.h1.fontFamily;

  return (
    <View style={styles.osdTopRow}>
      <OsdButton
        testID="player-back"
        icon="close"
        iconSize={isTv ? 24 : 22}
        variant="bare"
        size={isTv ? 44 : 40}
        accessibilityLabel={i18n.t('player.close')}
        {...(isDesktop ? { keyShortcuts: PLAYER_KEY_SHORTCUTS.back } : {})}
        onPress={p.onExit}
        isTv={isTv}
        tvFocused={isFocused('back')}
      />

      <View style={styles.osdTitles}>
        <View style={styles.titleRow}>
          <Text
            testID="osd-title"
            numberOfLines={1}
            style={[
              styles.titleText,
              {
                ...(titleFontFamily !== undefined ? { fontFamily: titleFontFamily } : {}),
                fontSize: titleFontSize,
                lineHeight: titleFontSize + Math.round(6 * Math.max(1, safeFontScale)),
                color: theme.colors.textPrimary,
              },
            ]}
          >
            {displayTitle}
          </Text>
          {p.isCatchup === true ? (
            <MicroPill
              testID="player-catchup-badge"
              label={i18n.t('player.catchupBadge')}
              tone="accent"
            />
          ) : !isVod && p.isChannelPreview === true ? (
            <MicroPill
              testID="player-preview-badge"
              label={i18n.t('player.previewBadge')}
              tone="accent"
            />
          ) : !isVod ? (
            <MicroPill testID="player-live-badge" label={i18n.t('ui.liveBadge')} tone="live" />
          ) : null}
          {!isVod && p.channelDigits !== undefined && p.channelDigits.length > 0 ? (
            <MicroPill testID="player-channel-digits" label={p.channelDigits} tone="accent" />
          ) : null}
          {!(isPortraitPhone && viewport.width > 0 && viewport.width < 540) ? (
            <StreamBadgePills videoInfo={p.videoInfo} tracks={p.tracks} />
          ) : null}
        </View>
        {!isVod && p.isChannelPreview === true ? (
          <Text
            testID="player-preview-hint"
            numberOfLines={1}
            style={[theme.typography.caption, { color: theme.colors.accent }]}
          >
            {i18n.t('player.previewChannelHint')}
          </Text>
        ) : null}
        {topSubtitle !== null ? (
          <Text
            testID="osd-subtitle"
            numberOfLines={1}
            style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
          >
            {topSubtitle}
          </Text>
        ) : null}
        {showStatus ? (
          <Text
            testID="osd-status"
            numberOfLines={1}
            style={[theme.typography.caption, { color: theme.colors.textMuted }]}
          >
            {p.statusLine}
          </Text>
        ) : null}
      </View>

      <View style={styles.utilityCluster}>
        {p.hasTracks && service !== null ? (
          <OsdButton
            testID="player-tracks-button"
            icon="subtitles"
            variant="bare"
            size={38}
            accessibilityLabel={i18n.t('player.tracks')}
            {...(isDesktop ? { keyShortcuts: PLAYER_KEY_SHORTCUTS.tracks } : {})}
            active={p.tracksOpen}
            onPress={p.onOpenTracks}
            isTv={isTv}
            tvFocused={isFocused('tracks')}
          />
        ) : null}

        {!isPortraitPhone && service !== null && p.onToggleMute !== undefined ? (
          <View testID="player-volume-control" style={styles.volumeWrap}>
            <View
              ref={volumeBridge.triggerRef as never}
              {...(isDesktop ? (volumeBridge.triggerProps as Record<string, unknown>) : {})}
            >
              <OsdButton
                testID="player-mute-button"
                icon={muted ? 'volumeMute' : 'audio'}
                variant="bare"
                size={38}
                accessibilityLabel={muted ? i18n.t('player.unmute') : i18n.t('player.mute')}
                tooltipPlacement="left"
                tooltipDisabled={volumeBridge.open}
                {...(isDesktop ? { keyShortcuts: PLAYER_KEY_SHORTCUTS.mute } : {})}
                active={muted}
                onHoverIn={isDesktop ? () => volumeBridge.setOpen(true) : undefined}
                onPress={p.onToggleMute}
                isTv={isTv}
              />
            </View>
            {isDesktop && volumeBridge.open && p.onSetVolume !== undefined ? (
              <View
                ref={volumeBridge.panelRef as never}
                testID="player-volume-popover-bridge"
                {...(volumeBridge.panelProps as Record<string, unknown>)}
                style={
                  p.docked === true
                    ? styles.volumeInlineDockedBridge
                    : styles.volumePopoverFloatingBridge
                }
              >
                <View
                  testID="player-volume-popover"
                  style={[
                    p.docked === true ? styles.volumeInlineDocked : styles.volumePopoverFloating,
                    {
                      backgroundColor: theme.colors.glassBg,
                      borderColor: theme.colors.glassBorder,
                      borderRadius: theme.radius.card,
                    },
                    webBackdropBlur(16),
                  ]}
                >
                  <OsdVolumeSlider
                    testID="player-volume-slider"
                    volume={volume}
                    muted={muted}
                    onChange={p.onSetVolume}
                    onDragStateChange={handleVolumeDragStateChange}
                    i18n={i18n}
                  />
                </View>
              </View>
            ) : null}
          </View>
        ) : null}

        {!isPortraitPhone && service !== null && p.onToggleResizeMode !== undefined ? (
          <OsdButton
            testID="player-aspect-button"
            icon="aspect"
            variant="bare"
            size={38}
            accessibilityLabel={i18n.t('player.aspect')}
            onPress={p.onToggleResizeMode}
            isTv={isTv}
          />
        ) : null}

        {!isPortraitPhone && service !== null && p.onMinimizeToMiniPlayer !== undefined ? (
          <OsdButton
            testID="player-minimize-button"
            icon="miniplayer"
            variant="bare"
            size={38}
            accessibilityLabel={i18n.t('player.miniPlayer.minimize')}
            onPress={p.onMinimizeToMiniPlayer}
            isTv={isTv}
          />
        ) : null}

        {!isPortraitPhone && service !== null && p.onEnterPip !== undefined ? (
          <OsdButton
            testID="player-pip-button"
            icon="pip"
            variant="bare"
            size={38}
            accessibilityLabel={i18n.t('player.pip.enter')}
            onPress={p.onEnterPip}
            isTv={isTv}
          />
        ) : null}

        {!isPortraitPhone && service !== null && p.onEnterMultiView !== undefined ? (
          <OsdButton
            testID="player-multiview-button"
            icon="multiview"
            variant="bare"
            size={38}
            accessibilityLabel={i18n.t('player.multiView.enter')}
            onPress={p.onEnterMultiView}
            isTv={isTv}
          />
        ) : null}

        {!isPortraitPhone && isDesktop && service !== null && p.onPopoutPlayer !== undefined ? (
          <OsdButton
            testID="player-popout-button"
            icon="popout"
            variant="bare"
            size={38}
            accessibilityLabel={i18n.t('player.popout.open')}
            onPress={p.onPopoutPlayer}
            isTv={isTv}
          />
        ) : null}

        {!isPortraitPhone && isDesktop && service !== null && p.onToggleFullscreen !== undefined ? (
          <OsdButton
            testID="player-fullscreen-button"
            icon={isFullscreen ? 'fullscreenExit' : 'fullscreen'}
            variant="bare"
            size={38}
            accessibilityLabel={
              isFullscreen ? i18n.t('player.exitFullscreen') : i18n.t('player.enterFullscreen')
            }
            keyShortcuts={PLAYER_KEY_SHORTCUTS.fullscreen}
            onPress={p.onToggleFullscreen}
            isTv={isTv}
          />
        ) : null}

        {!isPortraitPhone && isVod && service !== null && p.onOpenSpeed !== undefined ? (
          <OsdButton
            testID="player-speed-button"
            variant="bare"
            compact
            tabularLabel
            label={formatPlaybackSpeed(playbackSpeed)}
            accessibilityLabel={`${i18n.t('player.speed')}: ${formatPlaybackSpeed(playbackSpeed)}`}
            active={settingsOpen && p.settingsView === 'speed'}
            onPress={p.onOpenSpeed}
            isTv={isTv}
          />
        ) : null}

        {p.canLock === true && p.onLock !== undefined ? (
          <OsdButton
            testID="player-lock-button"
            icon="lock"
            variant="bare"
            size={38}
            accessibilityLabel={i18n.t('player.lockControls')}
            onPress={p.onLock}
            isTv={isTv}
          />
        ) : null}

        {service !== null && p.onOpenSettings !== undefined ? (
          <OsdButton
            testID="player-settings-button"
            icon="dots"
            variant="bare"
            size={38}
            accessibilityLabel={i18n.t('player.settings')}
            active={settingsOpen}
            onPress={p.onOpenSettings}
            isTv={isTv}
            tvFocused={isFocused('settings')}
          />
        ) : null}

        <AmbientTvClock
          surface="player"
          mode={p.tvClockMode}
          now={p.wallClock}
          testID="player-ambient-clock"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  osdTopRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  osdTitles: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  titleText: { flexShrink: 1, fontWeight: '700', letterSpacing: -0.3 },
  utilityCluster: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  volumeWrap: { position: 'relative', flexDirection: 'row', alignItems: 'center' },
  volumePopoverFloatingBridge: {
    position: 'absolute',
    top: 38,
    right: 0,
    paddingTop: 6,
    zIndex: 40,
  },
  volumePopoverFloating: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
  },
  volumeInlineDockedBridge: {
    paddingLeft: 4,
  },
  volumeInlineDocked: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
  },
});
