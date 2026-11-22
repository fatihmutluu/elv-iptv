import type { CatalogService } from '@elv/data';
import type { BufferPreset } from '@elv/domain';
import {
  type PlaybackClock,
  type PlaybackService,
  type PlaybackTimers,
  positionAt,
} from '@elv/playback';
import { MicroPill, TvFocusAnchor, useFormFactor, useI18n, useTheme } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { type AppLifecyclePort, noopAppLifecycle } from '../ports/app-lifecycle';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import type { PlaybackGuard } from '../ports/playback-guard';
import type { HostKey, VideoHost } from '../ports/video-host';
import { describePlaybackFailure } from './errors';
import { NextEpisodeBanner } from './NextEpisodeBanner';
import { PlayerChannelDrawer } from './PlayerChannelDrawer';
import { PlayerInfoSheet } from './PlayerInfoSheet';
import {
  DEFAULT_PLAYER_CLOCK,
  DEFAULT_PLAYER_TIMERS,
  formatStatusLine,
  HIDE_CURSOR_WEB_STYLE,
  PlayerLockedOverlay,
  PlayerOsd,
  playerStyles,
} from './PlayerScreenParts';
import { PlayerSettingsSheet } from './PlayerSettingsSheet';
import { PlayerStatsHud } from './PlayerStatsHud';
import { PlayerTouchGestures } from './PlayerTouchGestures';
import { TrackPickerModal } from './TrackPickerModal';
import { buildTouchHoverProps } from './touch-hover-guard';
import { useNextEpisodeResolver } from './useNextEpisodeResolver';
import { usePlayerControls } from './usePlayerControls';
import { usePlayerNowNext } from './usePlayerNowNext';
import { usePlayerSession } from './usePlayerSession';
import { usePlayerTargetHandoff } from './usePlayerTargetHandoff';
import { useWatchProgressSync } from './useWatchProgressSync';

/** Default production OSD auto-hide delay in milliseconds (`#421`). */
export const DEFAULT_AUTO_HIDE_OSD_MS = 3_500;

/** Props of {@link PlayerScreen}. */
export interface PlayerScreenProps {
  catalog: Pick<CatalogService, 'resolveStream' | 'getProgress' | 'saveProgress'> &
    Partial<Pick<CatalogService, 'channelByNumber' | 'nowNext' | 'queryNextEpisode'>> & {
      readonly epgNowNext?: CatalogService['nowNext'];
    };
  videoHost: VideoHost;
  target: PlayTarget;
  playbackGuard?: PlaybackGuard;
  appLifecycle?: AppLifecyclePort;
  clock?: PlaybackClock;
  timers?: PlaybackTimers;
  initialOsdHidden?: boolean;
  autoHideOsdMs?: number;
  /** Persisted player volume (`0`–`100`, `#394`). */
  initialVolume?: number;
  /** Persists user volume changes (`0`–`100`, `#394`). */
  onPersistVolume?: (volume: number) => void;
  /** Temporarily turns on subtitles on VOD backward skip (`#114`). */
  autoSubtitlesOnSkipBack?: boolean;
  /** Toggles persisted `autoSubtitlesOnSkipBack` preference (`#114`). */
  onToggleAutoSubtitlesOnSkipBack?: () => void;
  /** Automatically advances to the next episode after countdown (`#392`). */
  autoPlayNextEpisode?: boolean;
  /** Disables smooth motion transitions when reduced motion is enabled (`#392`). */
  reduceMotion?: boolean;
  /** User-selected playback buffer preset forwarded on load (`#147`). */
  bufferPreset?: BufferPreset;
  /** Opt-in TextureView fallback for broken Android SurfaceView compositing (`#262`). */
  useTextureView?: boolean;
  onTargetChange?: (next: PlayTarget) => void;
  onExit: () => void;
}

