import type { NowNextEntry } from '@elv/data';
import type { AppI18n } from '@elv/i18n';
import type {
  MediaTracks,
  PlaybackClock,
  PlaybackService,
  PlaybackStatus,
  StreamVideoInfo,
} from '@elv/playback';
import { MicroPill, useTheme, webBackdropBlur } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { DescribedPlaybackFailure } from './errors';
import { OsdVolumeSlider } from './OsdVolumeSlider';
import { JumpToLiveButton, OsdButton, OsdClock, PLAYER_KEY_SHORTCUTS } from './PlayerOsdButton';
import {
  DesktopPeekStrip,
  LiveNowNextStrip,
  PlayerFailureBanner,
  StreamBadgePills,
} from './PlayerOsdChrome';
import type { OsdTier } from './player-overlay-model';
import { formatPlaybackSpeed, type SettingsMenuView } from './settings-menu-nav';
import type { TvOsdAction } from './usePlayerControls';
import { VodProgressBar } from './VodProgressBar';

/** Props shared by {@link PlayerOsd} and {@link DesktopCinemaBar}. */
export interface PlayerOsdProps {
  title: string;
  subtitle?: string | null | undefined;
  channelDigits?: string;
  statusLine: string;
  statusKind?: PlaybackStatus['kind'];
  osdTier?: OsdTier;
  isBuffering?: boolean;
  failure: DescribedPlaybackFailure | null;
  isVod: boolean;
  isPausedOrEnded: boolean;
  canZap: boolean;
  hasTracks: boolean;
  hasPreviousChannel?: boolean;
  canLock?: boolean;
  showRetry: boolean;
  isTv: boolean;
  isDesktop?: boolean;
  muted?: boolean;
  volume?: number;
  isFullscreen?: boolean;
  playbackSpeed?: number;
  videoInfo?: StreamVideoInfo | undefined;
  tracks?: MediaTracks;
  nowNext?: NowNextEntry | null | undefined;
  /** Wall-clock Unix epoch timestamp in ms for Live EPG programme progress (defaults to `Date.now()`). */
  nowMs?: number | undefined;
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
  onOpenTracks: () => void;
  onOpenSettings?: () => void;
  onOpenSpeed?: () => void;
  onToggleInfo?: () => void;
  onToggleChannelList?: () => void;
  onToggleMute?: () => void;
  onSetVolume?: (volume: number) => void;
  onToggleFullscreen?: () => void;
  onLock?: () => void;
  onJumpPreviousChannel?: () => void;
  onJumpToLiveEdge?: () => void;
  onPrev: () => void;
  onNext: () => void;
  onRetry: () => void;
}

/**
 * Native-HWND flex-safe Desktop Cinema Bar docked cleanly below `player-surface-layer` (`#391`, `#58`, `#394`, `#57`).
 * Never uses `position: 'absolute'` so Windows/macOS child HWND bounds stay non-overlapping.
 */
