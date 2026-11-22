import type { BufferPreset } from '@elv/domain';
import { type PlaybackService, positionAt } from '@elv/playback';
import { useFormFactor, useI18n } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { noopAppLifecycle } from '../ports/app-lifecycle';
import type { PlayableEntry } from '../ports/play-target';
import type { HostKey } from '../ports/video-host';
import { describePlaybackFailure } from './errors';
import { NextEpisodeBanner } from './NextEpisodeBanner';
import { type ChannelDrawerNavHandle, PlayerChannelDrawer } from './PlayerChannelDrawer';
import { PlayerInfoSheet } from './PlayerInfoSheet';
import {
  DEFAULT_PLAYER_CLOCK,
  DEFAULT_PLAYER_TIMERS,
  formatStatusLine,
  playerStyles,
} from './PlayerScreenParts';
import { type PlayerScreenProps, PlayerScreenStage } from './PlayerScreenStage';
import { PlayerSettingsSheet } from './PlayerSettingsSheet';
import { MIN_BRIGHTNESS } from './PlayerTouchGestures';
import { clampVolume } from './player-overlay-model';
import { TrackPickerModal } from './TrackPickerModal';
import { buildTouchHoverProps } from './touch-hover-guard';
import { useNextEpisodeResolver } from './useNextEpisodeResolver';
import { usePlayerCinemaExtras } from './usePlayerCinemaExtras';
import { usePlayerControls } from './usePlayerControls';
import { usePlayerNowNext } from './usePlayerNowNext';
import { usePlayerSession } from './usePlayerSession';
import { usePlayerTargetHandoff } from './usePlayerTargetHandoff';
import {
  useAndroidDecoderModeSync,
  useInitialTrackSelection,
} from './usePlayerTrackAndDecoderSync';
import { useWatchProgressSync } from './useWatchProgressSync';

export type { PlayerScreenProps };

/** Default production OSD auto-hide delay in milliseconds (`#421`). */
export const DEFAULT_AUTO_HIDE_OSD_MS = 3_500;