/** Cross-platform Cinema Quietude v2 playback screen over injected {@link VideoHost} and {@link AppLifecyclePort} ports. */
export function PlayerScreen({
  catalog,
  videoHost,
  target,
  playbackGuard,
  appLifecycle = noopAppLifecycle,
  clock = DEFAULT_PLAYER_CLOCK,
  timers = DEFAULT_PLAYER_TIMERS,
  initialOsdHidden,
  autoHideOsdMs,
  initialVolume,
  onPersistVolume,
  autoSubtitlesOnSkipBack,
  onToggleAutoSubtitlesOnSkipBack,
  autoPlayNextEpisode,
  reduceMotion,
  bufferPreset = 'auto',
  useTextureView = false,
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
  const resolvedNextEpisodeRef = useRef<PlayableEntry | undefined>(undefined);
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
  const bufferPresetRef = useRef<BufferPreset>(bufferPreset);
  bufferPresetRef.current = bufferPreset;

  const handoff = usePlayerTargetHandoff({
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
    bufferPresetRef,
    resolvedNextEpisodeRef,
  });
  const { activeTarget, zapBy, jumpToChannel } = handoff;

  const zapByRef = useRef<(delta: 1 | -1, repeat?: boolean) => void>(zapBy);
  zapByRef.current = zapBy;
  const hostKeyRef = useRef<(key: HostKey) => void>((key) => {
    if (key === 'back') onExitRef.current();
  });

  const {
    sessionState,
    activeService,
    status,
    tracks,
    videoInfo,
    surfaceRecreationToken,
    inPip,
    isFullscreen,
  } = usePlayerSession({
    videoHost,
    activeTarget,
    serviceRef,
    clockRef,
    timersRef,
    hostKeyRef,
    onExitRef,
    onServiceReady: handoff.onServiceReady,
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

  const nowNext = usePlayerNowNext({
    catalog,
    itemKey: activeTarget.itemKey,
    enabled: activeTarget.kind === 'live' && !inPip,
    clock,
  });
  const nextEpisode = useNextEpisodeResolver({ catalog, activeTarget });
  resolvedNextEpisodeRef.current = nextEpisode;

  const [nextEpisodeDismissed, setNextEpisodeDismissed] = useState(false);
  const [nextEpisodeVisible, setNextEpisodeVisible] = useState(false);
  const [brightness, setBrightness] = useState(1);
  const [touchScrubDeltaMs, setTouchScrubDeltaMs] = useState<number | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per-item transient UI on item change
  useEffect(() => {
    setNextEpisodeDismissed(false);
    setNextEpisodeVisible(false);
    setTouchScrubDeltaMs(undefined);
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
  const openedEngine = sessionState.kind === 'ready' ? sessionState.opened : undefined;
  const hostToggleFullscreen = openedEngine?.toggleFullscreen;
  const hostToggleMute = openedEngine?.toggleMute;
  const hostSetVolume = openedEngine?.setVolume;
  const hostSetBrightness = openedEngine?.setBrightness;
  const hostSetOrientationLocked = openedEngine?.setOrientationLocked;
  const hostSetDeinterlace = openedEngine?.setDeinterlace;

  const controls = usePlayerControls({
    formFactor,
    activeTarget,
    status,
    tracks,
    hasTracks,
    showRetry,
    hasService: activeService !== null,
    hasSettings: activeService !== null,
    hasInfo: activeService !== null,
    hasChannelList: canZap,
    hasNextEpisode: nextEpisodeVisible,
    hasPreviousChannel,
    initialOsdHidden,
    autoHideOsdMs,
    initialVolume: initialVolume ?? openedEngine?.initialVolume,
    autoSubtitlesOnSkipBack,
    serviceRef,
    clockRef,
    timersRef,
    onExitRef,
    zapByRef,
    onSeekCommit: flushProgress,
    onPlayNextEpisode: () => handoff.handlePlayNextEpisode(undefined, nextEpisode),
    onJumpPreviousChannel: handoff.handleJumpPreviousChannel,
    onJumpToChannel: jumpToChannel,
    onToggleFullscreen: hostToggleFullscreen,
    onToggleMute: hostToggleMute,
    onSetVolume: hostSetVolume,
    onPersistVolume,
    onToggleAutoSubtitlesOnSkipBack,
    onSetOrientationLocked: hostSetOrientationLocked,
    onSetDeinterlace: hostSetDeinterlace,
  });
  hostKeyRef.current = controls.handleHostKey;
  cancelScrubRef.current = controls.cancelScrub;

  const fetchChannelNowNext = useCallback(async (itemKey: string) => {
    const query = catalogRef.current.nowNext ?? catalogRef.current.epgNowNext;
    if (query === undefined) return null;
    const rows = await query([itemKey], clockRef.current.now());
    return rows.find((r) => r.channelKey === itemKey) ?? rows[0] ?? null;
  }, []);

  const anchor = activeService?.getState().anchor;
  const currentPosMs = anchor !== undefined ? positionAt(anchor, clock.now()) : undefined;
  const durationMs = anchor?.durationMs;
  const effectivePreviewMs =
    touchScrubDeltaMs !== undefined && currentPosMs !== undefined && durationMs !== undefined
      ? Math.max(0, Math.min(durationMs, currentPosMs + touchScrubDeltaMs))
      : controls.previewPositionMs;

  const handleBrightnessChange = (next: number): void => {
    const clamped = Math.max(0.15, Math.min(1, next));
    setBrightness(clamped);
    hostSetBrightness?.(clamped);
  };
  const handleTouchScrubCommit = (deltaMs: number): void => {
    const latestAnchor = serviceRef.current?.getState().anchor;
    const dur = latestAnchor?.durationMs;
    if (latestAnchor !== undefined && dur !== undefined && dur > 0) {
      const targetMs = Math.max(0, Math.min(dur, positionAt(latestAnchor, clock.now()) + deltaMs));
      controls.seekToRatio(targetMs / dur);
      if (controls.osdHidden) controls.showProgressOsd();
    }
  };

  const anySheetOpen =
    controls.tracksOpen || controls.settingsOpen || controls.infoOpen || controls.channelListOpen;
  const isWebDesktop = isDesktop && (Platform.OS as string) === 'web';
  const hideDesktopCursor =
    isWebDesktop && controls.osdHidden && status.kind === 'playing' && !anySheetOpen;
  const desktopWebProps = isWebDesktop
    ? ({
        onContextMenu: (e?: { preventDefault?: () => void }) => {
          e?.preventDefault?.();
        },
        onWheel: (e?: {
          deltaY?: number;
          nativeEvent?: { deltaY?: number };
          preventDefault?: () => void;
        }) => {
          if (controls.handleWheelVolume(e?.deltaY ?? e?.nativeEvent?.deltaY ?? 0)) {
            e?.preventDefault?.();
          }
        },
      } as Record<string, unknown>)
    : undefined;
  const touchHoverProps = buildTouchHoverProps(
    controls.handleTouchActivity,
    controls.handlePointerHover,
  );
  const osdVisible = !inPip && !controls.osdHidden && !controls.locked;
  const subtitleBottomInsetPx =
    !isDesktop && osdVisible ? (isTv ? 120 : controls.osdTier === 'progress' ? 64 : 96) : 0;
  const showTouchGestures = !inPip && !isTv && !isDesktop && !controls.locked && !anySheetOpen;

  const surfaceNode =
    sessionState.kind === 'ready' ? (
      <View
        testID="player-surface-layer"
        style={isDesktop ? playerStyles.surfaceLayerDesktop : playerStyles.surfaceLayer}
      >
        {sessionState.opened.renderSurface({
          statusText: `${activeTarget.title} — ${statusLine}`,
          failed: status.kind === 'failed',
          resizeMode: controls.resizeMode,
          subtitleBottomInsetPx,
          surfaceRecreationToken,
          useTextureView,
          osdVisible,
          testID: 'player-surface',
        })}
      </View>
    ) : null;

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
      {...(autoPlayNextEpisode !== undefined ? { autoPlayNextEpisode } : {})}
      {...(reduceMotion !== undefined ? { reduceMotion } : {})}
      timers={timers}
      onPlayNext={(expectedKey) => handoff.handlePlayNextEpisode(expectedKey, nextEpisode)}
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

  const infoSheetNode = (
    <PlayerInfoSheet
      visible={controls.infoOpen && activeService !== null}
      title={activeTarget.title}
      subtitle={activeTarget.subtitle}
      isVod={activeTarget.kind === 'vod'}
      nowNext={nowNext}
      videoInfo={videoInfo}
      tracks={tracks}
      formFactor={formFactor}
      isTv={isTv}
      i18n={i18n}
      nowMs={clock.now()}
      onClose={controls.closeInfo}
    />
  );

  const channelDrawerNode = (
    <PlayerChannelDrawer
      visible={controls.channelListOpen && canZap}
      playlist={activeTarget.playlist}
      currentItemKey={activeTarget.itemKey}
      formFactor={formFactor}
      isTv={isTv}
      i18n={i18n}
      fetchNowNext={fetchChannelNowNext}
      onSelectChannel={(entry, index) => {
        handoff.selectChannel(entry, index);
        controls.closeChannelList();
      }}
      onClose={controls.closeChannelList}
    />
  );

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
      {...(hostSetDeinterlace !== undefined
        ? { deinterlace: controls.deinterlace, onToggleDeinterlace: controls.toggleDeinterlace }
        : {})}
      {...(onToggleAutoSubtitlesOnSkipBack !== undefined
        ? {
            autoSubtitlesOnSkipBack: autoSubtitlesOnSkipBack === true,
            onToggleAutoSubtitlesOnSkipBack,
          }
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
      channelDigits={controls.channelDigits}
      statusLine={statusLine}
      statusKind={sessionState.kind === 'unavailable' ? 'idle' : status.kind}
      osdTier={controls.osdTier}
      isBuffering={status.kind === 'tuning' || status.kind === 'recovering'}
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
      volume={controls.volume}
      isFullscreen={isFullscreen}
      playbackSpeed={controls.playbackSpeed}
      videoInfo={videoInfo}
      tracks={tracks}
      nowNext={nowNext}
      tvOsdFocused={controls.tvOsdFocused}
      tvScrubberFocused={controls.tvScrubberFocused}
      tvOsdAction={controls.tvOsdAction}
      tracksOpen={controls.tracksOpen}
      settingsOpen={controls.settingsOpen}
      settingsView={controls.settingsMenu.view}
      infoOpen={controls.infoOpen}
      channelListOpen={controls.channelListOpen}
      previewPositionMs={effectivePreviewMs}
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
      onToggleInfo={controls.toggleInfo}
      {...(canZap ? { onToggleChannelList: controls.toggleChannelList } : {})}
      {...(hostToggleMute !== undefined ? { onToggleMute: controls.toggleMute } : {})}
      onSetVolume={controls.setVolume}
      {...(hostToggleFullscreen !== undefined
        ? { onToggleFullscreen: controls.toggleFullscreen }
        : {})}
      onLock={controls.lockControls}
      onJumpPreviousChannel={handoff.handleJumpPreviousChannel}
      onJumpToLiveEdge={controls.jumpToLiveEdge}
      onPrev={() => zapBy(-1)}
      onNext={() => zapBy(1)}
      onRetry={controls.retry}
    />
  );

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
      {...desktopWebProps}
    >
      {isTv ? (
        <TvFocusAnchor
          testID="player-tv-focus-anchor"
          hasTVPreferredFocus={!anySheetOpen && !controls.locked}
        />
      ) : null}

      {isDesktop ? (
        <View testID="player-desktop-stage" style={playerStyles.desktopStageRow}>
          {!inPip ? channelDrawerNode : null}
          {surfaceNode}
        </View>
      ) : (
        surfaceNode
      )}

      {showTouchGestures ? (
        <PlayerTouchGestures
          isVod={activeTarget.kind === 'vod'}
          volume={controls.volume}
          brightness={brightness}
          durationMs={durationMs}
          positionMs={currentPosMs}
          i18n={i18n}
          onTouchActivity={controls.handleTouchActivity}
          onSingleTap={controls.toggleOsdByTouch}
          {...(activeTarget.kind === 'vod'
            ? {
                onDoubleTapSeek: (deltaMs) => {
                  if (deltaMs < 0) controls.seekStepBack();
                  else controls.seekStepForward();
                },
                onScrubPreview: setTouchScrubDeltaMs,
                onScrubCommit: handleTouchScrubCommit,
                onHoldSpeedStart: controls.startHoldSpeed,
                onHoldSpeedEnd: controls.endHoldSpeed,
              }
            : {})}
          onVolumeChange={controls.setVolume}
          onBrightnessChange={handleBrightnessChange}
        />
      ) : null}

      {controls.holdSpeedActive && !showTouchGestures ? (
        <View pointerEvents="none" style={playerStyles.holdSpeedWrap}>
          <MicroPill
            testID="player-hold-speed-pill"
            label={i18n.t('player.holdSpeedActive')}
            tone="accent"
          />
        </View>
      ) : null}

      <PlayerStatsHud
        visible={!inPip && controls.statsVisible}
        service={activeService}
        clock={clock}
        i18n={i18n}
        isDesktop={isDesktop}
      />

      {inPip ? null : isDesktop ? (
        <>
          {nextEpisodeNode}
          {trackPickerNode}
          {infoSheetNode}
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
          {channelDrawerNode}
          {trackPickerNode}
          {infoSheetNode}
          {settingsSheetNode}
        </>
      )}
    </View>
  );
}