export function DesktopCinemaBar(p: PlayerOsdProps): ReactElement {
  const theme = useTheme();
  const {
    i18n,
    isVod,
    service,
    osdTier = 'controls',
    settingsOpen = false,
    infoOpen = false,
    channelListOpen = false,
    muted = false,
    volume = 100,
    isFullscreen = false,
    playbackSpeed = 1,
  } = p;

  const trimmedSubtitle = p.subtitle?.trim();
  const showStatus = p.statusKind !== 'playing' && p.statusLine.trim().length > 0;
  const hasNowProg = !isVod && p.nowNext?.now != null;
  const showPrevChannelBtn =
    !isVod &&
    service !== null &&
    p.hasPreviousChannel === true &&
    p.onJumpPreviousChannel !== undefined;

  const barStyle = [
    styles.bar,
    { backgroundColor: theme.colors.glassBg, borderTopColor: theme.colors.glassBorder },
    webBackdropBlur(20),
  ];

  if (osdTier === 'progress') {
    return (
      <View testID="player-osd" style={barStyle}>
        <DesktopPeekStrip
          title={p.title}
          channelDigits={p.channelDigits}
          isVod={isVod}
          isTv={false}
          muted={muted}
          volume={volume}
          playbackSpeed={playbackSpeed}
          nowNext={p.nowNext}
          nowMs={p.nowMs}
          previewPositionMs={p.previewPositionMs}
          service={service}
          clock={p.clock}
          i18n={i18n}
          onSeekRatio={p.onSeekRatio}
          onScrubbingChange={p.onScrubbingChange}
        />
      </View>
    );
  }

  return (
    <View testID="player-osd" style={barStyle}>
      {isVod ? (
        <VodProgressBar
          service={service}
          clock={p.clock}
          isTv={false}
          docked
          label={i18n.t('player.progressLabel')}
          previewPositionMs={p.previewPositionMs}
          onSeekRatio={p.onSeekRatio}
          {...(p.onScrubbingChange !== undefined ? { onScrubbingChange: p.onScrubbingChange } : {})}
        />
      ) : null}

      {p.failure !== null ? <PlayerFailureBanner failure={p.failure} i18n={i18n} compact /> : null}

      <View style={styles.controlRow}>
        <View testID="desktop-bar-left" style={styles.leftTransport}>
          <OsdButton
            testID="player-back"
            icon="back"
            variant="icon"
            size={36}
            accessibilityLabel={i18n.t('player.back')}
            keyShortcuts={PLAYER_KEY_SHORTCUTS.back}
            onPress={p.onExit}
            isTv={false}
          />
          {isVod && service !== null ? (
            <>
              <OsdButton
                testID="player-play-pause"
                variant="primary"
                circular
                size={36}
                loading={p.isBuffering === true}
                icon={p.isPausedOrEnded ? 'play' : 'pause'}
                accessibilityLabel={
                  p.isPausedOrEnded ? i18n.t('player.play') : i18n.t('player.pause')
                }
                keyShortcuts={PLAYER_KEY_SHORTCUTS.playPause}
                onPress={p.onTogglePlayPause}
                isTv={false}
              />
              <OsdButton
                testID="player-seek-back"
                icon="skipBack"
                variant="icon"
                size={36}
                accessibilityLabel={i18n.t('player.seekBack')}
                keyShortcuts={PLAYER_KEY_SHORTCUTS.seekBack}
                onPress={p.onSeekBack}
                isTv={false}
              />
              <OsdButton
                testID="player-seek-forward"
                icon="skipForward"
                variant="icon"
                size={36}
                accessibilityLabel={i18n.t('player.seekForward')}
                keyShortcuts={PLAYER_KEY_SHORTCUTS.seekForward}
                onPress={p.onSeekForward}
                isTv={false}
              />
            </>
          ) : null}
          {!isVod && p.canZap ? (
            <>
              <OsdButton
                testID="player-prev"
                icon="chevronLeft"
                variant="icon"
                size={34}
                accessibilityLabel={i18n.t('player.prevChannel')}
                onPress={p.onPrev}
                isTv={false}
              />
              <OsdButton
                testID="player-next"
                icon="chevronRight"
                variant="icon"
                size={34}
                accessibilityLabel={i18n.t('player.nextChannel')}
                onPress={p.onNext}
                isTv={false}
              />
            </>
          ) : null}
          {showPrevChannelBtn && p.onJumpPreviousChannel !== undefined ? (
            <OsdButton
              testID="player-prev-channel"
              icon="prevChannel"
              variant="icon"
              size={34}
              accessibilityLabel={i18n.t('player.jumpPreviousChannel')}
              onPress={p.onJumpPreviousChannel}
              isTv={false}
            />
          ) : null}
          {service !== null && p.onToggleMute !== undefined ? (
            <OsdButton
              testID="player-mute-button"
              icon={muted ? 'volumeMute' : 'audio'}
              variant="icon"
              size={36}
              accessibilityLabel={muted ? i18n.t('player.unmute') : i18n.t('player.mute')}
              keyShortcuts={PLAYER_KEY_SHORTCUTS.mute}
              active={muted}
              onPress={p.onToggleMute}
              isTv={false}
            />
          ) : null}
          {service !== null && p.onSetVolume !== undefined ? (
            <OsdVolumeSlider
              testID="player-volume-slider"
              volume={volume}
              muted={muted}
              onChange={p.onSetVolume}
              i18n={i18n}
            />
          ) : null}
          {!isVod ? (
            <OsdClock service={service} clock={p.clock} previewPositionMs={p.previewPositionMs} />
          ) : null}
        </View>

        <View testID="desktop-bar-center" style={styles.centerInfo}>
          <View style={styles.titleLine}>
            <Text
              testID="osd-title"
              numberOfLines={1}
              style={[
                theme.typography.title,
                styles.titleText,
                { color: theme.colors.textPrimary },
              ]}
            >
              {p.title}
            </Text>
            {!isVod ? (
              <MicroPill testID="player-live-badge" label={i18n.t('ui.liveBadge')} tone="live" />
            ) : null}
            {!isVod && p.channelDigits !== undefined && p.channelDigits.length > 0 ? (
              <MicroPill testID="player-channel-digits" label={p.channelDigits} tone="accent" />
            ) : null}
            <StreamBadgePills videoInfo={p.videoInfo} tracks={p.tracks} />
          </View>
          {hasNowProg ||
          (trimmedSubtitle !== undefined && trimmedSubtitle.length > 0) ||
          showStatus ? (
            <View style={styles.metaLine}>
              {hasNowProg ? (
                <LiveNowNextStrip
                  nowNext={p.nowNext}
                  nowMs={p.nowMs ?? Date.now()}
                  i18n={i18n}
                  compact
                />
              ) : trimmedSubtitle !== undefined && trimmedSubtitle.length > 0 ? (
                <Text
                  testID="osd-subtitle"
                  numberOfLines={1}
                  style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
                >
                  {trimmedSubtitle}
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
          ) : null}
        </View>

        <View testID="desktop-bar-right" style={styles.rightUtilities}>
          <JumpToLiveButton
            isVod={isVod}
            service={service}
            clock={p.clock}
            i18n={i18n}
            isTv={false}
            compact
            {...(p.onJumpToLiveEdge !== undefined ? { onPress: p.onJumpToLiveEdge } : {})}
          />
          {!isVod && p.canZap && p.onToggleChannelList !== undefined ? (
            <OsdButton
              testID="player-channel-list-button"
              icon="list"
              variant="icon"
              size={36}
              accessibilityLabel={i18n.t('player.channelList')}
              keyShortcuts={PLAYER_KEY_SHORTCUTS.channelList}
              active={channelListOpen}
              onPress={p.onToggleChannelList}
              isTv={false}
            />
          ) : null}
          {service !== null && p.onToggleInfo !== undefined ? (
            <OsdButton
              testID="player-info-button"
              icon="info"
              variant="icon"
              size={36}
              accessibilityLabel={i18n.t('player.info')}
              keyShortcuts={PLAYER_KEY_SHORTCUTS.info}
              active={infoOpen}
              onPress={p.onToggleInfo}
              isTv={false}
            />
          ) : null}
          {p.hasTracks && service !== null ? (
            <OsdButton
              testID="player-tracks-button"
              icon="subtitles"
              variant="icon"
              size={36}
              accessibilityLabel={i18n.t('player.tracks')}
              keyShortcuts={PLAYER_KEY_SHORTCUTS.tracks}
              active={p.tracksOpen}
              onPress={p.onOpenTracks}
              isTv={false}
            />
          ) : null}
          {isVod && service !== null && p.onOpenSpeed !== undefined ? (
            <OsdButton
              testID="player-speed-button"
              compact
              tabularLabel
              label={formatPlaybackSpeed(playbackSpeed)}
              accessibilityLabel={`${i18n.t('player.speed')}: ${formatPlaybackSpeed(playbackSpeed)}`}
              active={settingsOpen && p.settingsView === 'speed'}
              onPress={p.onOpenSpeed}
              isTv={false}
            />
          ) : null}
          {service !== null && p.onOpenSettings !== undefined ? (
            <OsdButton
              testID="player-settings-button"
              icon="dots"
              variant="icon"
              size={36}
              accessibilityLabel={i18n.t('player.settings')}
              active={settingsOpen}
              onPress={p.onOpenSettings}
              isTv={false}
            />
          ) : null}
          {service !== null && p.onToggleFullscreen !== undefined ? (
            <OsdButton
              testID="player-fullscreen-button"
              icon={isFullscreen ? 'fullscreenExit' : 'fullscreen'}
              variant="icon"
              size={36}
              accessibilityLabel={
                isFullscreen ? i18n.t('player.exitFullscreen') : i18n.t('player.enterFullscreen')
              }
              keyShortcuts={PLAYER_KEY_SHORTCUTS.fullscreen}
              onPress={p.onToggleFullscreen}
              isTv={false}
            />
          ) : null}
          {p.showRetry ? (
            <OsdButton
              testID="player-retry"
              icon="refresh"
              compact
              label={i18n.t('player.retry')}
              onPress={p.onRetry}
              isTv={false}
            />
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: 1, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 10, gap: 6 },
  controlRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  leftTransport: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  centerInfo: { flex: 1, minWidth: 0, gap: 2 },
  rightUtilities: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  titleText: { flexShrink: 1, fontWeight: '600' },
  metaLine: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
});
