import type { AppI18n } from '@elv/i18n';
import {
  type ClockAnchor,
  type PlaybackClock,
  type PlaybackService,
  type PlaybackStatus,
  positionAt,
} from '@elv/playback';
import {
  Icon,
  MicroPill,
  Scrim,
  TABULAR_NUMS_STYLE,
  useTheme,
  useViewport,
  webBackdropBlur,
} from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { type DescribedPlaybackFailure, describePlaybackFailure } from './errors';
import { OsdButton, PlayerLockedOverlay } from './PlayerOsdButton';
import { usePlaybackTicker } from './usePlaybackTicker';
import type { TvOsdAction } from './usePlayerControls';
import { formatPlaybackPosition, VodProgressBar } from './VodProgressBar';

export { PlayerLockedOverlay };

/** Formats localized OSD status text from `PlaybackStatus`. */
export function formatStatusLine(status: PlaybackStatus, i18n: AppI18n): string {
  switch (status.kind) {
    case 'idle':
      return i18n.t('player.status.idle');
    case 'tuning':
      return i18n.t('player.status.tuning');
    case 'playing':
      return i18n.t('player.status.playing');
    case 'paused':
      return i18n.t('player.status.paused');
    case 'ended':
      return i18n.t('player.status.ended');
    case 'recovering':
      return i18n.t('player.status.recovering', { rung: status.rung });
    case 'limited':
      return i18n.t('player.status.limited');
    case 'failed':
      return i18n.t(describePlaybackFailure(status.error).messageId);
  }
}

const readClockText = (anchor: ClockAnchor | undefined, nowMs: number): string =>
  anchor === undefined ? '--:--' : formatPlaybackPosition(positionAt(anchor, nowMs));

const sameText = (a: string, b: string): boolean => a === b;

function OsdClock(p: {
  service: PlaybackService | null;
  clock: PlaybackClock;
  previewPositionMs: number | undefined;
}): ReactElement {
  const theme = useTheme();
  const text = usePlaybackTicker({
    service: p.service,
    clock: p.clock,
    mode: 'second',
    derive: readClockText,
    isEqual: sameText,
  });
  return (
    <Text
      testID="osd-clock"
      style={[
        theme.typography.title,
        TABULAR_NUMS_STYLE,
        playerStyles.clock,
        { color: theme.colors.textPrimary },
      ]}
    >
      {p.previewPositionMs === undefined ? text : formatPlaybackPosition(p.previewPositionMs)}
    </Text>
  );
}

/** Props of {@link PlayerOsd}. */
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
  tvOsdFocused: boolean;
  tvScrubberFocused?: boolean;
  tvOsdAction: TvOsdAction;
  tracksOpen: boolean;
  settingsOpen?: boolean;
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
  onLock?: () => void;
  onJumpPreviousChannel?: () => void;
  onPrev: () => void;
  onNext: () => void;
  onRetry: () => void;
}

