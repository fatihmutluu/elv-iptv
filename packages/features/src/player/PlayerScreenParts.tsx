import type { AppI18n } from '@elv/i18n';
import type { PlaybackClock, PlaybackStatus, PlaybackTimers } from '@elv/playback';
import { Scrim, useTheme, useViewport } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { ActivityIndicator, StyleSheet, View, type ViewStyle } from 'react-native';
import {
  DesktopCinemaBar,
  DesktopDockedTopBar,
  PlayerOsdBottomBar,
  type PlayerOsdProps,
  PlayerOsdTopBar,
} from './DesktopCinemaBar';
import { describePlaybackFailure } from './errors';
import { PlayerLockedOverlay } from './PlayerOsdButton';
import { FloatingPeekOsd } from './PlayerOsdChrome';

export { DesktopDockedTopBar, PlayerLockedOverlay, type PlayerOsdProps };

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
 * Unified Minimalist Cinema Player OSD (`Product Decision #40`):
 * - Floating mode (default on TV, Phone, Tablet, and Desktop in-canvas): transparent borderless
 *   top/bottom scrim zones with 100% open unobstructed middle video canvas.
 * - Docked mode (`isDesktop && overlayMode === 'docked'`): legacy child-HWND non-overlapping flex bar.
 */
export function PlayerOsd(p: PlayerOsdProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const {
    i18n,
    isTv,
    isVod,
    service,
    osdTier = 'controls',
    muted = false,
    volume = 100,
    playbackSpeed = 1,
  } = p;
  const resolvedDesktop = p.isDesktop ?? viewport.formFactor === 'desktop';
  const overlayMode = p.overlayMode ?? 'floating';

  if (resolvedDesktop && overlayMode === 'docked') {
    return <DesktopCinemaBar {...p} />;
  }

  const padH = (isTv ? 48 : resolvedDesktop ? 28 : 16) + viewport.overscan.x;
  const padTop =
    (isTv ? 24 : resolvedDesktop ? 20 : 14) + viewport.safeArea.top + viewport.overscan.y;
  const padBottom =
    (isTv ? 24 : resolvedDesktop ? 20 : 14) + viewport.safeArea.bottom + viewport.overscan.y;
  const padLeft = padH + viewport.safeArea.left;
  const padRight = padH + viewport.safeArea.right;

  if (osdTier === 'progress') {
    return (
      <FloatingPeekOsd
        title={p.title}
        channelDigits={p.channelDigits}
        isVod={isVod}
        isTv={isTv}
        muted={muted}
        volume={volume}
        playbackSpeed={playbackSpeed}
        chapters={p.chapters}
        timeDisplayMode={p.timeDisplayMode}
        wallClock={p.wallClock}
        nowNext={p.nowNext}
        nowMs={p.nowMs}
        previewPositionMs={p.previewPositionMs}
        service={service}
        clock={p.clock}
        i18n={i18n}
        onCycleTimeDisplayMode={p.onCycleTimeDisplayMode}
        onSeekRatio={p.onSeekRatio}
        onScrubbingChange={p.onScrubbingChange}
        padBottom={padBottom}
        padLeft={padLeft}
        padRight={padRight}
      />
    );
  }

  return (
    <View testID="player-osd" pointerEvents="box-none" style={playerStyles.floatingOsd}>
      <View
        testID="player-osd-top"
        pointerEvents="box-none"
        style={[
          playerStyles.topZone,
          { paddingTop: padTop, paddingLeft: padLeft, paddingRight: padRight },
        ]}
      >
        <Scrim direction="top" intensity="default" />
        <PlayerOsdTopBar {...p} isDesktop={resolvedDesktop} />
      </View>

      <View pointerEvents="none" style={playerStyles.openCenterCanvas}>
        {p.isBuffering === true && p.failure === null ? (
          <ActivityIndicator
            testID="player-buffering-indicator"
            size="large"
            color={theme.colors.textPrimary}
          />
        ) : null}
      </View>

      <View
        testID="player-osd-bottom"
        pointerEvents="box-none"
        style={[
          playerStyles.bottomZone,
          { paddingBottom: padBottom, paddingLeft: padLeft, paddingRight: padRight },
        ]}
      >
        <Scrim direction="bottom" intensity="strong" />
        <PlayerOsdBottomBar {...p} isDesktop={resolvedDesktop} />
      </View>
    </View>
  );
}

export const playerStyles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  desktopStageRow: { flex: 1, flexDirection: 'row' },
  flex1: { flex: 1 },
  surfaceLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  surfaceLayerDesktop: { flex: 1 },
  floatingOsd: { position: 'absolute', inset: 0, justifyContent: 'space-between' },
  topZone: { position: 'relative', paddingBottom: 24 },
  openCenterCanvas: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  bottomZone: { position: 'relative', paddingTop: 28 },
  holdSpeedWrap: {
    position: 'absolute',
    top: 20,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 25,
  },
  nextEpisodeOverlay: {
    position: 'absolute',
    right: 16,
    bottom: 96,
    zIndex: 15,
  },
  nextEpisodeOverlayTv: {
    position: 'absolute',
    right: 48,
    bottom: 112,
    zIndex: 15,
  },
});
