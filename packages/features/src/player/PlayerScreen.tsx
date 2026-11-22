import type { CatalogService } from '@elv/data';
import type { PlaybackClock, PlaybackService, PlaybackTimers } from '@elv/playback';
import { useFormFactor, useI18n, useTheme } from '@elv/ui-kit';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import { type AppLifecyclePort, noopAppLifecycle } from '../ports/app-lifecycle';
import type { PlayTarget } from '../ports/play-target';
import type { PlaybackGuard } from '../ports/playback-guard';
import type { VideoHost } from '../ports/video-host';
import { describePlaybackFailure } from './errors';
import { NextEpisodeBanner } from './NextEpisodeBanner';
import {
  formatStatusLine,
  PlayerCanvasTapTarget,
  PlayerLockedOverlay,
  PlayerOsd,
  playerStyles,
} from './PlayerScreenParts';
import { PlayerSettingsSheet } from './PlayerSettingsSheet';
import { PlayerStatsHud } from './PlayerStatsHud';
import { TrackPickerModal } from './TrackPickerModal';
import { buildTouchHoverProps } from './touch-hover-guard';
import { usePlayerControls } from './usePlayerControls';
import { usePlayerSession } from './usePlayerSession';
import { usePlayerTargetHandoff } from './usePlayerTargetHandoff';
import { useWatchProgressSync } from './useWatchProgressSync';

/** Default production OSD auto-hide delay in milliseconds (`#421`). */
export const DEFAULT_AUTO_HIDE_OSD_MS = 3_500;

const HIDE_CURSOR_WEB_STYLE = { cursor: 'none' } as unknown as ViewStyle;

const DEFAULT_CLOCK: PlaybackClock = { now: () => performance.now() };
const DEFAULT_TIMERS: PlaybackTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Props of {@link PlayerScreen}. */
export interface PlayerScreenProps {
  catalog: Pick<CatalogService, 'resolveStream' | 'getProgress' | 'saveProgress'>;
  videoHost: VideoHost;
  target: PlayTarget;
  playbackGuard?: PlaybackGuard;
  appLifecycle?: AppLifecyclePort;
  clock?: PlaybackClock;
  timers?: PlaybackTimers;
  initialOsdHidden?: boolean;
  autoHideOsdMs?: number;
  onTargetChange?: (next: PlayTarget) => void;
  onExit: () => void;
}