/** Cinema Quietude on-screen display over the video surface (or flex-docked on Desktop). */
export function PlayerOsd(p: PlayerOsdProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const { i18n, isTv, isVod, service, settingsOpen = false } = p;
  const resolvedDesktop = p.isDesktop ?? viewport.formFactor === 'desktop';
  const isPortrait = !resolvedDesktop && !isTv && viewport.orientation === 'portrait';
  const isFocused = (action: TvOsdAction): boolean =>
    isTv && p.tvOsdFocused && p.tvOsdAction === action;
  const trimmedSubtitle = p.subtitle?.trim();
  const showPrevChannelBtn =
    !isVod &&
    service !== null &&
    p.hasPreviousChannel === true &&
    p.onJumpPreviousChannel !== undefined;
  const hasBottomControls =
    (isVod && service !== null) || p.canZap || showPrevChannelBtn || p.showRetry;

  return (
    <View
      testID="player-osd"
      style={[
        playerStyles.osd,
        isTv ? playerStyles.osdTv : null,
        resolvedDesktop
          ? {
              backgroundColor: theme.colors.glassBg,
              borderTopColor: theme.colors.glassBorder,
              borderTopWidth: 1,
            }
          : {
              paddingBottom: (isTv ? 24 : 14) + viewport.safeArea.bottom + viewport.overscan.y,
              paddingLeft: (isTv ? 48 : 16) + viewport.safeArea.left + viewport.overscan.x,
              paddingRight: (isTv ? 48 : 16) + viewport.safeArea.right + viewport.overscan.x,
            },
        resolvedDesktop ? webBackdropBlur(20) : undefined,
      ]}
    >
      {!resolvedDesktop ? <Scrim direction="bottom" intensity="strong" /> : null}

      <View style={playerStyles.osdTopRow}>
        <OsdButton
          testID="player-back"
          icon="back"
          variant={isPortrait ? 'icon' : 'default'}
          {...(isPortrait ? {} : { label: i18n.t('player.back') })}
          accessibilityLabel={i18n.t('player.back')}
          onPress={p.onExit}
          isTv={isTv}
          tvFocused={isFocused('back')}
        />

        <View style={playerStyles.osdTitles}>
          <Text
            testID="osd-title"
            numberOfLines={1}
            style={[
              isTv ? theme.typography.h1 : theme.typography.h2,
              { color: theme.colors.textPrimary },
            ]}
          >
            {p.title}
          </Text>
          {trimmedSubtitle !== undefined && trimmedSubtitle.length > 0 ? (
            <Text
              testID="osd-subtitle"
              numberOfLines={1}
              style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
            >
              {trimmedSubtitle}
            </Text>
          ) : null}
          <View style={playerStyles.statusRow}>
            {!isVod ? (
              <MicroPill testID="player-live-badge" label={i18n.t('ui.liveBadge')} tone="live" />
            ) : null}
            <Text
              testID="osd-status"
              numberOfLines={1}
              style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
            >
              {p.statusLine}
            </Text>
            {isPortrait ? (
              <OsdClock service={service} clock={p.clock} previewPositionMs={p.previewPositionMs} />
            ) : null}
          </View>
        </View>

        <View style={playerStyles.utilityCluster}>
          {!isPortrait ? (
            <OsdClock service={service} clock={p.clock} previewPositionMs={p.previewPositionMs} />
          ) : null}
          {p.hasTracks && service !== null ? (
            <OsdButton
              testID="player-tracks-button"
              icon="subtitles"
              variant={isPortrait ? 'icon' : 'default'}
              {...(isPortrait ? {} : { label: i18n.t('player.tracks') })}
              accessibilityLabel={i18n.t('player.tracks')}
              active={p.tracksOpen}
              onPress={p.onOpenTracks}
              isTv={isTv}
              tvFocused={isFocused('tracks')}
            />
          ) : null}
          {p.canLock === true && p.onLock !== undefined ? (
            <OsdButton
              testID="player-lock-button"
              icon="lock"
              variant="icon"
              accessibilityLabel={i18n.t('player.lockControls')}
              onPress={p.onLock}
              isTv={isTv}
            />
          ) : null}
          {service !== null && p.onOpenSettings !== undefined ? (
            <OsdButton
              testID="player-settings-button"
              icon="dots"
              variant="icon"
              accessibilityLabel={i18n.t('player.settings')}
              active={settingsOpen}
              onPress={p.onOpenSettings}
              isTv={isTv}
              tvFocused={isFocused('settings')}
            />
          ) : null}
        </View>
      </View>

      {isVod ? (
        <VodProgressBar
          service={service}
          clock={p.clock}
          isTv={isTv}
          tvFocused={isTv && p.tvScrubberFocused === true}
          label={i18n.t('player.progressLabel')}
          previewPositionMs={p.previewPositionMs}
          dimmed={isPortrait && (p.tracksOpen || settingsOpen)}
          onSeekRatio={p.onSeekRatio}
        />
      ) : null}

      {p.failure !== null ? (
        <View
          style={[
            playerStyles.errorBox,
            {
              backgroundColor: theme.colors.scrimStrong,
              borderColor: theme.colors.liveColor,
              borderRadius: theme.radius.card,
            },
          ]}
        >
          <Icon name="warning" size={16} color={theme.colors.liveColor} />
          <View style={playerStyles.flex1}>
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

      {hasBottomControls ? (
        <View style={playerStyles.controlsRow}>
          {isVod && service !== null ? (
            <>
              <OsdButton
                testID="player-seek-back"
                icon="skipBack"
                label={i18n.t('player.seekBack')}
                onPress={p.onSeekBack}
                isTv={isTv}
                tvFocused={isFocused('seekBack')}
              />
              <OsdButton
                testID="player-play-pause"
                variant="primary"
                icon={p.isPausedOrEnded ? 'play' : 'pause'}
                label={p.isPausedOrEnded ? i18n.t('player.play') : i18n.t('player.pause')}
                onPress={p.onTogglePlayPause}
                isTv={isTv}
                tvFocused={isFocused('playPause')}
              />
              <OsdButton
                testID="player-seek-forward"
                icon="skipForward"
                label={i18n.t('player.seekForward')}
                onPress={p.onSeekForward}
                isTv={isTv}
                tvFocused={isFocused('seekForward')}
              />
            </>
          ) : null}
          {p.canZap ? (
            <>
              <OsdButton
                testID="player-prev"
                label={i18n.t('player.prevChannel')}
                onPress={p.onPrev}
                isTv={isTv}
              />
              <OsdButton
                testID="player-next"
                label={i18n.t('player.nextChannel')}
                onPress={p.onNext}
                isTv={isTv}
              />
            </>
          ) : null}
          {showPrevChannelBtn && p.onJumpPreviousChannel !== undefined ? (
            <OsdButton
              testID="player-prev-channel"
              icon="prevChannel"
              label={i18n.t('player.jumpPreviousChannel')}
              onPress={p.onJumpPreviousChannel}
              isTv={isTv}
              tvFocused={isFocused('prevChannel')}
            />
          ) : null}
          {p.showRetry ? (
            <OsdButton
              testID="player-retry"
              icon="refresh"
              label={i18n.t('player.retry')}
              onPress={p.onRetry}
              isTv={isTv}
              tvFocused={
                p.tvOsdFocused
                  ? isFocused('retry')
                  : isTv && !p.tracksOpen && !settingsOpen && p.tvScrubberFocused !== true
              }
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export const playerStyles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  flex1: { flex: 1 },
  tvFocusAnchor: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  surfaceLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  surfaceLayerDesktop: { flex: 1 },
  osd: { position: 'relative', paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  osdTv: { paddingHorizontal: 48, paddingVertical: 24 },
  osdTopRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  osdTitles: { flex: 1, minWidth: 0, gap: 2 },
  statusRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  utilityCluster: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  clock: { fontWeight: '600' },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  controlsRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  nextEpisodeOverlay: { paddingHorizontal: 16, marginBottom: 8 },
  nextEpisodeOverlayTv: { paddingHorizontal: 48, marginBottom: 12 },
});