/** Cross-platform Minimalist Cinema playback screen over injected {@link VideoHost} and {@link AppLifecyclePort} ports. */
export function PlayerScreen({
  catalog,
  videoHost,
  target,
  playbackGuard,
  appLifecycle = noopAppLifecycle,
  clock = DEFAULT_PLAYER_CLOCK,
  wallClock = Date.now,
  timers = DEFAULT_PLAYER_TIMERS,
  initialOsdHidden,
  autoHideOsdMs,
  initialVolume,
  onPersistVolume,
  autoSubtitlesOnSkipBack,
  onToggleAutoSubtitlesOnSkipBack,
  autoPlayNextEpisode,
  onToggleAutoPlayNextEpisode,
  reduceMotion,
  bufferPreset = 'auto',
  useTextureView = false,
  seekStepSec = 10,
  defaultResizeMode = 'fit',
  onPersistResizeMode,
  preferredAudioLang,
  preferredSubtitleLang,
  preferredAudioLanguages,
  preferredSubtitleLanguages,
  preferDefaultAudioTrack = true,
  preferHevcOverDolbyVision = false,
  filterSdhSubtitles = false,
  subtitleMode = 'smart',
  osdTimeDisplayMode = 'total',
  onPersistOsdTimeDisplayMode,
  sleepTimerDefaultAction = 'stop',
  onPersistSleepTimerAction,
  stillWatchingTimeoutMin = 0,
  onPlaybackActiveChange,
  onFineScrubHaptic,
  preferredAudioDevice,
  onPersistAudioDevice,
  androidDecoderMode,
  onSelectAndroidDecoderMode,
  onTargetChange,
  onExit,
}: PlayerScreenProps): ReactElement {
  const formFactor = useFormFactor();
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
  const wallClockRef = useRef(wallClock);
  wallClockRef.current = wallClock;
  const channelDrawerNavRef = useRef<ChannelDrawerNavHandle | null>(null);
  const timersRef = useRef(timers);
  timersRef.current = timers;
  const onTargetChangeRef = useRef(onTargetChange);
  onTargetChangeRef.current = onTargetChange;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const bufferPresetRef = useRef<BufferPreset>(bufferPreset);
  bufferPresetRef.current = bufferPreset;
  const preferHevcRef = useRef<boolean>(preferHevcOverDolbyVision);
  preferHevcRef.current = preferHevcOverDolbyVision;
  const filterSdhRef = useRef<boolean>(filterSdhSubtitles);
  filterSdhRef.current = filterSdhSubtitles;
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
    cancelScrubRef,
    onTargetChangeRef,
    bufferPresetRef,
    decoderModeRef,
    preferHevcOverDolbyVisionRef: preferHevcRef,
    filterSdhSubtitlesRef: filterSdhRef,
    resolvedNextEpisodeRef,
  });
  reloadActiveTargetRef.current = handoff.reloadActiveTarget;
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
    chapters,
    surfaceRecreationToken,
    inPip,
    isFullscreen,
    alwaysOnTop,
    overlayMode,
    audioDevices,
    activeAudioDevice,
  } = usePlayerSession({
    videoHost,
    activeTarget,
    isDesktop,
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
    wallClock,
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

  const openedEngine = sessionState.kind === 'ready' ? sessionState.opened : undefined;
  const extras = usePlayerCinemaExtras({
    activeTarget,
    status,
    tracks,
    chapters,
    openedEngine,
    catalogRef,
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

  const [stillWatchingAction, setStillWatchingAction] = useState<'continue' | 'stop'>('continue');
  const stillWatchingActionRef = useRef(stillWatchingAction);
  stillWatchingActionRef.current = stillWatchingAction;
  useEffect(() => {
    if (extras.stillWatching.promptVisible) setStillWatchingAction('continue');
  }, [extras.stillWatching.promptVisible]);

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
    onChannelListSelect: () => channelDrawerNavRef.current?.select(),
    onSetOrientationLocked: hostSetOrientationLocked,
    onSetDeinterlace: hostSetDeinterlace,
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
    stillWatchingVisible: !inPip && extras.stillWatching.promptVisible,
    onStillWatchingKey: (key) => {
      if (key === 'left' || key === 'up') {
        setStillWatchingAction('continue');
      } else if (key === 'right' || key === 'down') {
        setStillWatchingAction('stop');
      } else if (key === 'back') {
        extras.stillWatching.keepWatching();
      } else if (key === 'select') {
        if (stillWatchingActionRef.current === 'stop') extras.stillWatching.stopNow();
        else extras.stillWatching.keepWatching();
      }
    },
  });
  hostKeyRef.current = controls.handleHostKey;
  cancelScrubRef.current = controls.cancelScrub;

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
    onHydratedResizeMode: (mode) => {
      setResizeModeRef.current(mode, false);
      openedEngine?.setResizeMode?.(mode);
    },
  });

  const latestVolumeRef = useRef(controls.volume);
  latestVolumeRef.current = controls.volume;
  const latestResizeModeRef = useRef(controls.resizeMode);
  latestResizeModeRef.current = controls.resizeMode;
  const initialVolumeRef = useRef(initialVolume);
  initialVolumeRef.current = initialVolume;
  const preferredAudioDeviceRef = useRef(preferredAudioDevice);
  preferredAudioDeviceRef.current = preferredAudioDevice;
  useEffect(() => {
    if (openedEngine === undefined) return;
    const effective =
      initialVolumeRef.current !== undefined
        ? latestVolumeRef.current
        : (openedEngine.initialVolume ?? latestVolumeRef.current);
    openedEngine.setVolume?.(clampVolume(effective));
    openedEngine.setResizeMode?.(latestResizeModeRef.current);
    const savedDevice = preferredAudioDeviceRef.current?.trim();
    if (savedDevice && savedDevice !== 'auto') {
      openedEngine.setAudioDevice?.(savedDevice);
    }
  }, [openedEngine]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-send resizeMode when activeTarget.itemKey changes so mpv --reset-on-next-file never reverts to fit
  useEffect(() => {
    if (openedEngine === undefined) return;
    if (status.kind === 'playing' || status.kind === 'paused') {
      openedEngine.setResizeMode?.(controls.resizeMode);
    }
  }, [openedEngine, activeTarget.itemKey, status.kind, controls.resizeMode]);

  const fetchChannelNowNext = useCallback(async (itemKey: string) => {
    const query = catalogRef.current.nowNext ?? catalogRef.current.epgNowNext;
    if (query === undefined) return null;
    const rows = await query([itemKey], wallClockRef.current());
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
  const isWebDesktop = isDesktop && (Platform.OS as string) === 'web';
  const useDockedDesktopLayout = isDesktop && overlayMode === 'docked';
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
            extras.stillWatching.recordUserActivity();
            e?.preventDefault?.();
          }
        },
      } as Record<string, unknown>)
    : undefined;
  const touchHoverProps = buildTouchHoverProps(
    () => {
      extras.stillWatching.recordUserActivity();
      controls.handleTouchActivity();
    },
    (pointerType, point) => {
      extras.stillWatching.recordUserActivity();
      controls.handlePointerHover(pointerType, point);
    },
  );
  const osdVisible = !inPip && !controls.osdHidden && !controls.locked;
  const subtitleBottomInsetPx =
    !useDockedDesktopLayout && osdVisible
      ? isTv
        ? 120
        : controls.osdTier === 'progress'
          ? 64
          : 96
      : 0;
  const showTouchGestures = !inPip && !isTv && !isDesktop && !controls.locked && !anySheetOpen;

  const surfaceNode =
    sessionState.kind === 'ready' ? (
      <View
        testID="player-surface-layer"
        style={
          useDockedDesktopLayout ? playerStyles.surfaceLayerDesktop : playerStyles.surfaceLayer
        }
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
      fetchNowNext={fetchChannelNowNext}
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
      {...(hostSetDeinterlace !== undefined
        ? { deinterlace: controls.deinterlace, onToggleDeinterlace: controls.toggleDeinterlace }
        : {})}
      {...(onToggleAutoSubtitlesOnSkipBack !== undefined
        ? {
            autoSubtitlesOnSkipBack: autoSubtitlesOnSkipBack === true,
            onToggleAutoSubtitlesOnSkipBack,
          }
        : {})}
      {...(onToggleAutoPlayNextEpisode !== undefined
        ? {
            autoPlayNextEpisode: autoPlayNextEpisode !== false,
            onToggleAutoPlayNextEpisode,
          }
        : {})}
      chapters={chapters}
      onSelectChapter={extras.handleSelectChapter}
      sleepTimer={extras.sleepTimer}
      onSelectSleepTimer={extras.selectSleepTimer}
      onToggleSleepTimerAction={extras.toggleSleepTimerAction}
      statsVisible={controls.statsVisible}
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
    title: activeTarget.title,
    subtitle: activeTarget.subtitle,
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
    onRetry: controls.retry,
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
      stillWatchingFocusedAction={stillWatchingAction}
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
