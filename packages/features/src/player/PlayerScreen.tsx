import { useFormFactor, useI18n } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { noopAppLifecycle } from '../ports/app-lifecycle';
import { describePlaybackFailure } from './errors';
import { useLiveTimeShiftState } from './LiveTimeShiftBar';
import { targetIdentityKey } from './live-timeshift-model';
import {
  buildDesktopWebProps,
  buildPlayerStageCallbacks,
  computeSubtitleBottomInsetPx,
  DEFAULT_PLAYER_CLOCK,
  DEFAULT_PLAYER_TIMERS,
  formatStatusLine,
  PlayerSurfaceLayer,
  resolveTargetCapabilities,
  useLatestRef,
  usePlayerScreenRefs,
  usePlayerTouchScrubAndBrightness,
  usePreviewOsdAndResizeSync,
} from './PlayerScreenParts';
import { buildPlayerOverlayNodes } from './PlayerScreenSheets';
import { type PlayerScreenProps, PlayerScreenStage } from './PlayerScreenStage';
import { buildPlayerOsdProps } from './player-osd-props';
import { buildTouchHoverProps } from './touch-hover-guard';
import { usePlayerLiveVariantsAndElvQuality } from './useElvQualityReporting';
import { useGaplessEpisodeQueue } from './useGaplessEpisodeQueue';
import { useNextEpisodeResolver } from './useNextEpisodeResolver';
import { usePlayerCinemaExtras } from './usePlayerCinemaExtras';
import { usePlayerControls } from './usePlayerControls';
import { usePlayerDisplayAndAudioSync } from './usePlayerDisplayAndAudioSync';
import { usePlayerNowNext } from './usePlayerNowNext';
import { usePlayerParentalUnlock } from './usePlayerParentalUnlock';
import { usePlayerPip, usePlayerWindowHandoff, useRestoreOsdOnToken } from './usePlayerPip';
import { usePlayerSession } from './usePlayerSession';
import { usePlayerSubtitlesSuite } from './usePlayerSubtitlesSuite';
import { usePlayerSyncAndQuality } from './usePlayerSyncAndQuality';
import { usePlayerTargetHandoff } from './usePlayerTargetHandoff';
import {
  useAndroidDecoderModeSync,
  useInitialTrackSelection,
} from './usePlayerTrackAndDecoderSync';
import { usePlayerTvPan } from './useTvPanGesture';
import { useWatchProgressSync } from './useWatchProgressSync';

export type { PlayerScreenProps };

/** Default production OSD auto-hide delay in milliseconds (`#421`). */
export const DEFAULT_AUTO_HIDE_OSD_MS = 3_500;

