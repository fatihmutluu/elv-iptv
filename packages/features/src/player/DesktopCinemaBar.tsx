import type { AppI18n } from '@elv/i18n';
import type { PlaybackClock, PlaybackService } from '@elv/playback';
import { Icon, MicroPill, useTheme, webBackdropBlur } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { DescribedPlaybackFailure } from './errors';
import { OsdButton, OsdClock, PLAYER_KEY_SHORTCUTS } from './PlayerOsdButton';
import { formatPlaybackSpeed, type SettingsMenuView } from './settings-menu-nav';
import type { TvOsdAction } from './usePlayerControls';
import { VodProgressBar } from './VodProgressBar';

/** Props shared by {@link PlayerOsd} and {@link DesktopCinemaBar}. */
export interface PlayerOsdProps {
  title: string;
  subtitle?: string | null | undefined;
  statusLine: string;
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
  playbackSpeed?: number;
  tvOsdFocused: boolean;
  tvScrubberFocused?: boolean;
  tvOsdAction: TvOsdAction;
  tracksOpen: boolean;
  settingsOpen?: boolean;
  settingsView?: SettingsMenuView;
  previewPositionMs?: number | undefined;
  i18n: AppI18n;
  service: PlaybackService | null;
  clock: PlaybackClock;
  onExit: () => void;
  onTogglePlayPause: () => void;
  onSeekBack: () => void;
  onSeekForward: () => void;
  onSeekRatio: (ratio: number) => void;
  onOpenTracks: () => void;
  onOpenSettings?: () => void;
  onOpenSpeed?: () => void;
  onToggleMute?: () => void;
  onToggleFullscreen?: () => void;
  onLock?: () => void;
  onJumpPreviousChannel?: () => void;
  onPrev: () => void;
  onNext: () => void;
  onRetry: () => void;
}

/**
 * Native-HWND flex-safe Desktop Cinema Bar docked cleanly below `player-surface-layer`.
 * Never uses `position: 'absolute'` so Windows `libmpv` child HWND bounds stay non-overlapping.
 */
export function DesktopCinemaBar(p: PlayerOsdProps): ReactElement {
  const theme = useTheme();
  const { i18n, isVod, service, settingsOpen = false, muted = false, playbackSpeed = 1 } = p;
  const trimmedSubtitle = p.subtitle?.trim();
  const showPrevChannelBtn =
    !isVod &&
    service !== null &&
    p.hasPreviousChannel === true &&
    p.onJumpPreviousChannel !== undefined;

  return (
    <View
      testID="player-osd"
      style={[
        styles.bar,
        {
          backgroundColor: theme.colors.glassBg,
          borderTopColor: theme.colors.glassBorder,
        },
        webBackdropBlur(20),
      ]}
    >
      {isVod ? (
        <VodProgressBar
          service={service}
          clock={p.clock}
          isTv={false}
          docked
          label={i18n.t('player.progressLabel')}
          previewPositionMs={p.previewPositionMs}
          onSeekRatio={p.onSeekRatio}
        />
      ) : null}

      {p.failure !== null ? (
        <View
          style={[
            styles.errorBox,
            {
              backgroundColor: theme.colors.scrimStrong,
              borderColor: theme.colors.liveColor,
              borderRadius: theme.radius.card,
            },
          ]}
        >
          <Icon name="warning" size={16} color={theme.colors.liveColor} />
          <View style={styles.flex1}>
            <Text
              testID="osd-error-hint"
              style={[theme.typography.caption, { color: theme.colors.textPrimary }]}
            >
              {i18n.t(p.failure.hintId)}
            </Text>
            {p.failure.evidence !== undefined && p.failure.evidence.trim().length > 0 ? (
              <Text
                testID="player-error-evidence"
                numberOfLines={1}
                style={[theme.typography.caption, { color: theme.colors.textMuted }]}
              >
                {p.failure.evidence}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}

      <View style={styles.controlRow}>
        <View style={styles.leftCluster}>
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
                compact
                label={i18n.t('player.prevChannel')}
                onPress={p.onPrev}
                isTv={false}
              />
              <OsdButton
                testID="player-next"
                compact
                label={i18n.t('player.nextChannel')}
                onPress={p.onNext}
                isTv={false}
              />
            </>
          ) : null}
          {showPrevChannelBtn && p.onJumpPreviousChannel !== undefined ? (
            <OsdButton
              testID="player-prev-channel"
              icon="prevChannel"
              compact
              label={i18n.t('player.jumpPreviousChannel')}
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

          <View style={styles.titleBlock}>
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
            </View>
            <View style={styles.metaLine}>
              {trimmedSubtitle !== undefined && trimmedSubtitle.length > 0 ? (
                <Text
                  testID="osd-subtitle"
                  numberOfLines={1}
                  style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
                >
                  {trimmedSubtitle}
                </Text>
              ) : null}
              <Text
                testID="osd-status"
                numberOfLines={1}
                style={[theme.typography.caption, { color: theme.colors.textMuted }]}
              >
                {p.statusLine}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.rightCluster}>
          <OsdClock service={service} clock={p.clock} previewPositionMs={p.previewPositionMs} />
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
              icon="fullscreen"
              variant="icon"
              size={36}
              accessibilityLabel={i18n.t('player.enterFullscreen')}
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
  bar: {
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 10,
    gap: 6,
  },
  flex1: { flex: 1 },
  controlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  leftCluster: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rightCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  titleBlock: { flex: 1, minWidth: 0, marginLeft: 4, gap: 1 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  titleText: { flexShrink: 1, fontWeight: '600' },
  metaLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
});
