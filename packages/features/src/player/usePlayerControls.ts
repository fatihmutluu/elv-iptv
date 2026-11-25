import {
  createSelectDebounceGuard,
  type KeyEvent,
  type SelectDebounceGuard,
} from '@elv/focus-core';
import type { PlaybackStatus } from '@elv/playback';
import { type UseKeyInterpreterOptions, useKeyInterpreter, useTvKeySource } from '@elv/ui-kit';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { HostKey } from '../ports/video-host';
import { useKeymap, useProfile } from '../shared';
import {
  type ChannelDigitBuffer,
  createChannelDigitBuffer,
  digitKeyToChar,
  isHiddenOsdPassthroughKey,
} from './channel-digit-entry';
import { targetIdentityKey } from './live-timeshift-model';
import { buildDesktopShortcutGuard } from './player-desktop-guard';
import {
  type PlayerControlsParams,
  readSettingsMenuOptionsFromControls,
  routeHostKey,
  routeOverlayAndMediaKey,
} from './player-key-routing';
import { clampVolume, stepVolume } from './player-overlay-model';
import { canPauseStatus, digitKeyToRatio, isScrubKey, STEP_SEEK_MS } from './scrub-controller';
import { rootIndexForSettingsViewOptions } from './settings-menu-nav';
import {
  createSkipBackSubtitlesController,
  type SkipBackSubtitlesController,
} from './skip-back-subtitles';
import { type clampTvOsdAction, initialTvOsdAction } from './tv-osd-nav';
import { isWebButtonActive, useDesktopPlayerShortcuts } from './useDesktopPlayerShortcuts';
import { usePlayerOverlayState } from './usePlayerOverlayState';
import { usePlayerScrub } from './usePlayerScrub';

export type { TvOsdAction } from './tv-osd-nav';
export type { PlayerControlsParams };

/**
 * Coordinates VOD & Live transport, decoupled preview-seek (`#292`), hidden-OSD passthrough (`#439`),
 * 3-tier OSD (`#391`), volume/wheel (`#394`), skip-back subtitles & hold-to-2× (`#114`),
 * Info & Channel drawers (`#58`, `#57`), TV OSD bar focus, Select debounce (`#130`), and touch lock.
 */
