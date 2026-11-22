import type { AppI18n } from '@elv/i18n';
import type { PlaybackClock, PlaybackStatus, PlaybackTimers } from '@elv/playback';
import { Icon, MicroPill, Scrim, useTheme, useViewport } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { DesktopCinemaBar, type PlayerOsdProps } from './DesktopCinemaBar';
import { describePlaybackFailure } from './errors';
import { OsdButton, OsdClock, PlayerCanvasTapTarget, PlayerLockedOverlay } from './PlayerOsdButton';
import type { TvOsdAction } from './usePlayerControls';
import { VodProgressBar } from './VodProgressBar';

export { PlayerCanvasTapTarget, PlayerLockedOverlay, type PlayerOsdProps };

/** Web-only cursor style applied while desktop OSD is hidden during playback. */
export const HIDE_CURSOR_WEB_STYLE = { cursor: 'none' } as unknown as ViewStyle;
/** Default monotonic playback clock for {@link PlayerScreen}. */
export const DEFAULT_PLAYER_CLOCK: PlaybackClock = { now: () => performance.now() };
/** Default timeout scheduler for {@link PlayerScreen}. */
export const DEFAULT_PLAYER_TIMERS: PlaybackTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

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

/**
 * Cinema Quietude on-screen display: native-HWND flex-safe Desktop Cinema Bar on `desktop`,
 * and Floating 3-Zone Cinema OSD (top scrim, centered transport stage, bottom scrim) elsewhere.
 */
export function PlayerOsd(p: PlayerOsdProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const { i18n, isTv, isVod, service, settingsOpen = false } = p;
  const resolvedDesktop = p.isDesktop ?? viewport.formFactor === 'desktop';

  if (resolvedDesktop) return <DesktopCinemaBar {...p} />;

  const isPortrait = !isTv && viewport.orientation === 'portrait';
  const isFocused = (action: TvOsdAction): boolean =>
    isTv && p.tvOsdFocused && p.tvOsdAction === action;
  const trimmedSubtitle = p.subtitle?.trim();
  const showPrevChannelBtn =
    !isVod &&
    service !== null &&
    p.hasPreviousChannel === true &&
    p.onJumpPreviousChannel !== undefined;
  const showCenterTransport =
    !p.tracksOpen &&
    !settingsOpen &&
    p.failure === null &&
    ((isVod && service !== null) || p.canZap);

  const padH = (isTv ? 48 : 16) + viewport.overscan.x;
  const padTop = (isTv ? 24 : 14) + viewport.safeArea.top + viewport.overscan.y;
  const padBottom = (isTv ? 24 : 14) + viewport.safeArea.bottom + viewport.overscan.y;
  const padLeft = padH + viewport.safeArea.left;
  const padRight = padH + viewport.safeArea.right;

  return (
    <View testID="player-osd" pointerEvents="box-none" style={playerStyles.floatingOsd}>
      <View
        testID="player-osd-top"
        style={[
          playerStyles.topZone,
          { paddingTop: padTop, paddingLeft: padLeft, paddingRight: padRight },
        ]}
      >
        <Scrim direction="top" intensity="default" />
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
            <View style={playerStyles.titleRow}>
              <Text
                testID="osd-title"
                numberOfLines={1}
                style={[
                  isTv ? theme.typography.h1 : theme.typography.h2,
                  playerStyles.titleShrink,
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
            </View>
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
              style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
            >
              {p.statusLine}
            </Text>
          </View>

          <View style={playerStyles.utilityCluster}>
            {p.hasTracks && service !== null ? (
              <OsdButton
                testID="player-tracks-button"
                icon="subtitles"
                variant={isTv ? 'default' : 'icon'}
                {...(isTv ? { label: i18n.t('player.tracks') } : {})}
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
      </View>

      {showCenterTransport ? (
        <View
          testID="player-center-transport"
          pointerEvents="box-none"
          style={playerStyles.centerStage}
        >
          {isVod && service !== null ? (
            <View style={playerStyles.transportCluster}>
              <OsdButton
                testID="player-seek-back"
                icon="skipBack"
                variant="icon"
                size={isTv ? 46 : 42}
                iconSize={20}
                accessibilityLabel={i18n.t('player.seekBack')}
                onPress={p.onSeekBack}
                isTv={isTv}
                tvFocused={isFocused('seekBack')}
              />
              <OsdButton
                testID="player-play-pause"
                variant="primary"
                circular
                size={isTv ? 54 : 48}
                iconSize={isTv ? 26 : 22}
                icon={p.isPausedOrEnded ? 'play' : 'pause'}
                accessibilityLabel={
                  p.isPausedOrEnded ? i18n.t('player.play') : i18n.t('player.pause')
                }
                onPress={p.onTogglePlayPause}
                isTv={isTv}
                tvFocused={isFocused('playPause')}
              />
              <OsdButton
                testID="player-seek-forward"
                icon="skipForward"
                variant="icon"
                size={isTv ? 46 : 42}
                iconSize={20}
                accessibilityLabel={i18n.t('player.seekForward')}
                onPress={p.onSeekForward}
                isTv={isTv}
                tvFocused={isFocused('seekForward')}
              />
            </View>
          ) : p.canZap ? (
            <View style={playerStyles.transportCluster}>
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
            </View>
          ) : null}
        </View>
      ) : null}

      <View
        testID="player-osd-bottom"
        style={[
          playerStyles.bottomZone,
          { paddingBottom: padBottom, paddingLeft: padLeft, paddingRight: padRight },
        ]}
      >
        <Scrim direction="bottom" intensity="strong" />
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
            {...(p.onScrubbingChange !== undefined
              ? { onScrubbingChange: p.onScrubbingChange }
              : {})}
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

        <View style={playerStyles.bottomMetaRow}>
          <OsdClock service={service} clock={p.clock} previewPositionMs={p.previewPositionMs} />
          <View style={playerStyles.bottomActions}>
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
        </View>
      </View>
    </View>
  );
}

export const playerStyles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  flex1: { flex: 1 },
  surfaceLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  surfaceLayerDesktop: { flex: 1 },
  floatingOsd: { position: 'absolute', inset: 0, justifyContent: 'space-between' },
  topZone: { position: 'relative', paddingBottom: 20 },
  bottomZone: { position: 'relative', paddingTop: 24, gap: 10 },
  centerStage: { alignItems: 'center', justifyContent: 'center' },
  transportCluster: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  osdTopRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  osdTitles: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  titleShrink: { flexShrink: 1 },
  utilityCluster: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  bottomMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  bottomActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  nextEpisodeOverlay: { paddingHorizontal: 16, marginBottom: 88, zIndex: 15 },
  nextEpisodeOverlayTv: { paddingHorizontal: 48, marginBottom: 104, zIndex: 15 },
});
