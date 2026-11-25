import {
  type BufferPreset,
  DEFAULT_SUBTITLE_STYLE,
  type LiveChannelSwitchModePref,
  type SubtitleStyleConfig,
} from '@elv/domain';
import type { PlaybackService } from '@elv/playback';
import { useFormFactor, useI18n } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { noopAppLifecycle } from '../ports/app-lifecycle';
import type { PlayableEntry } from '../ports/play-target';
import type { HostKey } from '../ports/video-host';
import { describePlaybackFailure } from './errors';
import { useLiveTimeShiftState } from './LiveTimeShiftBar';
import { targetIdentityKey } from './live-timeshift-model';
import type { ChannelDrawerNavHandle } from './PlayerChannelDrawer';
import {
  buildDesktopWebProps,
  computeSubtitleBottomInsetPx,
  DEFAULT_PLAYER_CLOCK,
  DEFAULT_PLAYER_TIMERS,
  formatStatusLine,
  PlayerSurfaceLayer,
  useLatestRef,
  usePlayerTouchScrubAndBrightness,
  usePreviewOsdAndResizeSync,
} from './PlayerScreenParts';
import { buildPlayerOverlayNodes } from './PlayerScreenSheets';
import { type PlayerScreenProps, PlayerScreenStage } from './PlayerScreenStage';
import { buildPlayerOsdProps } from './player-osd-props';
import { buildTouchHoverProps } from './touch-hover-guard';
import { useGaplessEpisodeQueue } from './useGaplessEpisodeQueue';
import { useLiveQualityVariants } from './useLiveQualityVariants';
import { useNextEpisodeResolver } from './useNextEpisodeResolver';
import { usePlayerCinemaExtras } from './usePlayerCinemaExtras';
import { usePlayerControls } from './usePlayerControls';
import {
  buildWaveF7aLoadOptions,
  usePlayerDisplayAndAudioSync,
} from './usePlayerDisplayAndAudioSync';
import { usePlayerNowNext } from './usePlayerNowNext';
import { usePlayerParentalUnlock } from './usePlayerParentalUnlock';
import { readServicePositionMs, usePlayerPip, useRestoreOsdOnToken } from './usePlayerPip';
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
    onTargetChange,
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
    osdTimeDisplayMode = 'total',
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

  const serviceRef = useRef<PlaybackService | null>(null);
  const flushProgressRef = useRef<(overridePosMs?: number) => void>(() => undefined);
  const flushEndedProgressRef = useRef<() => void>(() => undefined);
  const cancelScrubRef = useRef<() => void>(() => undefined);
  const resolvedNextEpisodeRef = useRef<PlayableEntry | undefined>(undefined);
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const clockRef = useLatestRef(clock);
  const wallClockRef = useRef(wallClock);
  wallClockRef.current = wallClock;
  const channelDrawerNavRef = useRef<ChannelDrawerNavHandle | null>(null);
  const timersRef = useLatestRef(timers);
  const onTargetChangeRef = useLatestRef(onTargetChange);
  const onExitRef = useLatestRef(onExit);
  const bufferPresetRef = useLatestRef<BufferPreset>(bufferPreset);
  const preferHevcRef = useLatestRef<boolean>(preferHevcOverDolbyVision);
  const filterSdhRef = useLatestRef<boolean>(filterSdhSubtitles);
  const subtitleStyleRef = useRef<SubtitleStyleConfig>(
    props.subtitleStyle ?? DEFAULT_SUBTITLE_STYLE,
  );
  const switchModeRef = useLatestRef<LiveChannelSwitchModePref>(liveChannelSwitchMode);
  const backgroundAudioRef = useLatestRef<boolean>(effectiveBackgroundAudio);
  const waveF7aLoadOptionsRef = useLatestRef(buildWaveF7aLoadOptions(props));
  const reloadActiveTargetRef = useRef<() => void>(() => undefined);
  const { decoderModeRef, activeDecoderMode, showAndroidDecoder, handleSelectAndroidDecoderMode } =
    useAndroidDecoderModeSync({
      androidDecoderMode: props.androidDecoderMode,
      onSelectAndroidDecoderMode: props.onSelectAndroidDecoderMode,
      reloadActiveTarget: () => reloadActiveTargetRef.current(),
    });

  const handoff = usePlayerTargetHandoff({
    target,
    playbackGuard,
    appLifecycle,
    catalogRef,
    serviceRef,
    clockRef,
    timersRef,
    flushProgressRef,
    flushEndedProgressRef,
    cancelScrubRef,
    onTargetChangeRef,
    bufferPresetRef,
    decoderModeRef,
    preferHevcOverDolbyVisionRef: preferHevcRef,
    filterSdhSubtitlesRef: filterSdhRef,
    subtitleStyleRef,
    liveChannelSwitchModeRef: switchModeRef,
    resolvedNextEpisodeRef,
    backgroundAudioPlaybackRef: backgroundAudioRef,
    onRegisterStopActivePlayer: props.onRegisterStopActivePlayer,
  });
  reloadActiveTargetRef.current = handoff.reloadActiveTarget;
  const { activeTarget, previewTarget, zapBy, jumpToChannel } = handoff;

  const zapByRef = useLatestRef(zapBy);
  const hostKeyRef = useRef<(key: HostKey) => void>((key) => {
    if (key === 'back') onExitRef.current();
  });

  const nextEpisode = useNextEpisodeResolver({ catalog, activeTarget });
  resolvedNextEpisodeRef.current = nextEpisode;

  const session = usePlayerSession({
    videoHost,
    activeTarget,
    isDesktop,
    subtitleFontFamily,
    ...(props.deinterlaceMode !== undefined ? { deinterlaceMode: props.deinterlaceMode } : {}),
    ...(props.pitchLock !== undefined ? { pitchLock: props.pitchLock } : {}),
    ...(props.audioNormalization !== undefined
      ? { audioNormalization: props.audioNormalization }
      : {}),
    backgroundAudioPlayback: effectiveBackgroundAudio,
    ...(props.windowAspectRatioLock !== undefined
      ? { windowAspectRatioLock: props.windowAspectRatioLock }
      : {}),
    ...(props.onWindowAspectRatioLockChange !== undefined
      ? { onWindowAspectRatioLockChange: props.onWindowAspectRatioLockChange }
      : {}),
    ...(props.canAcquireAlternate !== undefined
      ? { canAcquireAlternate: props.canAcquireAlternate }
      : {}),
    catalogRef,
    serviceRef,
    clockRef,
    timersRef,
    hostKeyRef,
    onExitRef,
    waveF7aLoadOptionsRef,
    onServiceReady: handoff.onServiceReady,
  });
  const { sessionState, activeService, status, tracks, videoInfo, chapters } = session;
  const { surfaceRecreationToken, inPip, isFullscreen, alwaysOnTop, overlayMode } = session;
  const { audioDevices, activeAudioDevice, subtitleDelayMs } = session;

  const { flushProgress, flushEndedProgress } = useWatchProgressSync({
    activeTarget,
    status,
    serviceRef,
    catalogRef,
    clockRef,
    timersRef,
  });
  flushProgressRef.current = flushProgress;
  flushEndedProgressRef.current = flushEndedProgress;

  const nowNext = usePlayerNowNext({
    catalog,
    itemKey: previewTarget?.itemKey ?? activeTarget.itemKey,
    enabled: activeTarget.kind === 'live' && !inPip && !isMini,
    wallClock,
  });
  const quality = useLiveQualityVariants({
    catalog,
    activeTarget,
    onSelect: handoff.selectQualityVariant,
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
  const handleEnterPip = pip.canShowPipAction
    ? () => {
        pip.enterPip();
      }
    : undefined;
  const handleEnterMultiView =
    multiViewSupported && activeTarget.kind === 'live' && props.onEnterMultiView !== undefined
      ? () => props.onEnterMultiView?.(activeTarget)
      : undefined;
  const handlePopoutPlayer =
    props.onPopoutPlayer !== undefined
      ? () => {
          const posMs = readServicePositionMs(serviceRef.current, clockRef.current);
          flushProgress(posMs);
          props.onPopoutPlayer?.(activeTarget, posMs);
        }
      : undefined;
  const subtitlesSuite = usePlayerSubtitlesSuite({
    activeItemKey: activeTarget.itemKey,
    tracks,
    openedEngine,
    activeService,
    serviceRef,
    timersRef,
    subtitleStyleRef,
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
    chapters,
    openedEngine,
    catalogRef,
    wallClockRef,
    serviceRef,
    clockRef,
    timersRef,
    flushProgressRef,
    onExitRef,
    filterSdhSubtitles,
    osdTimeDisplayMode,
    onPersistOsdTimeDisplayMode: props.onPersistOsdTimeDisplayMode,
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
    initialVolume,
    preferredAudioDevice: props.preferredAudioDevice,
  });

  const hasTracks =
    tracks.audio.length > 0 ||
    tracks.subtitles.length > 0 ||
    subtitlesSuite.supportsExternalSubtitles;
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
  const hostToggleFullscreen = openedEngine?.toggleFullscreen;
  const hostToggleAlwaysOnTop = openedEngine?.toggleAlwaysOnTop;
  const hostSetAudioDevice = openedEngine?.setAudioDevice;
  const hostToggleMute = openedEngine?.toggleMute;
  const hostSetVolume = openedEngine?.setVolume;
  const hostSetBrightness = openedEngine?.setBrightness;
  const hostSetOrientationLocked = openedEngine?.setOrientationLocked;
  const hostSetDeinterlace = openedEngine?.setDeinterlace;

  const selectAudioDevice = useCallback(
    (name: string) => {
      hostSetAudioDevice?.(name);
      props.onPersistAudioDevice?.(name);
    },
    [hostSetAudioDevice, props.onPersistAudioDevice],
  );

  const isCatchup = activeTarget.catchup !== undefined;
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
    hasInfo: activeService !== null,
    hasChannelList: canZap,
    hasNextEpisode: !isCatchup && (nextEpisodeVisible || nextEpisode !== undefined),
    hasPreviousChannel,
    hasBackToLive: isCatchup,
    liveTimeShiftSupported: activeTarget.kind === 'live' && liveTimeShift.supported,
    hasJumpToLive: activeTarget.kind === 'live' && liveTimeShift.showJumpToLive,
    initialOsdHidden,
    autoHideOsdMs,
    initialVolume: initialVolume ?? openedEngine?.initialVolume,
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
    onToggleFullscreen: hostToggleFullscreen,
    onToggleAlwaysOnTop: hostToggleAlwaysOnTop,
    audioDevices,
    activeAudioDevice,
    onSelectAudioDevice: hostSetAudioDevice !== undefined ? selectAudioDevice : undefined,
    ...(showAndroidDecoder
      ? {
          androidDecoderMode: activeDecoderMode,
          onSelectAndroidDecoderMode: handleSelectAndroidDecoderMode,
        }
      : {}),
    onToggleMute: hostToggleMute,
    onSetVolume: hostSetVolume,
    onPersistVolume: props.onPersistVolume,
    onToggleAutoSubtitlesOnSkipBack: props.onToggleAutoSubtitlesOnSkipBack,
    onToggleAutoPlayNextEpisode: props.onToggleAutoPlayNextEpisode,
    onChannelListMove: (delta) => channelDrawerNavRef.current?.move(delta),
    onChannelListSwitchTab: (dir) => channelDrawerNavRef.current?.switchTab(dir),
    onChannelListSelect: () => channelDrawerNavRef.current?.select(),
    onSetOrientationLocked: hostSetOrientationLocked,
    onSetDeinterlace: hostSetDeinterlace,
    onCycleDeinterlaceMode: extras.cycleDeinterlaceMode,
    onTogglePitchLock: extras.togglePitchLock,
    onToggleAudioNormalization: extras.toggleAudioNormalization,
    onResizeModeChange: extras.handleResizeModeChange,
    onAudioTrackSelected: extras.handleAudioTrackSelected,
    onSubtitleTrackSelected: extras.handleSubtitleTrackSelected,
    chapters,
    onSelectChapter: extras.handleSelectChapter,
    onPrevChapter: (chapters?.length ?? 0) > 0 ? extras.handlePrevChapter : undefined,
    onNextChapter: (chapters?.length ?? 0) > 0 ? extras.handleNextChapter : undefined,
    sleepTimerMinutes: extras.sleepTimer.active ? extras.sleepTimer.totalMinutes : 0,
    onSelectSleepTimer: extras.selectSleepTimer,
    onToggleSleepTimerAction: extras.toggleSleepTimerAction,
    onCycleTimeDisplayMode: extras.handleCycleTimeDisplayMode,
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
  hostKeyRef.current = controls.handleHostKey;
  cancelScrubRef.current = controls.cancelScrub;
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
    hostSetBrightness,
    previewPositionMs: controls.previewPositionMs,
    osdHidden: controls.osdHidden,
    seekToRatio: controls.seekToRatio,
    showProgressOsd: controls.showProgressOsd,
    recordUserActivity: extras.stillWatching.recordUserActivity,
  });

  const anySheetOpen =
    controls.tracksOpen ||
    controls.settingsOpen ||
    controls.infoOpen ||
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

  const { nextEpisodeNode, trackPickerNode, infoSheetNode, channelDrawerNode, settingsSheetNode } =
    buildPlayerOverlayNodes({
      activeTarget,
      nextEpisode,
      nextEpisodeDismissed,
      isGaplessArmed,
      status,
      activeService,
      clock,
      timers,
      wallClock,
      isTv,
      formFactor,
      i18n,
      useDockedDesktopLayout,
      canZap,
      tracks,
      videoInfo,
      nowNext,
      chapters,
      alwaysOnTop,
      hostToggleAlwaysOnTop,
      hostSetDeinterlace,
      hostSetAudioDevice,
      audioDevices,
      activeAudioDevice,
      selectAudioDevice,
      showAndroidDecoder,
      activeDecoderMode,
      handleSelectAndroidDecoderMode,
      autoSubtitlesOnSkipBack: props.autoSubtitlesOnSkipBack,
      onToggleAutoSubtitlesOnSkipBack: props.onToggleAutoSubtitlesOnSkipBack,
      autoPlayNextEpisode: props.autoPlayNextEpisode,
      onToggleAutoPlayNextEpisode: props.onToggleAutoPlayNextEpisode,
      reduceMotion: props.reduceMotion,
      activeDeinterlaceMode: extras.activeDeinterlaceMode,
      cycleDeinterlaceMode: extras.cycleDeinterlaceMode,
      activePitchLock: extras.activePitchLock,
      togglePitchLock: extras.togglePitchLock,
      activeAudioNorm: extras.activeAudioNorm,
      toggleAudioNormalization: extras.toggleAudioNormalization,
      timeDisplayMode: extras.timeDisplayMode,
      handleCycleTimeDisplayMode: extras.handleCycleTimeDisplayMode,
      handleSelectChapter: extras.handleSelectChapter,
      sleepTimer: extras.sleepTimer,
      selectSleepTimer: extras.selectSleepTimer,
      toggleSleepTimerAction: extras.toggleSleepTimerAction,
      fetchChannelNowNext: extras.fetchChannelNowNext,
      fetchRecentChannels:
        catalog.listRecentChannels !== undefined ? extras.fetchRecentChannels : undefined,
      channelDrawerNavRef,
      controls,
      qualitySheetProps: quality.sheetProps,
      syncAndQualitySheetProps: syncAndQuality.sheetProps,
      subtitlesTrackPickerProps: subtitlesSuite.trackPickerProps,
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
    alwaysOnTop,
    chapters,
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
    hostToggleMute,
    hostToggleFullscreen,
    hostToggleAlwaysOnTop,
    onMinimizeToMiniPlayer: props.onMinimizeToMiniPlayer,
    onEnterPip: handleEnterPip,
    onEnterMultiView: handleEnterMultiView,
    onPopoutPlayer: handlePopoutPlayer,
    onExit,
    onCycleTimeDisplayMode: extras.handleCycleTimeDisplayMode,
    onFineScrubHaptic: props.onFineScrubHaptic,
    onPlayNextEpisode: () => {
      extras.stillWatching.recordUserActivity();
      handoff.handlePlayNextEpisode(undefined, nextEpisode);
    },
    onPrevChapter: extras.handlePrevChapter,
    onNextChapter: extras.handleNextChapter,
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

  return (
    <PlayerScreenStage
      isTv={isTv}
      isDesktop={isDesktop}
      inPip={inPip}
      isMini={isMini}
      isVod={activeTarget.kind === 'vod'}
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
      nextEpisodeNode={nextEpisodeNode}
      trackPickerNode={trackPickerNode}
      infoSheetNode={infoSheetNode}
      channelDrawerNode={channelDrawerNode}
      settingsSheetNode={settingsSheetNode}
      externalSubtitleOverlay={subtitlesSuite.externalSubtitleOverlay}
      externalSubtitleFeedback={subtitlesSuite.feedback?.kind ?? null}
      passthroughFallbackVisible={displayAudioSync.passthroughFallbackVisible}
      stillWatchingVisible={extras.stillWatching.promptVisible}
      stillWatchingRemainingSec={extras.stillWatching.remainingSeconds}
      stillWatchingFocusedAction={extras.stillWatchingAction}
      onKeepWatching={extras.stillWatching.keepWatching}
      onStopWatching={extras.stillWatching.stopNow}
      onTouchActivity={() => {
        extras.stillWatching.recordUserActivity();
        controls.handleTouchActivity();
      }}
      onSingleTap={() => {
        extras.stillWatching.recordUserActivity();
        controls.toggleOsdByTouch();
      }}
      onDoubleTapSeek={(deltaMs) => {
        extras.stillWatching.recordUserActivity();
        if (deltaMs < 0) controls.seekStepBack();
        else controls.seekStepForward();
      }}
      onScrubPreview={touch.setTouchScrubDeltaMs}
      onScrubCommit={touch.handleTouchScrubCommit}
      onHoldSpeedStart={controls.startHoldSpeed}
      onHoldSpeedEnd={controls.endHoldSpeed}
      onVolumeChange={controls.setVolume}
      onBrightnessChange={touch.handleBrightnessChange}
      onUnlock={controls.unlockControls}
      onExpandMiniPlayer={props.onExpandMiniPlayer}
      onCloseMiniPlayer={onExit}
      onPinchMinimize={formFactor === 'tablet' ? props.onMinimizeToMiniPlayer : undefined}
    />
  );
}
