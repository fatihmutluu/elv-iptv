import type { BufferPreset, LiveChannelSwitchModePref } from '@elv/domain';
import { type PlaybackService, positionAt } from '@elv/playback';
import { useFormFactor, useI18n } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { noopAppLifecycle } from '../ports/app-lifecycle';
import type { PlayableEntry } from '../ports/play-target';
import type { HostKey } from '../ports/video-host';
import { describePlaybackFailure } from './errors';
import { NextEpisodeBanner } from './NextEpisodeBanner';
import { type ChannelDrawerNavHandle, PlayerChannelDrawer } from './PlayerChannelDrawer';
import { PlayerInfoSheet } from './PlayerInfoSheet';
import {
  buildDesktopWebProps,
  computeSubtitleBottomInsetPx,
  DEFAULT_PLAYER_CLOCK,
  DEFAULT_PLAYER_TIMERS,
  formatStatusLine,
  PlayerSurfaceLayer,
  useLatestRef,
} from './PlayerScreenParts';
import { type PlayerScreenProps, PlayerScreenStage } from './PlayerScreenStage';
import { PlayerSettingsSheet } from './PlayerSettingsSheet';
import { MIN_BRIGHTNESS } from './PlayerTouchGestures';
import { TrackPickerModal } from './TrackPickerModal';
import { buildTouchHoverProps } from './touch-hover-guard';
import { useGaplessEpisodeQueue } from './useGaplessEpisodeQueue';
import { useLiveQualityVariants } from './useLiveQualityVariants';
import { useNextEpisodeResolver } from './useNextEpisodeResolver';
import { usePlayerCinemaExtras } from './usePlayerCinemaExtras';
import { usePlayerControls } from './usePlayerControls';
import { usePlayerNowNext } from './usePlayerNowNext';
import { usePlayerParentalUnlock } from './usePlayerParentalUnlock';
import { usePlayerSession } from './usePlayerSession';
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
  const { catalog, videoHost, target, playbackGuard, onTargetChange, onExit } = props;
  const {
    appLifecycle = noopAppLifecycle,
    clock = DEFAULT_PLAYER_CLOCK,
    wallClock = Date.now,
  } = props;
  const { timers = DEFAULT_PLAYER_TIMERS, initialOsdHidden, autoHideOsdMs, initialVolume } = props;
  const { onPersistVolume, autoSubtitlesOnSkipBack, onToggleAutoSubtitlesOnSkipBack } = props;
  const {
    autoPlayNextEpisode,
    onToggleAutoPlayNextEpisode,
    reduceMotion,
    bufferPreset = 'auto',
  } = props;
  const { useTextureView = false, seekStepSec = 10, defaultResizeMode = 'fit' } = props;
  const { onPersistResizeMode, preferredAudioLang, preferredSubtitleLang } = props;
  const {
    preferredAudioLanguages,
    preferredSubtitleLanguages,
    preferDefaultAudioTrack = true,
  } = props;
  const { preferHevcOverDolbyVision = false, filterSdhSubtitles = false } = props;
  const { subtitleMode = 'smart', subtitleFontFamily = 'system', tvClockMode = 'always' } = props;
  const { osdTimeDisplayMode = 'total', onPersistOsdTimeDisplayMode } = props;
  const { sleepTimerDefaultAction = 'stop', onPersistSleepTimerAction } = props;
  const { stillWatchingTimeoutMin = 0, onPlaybackActiveChange, onFineScrubHaptic } = props;
  const { preferredAudioDevice, onPersistAudioDevice, androidDecoderMode } = props;
  const { onSelectAndroidDecoderMode, liveChannelSwitchMode = 'instant' } = props;
  const { deinterlaceMode, onPersistDeinterlaceMode, pitchLock, onPersistPitchLock } = props;
  const { audioNormalization, onPersistAudioNormalization, windowAspectRatioLock } = props;
  const { onWindowAspectRatioLockChange, backgroundAudioPlayback = false } = props;
  const formFactor = useFormFactor();
  const i18n = useI18n();
  const isTv = formFactor === 'tv';
  const isDesktop = formFactor === 'desktop';
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
  const switchModeRef = useLatestRef<LiveChannelSwitchModePref>(liveChannelSwitchMode);
  const backgroundAudioRef = useLatestRef<boolean>(effectiveBackgroundAudio);
  const reloadActiveTargetRef = useRef<() => void>(() => undefined);
  const { decoderModeRef, activeDecoderMode, showAndroidDecoder, handleSelectAndroidDecoderMode } =
    useAndroidDecoderModeSync({
      androidDecoderMode,
      onSelectAndroidDecoderMode,
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
    liveChannelSwitchModeRef: switchModeRef,
    resolvedNextEpisodeRef,
    backgroundAudioPlaybackRef: backgroundAudioRef,
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
    ...(deinterlaceMode !== undefined ? { deinterlaceMode } : {}),
    ...(pitchLock !== undefined ? { pitchLock } : {}),
    ...(audioNormalization !== undefined ? { audioNormalization } : {}),
    backgroundAudioPlayback: effectiveBackgroundAudio,
    ...(windowAspectRatioLock !== undefined ? { windowAspectRatioLock } : {}),
    ...(onWindowAspectRatioLockChange !== undefined ? { onWindowAspectRatioLockChange } : {}),
    serviceRef,
    clockRef,
    timersRef,
    hostKeyRef,
    onExitRef,
    onServiceReady: handoff.onServiceReady,
  });
  const { sessionState, activeService, status, tracks, videoInfo, chapters } = session;
  const { surfaceRecreationToken, inPip, isFullscreen, alwaysOnTop, overlayMode } = session;
  const { audioDevices, activeAudioDevice, audioDelayMs, subtitleDelayMs } = session;

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
    enabled: activeTarget.kind === 'live' && !inPip,
    wallClock,
  });
  const quality = useLiveQualityVariants({
    catalog,
    activeTarget,
    onSelect: handoff.selectQualityVariant,
  });

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

  const openedEngine = sessionState.kind === 'ready' ? sessionState.opened : undefined;
  const syncAndQuality = usePlayerSyncAndQuality({
    activeTarget,
    tracks,
    openedEngine,
    audioDelayMs,
    subtitleDelayMs,
    selectedVideoQualityId: session.selectedVideoQualityId,
    serviceRef,
    catalogRef,
  });
  const { isGaplessArmed } = useGaplessEpisodeQueue({
    activeTarget,
    nextEpisode,
    autoPlayNextEpisode,
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
    onPersistOsdTimeDisplayMode,
    onPersistResizeMode,
    sleepTimerDefaultAction,
    onPersistSleepTimerAction,
    stillWatchingTimeoutMin,
    onPlaybackActiveChange,
    deinterlaceMode,
    onPersistDeinterlaceMode,
    pitchLock,
    onPersistPitchLock,
    audioNormalization,
    onPersistAudioNormalization,
    initialVolume,
    preferredAudioDevice,
  });

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
      onPersistAudioDevice?.(name);
    },
    [hostSetAudioDevice, onPersistAudioDevice],
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
    hasNextEpisode: nextEpisodeVisible || nextEpisode !== undefined,
    hasPreviousChannel,
    initialOsdHidden,
    autoHideOsdMs,
    initialVolume: initialVolume ?? openedEngine?.initialVolume,
    autoSubtitlesOnSkipBack,
    seekStepSec,
    defaultResizeMode,
    serviceRef,
    clockRef,
    timersRef,
    onExitRef,
    zapByRef,
    onSeekCommit: flushProgress,
    onPlayNextEpisode: () => handoff.handlePlayNextEpisode(undefined, nextEpisode),
    onJumpPreviousChannel: handoff.handleJumpPreviousChannel,
    qualityVariants: quality.variants,
    onSelectQualityVariant: quality.selectVariant,
    ...syncAndQuality.controlsProps,
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
    onPersistVolume,
    onToggleAutoSubtitlesOnSkipBack,
    onToggleAutoPlayNextEpisode,
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
    stillWatchingVisible: !inPip && extras.stillWatching.promptVisible,
    onStillWatchingKey: extras.handleStillWatchingKey,
    externalOverlayOpen: props.externalOverlayOpen,
  });
  hostKeyRef.current = controls.handleHostKey;
  cancelScrubRef.current = controls.cancelScrub;

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
    preferredAudioLang,
    preferredSubtitleLang,
    preferredAudioLanguages,
    preferredSubtitleLanguages,
    preferDefaultAudioTrack,
    subtitleMode,
    statusKind: status.kind,
    onHydratedResizeMode: (mode) => {
      setResizeModeRef.current(mode, false);
      openedEngine?.setResizeMode?.(mode);
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-send resizeMode when activeTarget.itemKey changes so mpv --reset-on-next-file never reverts to fit
  useEffect(() => {
    if (openedEngine === undefined) return;
    if (status.kind === 'playing' || status.kind === 'paused') {
      openedEngine.setResizeMode?.(controls.resizeMode);
    }
  }, [openedEngine, activeTarget.itemKey, status.kind, controls.resizeMode]);

  const showOsdRef = useRef(controls.showOsd);
  showOsdRef.current = controls.showOsd;
  const prevOsdHiddenRef = useRef(controls.osdHidden);
  const cancelPreview = handoff.cancelPreviewChannel;
  useEffect(() => {
    if (previewTarget !== null) showOsdRef.current();
  }, [previewTarget]);
  useEffect(() => {
    const wasHidden = prevOsdHiddenRef.current;
    prevOsdHiddenRef.current = controls.osdHidden;
    if (!wasHidden && controls.osdHidden && previewTarget !== null) cancelPreview();
  }, [cancelPreview, controls.osdHidden, previewTarget]);

  const anchor = activeService?.getState().anchor;
  const currentPosMs = anchor !== undefined ? positionAt(anchor, clock.now()) : undefined;
  const durationMs = anchor?.durationMs;
  const effectivePreviewMs =
    touchScrubDeltaMs !== undefined && currentPosMs !== undefined && durationMs !== undefined
      ? Math.max(0, Math.min(durationMs, currentPosMs + touchScrubDeltaMs))
      : controls.previewPositionMs;

  const handleBrightnessChange = (next: number): void => {
    const clamped = Math.max(MIN_BRIGHTNESS, Math.min(1, next));
    setBrightness(clamped);
    hostSetBrightness?.(clamped);
  };
  const handleTouchScrubCommit = (deltaMs: number): void => {
    extras.stillWatching.recordUserActivity();
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
  const recordActivity = extras.stillWatching.recordUserActivity;
  usePlayerTvPan({
    openedEngine,
    isTv,
    hasService: activeService !== null,
    isVod: activeTarget.kind === 'vod',
    hasChannelList: canZap,
    anySheetOpen,
    stillWatchingVisible: !inPip && extras.stillWatching.promptVisible,
    durationMs,
    controls,
    recordActivity,
    setScrubDeltaMs: setTouchScrubDeltaMs,
    commitScrub: handleTouchScrubCommit,
  });
  const isWebDesktop = isDesktop && (Platform.OS as string) === 'web';
  const useDockedDesktopLayout = isDesktop && overlayMode === 'docked';
  const hideDesktopCursor =
    isWebDesktop && controls.osdHidden && status.kind === 'playing' && !anySheetOpen;
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
  const osdVisible = !inPip && !controls.osdHidden && !controls.locked;
  const subtitleBottomInsetPx = computeSubtitleBottomInsetPx({
    useDockedDesktopLayout,
    osdVisible,
    isTv,
    osdTier: controls.osdTier,
  });
  const showTouchGestures = !inPip && !isTv && !isDesktop && !controls.locked && !anySheetOpen;

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
        surfaceRecreationToken={surfaceRecreationToken}
        useTextureView={useTextureView}
        osdVisible={osdVisible}
      />
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
      autoAdvanceDisabled={isGaplessArmed}
      {...(reduceMotion !== undefined ? { reduceMotion } : {})}
      timers={timers}
      onPlayNext={(expectedKey) => handoff.handlePlayNextEpisode(expectedKey, nextEpisode)}
      onDismiss={() => {
        extras.stillWatching.recordUserActivity();
        setNextEpisodeDismissed(true);
      }}
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
      docked={useDockedDesktopLayout}
      title={activeTarget.title}
      subtitle={activeTarget.subtitle}
      isVod={activeTarget.kind === 'vod'}
      nowNext={nowNext}
      videoInfo={videoInfo}
      tracks={tracks}
      formFactor={formFactor}
      isTv={isTv}
      i18n={i18n}
      nowMs={wallClock()}
      onClose={controls.closeInfo}
    />
  );

  const channelDrawerNode = (
    <PlayerChannelDrawer
      visible={controls.channelListOpen && canZap}
      docked={useDockedDesktopLayout}
      playlist={activeTarget.playlist}
      currentItemKey={activeTarget.itemKey}
      formFactor={formFactor}
      isTv={isTv}
      i18n={i18n}
      fetchNowNext={extras.fetchChannelNowNext}
      {...(catalog.listRecentChannels !== undefined
        ? { fetchRecentChannels: extras.fetchRecentChannels }
        : {})}
      navigationRef={channelDrawerNavRef}
      onSelectChannel={(entry, index) => {
        extras.stillWatching.recordUserActivity();
        handoff.selectChannel(entry, index);
        controls.closeChannelList();
      }}
      onClose={controls.closeChannelList}
    />
  );

  const settingsSheetNode = (
    <PlayerSettingsSheet
      visible={controls.settingsOpen && activeService !== null}
      docked={useDockedDesktopLayout}
      menuState={controls.settingsMenu}
      tracks={tracks}
      isVod={activeTarget.kind === 'vod'}
      playbackSpeed={controls.playbackSpeed}
      resizeMode={controls.resizeMode}
      onToggleResizeMode={controls.toggleResizeMode}
      timeDisplayMode={extras.timeDisplayMode}
      onCycleTimeDisplayMode={extras.handleCycleTimeDisplayMode}
      onToggleInfo={controls.toggleInfo}
      {...(hostToggleAlwaysOnTop !== undefined
        ? { alwaysOnTop, onToggleAlwaysOnTop: hostToggleAlwaysOnTop }
        : {})}
      {...(extras.cycleDeinterlaceMode !== undefined
        ? {
            deinterlaceMode: extras.activeDeinterlaceMode,
            onCycleDeinterlaceMode: extras.cycleDeinterlaceMode,
          }
        : hostSetDeinterlace !== undefined
          ? { deinterlace: controls.deinterlace, onToggleDeinterlace: controls.toggleDeinterlace }
          : {})}
      {...(extras.togglePitchLock !== undefined
        ? { pitchLock: extras.activePitchLock, onTogglePitchLock: extras.togglePitchLock }
        : {})}
      {...(extras.toggleAudioNormalization !== undefined
        ? {
            audioNormalization: extras.activeAudioNorm,
            onToggleAudioNormalization: extras.toggleAudioNormalization,
          }
        : {})}
      {...(onToggleAutoSubtitlesOnSkipBack !== undefined
        ? {
            autoSubtitlesOnSkipBack: autoSubtitlesOnSkipBack === true,
            onToggleAutoSubtitlesOnSkipBack,
          }
        : {})}
      {...(onToggleAutoPlayNextEpisode !== undefined
        ? { autoPlayNextEpisode: autoPlayNextEpisode !== false, onToggleAutoPlayNextEpisode }
        : {})}
      chapters={chapters}
      onSelectChapter={extras.handleSelectChapter}
      sleepTimer={extras.sleepTimer}
      onSelectSleepTimer={extras.selectSleepTimer}
      onToggleSleepTimerAction={extras.toggleSleepTimerAction}
      statsVisible={controls.statsVisible}
      {...quality.sheetProps}
      {...syncAndQuality.sheetProps}
      {...(hostSetAudioDevice !== undefined
        ? { audioDevices, activeAudioDevice, onSelectAudioDevice: selectAudioDevice }
        : {})}
      {...(showAndroidDecoder
        ? {
            androidDecoderMode: activeDecoderMode,
            onSelectAndroidDecoderMode: handleSelectAndroidDecoderMode,
          }
        : {})}
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

  const osdProps = {
    title: previewTarget?.title ?? activeTarget.title,
    subtitle: previewTarget !== null ? previewTarget.subtitle : activeTarget.subtitle,
    isChannelPreview: previewTarget !== null,
    channelDigits: controls.channelDigits,
    statusLine,
    statusKind: sessionState.kind === 'unavailable' ? ('idle' as const) : status.kind,
    osdTier: controls.osdTier,
    overlayMode: isDesktop ? overlayMode : ('floating' as const),
    isBuffering: status.kind === 'tuning' || status.kind === 'recovering',
    failure,
    isVod: activeTarget.kind === 'vod',
    isPausedOrEnded: controls.isPausedOrEnded,
    canZap,
    hasTracks,
    hasPreviousChannel,
    hasNextEpisodeAction: activeTarget.kind === 'vod' && nextEpisode !== undefined,
    nextEpisodeBannerVisible: nextEpisodeVisible,
    canLock: controls.canLock,
    showRetry,
    isTv,
    isDesktop,
    muted: controls.muted,
    volume: controls.volume,
    isFullscreen,
    alwaysOnTop,
    playbackSpeed: controls.playbackSpeed,
    chapters,
    timeDisplayMode: extras.timeDisplayMode,
    videoInfo,
    tracks,
    nowNext,
    nowMs: wallClock(),
    wallClock,
    tvClockMode,
    tvOsdFocused: controls.tvOsdFocused,
    tvScrubberFocused: controls.tvScrubberFocused,
    tvOsdAction: controls.tvOsdAction,
    tracksOpen: controls.tracksOpen,
    settingsOpen: controls.settingsOpen,
    settingsView: controls.settingsMenu.view,
    infoOpen: controls.infoOpen,
    channelListOpen: controls.channelListOpen,
    previewPositionMs: effectivePreviewMs,
    i18n,
    service: activeService,
    clock,
    onExit,
    onTogglePlayPause: controls.togglePlayPause,
    onSeekBack: controls.seekStepBack,
    onSeekForward: controls.seekStepForward,
    onSeekRatio: controls.seekToRatio,
    onScrubbingChange: controls.setBarScrubbing,
    onCycleTimeDisplayMode: extras.handleCycleTimeDisplayMode,
    ...(onFineScrubHaptic !== undefined ? { onFineScrubHaptic } : {}),
    onOpenTracks: controls.openTracks,
    onOpenSettings: () =>
      controls.settingsOpen ? controls.closeSettings() : controls.openSettings(),
    onOpenSpeed: () =>
      controls.settingsOpen && controls.settingsMenu.view === 'speed'
        ? controls.closeSettings()
        : controls.openSettings('speed'),
    onToggleResizeMode: controls.toggleResizeMode,
    onToggleInfo: controls.toggleInfo,
    ...(canZap ? { onToggleChannelList: controls.toggleChannelList } : {}),
    onPlayNextEpisode: () => {
      extras.stillWatching.recordUserActivity();
      handoff.handlePlayNextEpisode(undefined, nextEpisode);
    },
    ...((chapters?.length ?? 0) > 0
      ? { onPrevChapter: extras.handlePrevChapter, onNextChapter: extras.handleNextChapter }
      : {}),
    ...(hostToggleMute !== undefined ? { onToggleMute: controls.toggleMute } : {}),
    onSetVolume: controls.setVolume,
    ...(hostToggleFullscreen !== undefined
      ? { onToggleFullscreen: controls.toggleFullscreen }
      : {}),
    ...(hostToggleAlwaysOnTop !== undefined ? { onToggleAlwaysOnTop: hostToggleAlwaysOnTop } : {}),
    onLock: controls.lockControls,
    onJumpPreviousChannel: handoff.handleJumpPreviousChannel,
    onJumpToLiveEdge: controls.jumpToLiveEdge,
    onPrev: () => {
      extras.stillWatching.recordUserActivity();
      zapBy(-1);
    },
    onNext: () => {
      extras.stillWatching.recordUserActivity();
      zapBy(1);
    },
    onRetry: handleRetryWithParental,
  };

  return (
    <PlayerScreenStage
      isTv={isTv}
      isDesktop={isDesktop}
      inPip={inPip}
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
      brightness={brightness}
      volume={controls.volume}
      durationMs={durationMs}
      currentPosMs={currentPosMs}
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
      onScrubPreview={setTouchScrubDeltaMs}
      onScrubCommit={handleTouchScrubCommit}
      onHoldSpeedStart={controls.startHoldSpeed}
      onHoldSpeedEnd={controls.endHoldSpeed}
      onVolumeChange={controls.setVolume}
      onBrightnessChange={handleBrightnessChange}
      onUnlock={controls.unlockControls}
    />
  );
}