/** Cross-platform playback screen over injected {@link VideoHost} and {@link AppLifecyclePort} ports. */
export function PlayerScreen({
  catalog,
  videoHost,
  target,
  playbackGuard,
  appLifecycle = noopAppLifecycle,
  clock = DEFAULT_CLOCK,
  timers = DEFAULT_TIMERS,
  initialOsdHidden,
  autoHideOsdMs,
  onTargetChange,
  onExit,
}: PlayerScreenProps): ReactElement {
  const formFactor = useFormFactor();
  const theme = useTheme();
  const i18n = useI18n();
  const isTv = formFactor === 'tv';
  const isDesktop = formFactor === 'desktop';

  const serviceRef = useRef<PlaybackService | null>(null);
  const flushProgressRef = useRef<(overridePosMs?: number) => void>(() => undefined);
  const cancelScrubRef = useRef<() => void>(() => undefined);
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const timersRef = useRef(timers);
  timersRef.current = timers;
  const onTargetChangeRef = useRef(onTargetChange);
  onTargetChangeRef.current = onTargetChange;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const { activeTarget, zapBy, onServiceReady, handlePlayNextEpisode, handleJumpPreviousChannel } =
    usePlayerTargetHandoff({
      target,
      playbackGuard,
      appLifecycle,
      catalogRef,
      serviceRef,
      clockRef,
      timersRef,
      flushProgressRef,
      cancelScrubRef,
      onTargetChangeRef,
    });

  const zapByRef = useRef<(delta: 1 | -1, repeat?: boolean) => void>(zapBy);
  zapByRef.current = zapBy;
  const hostBackRef = useRef<() => void>(() => onExitRef.current());
  const hostFullscreenRef = useRef<() => void>(() => undefined);

  const { sessionState, activeService, status, tracks } = usePlayerSession({
    videoHost,
    serviceRef,
    clockRef,
    timersRef,
    hostBackRef,
    hostFullscreenRef,
    onExitRef,
    zapByRef,
    onServiceReady,
  });

  const { flushProgress } = useWatchProgressSync({
    activeTarget,
    status,
    serviceRef,
    catalogRef,
    clockRef,
    timersRef,
  });
  flushProgressRef.current = flushProgress;

  const [nextEpisodeDismissed, setNextEpisodeDismissed] = useState(false);
  const [nextEpisodeVisible, setNextEpisodeVisible] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset Next Episode prompt dismissal on item change
  useEffect(() => {
    setNextEpisodeDismissed(false);
    setNextEpisodeVisible(false);
  }, [activeTarget.itemKey]);

  const hasTracks = tracks.audio.length > 0 || tracks.subtitles.length > 0;
  const showRetry = status.kind === 'failed' && activeService !== null;
  const statusLine =
    sessionState.kind === 'unavailable'
      ? i18n.t('player.unavailable')
      : formatStatusLine(status, i18n);
  const failure = status.kind === 'failed' ? describePlaybackFailure(status.error) : null;
  const canZap =
    activeTarget.kind === 'live' &&
    activeTarget.playlist !== undefined &&
    activeTarget.playlist.count > 1;
  const hasPreviousChannel =
    activeTarget.kind === 'live' &&
    activeTarget.previousChannel !== undefined &&
    activeTarget.previousChannel.itemKey !== activeTarget.itemKey;
  const nextEpisode = activeTarget.kind === 'vod' ? activeTarget.nextEpisodes?.[0] : undefined;
  const hostToggleFullscreen =
    sessionState.kind === 'ready' ? sessionState.opened.toggleFullscreen : undefined;
  const hostToggleMute = sessionState.kind === 'ready' ? sessionState.opened.toggleMute : undefined;
  const hostSetOrientationLocked =
    sessionState.kind === 'ready' ? sessionState.opened.setOrientationLocked : undefined;

  const controls = usePlayerControls({
    formFactor,
    activeTarget,
    status,
    tracks,
    hasTracks,
    showRetry,
    hasService: activeService !== null,
    hasSettings: activeService !== null,
    hasNextEpisode: nextEpisodeVisible,
    hasPreviousChannel,
    initialOsdHidden,
    autoHideOsdMs,
    serviceRef,
    clockRef,
    timersRef,
    onExitRef,
    zapByRef,
    onSeekCommit: flushProgress,
    onPlayNextEpisode: handlePlayNextEpisode,
    onJumpPreviousChannel: handleJumpPreviousChannel,
    onToggleFullscreen: hostToggleFullscreen,
    onToggleMute: hostToggleMute,
    onSetOrientationLocked: hostSetOrientationLocked,
  });
  hostBackRef.current = controls.handleBack;
  hostFullscreenRef.current = controls.toggleFullscreen;
  cancelScrubRef.current = controls.cancelScrub;

  const nextEpisodeNode = (
    <NextEpisodeBanner
      nextEpisode={nextEpisode}
      statusKind={status.kind}
      dismissed={nextEpisodeDismissed}
      service={activeService}
      clock={clock}
      isTv={isTv}
      tvFocused={isTv && controls.tvOsdFocused && controls.tvOsdAction === 'nextEpisode'}
      i18n={i18n}
      onPlayNext={handlePlayNextEpisode}
      onDismiss={() => setNextEpisodeDismissed(true)}
      onVisibilityChange={setNextEpisodeVisible}
    />
  );

  const trackPickerNode =
    controls.tracksOpen && activeService !== null ? (
      <TrackPickerModal
        tracks={tracks}
        cursor={controls.pickerCursor}
        isTv={isTv}
        formFactor={formFactor}
        i18n={i18n}
        onSelectAudio={controls.selectAudio}
        onSelectSubtitle={controls.selectSubtitle}
        onClose={controls.closeTracks}
      />
    ) : null;

  const settingsSheetNode = (
    <PlayerSettingsSheet
      visible={controls.settingsOpen && activeService !== null}
      menuState={controls.settingsMenu}
      tracks={tracks}
      isVod={activeTarget.kind === 'vod'}
      playbackSpeed={controls.playbackSpeed}
      {...(!isDesktop
        ? { resizeMode: controls.resizeMode, onToggleResizeMode: controls.toggleResizeMode }
        : {})}
      statsVisible={controls.statsVisible}
      isTv={isTv}
      formFactor={formFactor}
      i18n={i18n}
      onOpenView={controls.openSettingsView}
      onSelectAudio={controls.selectAudio}
      onSelectSubtitle={controls.selectSubtitle}
      onSelectSpeed={controls.selectSpeed}
      onToggleStats={controls.toggleStats}
      onClose={controls.closeSettings}
    />
  );

  const osdNode = (
    <PlayerOsd
      title={activeTarget.title}
      subtitle={activeTarget.subtitle}
      statusLine={statusLine}
      failure={failure}
      isVod={activeTarget.kind === 'vod'}
      isPausedOrEnded={controls.isPausedOrEnded}
      canZap={canZap}
      hasTracks={hasTracks}
      hasPreviousChannel={hasPreviousChannel}
      canLock={controls.canLock}
      showRetry={showRetry}
      isTv={isTv}
      isDesktop={isDesktop}
      muted={controls.muted}
      playbackSpeed={controls.playbackSpeed}
      tvOsdFocused={controls.tvOsdFocused}
      tvScrubberFocused={controls.tvScrubberFocused}
      tvOsdAction={controls.tvOsdAction}
      tracksOpen={controls.tracksOpen}
      settingsOpen={controls.settingsOpen}
      settingsView={controls.settingsMenu.view}
      previewPositionMs={controls.previewPositionMs}
      i18n={i18n}
      service={activeService}
      clock={clock}
      onExit={onExit}
      onTogglePlayPause={controls.togglePlayPause}
      onSeekBack={controls.seekStepBack}
      onSeekForward={controls.seekStepForward}
      onSeekRatio={controls.seekToRatio}
      onScrubbingChange={controls.setBarScrubbing}
      onOpenTracks={controls.openTracks}
      onOpenSettings={() =>
        controls.settingsOpen ? controls.closeSettings() : controls.openSettings()
      }
      onOpenSpeed={() =>
        controls.settingsOpen && controls.settingsMenu.view === 'speed'
          ? controls.closeSettings()
          : controls.openSettings('speed')
      }
      {...(hostToggleMute !== undefined ? { onToggleMute: controls.toggleMute } : {})}
      {...(hostToggleFullscreen !== undefined
        ? { onToggleFullscreen: controls.toggleFullscreen }
        : {})}
      onLock={controls.lockControls}
      onJumpPreviousChannel={handleJumpPreviousChannel}
      onPrev={() => zapBy(-1)}
      onNext={() => zapBy(1)}
      onRetry={controls.retry}
    />
  );

  const touchHoverProps = buildTouchHoverProps(
    controls.handleTouchActivity,
    controls.handlePointerHover,
  );
  const isWebDesktop = isDesktop && (Platform.OS as string) === 'web';
  const hideDesktopCursor =
    isWebDesktop &&
    controls.osdHidden &&
    status.kind === 'playing' &&
    !controls.tracksOpen &&
    !controls.settingsOpen;
  const desktopContextMenuProps = isWebDesktop
    ? ({
        onContextMenu: (e?: { preventDefault?: () => void }) => {
          e?.preventDefault?.();
        },
      } as Record<string, unknown>)
    : undefined;
  const subtitleBottomInsetPx =
    !isDesktop && !controls.osdHidden && !controls.locked ? (isTv ? 120 : 96) : 0;
  const showTouchCanvasTap =
    !isTv && !isDesktop && !controls.locked && !controls.tracksOpen && !controls.settingsOpen;

  return (
    <View
      testID="player-screen"
      style={[
        playerStyles.root,
        { backgroundColor: theme.colors.bgCanvas },
        hideDesktopCursor ? HIDE_CURSOR_WEB_STYLE : undefined,
      ]}
      {...controls.desktopFallbackKeyProps}
      {...touchHoverProps}
      {...desktopContextMenuProps}
    >
      {isTv ? (
        <View
          testID="player-tv-focus-anchor"
          focusable
          hasTVPreferredFocus
          style={playerStyles.tvFocusAnchor}
        />
      ) : null}

      {sessionState.kind === 'ready' ? (
        <View
          testID="player-surface-layer"
          style={isDesktop ? playerStyles.surfaceLayerDesktop : playerStyles.surfaceLayer}
        >
          {sessionState.opened.renderSurface({
            statusText: `${activeTarget.title} — ${statusLine}`,
            failed: status.kind === 'failed',
            resizeMode: controls.resizeMode,
            subtitleBottomInsetPx,
            testID: 'player-surface',
          })}
        </View>
      ) : null}

      {showTouchCanvasTap ? (
        <PlayerCanvasTapTarget
          onTouchActivity={controls.handleTouchActivity}
          onToggleOsd={controls.toggleOsdByTouch}
        />
      ) : null}

      <PlayerStatsHud
        visible={controls.statsVisible}
        service={activeService}
        clock={clock}
        i18n={i18n}
        isDesktop={isDesktop}
      />

      {isDesktop ? (
        <>
          {nextEpisodeNode}
          {trackPickerNode}
          {settingsSheetNode}
          {controls.osdHidden ? null : osdNode}
        </>
      ) : controls.locked ? (
        <PlayerLockedOverlay i18n={i18n} onUnlock={controls.unlockControls} />
      ) : (
        <>
          <View
            pointerEvents="box-none"
            style={
              nextEpisodeVisible
                ? isTv
                  ? playerStyles.nextEpisodeOverlayTv
                  : playerStyles.nextEpisodeOverlay
                : undefined
            }
          >
            {nextEpisodeNode}
          </View>
          {controls.osdHidden ? null : osdNode}
          {trackPickerNode}
          {settingsSheetNode}
        </>
      )}
    </View>
  );
}