/** Cross-platform Minimalist Cinema playback screen over injected {@link VideoHost} and {@link AppLifecyclePort} ports. */
export function PlayerScreen(props: PlayerScreenProps): ReactElement {
  const {
    catalog,
    videoHost,
    target,
    playbackGuard,
    onExit,
    appLifecycle = noopAppLifecycle,
    clock = DEFAULT_PLAYER_CLOCK,
    wallClock = Date.now,
    timers = DEFAULT_PLAYER_TIMERS,
    initialOsdHidden,
    autoHideOsdMs,
    initialVolume,
    bufferPreset = 'auto',
    useTextureView = false,
    seekStepSec = 10,
    defaultResizeMode = 'fit',
    preferDefaultAudioTrack = true,
    preferHevcOverDolbyVision = false,
    filterSdhSubtitles = false,
    subtitleMode = 'smart',
    subtitleFontFamily = 'system',
    tvClockMode = 'always',
    sleepTimerDefaultAction = 'stop',
    stillWatchingTimeoutMin = 0,
    liveChannelSwitchMode = 'instant',
    backgroundAudioPlayback = false,
    viewMode = 'full',
    autoEnterPip = true,
    multiViewSupported = false,
    restoreCursorToken = 0,
    tvBackMinimizesLive,
  } = props;
  const formFactor = useFormFactor();
  const i18n = useI18n();
  const isTv = formFactor === 'tv';
  const isDesktop = formFactor === 'desktop';
  const isMini = viewMode === 'mini';
  const effectiveBackgroundAudio = !isTv && !isDesktop && backgroundAudioPlayback;

  const refs = usePlayerScreenRefs({
    props,
    clock,
    wallClock,
    timers,
    bufferPreset,
    preferHevcOverDolbyVision,
    filterSdhSubtitles,
    liveChannelSwitchMode,
    effectiveBackgroundAudio,
  });
  const { serviceRef, catalogRef, clockRef, timersRef, onExitRef } = refs;
  const { decoderModeRef, activeDecoderMode, showAndroidDecoder, handleSelectAndroidDecoderMode } =
    useAndroidDecoderModeSync({
      androidDecoderMode: props.androidDecoderMode,
      onSelectAndroidDecoderMode: props.onSelectAndroidDecoderMode,
      reloadActiveTarget: () => refs.reloadActiveTargetRef.current(),
    });

  const handoff = usePlayerTargetHandoff({
    target,
    playbackGuard,
    appLifecycle,
    catalogRef,
    serviceRef,
    clockRef,
    timersRef,
    flushProgressRef: refs.flushProgressRef,
    flushEndedProgressRef: refs.flushEndedProgressRef,
    cancelScrubRef: refs.cancelScrubRef,
    onTargetChangeRef: refs.onTargetChangeRef,
    bufferPresetRef: refs.bufferPresetRef,
    decoderModeRef,
    preferHevcOverDolbyVisionRef: refs.preferHevcRef,
    filterSdhSubtitlesRef: refs.filterSdhRef,
    subtitleStyleRef: refs.subtitleStyleRef,
    liveChannelSwitchModeRef: refs.switchModeRef,
    resolvedNextEpisodeRef: refs.resolvedNextEpisodeRef,
    backgroundAudioPlaybackRef: refs.backgroundAudioRef,
    onRegisterStopActivePlayer: props.onRegisterStopActivePlayer,
  });
  refs.reloadActiveTargetRef.current = handoff.reloadActiveTarget;
  const { activeTarget, previewTarget, zapBy, jumpToChannel } = handoff;

  const zapByRef = useLatestRef(zapBy);

  const nextEpisode = useNextEpisodeResolver({ catalog, activeTarget });
  refs.resolvedNextEpisodeRef.current = nextEpisode;

  const session = usePlayerSession({
    videoHost,
    activeTarget,
    isDesktop,
    subtitleFontFamily,
    deinterlaceMode: props.deinterlaceMode,
    pitchLock: props.pitchLock,
    audioNormalization: props.audioNormalization,
    backgroundAudioPlayback: effectiveBackgroundAudio,
    windowAspectRatioLock: props.windowAspectRatioLock,
    onWindowAspectRatioLockChange: props.onWindowAspectRatioLockChange,
    canAcquireAlternate: props.canAcquireAlternate,
    adoptedSession: props.adoptedSession,
    adoptEngineId: props.adoptEngineId,
    onConsumeAdoptedSession: props.onConsumeAdoptedSession,
    handoffModeRef: refs.handoffModeRef,
    catalogRef,
    serviceRef,
    clockRef,
    timersRef,
    hostKeyRef: refs.hostKeyRef,
    onExitRef,
    waveF7aLoadOptionsRef: refs.waveF7aLoadOptionsRef,
    onServiceReady: handoff.onServiceReady,
  });
  const { sessionState, activeService, status, tracks, videoInfo } = session;
  const { surfaceRecreationToken, inPip, isFullscreen, overlayMode } = session;
  const { audioDevices, activeAudioDevice, subtitleDelayMs, externalPlaybackActive } = session;

  const { flushProgress, flushEndedProgress } = useWatchProgressSync({
    activeTarget,
    status,
    serviceRef,
    catalogRef,
    clockRef,
    timersRef,
  });
  refs.flushProgressRef.current = flushProgress;
  refs.flushEndedProgressRef.current = flushEndedProgress;

  const nowNext = usePlayerNowNext({
    catalog,
    itemKey: previewTarget?.itemKey ?? activeTarget.itemKey,
    enabled: activeTarget.kind === 'live' && !inPip && !isMini,
    wallClock,
  });
  const quality = usePlayerLiveVariantsAndElvQuality({
    catalog,
    activeTarget,
    status,
    videoInfo,
    verifyRealQuality: props.elvVerifyRealQuality,
    elvLiveEnhance: props.elvLiveEnhance,
    onSelectVariant: handoff.selectQualityVariant,
  });

  const [nextEpisodeDismissed, setNextEpisodeDismissed] = useState(false);
  const [nextEpisodeVisible, setNextEpisodeVisible] = useState(false);

  const activeTargetKey = targetIdentityKey(activeTarget);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per-item transient UI on item or catch-up/live transition
  useEffect(() => {
    setNextEpisodeDismissed(false);
    setNextEpisodeVisible(false);
  }, [activeTargetKey]);

  const openedEngine = sessionState.kind === 'ready' ? sessionState.opened : undefined;
  const displayAudioSync = usePlayerDisplayAndAudioSync({
    activeItemKey: activeTarget.itemKey,
    openedEngine,
    activeService,
    statusKind: status.kind,
    fps: videoInfo?.fps,
    timersRef,
    preferences: props,
  });
  const pip = usePlayerPip({
    openedEngine,
    statusKind: status.kind,
    videoInfo,
    autoEnterPip,
    onMinimizeToMiniPlayer: props.onMinimizeToMiniPlayer,
  });
  const handleEnterPip = pip.canShowPipAction ? () => pip.enterPip() : undefined;
  const handleEnterMultiView =
    multiViewSupported && props.onEnterMultiView !== undefined
      ? () => props.onEnterMultiView?.(activeTarget)
      : undefined;
  const mutedStateRef = useRef(props.adoptedSession?.muted === true);
  const volumeStateRef = useRef(props.adoptedSession?.volume ?? initialVolume ?? 100);
  const { handlePopoutPlayer, handleDockPopout } = usePlayerWindowHandoff({
    openedEngine,
    activeService,
    activeTarget,
    mutedRef: mutedStateRef,
    volumeRef: volumeStateRef,
    handoffModeRef: refs.handoffModeRef,
    serviceRef,
    clockRef,
    flushProgress,
    onRegisterHandoffSession: props.onRegisterHandoffSession,
    onPopoutPlayer: props.onPopoutPlayer,
    onDockPopout: props.onDockPopout,
  });
  const subtitlesSuite = usePlayerSubtitlesSuite({
    activeItemKey: activeTarget.itemKey,
    tracks,
    openedEngine,
    activeService,
    serviceRef,
    timersRef,
    subtitleStyleRef: refs.subtitleStyleRef,
    subtitleStyleProp: props.subtitleStyle,
    onPersistSubtitleStyle: props.onPersistSubtitleStyle,
  });
  const syncAndQuality = usePlayerSyncAndQuality({
    activeTarget,
    tracks,
    openedEngine,
    audioDelayMs: displayAudioSync.manualAudioDelayMs,
    onChangeManualAudioDelayMs: displayAudioSync.setManualAudioDelayMs,
    subtitleDelayMs,
    selectedVideoQualityId: session.selectedVideoQualityId,
    serviceRef,
    catalogRef,
  });
  const { isGaplessArmed } = useGaplessEpisodeQueue({
    activeTarget,
    nextEpisode,
    autoPlayNextEpisode: props.autoPlayNextEpisode,
    statusKind: status.kind,
    openedEngine,
    catalogRef,
    preferHevcOverDolbyVision,
    filterSdhSubtitles,
    onQueueAdvanced: handoff.handleQueueAdvanced,
  });
  const extras = usePlayerCinemaExtras({
    activeTarget,
    status,
    tracks,
    openedEngine,
    catalogRef,
    wallClockRef: refs.wallClockRef,
    serviceRef,
    clockRef,
    timersRef,
    flushProgressRef: refs.flushProgressRef,
    onExitRef,
    filterSdhSubtitles,
    onPersistResizeMode: props.onPersistResizeMode,
    sleepTimerDefaultAction,
    onPersistSleepTimerAction: props.onPersistSleepTimerAction,
    stillWatchingTimeoutMin,
    onPlaybackActiveChange: props.onPlaybackActiveChange,
    deinterlaceMode: props.deinterlaceMode,
    onPersistDeinterlaceMode: props.onPersistDeinterlaceMode,
    pitchLock: props.pitchLock,
    onPersistPitchLock: props.onPersistPitchLock,
    audioNormalization: props.audioNormalization,
    onPersistAudioNormalization: props.onPersistAudioNormalization,
    initialVolume: props.adoptedSession?.volume ?? initialVolume,
    preferredAudioDevice: props.preferredAudioDevice,
    preferredAudioLanguages: props.preferredAudioLanguages,
    preferredSubtitleLanguages: props.preferredSubtitleLanguages,
    subtitleMode: props.subtitleMode,
    onPersistTrackLanguagePatch: props.onPersistTrackLanguagePatch,
  });

  const hasTracks =
    tracks.audio.length > 0 ||
    tracks.subtitles.length > 0 ||
    (tracks.programs?.length ?? 0) > 1 ||
    subtitlesSuite.supportsExternalSubtitles;
  const showRetry = status.kind === 'failed' && activeService !== null;
  const statusLine =
    sessionState.kind === 'unavailable'
      ? i18n.t('player.unavailable')
      : formatStatusLine(status, i18n);
  const failure = status.kind === 'failed' ? describePlaybackFailure(status.error) : null;
  const { canZap, hasPreviousChannel, isCatchup } = resolveTargetCapabilities(activeTarget);
  const selectAudioDevice = useCallback(
    (name: string) => {
      openedEngine?.setAudioDevice?.(name);
      props.onPersistAudioDevice?.(name);
    },
    [openedEngine, props.onPersistAudioDevice],
  );
  const isPausedOrEndedStatus = status.kind === 'paused' || status.kind === 'ended';
  const liveTimeShift = useLiveTimeShiftState(
    activeService,
    clock,
    activeTarget.kind === 'live',
    isPausedOrEndedStatus,
  );

  const controls = usePlayerControls({
    formFactor,
    activeTarget,
    status,
    tracks,
    hasTracks,
    showRetry,
    hasService: activeService !== null,
    hasSettings: activeService !== null,
    hasChannelList: canZap,
    hasNextEpisode: !isCatchup && (nextEpisodeVisible || nextEpisode !== undefined),
    hasPreviousChannel,
    hasBackToLive: isCatchup,
    liveTimeShiftSupported: activeTarget.kind === 'live' && liveTimeShift.supported,
    hasJumpToLive: activeTarget.kind === 'live' && liveTimeShift.showJumpToLive,
    initialOsdHidden,
    autoHideOsdMs,
    initialMuted: props.adoptedSession?.muted,
    initialVolume: props.adoptedSession?.volume ?? initialVolume ?? openedEngine?.initialVolume,
    autoSubtitlesOnSkipBack: props.autoSubtitlesOnSkipBack,
    seekStepSec,
    defaultResizeMode,
    serviceRef,
    clockRef,
    timersRef,
    onExitRef,
    zapByRef,
    onSeekCommit: flushProgress,
    onPlayNextEpisode: () => handoff.handlePlayNextEpisode(undefined, nextEpisode),
    onBackToLive: handoff.handleBackToLive,
    onJumpPreviousChannel: handoff.handleJumpPreviousChannel,
    qualityVariants: quality.variants,
    onSelectQualityVariant: quality.selectVariant,
    ...syncAndQuality.controlsProps,
    ...subtitlesSuite.controlsProps,
    onJumpToChannel: jumpToChannel,
    onToggleFullscreen: openedEngine?.toggleFullscreen,
    audioDevices,
    activeAudioDevice,
    onSelectAudioDevice: openedEngine?.setAudioDevice !== undefined ? selectAudioDevice : undefined,
    ...(showAndroidDecoder
      ? {
          androidDecoderMode: activeDecoderMode,
          onSelectAndroidDecoderMode: handleSelectAndroidDecoderMode,
        }
      : {}),
    onToggleMute: openedEngine?.toggleMute,
    onSetVolume: openedEngine?.setVolume,
    onPersistVolume: props.onPersistVolume,
    onToggleAutoPlayNextEpisode: props.onToggleAutoPlayNextEpisode,
    onChannelListMove: (delta) => refs.channelDrawerNavRef.current?.move(delta),
    onChannelListSwitchTab: (dir) => refs.channelDrawerNavRef.current?.switchTab(dir),
    onChannelListSelect: () => refs.channelDrawerNavRef.current?.select(),
    onSetOrientationLocked: openedEngine?.setOrientationLocked,
    onSetDeinterlace: openedEngine?.setDeinterlace,
    onCycleDeinterlaceMode: extras.cycleDeinterlaceMode,
    onTogglePitchLock: extras.togglePitchLock,
    onToggleAudioNormalization: extras.toggleAudioNormalization,
    onResizeModeChange: extras.handleResizeModeChange,
    onAudioTrackSelected: extras.handleAudioTrackSelected,
    onSubtitleTrackSelected: extras.handleSubtitleTrackSelected,
    sleepTimerMinutes: extras.sleepTimer.active ? extras.sleepTimer.totalMinutes : 0,
    onSelectSleepTimer: extras.selectSleepTimer,
    onToggleSleepTimerAction: extras.toggleSleepTimerAction,
    onUserActivity: extras.stillWatching.recordUserActivity,
    previewChannelActive: previewTarget !== null,
    onConfirmPreviewChannel: handoff.confirmPreviewChannel,
    onCancelPreviewChannel: handoff.cancelPreviewChannel,
    stillWatchingVisible: !inPip && !isMini && extras.stillWatching.promptVisible,
    onStillWatchingKey: extras.handleStillWatchingKey,
    onMinimizeToMiniPlayer: props.onMinimizeToMiniPlayer,
    onEnterPip: handleEnterPip,
    onEnterMultiView: handleEnterMultiView,
    onPopoutPlayer: handlePopoutPlayer,
    tvBackMinimizesLive: tvBackMinimizesLive ?? Platform.OS === 'ios',
    externalOverlayOpen:
      isMini || props.externalOverlayOpen === true || subtitlesSuite.urlOverlayOpen,
  });
  refs.hostKeyRef.current = controls.handleHostKey;
  refs.cancelScrubRef.current = controls.cancelScrub;
  mutedStateRef.current = controls.muted;
  volumeStateRef.current = controls.volume;
  useRestoreOsdOnToken(restoreCursorToken, isMini, controls.showOsd);

  const handleRetryWithParental = usePlayerParentalUnlock({
    itemKey: activeTarget.itemKey,
    status,
    reloadActiveTarget: handoff.reloadActiveTarget,
    fallbackRetry: controls.retry,
  });

  const setResizeModeRef = useRef(controls.setResizeMode);
  setResizeModeRef.current = controls.setResizeMode;

  useInitialTrackSelection({
    activeService,
    activeTarget,
    tracks,
    catalog,
    preferredAudioLang: props.preferredAudioLang,
    preferredSubtitleLang: props.preferredSubtitleLang,
    preferredAudioLanguages: props.preferredAudioLanguages,
    preferredSubtitleLanguages: props.preferredSubtitleLanguages,
    preferDefaultAudioTrack,
    fallbackLocale: i18n.locale,
    subtitleMode,
    statusKind: status.kind,
    onHydratedResizeMode: (mode) => {
      setResizeModeRef.current(mode, false);
      openedEngine?.setResizeMode?.(mode);
    },
    onHydratedAudioDelayMs: displayAudioSync.setManualAudioDelayMs,
  });

  usePreviewOsdAndResizeSync({
    openedEngine,
    activeItemKey: activeTarget.itemKey,
    statusKind: status.kind,
    resizeMode: controls.resizeMode,
    previewActive: previewTarget !== null,
    osdHidden: controls.osdHidden,
    showOsd: controls.showOsd,
    cancelPreview: handoff.cancelPreviewChannel,
  });

  const touch = usePlayerTouchScrubAndBrightness({
    activeItemKey: activeTarget.itemKey,
    activeService,
    serviceRef,
    clock,
    hostSetBrightness: openedEngine?.setBrightness,
    previewPositionMs: controls.previewPositionMs,
    osdHidden: controls.osdHidden,
    seekToRatio: controls.seekToRatio,
    showProgressOsd: controls.showProgressOsd,
    recordUserActivity: extras.stillWatching.recordUserActivity,
  });

  const anySheetOpen =
    controls.settingsOpen ||
    controls.windowModeOpen ||
    controls.channelListOpen ||
    subtitlesSuite.urlOverlayOpen;
  const recordActivity = extras.stillWatching.recordUserActivity;
  usePlayerTvPan({
    openedEngine,
    isTv,
    hasService: !isMini && activeService !== null,
    isVod: activeTarget.kind === 'vod',
    hasChannelList: canZap,
    anySheetOpen,
    stillWatchingVisible: !inPip && !isMini && extras.stillWatching.promptVisible,
    durationMs: touch.durationMs,
    controls,
    recordActivity,
    setScrubDeltaMs: touch.setTouchScrubDeltaMs,
    commitScrub: touch.handleTouchScrubCommit,
  });
  const isWebDesktop = isDesktop && (Platform.OS as string) === 'web';
  const useDockedDesktopLayout = isDesktop && overlayMode === 'docked';
  const hideDesktopCursor =
    !isMini && isWebDesktop && controls.osdHidden && status.kind === 'playing' && !anySheetOpen;
  const desktopWebProps = buildDesktopWebProps(
    isWebDesktop,
    controls.handleWheelVolume,
    recordActivity,
  );
  const touchHoverProps = buildTouchHoverProps(
    () => {
      recordActivity();
      controls.handleTouchActivity();
    },
    (pt, pos) => {
      recordActivity();
      controls.handlePointerHover(pt, pos);
    },
  );
  const osdVisible = !isMini && !inPip && !controls.osdHidden && !controls.locked;
  const subtitleBottomInsetPx = computeSubtitleBottomInsetPx({
    useDockedDesktopLayout,
    osdVisible,
    isTv,
    osdTier: controls.osdTier,
  });
  const showTouchGestures =
    !isMini && !inPip && !isTv && !isDesktop && !controls.locked && !anySheetOpen;

  const surfaceNode =
    sessionState.kind === 'ready' ? (
      <PlayerSurfaceLayer
        opened={sessionState.opened}
        useDockedDesktopLayout={useDockedDesktopLayout}
        statusText={`${activeTarget.title} — ${statusLine}`}
        failed={status.kind === 'failed'}
        resizeMode={controls.resizeMode}
        subtitleBottomInsetPx={subtitleBottomInsetPx}
        subtitleFontFamily={subtitleFontFamily}
        subtitleStyle={subtitlesSuite.subtitleStyle}
        surfaceRecreationToken={surfaceRecreationToken}
        useTextureView={useTextureView}
        osdVisible={osdVisible}
      />
    ) : null;

  const overlayNodes = buildPlayerOverlayNodes({
    activeTarget,
    nextEpisode,
    nextEpisodeDismissed,
    isGaplessArmed,
    status,
    activeService,
    clock,
    timers,
    isTv,
    formFactor,
    i18n,
    useDockedDesktopLayout,
    canZap,
    tracks,
    hostSetDeinterlace: openedEngine?.setDeinterlace,
    hostSetAudioDevice: openedEngine?.setAudioDevice,
    audioDevices,
    activeAudioDevice,
    selectAudioDevice,
    showAndroidDecoder,
    activeDecoderMode,
    handleSelectAndroidDecoderMode,
    autoPlayNextEpisode: props.autoPlayNextEpisode,
    onToggleAutoPlayNextEpisode: props.onToggleAutoPlayNextEpisode,
    reduceMotion: props.reduceMotion,
    extras,
    hasRecentChannels: catalog.listRecentChannels !== undefined,
    channelDrawerNavRef: refs.channelDrawerNavRef,
    controls,
    qualitySheetProps: quality.sheetProps,
    syncAndQualitySheetProps: syncAndQuality.sheetProps,
    subtitlesSettingsSheetProps: subtitlesSuite.settingsSheetProps,
    onRecordUserActivity: extras.stillWatching.recordUserActivity,
    onPlayNextEpisode: (expectedKey) => handoff.handlePlayNextEpisode(expectedKey, nextEpisode),
    onDismissNextEpisode: () => setNextEpisodeDismissed(true),
    onNextEpisodeVisibilityChange: setNextEpisodeVisible,
    onSelectChannel: handoff.selectChannel,
    onMinimizeToMiniPlayer: props.onMinimizeToMiniPlayer,
    onEnterPip: handleEnterPip,
    onEnterMultiView: handleEnterMultiView,
    onPopoutPlayer: handlePopoutPlayer,
  });

  const osdProps = buildPlayerOsdProps({
    activeTarget,
    previewTarget,
    statusLine,
    sessionUnavailable: sessionState.kind === 'unavailable',
    status,
    overlayMode,
    failure,
    isCatchup,
    liveTimeShiftSupported: activeTarget.kind === 'live' && liveTimeShift.supported,
    canZap,
    hasTracks,
    hasPreviousChannel,
    nextEpisode,
    nextEpisodeVisible,
    showRetry,
    isTv,
    isDesktop,
    isFullscreen,
    timeDisplayMode: extras.timeDisplayMode,
    videoInfo,
    tracks,
    nowNext,
    wallClock,
    tvClockMode,
    effectivePreviewMs: touch.effectivePreviewMs,
    i18n,
    activeService,
    clock,
    controls,
    hostToggleMute: openedEngine?.toggleMute,
    hostToggleFullscreen: openedEngine?.toggleFullscreen,
    onMinimizeToMiniPlayer: props.onMinimizeToMiniPlayer,
    onEnterPip: handleEnterPip,
    onPopoutPlayer: handlePopoutPlayer,
    onDockPopout: handleDockPopout,
    onExit,
    onCycleTimeDisplayMode: extras.handleCycleTimeDisplayMode,
    onFineScrubHaptic: props.onFineScrubHaptic,
    onPlayNextEpisode: () => {
      extras.stillWatching.recordUserActivity();
      handoff.handlePlayNextEpisode(undefined, nextEpisode);
    },
    onJumpPreviousChannel: handoff.handleJumpPreviousChannel,
    onBackToLive: handoff.handleBackToLive,
    onPrev: () => {
      extras.stillWatching.recordUserActivity();
      zapBy(-1);
    },
    onNext: () => {
      extras.stillWatching.recordUserActivity();
      zapBy(1);
    },
    onRetry: handleRetryWithParental,
  });

  const dismissOpenSheets = (): void => {
    controls.closeSettings();
    controls.closeWindowMode();
    controls.closeChannelList();
  };

  return (
    <PlayerScreenStage
      isTv={isTv}
      isDesktop={isDesktop}
      inPip={inPip}
      isMini={isMini}
      externalPlaybackActive={externalPlaybackActive}
      isVod={activeTarget.kind === 'vod'}
      title={previewTarget?.title ?? activeTarget.title}
      subtitle={previewTarget !== null ? previewTarget.subtitle : activeTarget.subtitle}
      nowNext={nowNext}
      nowMs={wallClock()}
      useDockedDesktopLayout={useDockedDesktopLayout}
      hideDesktopCursor={hideDesktopCursor}
      anySheetOpen={anySheetOpen}
      locked={controls.locked}
      osdHidden={controls.osdHidden}
      showTouchGestures={showTouchGestures}
      holdSpeedActive={controls.holdSpeedActive}
      statsVisible={controls.statsVisible}
      nextEpisodeVisible={nextEpisodeVisible}
      brightness={touch.brightness}
      volume={controls.volume}
      durationMs={touch.durationMs}
      currentPosMs={touch.currentPosMs}
      activeService={activeService}
      clock={clock}
      i18n={i18n}
      osdProps={osdProps}
      desktopFallbackKeyProps={controls.desktopFallbackKeyProps as Record<string, unknown>}
      touchHoverProps={touchHoverProps as Record<string, unknown>}
      desktopWebProps={desktopWebProps}
      surfaceNode={surfaceNode}
      {...overlayNodes}
      onDismissOpenSheets={dismissOpenSheets}
      externalSubtitleOverlay={subtitlesSuite.externalSubtitleOverlay}
      externalSubtitleFeedback={subtitlesSuite.feedback?.kind ?? null}
      passthroughFallbackVisible={displayAudioSync.passthroughFallbackVisible}
      stillWatchingVisible={extras.stillWatching.promptVisible}
      stillWatchingRemainingSec={extras.stillWatching.remainingSeconds}
      stillWatchingFocusedAction={extras.stillWatchingAction}
      onKeepWatching={extras.stillWatching.keepWatching}
      onStopWatching={extras.stillWatching.stopNow}
      {...buildPlayerStageCallbacks({
        recordUserActivity: extras.stillWatching.recordUserActivity,
        handleTouchActivity: controls.handleTouchActivity,
        toggleOsdByTouch: controls.toggleOsdByTouch,
        seekStepBack: controls.seekStepBack,
        seekStepForward: controls.seekStepForward,
        setTouchScrubDeltaMs: touch.setTouchScrubDeltaMs,
        handleTouchScrubCommit: touch.handleTouchScrubCommit,
        startHoldSpeed: controls.startHoldSpeed,
        endHoldSpeed: controls.endHoldSpeed,
        setVolume: controls.setVolume,
        handleBrightnessChange: touch.handleBrightnessChange,
        unlockControls: controls.unlockControls,
        onExpandMiniPlayer: props.onExpandMiniPlayer,
        onExit,
        onPinchMinimize: formFactor === 'tablet' ? props.onMinimizeToMiniPlayer : undefined,
      })}
      resizeMode={controls.resizeMode}
      aspectToastNonce={controls.aspectToastNonce}
      reduceMotion={props.reduceMotion}
    />
  );
}