export function usePlayerControls(params: PlayerControlsParams) {
  const { formFactor, activeTarget, status, tracks, hasTracks, showRetry, hasService } = params;
  const { serviceRef, clockRef, timersRef, onExitRef, zapByRef } = params;
  const isTv = formFactor === 'tv';
  const isWebDesktop = formFactor === 'desktop' && (Platform.OS as string) === 'web';
  const hasPreviousChannel = params.hasPreviousChannel ?? false;

  const cbRef = useRef(params);
  cbRef.current = params;
  const keymap = useKeymap();
  const keymapOverridesRef = useRef(keymap.overrides);
  keymapOverridesRef.current = keymap.overrides;
  const { pinDialog, profilePickerOpen } = useProfile();
  const externalOverlayOpenRef = useRef(false);
  externalOverlayOpenRef.current =
    params.externalOverlayOpen === true || pinDialog !== null || profilePickerOpen;

  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const [volume, setVolumeState] = useState<number>(() => clampVolume(params.initialVolume ?? 100));
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const prevInitialVolumeRef = useRef(params.initialVolume);

  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [holdSpeedActive, setHoldSpeedActive] = useState(false);
  const [barScrubbing, setBarScrubbing] = useState(false);
  const [channelDigits, setChannelDigits] = useState('');
  const playbackSpeedRef = useRef(1);
  playbackSpeedRef.current = playbackSpeed;
  const priorSpeedRef = useRef<number | null>(null);

  const selectGuardRef = useRef<SelectDebounceGuard | null>(null);
  selectGuardRef.current ??= createSelectDebounceGuard();

  const digitBufRef = useRef<ChannelDigitBuffer | null>(null);
  digitBufRef.current ??= createChannelDigitBuffer({
    timers: () => timersRef.current,
    onChange: setChannelDigits,
    onCommit: (num) => cbRef.current.onJumpToChannel?.(num),
  });
  const digitBuf = digitBufRef.current;

  const skipBackSubsRef = useRef<SkipBackSubtitlesController | null>(null);
  skipBackSubsRef.current ??= createSkipBackSubtitlesController({
    timers: () => timersRef.current,
    onSelectSubtitle: (id) => {
      serviceRef.current?.selectSubtitleTrack(id);
    },
  });

  useEffect(() => {
    if (!hasService) setMuted(false);
  }, [hasService]);

  useEffect(() => {
    if (
      params.initialVolume !== undefined &&
      params.initialVolume !== prevInitialVolumeRef.current
    ) {
      prevInitialVolumeRef.current = params.initialVolume;
      const clamped = clampVolume(params.initialVolume);
      volumeRef.current = clamped;
      setVolumeState(clamped);
    }
  }, [params.initialVolume]);

  const activeTargetKey = targetIdentityKey(activeTarget);
  const latestTargetKeyRef = useRef(activeTargetKey);
  latestTargetKeyRef.current = activeTargetKey;

  useEffect(() => {
    const hadNonDefaultSpeed = priorSpeedRef.current !== null || playbackSpeedRef.current !== 1;
    priorSpeedRef.current = null;
    playbackSpeedRef.current = 1;
    setHoldSpeedActive(false);
    setPlaybackSpeed(1);
    if (hadNonDefaultSpeed) serviceRef.current?.setSpeed(1);
    setBarScrubbing(false);
    digitBuf.cancel();
    skipBackSubsRef.current?.reset();
    selectGuardRef.current?.reset();
    return () => {
      if (
        latestTargetKeyRef.current !== activeTargetKey &&
        (priorSpeedRef.current !== null || playbackSpeedRef.current !== 1)
      ) {
        priorSpeedRef.current = null;
        playbackSpeedRef.current = 1;
        serviceRef.current?.setSpeed(1);
      }
      digitBuf.cancel();
      skipBackSubsRef.current?.dispose();
    };
  }, [activeTargetKey, digitBuf, serviceRef]);

  useEffect(() => {
    return () => {
      if (priorSpeedRef.current !== null) {
        const restore = priorSpeedRef.current;
        priorSpeedRef.current = null;
        serviceRef.current?.setSpeed(restore);
      }
    };
  }, [serviceRef]);

  const getStepSeekMs = (): number =>
    cbRef.current.seekStepSec !== undefined ? cbRef.current.seekStepSec * 1_000 : STEP_SEEK_MS;

  const revealLiveControlsOsdRef = useRef<() => void>(() => undefined);

  const {
    scrub,
    previewPositionMs,
    timeShiftUnavailableVisible,
    cancelScrub,
    togglePlayPause,
    seekBy: rawSeekBy,
    seekToRatio,
    seekToEnd,
  } = usePlayerScrub({
    activeTarget,
    statusKind: status.kind,
    serviceRef,
    clockRef,
    timersRef,
    stepSeekMs: params.seekStepSec !== undefined ? params.seekStepSec * 1_000 : STEP_SEEK_MS,
    onTimeShiftUnavailable: () => revealLiveControlsOsdRef.current(),
    onSeekCommit: (positionMs, priorPositionMs) => {
      cbRef.current.onSeekCommit?.(positionMs);
      if (
        priorPositionMs !== undefined &&
        positionMs < priorPositionMs &&
        cbRef.current.activeTarget.kind === 'vod'
      ) {
        skipBackSubsRef.current?.onBackwardSeek({
          enabled: cbRef.current.autoSubtitlesOnSkipBack === true,
          tracks: cbRef.current.tracks,
        });
      }
    },
  });

  const scrubbingActive =
    hasService && activeTarget.kind === 'vod' && (barScrubbing || previewPositionMs !== undefined);
  const lastScrubbingSentRef = useRef(false);
  useEffect(() => {
    if (scrubbingActive !== lastScrubbingSentRef.current) {
      lastScrubbingSentRef.current = scrubbingActive;
      serviceRef.current?.setScrubbing?.(scrubbingActive);
    }
  }, [scrubbingActive, serviceRef]);
  useEffect(() => {
    return () => {
      if (lastScrubbingSentRef.current) {
        lastScrubbingSentRef.current = false;
        serviceRef.current?.setScrubbing?.(false);
      }
    };
  }, [serviceRef]);

  const overlay = usePlayerOverlayState({
    formFactor,
    itemKey: activeTarget.itemKey,
    resetKey: activeTargetKey,
    isVod: activeTarget.kind === 'vod',
    playbackSpeed,
    statusKind: status.kind,
    tracks,
    hasTracks,
    hasService,
    showRetry,
    hasSettings: params.hasSettings ?? false,
    hasInfo: params.hasInfo,
    hasChannelList: params.hasChannelList,
    hasPitchLock: params.onTogglePitchLock !== undefined,
    hasAudioNormalization: params.onToggleAudioNormalization !== undefined,
    hasAutoSubtitlesOnSkipBack:
      activeTarget.kind === 'vod' && params.onToggleAutoSubtitlesOnSkipBack !== undefined,
    hasAutoPlayNextEpisode:
      activeTarget.kind === 'vod' && params.onToggleAutoPlayNextEpisode !== undefined,
    hasAudioDevice:
      (params.audioDevices?.length ?? 0) > 0 && params.onSelectAudioDevice !== undefined,
    audioDevices: params.audioDevices,
    activeAudioDevice: params.activeAudioDevice,
    hasAudioDelay: params.onAdjustAudioDelay !== undefined,
    audioDelayMs: params.audioDelayMs,
    hasSubtitleDelay: params.onAdjustSubtitleDelay !== undefined,
    subtitleDelayMs: params.subtitleDelayMs,
    hasSubtitleStyle: params.hasSubtitleStyle,
    hasDualSubtitles: params.hasDualSubtitles,
    canPickSubtitleFile: params.canPickSubtitleFile,
    canLoadSubtitleUrl: params.canLoadSubtitleUrl,
    hasVideoQuality:
      (tracks.videoQualities?.length ?? 0) > 0 && params.onSelectVideoQuality !== undefined,
    selectedVideoQualityId: params.selectedVideoQualityId,
    qualityVariants: params.qualityVariants,
    hasVideoDecoder:
      params.androidDecoderMode !== undefined && params.onSelectAndroidDecoderMode !== undefined,
    androidDecoderMode: params.androidDecoderMode,
    chapters: params.chapters,
    hasSleepTimer: params.onSelectSleepTimer !== undefined,
    sleepTimerMinutes: params.sleepTimerMinutes,
    hasTimeDisplay: params.onCycleTimeDisplayMode !== undefined,
    hasAlwaysOnTop: params.onToggleAlwaysOnTop !== undefined,
    hasMiniPlayer: params.onMinimizeToMiniPlayer !== undefined,
    hasPip: params.onEnterPip !== undefined,
    hasMultiView: params.onEnterMultiView !== undefined,
    hasPopout: params.onPopoutPlayer !== undefined,
    hasNextEpisode: params.hasNextEpisode ?? false,
    hasPreviousChannel,
    ...(params.hasBackToLive === true ? { hasBackToLive: true } : {}),
    ...(params.liveTimeShiftSupported === true ? { liveTimeShiftSupported: true } : {}),
    ...(params.hasJumpToLive === true ? { hasJumpToLive: true } : {}),
    initialOsdHidden: params.initialOsdHidden,
    autoHideOsdMs: params.autoHideOsdMs,
    defaultResizeMode: params.defaultResizeMode,
    isScrubbing: previewPositionMs !== undefined || barScrubbing,
    clockRef,
    timersRef,
    cancelScrub,
    onResizeModeChange: params.onResizeModeChange,
    onSetOrientationLocked: params.onSetOrientationLocked,
    onSetDeinterlace:
      params.onSetDeinterlace ??
      (params.onCycleDeinterlaceMode !== undefined
        ? () => params.onCycleDeinterlaceMode?.()
        : undefined),
  });

  const allowTvSelect = (): boolean =>
    !isTv || (selectGuardRef.current?.allow(clockRef.current.now(), 'tv-select') ?? true);

  const retry = (): void => {
    scrub.cancel();
    overlay.blurTvOsd();
    overlay.blurTvScrubber();
    serviceRef.current?.retry();
  };

  const selectSpeed = (rate: number): void => {
    priorSpeedRef.current = null;
    setHoldSpeedActive(false);
    playbackSpeedRef.current = rate;
    setPlaybackSpeed(rate);
    serviceRef.current?.setSpeed(rate);
  };

  const startHoldSpeed = (): void => {
    if (
      cbRef.current.activeTarget.kind !== 'vod' ||
      serviceRef.current === null ||
      overlay.liveRef.current.locked ||
      priorSpeedRef.current !== null
    ) {
      return;
    }
    priorSpeedRef.current = playbackSpeedRef.current;
    setHoldSpeedActive(true);
    playbackSpeedRef.current = 2;
    setPlaybackSpeed(2);
    serviceRef.current.setSpeed(2);
  };

  const endHoldSpeed = (): void => {
    if (priorSpeedRef.current === null) return;
    const restore = priorSpeedRef.current;
    priorSpeedRef.current = null;
    setHoldSpeedActive(false);
    playbackSpeedRef.current = restore;
    setPlaybackSpeed(restore);
    serviceRef.current?.setSpeed(restore);
  };

  const selectProgram = (id: string): void => {
    serviceRef.current?.selectProgram?.(id);
  };

  const selectAudio = (id: string): void => {
    serviceRef.current?.selectAudioTrack(id);
    cbRef.current.onAudioTrackSelected?.(id);
  };

  const selectSubtitle = (id: string | null): void => {
    skipBackSubsRef.current?.onManualSubtitleChange();
    serviceRef.current?.selectSubtitleTrack(id);
    cbRef.current.onSubtitleTrackSelected?.(id);
  };

  revealLiveControlsOsdRef.current = () => {
    if (overlay.liveRef.current.osdTier !== 'controls') overlay.showControlsOsd();
    else overlay.notifyOsdActivity();
  };

  const seekBy = (deltaMs: number): void => {
    const hasVodAnchor =
      cbRef.current.activeTarget.kind === 'vod' &&
      serviceRef.current?.getState().anchor !== undefined;
    const isLiveTimeShift =
      cbRef.current.activeTarget.kind === 'live' && cbRef.current.liveTimeShiftSupported === true;
    rawSeekBy(deltaMs);
    if (hasVodAnchor) {
      if (overlay.liveRef.current.osdTier === 'hidden') overlay.showProgressOsd();
      else overlay.notifyOsdActivity();
    } else if (isLiveTimeShift) {
      revealLiveControlsOsdRef.current();
    }
  };

  const setVolume = (next: number): void => {
    const clamped = clampVolume(next);
    volumeRef.current = clamped;
    setVolumeState(clamped);
    if (clamped > 0 && mutedRef.current) {
      mutedRef.current = false;
      setMuted(false);
      cbRef.current.onToggleMute?.();
    }
    cbRef.current.onSetVolume?.(clamped);
    cbRef.current.onPersistVolume?.(clamped);
  };

  const stepVolumeBy = (delta: number): void => {
    setVolume(stepVolume(volumeRef.current, delta));
    if (overlay.liveRef.current.osdTier === 'hidden') overlay.showProgressOsd();
    else overlay.notifyOsdActivity();
  };

  const handleWheelVolume = (deltaY: number): boolean => {
    const s = overlay.liveRef.current;
    if (s.locked || s.tracksOpen || s.settingsOpen || s.infoOpen || s.channelListOpen) {
      return false;
    }
    if (!Number.isFinite(deltaY) || deltaY === 0) return false;
    stepVolumeBy(deltaY < 0 ? 5 : -5);
    return true;
  };

  const applyPlayOrPause = (
    key: 'play' | 'pause',
    statusKind: PlaybackStatus['kind'] | undefined,
  ): void => {
    scrub.cancel();
    if (key === 'play') {
      if (statusKind === 'paused' || statusKind === 'ended') serviceRef.current?.play();
      else if (statusKind === 'failed') retry();
    } else if (canPauseStatus(statusKind)) {
      serviceRef.current?.pause();
    }
  };

  const handleBack = (): void => {
    scrub.cancel();
    digitBuf.cancel();
    selectGuardRef.current?.reset();
    const s = overlay.liveRef.current;
    if (cbRef.current.previewChannelActive) {
      cbRef.current.onCancelPreviewChannel?.();
      return;
    }
    if (s.locked) overlay.unlockControls();
    else if (s.settingsOpen) {
      if (s.settingsMenu.view !== 'root') {
        overlay.updateSettingsMenu({
          view: 'root',
          index: rootIndexForSettingsViewOptions(
            s.settingsMenu.view,
            readSettingsMenuOptionsFromControls(cbRef.current, s.canOpenInfo),
          ),
        });
      } else overlay.closeSettings();
    } else if (s.tracksOpen) overlay.closeTracks();
    else if (s.infoOpen) overlay.closeInfo();
    else if (s.channelListOpen) overlay.closeChannelList();
    else if (isTv && s.tvScrubberFocused) overlay.blurTvScrubber();
    else if (isTv && s.tvOsdFocused) overlay.blurTvOsd();
    else if (s.osdTier === 'progress') overlay.hideOsd();
    else if (
      isTv &&
      cbRef.current.activeTarget.kind === 'live' &&
      cbRef.current.tvBackMinimizesLive === true &&
      cbRef.current.onMinimizeToMiniPlayer !== undefined
    ) {
      cbRef.current.onMinimizeToMiniPlayer();
    } else onExitRef.current();
  };

  const jumpToLiveEdge = (): void => {
    const svc = serviceRef.current;
    if (svc === null) return;
    svc.jumpToLiveEdge();
    if (svc.getState().status.kind === 'paused') svc.play();
  };

  const activateTvOsd = (act: ReturnType<typeof clampTvOsdAction>): void => {
    if (!allowTvSelect()) return;
    if (act === 'back') onExitRef.current();
    else if (act === 'playPause') togglePlayPause();
    else if (act === 'seekBack') seekBy(-getStepSeekMs());
    else if (act === 'seekForward') seekBy(getStepSeekMs());
    else if (act === 'jumpToLive') jumpToLiveEdge();
    else if (act === 'backToLive') {
      overlay.blurTvOsd();
      cbRef.current.onBackToLive?.();
    } else if (act === 'tracks') overlay.openTracks();
    else if (act === 'settings') overlay.openSettings();
    else if (act === 'info') overlay.toggleInfo();
    else if (act === 'channelList') overlay.toggleChannelList();
    else if (act === 'retry') retry();
    else if (act === 'prevChannel') {
      overlay.blurTvOsd();
      cbRef.current.onJumpPreviousChannel?.();
    } else if (act === 'nextEpisode') {
      overlay.blurTvOsd();
      cbRef.current.onPlayNextEpisode?.();
    }
  };

  const handleKeyEvent = (event: KeyEvent): boolean => {
    if (externalOverlayOpenRef.current) return false;
    if (cbRef.current.stillWatchingVisible) {
      if (event.kind === 'press') {
        cbRef.current.onStillWatchingKey?.(event.key);
      }
      return true;
    }
    cbRef.current.onUserActivity?.();
    const s = overlay.liveRef.current;
    if (event.kind === 'press' && event.key === 'back') {
      handleBack();
      return true;
    }
    if (s.locked) return true;
    if (isTv && s.osdHidden) {
      if (
        cbRef.current.activeTarget.kind === 'live' &&
        (event.kind === 'press' || event.kind === 'repeat') &&
        (event.key === 'channelUp' || event.key === 'channelDown')
      ) {
        zapByRef.current(event.key === 'channelUp' ? 1 : -1, event.kind === 'repeat');
        return true;
      }
      if (
        cbRef.current.activeTarget.kind === 'vod' &&
        (event.kind === 'press' || event.kind === 'repeat') &&
        (event.key === 'rewind' || event.key === 'fastForward')
      ) {
        overlay.showProgressOsd();
      } else {
        overlay.showOsd();
        if (!isHiddenOsdPassthroughKey(event.key)) {
          if (event.kind === 'press' && event.key === 'select') allowTvSelect();
          return true;
        }
      }
    }
    if (
      event.key === 'up' ||
      event.key === 'down' ||
      event.key === 'left' ||
      event.key === 'right'
    ) {
      selectGuardRef.current?.reset();
    }
    if (isTv) overlay.notifyOsdActivity();
    if (event.kind === 'press' && event.key === 'select' && isWebButtonActive()) return true;

    const anySheetOpen = s.settingsOpen || s.tracksOpen || s.channelListOpen || s.infoOpen;
    if (
      cbRef.current.previewChannelActive &&
      !anySheetOpen &&
      event.kind === 'press' &&
      event.key === 'select'
    ) {
      if (allowTvSelect()) cbRef.current.onConfirmPreviewChannel?.();
      return true;
    }

    const isVodTarget = cbRef.current.activeTarget.kind === 'vod';
    if (
      routeOverlayAndMediaKey(event, {
        isTv,
        liveTimeShiftSupported: cbRef.current.liveTimeShiftSupported === true,
        ...readSettingsMenuOptionsFromControls(cbRef.current, s.canOpenInfo),
        playbackSpeed: playbackSpeedRef.current,
        state: s,
        service: serviceRef.current,
        scrub,
        digitBuf,
        allowTvSelect,
        showOsd: overlay.showOsd,
        toggleStats: overlay.toggleStats,
        toggleInfo: overlay.toggleInfo,
        toggleAlwaysOnTop: cbRef.current.onToggleAlwaysOnTop,
        toggleTimeDisplayMode: cbRef.current.onCycleTimeDisplayMode,
        toggleChannelList: overlay.toggleChannelList,
        toggleResizeMode: overlay.toggleResizeMode,
        toggleDeinterlace: cbRef.current.onCycleDeinterlaceMode ?? overlay.toggleDeinterlace,
        togglePitchLock: cbRef.current.onTogglePitchLock,
        toggleAudioNormalization: cbRef.current.onToggleAudioNormalization,
        toggleAutoSubtitlesOnSkipBack: cbRef.current.onToggleAutoSubtitlesOnSkipBack,
        toggleAutoPlayNextEpisode: cbRef.current.onToggleAutoPlayNextEpisode,
        onMinimizeToMiniPlayer: cbRef.current.onMinimizeToMiniPlayer,
        onEnterPip: cbRef.current.onEnterPip,
        onEnterMultiView: cbRef.current.onEnterMultiView,
        onPopoutPlayer: cbRef.current.onPopoutPlayer,
        onChannelListMove: cbRef.current.onChannelListMove,
        onChannelListSwitchTab: cbRef.current.onChannelListSwitchTab,
        onChannelListSelect: cbRef.current.onChannelListSelect,
        togglePlayPause,
        openTracks: overlay.openTracks,
        closeTracks: overlay.closeTracks,
        closeSettings: overlay.closeSettings,
        updateSettingsMenu: overlay.updateSettingsMenu,
        updatePickerCursor: overlay.updatePickerCursor,
        focusTvOsd: overlay.focusTvOsd,
        blurTvOsd: overlay.blurTvOsd,
        focusTvScrubber: overlay.focusTvScrubber,
        blurTvScrubber: overlay.blurTvScrubber,
        activateTvOsd,
        selectSpeed,
        selectProgram,
        selectAudio,
        selectSubtitle,
        selectSecondarySubtitle: cbRef.current.onSelectSecondarySubtitle,
        pickSubtitleFile: cbRef.current.onPickSubtitleFile,
        loadSubtitleUrl: cbRef.current.onLoadSubtitleUrl,
        stepSubtitleStyle: cbRef.current.onStepSubtitleStyle,
        resetSubtitleStyle: cbRef.current.onResetSubtitleStyle,
        selectChapter: cbRef.current.onSelectChapter,
        selectSleepTimer: cbRef.current.onSelectSleepTimer,
        toggleSleepTimerAction: cbRef.current.onToggleSleepTimerAction,
        selectAudioDevice: cbRef.current.onSelectAudioDevice,
        adjustAudioDelay: cbRef.current.onAdjustAudioDelay,
        adjustSubtitleDelay: cbRef.current.onAdjustSubtitleDelay,
        selectVideoQuality: cbRef.current.onSelectVideoQuality,
        selectQualityVariant: cbRef.current.onSelectQualityVariant,
        selectAndroidDecoderMode: cbRef.current.onSelectAndroidDecoderMode,
        onExit: () => onExitRef.current(),
        onJumpPreviousChannel: cbRef.current.onJumpPreviousChannel,
        keymapOverrides: keymapOverridesRef.current,
        openSettings: overlay.openSettings,
        seekBy,
        stepSeekMs: getStepSeekMs(),
        zapBy: (delta) => zapByRef.current(delta, false),
        toggleMute: cbRef.current.onToggleMute !== undefined ? toggleMute : undefined,
      })
    ) {
      return true;
    }

    const statusKind = serviceRef.current?.getState().status.kind;
    if (event.kind === 'press' && event.key === 'select' && statusKind === 'failed') {
      if (allowTvSelect()) retry();
      return true;
    }

    if (isVodTarget) {
      const digitRatio =
        !isWebDesktop && event.kind === 'press' ? digitKeyToRatio(event.key) : undefined;
      if (digitRatio !== undefined) seekToRatio(digitRatio);
      else if (event.kind === 'press' && event.key === 'next') cbRef.current.onPlayNextEpisode?.();
      else if (event.kind === 'press' && (event.key === 'select' || event.key === 'playPause')) {
        if (event.key === 'select' && !allowTvSelect()) return true;
        if (event.key === 'select' && scrub.previewPositionMs !== undefined) scrub.commit();
        else togglePlayPause();
      } else if (event.kind === 'press' && (event.key === 'play' || event.key === 'pause')) {
        applyPlayOrPause(event.key, statusKind);
      } else if ((event.kind === 'press' || event.kind === 'repeat') && isScrubKey(event.key)) {
        const direction = event.key === 'left' || event.key === 'rewind' ? -1 : 1;
        if (s.osdTier === 'hidden') overlay.showProgressOsd();
        else overlay.notifyOsdActivity();
        scrub.step(direction, event.kind);
      } else if (isTv && event.kind === 'press' && event.key === 'up') overlay.hideOsd();
      else if (isTv && event.kind === 'press' && event.key === 'down') {
        overlay.focusTvOsd(initialTvOsdAction(s.availableOsd));
      }
      return true;
    }

    const digitChar = event.kind === 'press' ? digitKeyToChar(event.key) : undefined;
    if (digitChar !== undefined) digitBuf.push(digitChar);
    else if (event.kind === 'press' && event.key === 'playPause') togglePlayPause();
    else if (event.kind === 'press' && (event.key === 'play' || event.key === 'pause')) {
      applyPlayOrPause(event.key, statusKind);
    } else if (
      (event.kind === 'press' || event.kind === 'repeat') &&
      (event.key === 'rewind' ||
        event.key === 'fastForward' ||
        (!isTv &&
          cbRef.current.liveTimeShiftSupported === true &&
          (event.key === 'left' || event.key === 'right')))
    ) {
      const dir = event.key === 'rewind' || event.key === 'left' ? -1 : 1;
      seekBy(dir * getStepSeekMs());
    } else if (event.kind === 'press' && event.key === 'next') zapByRef.current(1, false);
    else if (event.kind === 'press' && event.key === 'previous') zapByRef.current(-1, false);
    else if (isTv && event.kind === 'press' && event.key === 'left') {
      if (s.canOpenChannelList) overlay.openChannelList();
      else if (s.hasTracks) overlay.openTracks();
    } else if (
      isTv &&
      event.kind === 'press' &&
      (event.key === 'select' || event.key === 'right')
    ) {
      if (event.key !== 'select' || allowTvSelect()) {
        overlay.focusTvOsd(initialTvOsdAction(s.availableOsd));
      }
    } else if (event.kind === 'press' || event.kind === 'repeat') {
      const repeat = event.kind === 'repeat';
      if (event.key === 'channelUp' || event.key === 'up') zapByRef.current(1, repeat);
      else if (event.key === 'channelDown' || event.key === 'down') zapByRef.current(-1, repeat);
    }
    return true;
  };

  const interpreterInputRef = useRef<
    Parameters<NonNullable<UseKeyInterpreterOptions['keySource']>>[0]
  >(() => undefined);
  useTvKeySource((input) => {
    const consumed = interpreterInputRef.current(input);
    if (isScrubKey(input.key)) {
      if (input.action === 'up') scrub.commit();
      else if (input.action === 'cancel') scrub.cancel();
    }
    return consumed;
  });
  useKeyInterpreter(handleKeyEvent, {
    longKeys: keymap.longPressKeys,
    keySource: (onInput) => {
      interpreterInputRef.current = onInput;
    },
  });

  const toggleFullscreen = (): void => {
    if (overlay.liveRef.current.tracksOpen) overlay.closeTracks();
    if (overlay.liveRef.current.settingsOpen) overlay.closeSettings();
    if (overlay.liveRef.current.infoOpen) overlay.closeInfo();
    if (overlay.liveRef.current.channelListOpen) overlay.closeChannelList();
    cbRef.current.onToggleFullscreen?.();
  };
  const toggleMute = (): void => {
    setMuted((prev) => {
      mutedRef.current = !prev;
      return !prev;
    });
    cbRef.current.onToggleMute?.();
  };
  const handleStop = (): void => {
    scrub.cancel();
    digitBuf.cancel();
    selectGuardRef.current?.reset();
    serviceRef.current?.stop();
    onExitRef.current();
  };
  const handleHostKey = (key: HostKey): void => {
    if (externalOverlayOpenRef.current) return;
    if (key === 'stop') {
      handleStop();
      return;
    }
    if (cbRef.current.stillWatchingVisible) return;
    cbRef.current.onUserActivity?.();
    overlay.notifyOsdActivity();
    routeHostKey(key, {
      isVod: cbRef.current.activeTarget.kind === 'vod',
      liveTimeShiftSupported: cbRef.current.liveTimeShiftSupported === true,
      state: overlay.liveRef.current,
      handleBack,
      onStop: handleStop,
      toggleFullscreen,
      toggleResizeMode: overlay.toggleResizeMode,
      toggleAlwaysOnTop: cbRef.current.onToggleAlwaysOnTop,
      togglePlayPause,
      seekBy,
      stepSeekMs: getStepSeekMs(),
      stepVolumeBy,
      toggleMute: cbRef.current.onToggleMute !== undefined ? toggleMute : undefined,
      openTracks: overlay.openTracks,
      closeTracks: overlay.closeTracks,
      toggleInfo: overlay.toggleInfo,
      toggleChannelList: overlay.toggleChannelList,
      zapBy: (delta) => zapByRef.current(delta),
      onJumpPreviousChannel: cbRef.current.onJumpPreviousChannel,
    });
  };
  const desktopFallbackKeyProps = useDesktopPlayerShortcuts({
    formFactor,
    clockRef,
    scrub,
    guard: buildDesktopShortcutGuard({
      cbRef,
      externalOverlayOpenRef,
      overlayLiveRef: overlay.liveRef,
      openTracks: overlay.openTracks,
      closeTracks: overlay.closeTracks,
      toggleInfo: overlay.toggleInfo,
      toggleStats: overlay.toggleStats,
      toggleChannelList: overlay.toggleChannelList,
      toggleMute,
      toggleFullscreen,
      getStepSeekMs,
      seekBy,
      seekToRatio,
      seekToEnd,
      togglePlayPause,
      handleKeyEvent,
    }),
  });

  return {
    ...overlay.publicState,
    previewPositionMs,
    channelDigits,
    muted,
    volume,
    playbackSpeed,
    holdSpeedActive,
    isPausedOrEnded: status.kind === 'paused' || status.kind === 'ended',
    retry,
    togglePlayPause,
    toggleFullscreen,
    toggleMute,
    setVolume,
    stepVolumeBy,
    handleWheelVolume,
    seekStepBack: () => seekBy(-getStepSeekMs()),
    seekStepForward: () => seekBy(getStepSeekMs()),
    seekToRatio,
    setBarScrubbing,
    timeShiftUnavailableVisible,
    jumpToLiveEdge,
    selectProgram,
    selectAudio,
    selectSubtitle,
    selectSpeed,
    startHoldSpeed,
    endHoldSpeed,
    cancelScrub,
    handleBack,
    handleHostKey,
    desktopFallbackKeyProps,
  };
}
