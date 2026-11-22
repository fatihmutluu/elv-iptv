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
import {
  type ChannelDigitBuffer,
  createChannelDigitBuffer,
  digitKeyToChar,
  isHiddenOsdPassthroughKey,
} from './channel-digit-entry';
import {
  type PlayerControlsParams,
  routeHostKey,
  routeOverlayAndMediaKey,
} from './player-key-routing';
import { canPauseStatus, digitKeyToRatio, isScrubKey, STEP_SEEK_MS } from './scrub-controller';
import { rootIndexForSettingsView } from './settings-menu-nav';
import { type clampTvOsdAction, initialTvOsdAction } from './tv-osd-nav';
import { isWebButtonActive, useDesktopPlayerShortcuts } from './useDesktopPlayerShortcuts';
import { usePlayerOverlayState } from './usePlayerOverlayState';
import { usePlayerScrub } from './usePlayerScrub';

export type { TvOsdAction } from './tv-osd-nav';
export type { PlayerControlsParams };

/**
 * Coordinates VOD & Live transport, decoupled preview-seek (`#292`), hidden-OSD passthrough (`#439`),
 * TV OSD bar focus, `TrackPickerModal`, 2-level `PlayerSettingsSheet`, Select debounce (`#130`), and touch lock.
 */
export function usePlayerControls(params: PlayerControlsParams) {
  const { formFactor, activeTarget, status, tracks, hasTracks, showRetry, hasService } = params;
  const { serviceRef, clockRef, timersRef, onExitRef, zapByRef } = params;
  const isTv = formFactor === 'tv';
  const isWebDesktop = formFactor === 'desktop' && (Platform.OS as string) === 'web';
  const hasPreviousChannel = params.hasPreviousChannel ?? false;

  const cbRef = useRef(params);
  cbRef.current = params;

  const [muted, setMuted] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [barScrubbing, setBarScrubbing] = useState(false);
  const [channelDigits, setChannelDigits] = useState('');
  const playbackSpeedRef = useRef(1);
  playbackSpeedRef.current = playbackSpeed;

  const selectGuardRef = useRef<SelectDebounceGuard | null>(null);
  selectGuardRef.current ??= createSelectDebounceGuard();

  const digitBufRef = useRef<ChannelDigitBuffer | null>(null);
  digitBufRef.current ??= createChannelDigitBuffer({
    timers: () => timersRef.current,
    onChange: setChannelDigits,
    onCommit: (num) => cbRef.current.onJumpToChannel?.(num),
  });
  const digitBuf = digitBufRef.current;

  useEffect(() => {
    if (!hasService) setMuted(false);
  }, [hasService]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset speed, scrubbing, digit buffer, and select guard on item change
  useEffect(() => {
    setPlaybackSpeed(1);
    setBarScrubbing(false);
    digitBuf.cancel();
    selectGuardRef.current?.reset();
    return () => digitBuf.cancel();
  }, [activeTarget.itemKey, digitBuf]);

  const { scrub, previewPositionMs, cancelScrub, togglePlayPause, seekBy, seekToRatio, seekToEnd } =
    usePlayerScrub({
      activeTarget,
      statusKind: status.kind,
      serviceRef,
      clockRef,
      timersRef,
      onSeekCommit: params.onSeekCommit,
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
    isVod: activeTarget.kind === 'vod',
    playbackSpeed,
    statusKind: status.kind,
    tracks,
    hasTracks,
    hasService,
    showRetry,
    hasSettings: params.hasSettings ?? false,
    hasNextEpisode: params.hasNextEpisode ?? false,
    hasPreviousChannel,
    initialOsdHidden: params.initialOsdHidden,
    autoHideOsdMs: params.autoHideOsdMs,
    isScrubbing: previewPositionMs !== undefined || barScrubbing,
    clockRef,
    timersRef,
    cancelScrub,
    onSetOrientationLocked: params.onSetOrientationLocked,
    onSetDeinterlace: params.onSetDeinterlace,
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
    setPlaybackSpeed(rate);
    serviceRef.current?.setSpeed(rate);
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
    if (s.locked) overlay.unlockControls();
    else if (s.settingsOpen) {
      if (s.settingsMenu.view !== 'root') {
        overlay.updateSettingsMenu({
          view: 'root',
          index: rootIndexForSettingsView(
            s.settingsMenu.view,
            cbRef.current.activeTarget.kind === 'vod',
            formFactor !== 'desktop',
            cbRef.current.onSetDeinterlace !== undefined,
          ),
        });
      } else overlay.closeSettings();
    } else if (s.tracksOpen) overlay.closeTracks();
    else if (isTv && s.tvScrubberFocused) overlay.blurTvScrubber();
    else if (isTv && s.tvOsdFocused) overlay.blurTvOsd();
    else onExitRef.current();
  };

  const activateTvOsd = (act: ReturnType<typeof clampTvOsdAction>): void => {
    if (!allowTvSelect()) return;
    if (act === 'back') onExitRef.current();
    else if (act === 'playPause') togglePlayPause();
    else if (act === 'seekBack') seekBy(-STEP_SEEK_MS);
    else if (act === 'seekForward') seekBy(STEP_SEEK_MS);
    else if (act === 'tracks') overlay.openTracks();
    else if (act === 'settings') overlay.openSettings();
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
      overlay.showOsd();
      if (!isHiddenOsdPassthroughKey(event.key)) {
        if (event.kind === 'press' && event.key === 'select') allowTvSelect();
        return true;
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

    const isVodTarget = cbRef.current.activeTarget.kind === 'vod';
    if (
      routeOverlayAndMediaKey(event, {
        isTv,
        isVod: isVodTarget,
        hasAspect: formFactor !== 'desktop',
        hasDeinterlace: cbRef.current.onSetDeinterlace !== undefined,
        playbackSpeed: playbackSpeedRef.current,
        state: s,
        service: serviceRef.current,
        scrub,
        digitBuf,
        allowTvSelect,
        showOsd: overlay.showOsd,
        toggleStats: overlay.toggleStats,
        toggleResizeMode: overlay.toggleResizeMode,
        toggleDeinterlace: overlay.toggleDeinterlace,
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
        onExit: () => onExitRef.current(),
        onJumpPreviousChannel: cbRef.current.onJumpPreviousChannel,
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
        scrub.step(event.key === 'left' || event.key === 'rewind' ? -1 : 1, event.kind);
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
    } else if (event.kind === 'press' && event.key === 'next') zapByRef.current(1, false);
    else if (event.kind === 'press' && event.key === 'previous') zapByRef.current(-1, false);
    else if (isTv && event.kind === 'press' && event.key === 'left' && s.hasTracks) {
      overlay.openTracks();
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
    keySource: (onInput) => {
      interpreterInputRef.current = onInput;
    },
  });

  const canUseDesktopShortcuts = (): boolean => {
    const s = overlay.liveRef.current;
    return !s.locked && !s.tracksOpen && !s.settingsOpen;
  };
  const toggleFullscreen = (): void => {
    if (overlay.liveRef.current.tracksOpen) overlay.closeTracks();
    if (overlay.liveRef.current.settingsOpen) overlay.closeSettings();
    cbRef.current.onToggleFullscreen?.();
  };
  const toggleMute = (): void => {
    setMuted((prev) => !prev);
    cbRef.current.onToggleMute?.();
  };
  const handleHostKey = (key: HostKey): void => {
    overlay.notifyOsdActivity();
    routeHostKey(key, {
      isVod: cbRef.current.activeTarget.kind === 'vod',
      state: overlay.liveRef.current,
      handleBack,
      toggleFullscreen,
      togglePlayPause,
      seekBy,
      toggleMute: cbRef.current.onToggleMute !== undefined ? toggleMute : undefined,
      openTracks: overlay.openTracks,
      closeTracks: overlay.closeTracks,
      zapBy: (delta) => zapByRef.current(delta),
      onJumpPreviousChannel: cbRef.current.onJumpPreviousChannel,
    });
  };
  const desktopFallbackKeyProps = useDesktopPlayerShortcuts({
    formFactor,
    clockRef,
    scrub,
    guard: {
      canJumpPreviousChannel: () =>
        cbRef.current.activeTarget.kind === 'live' &&
        cbRef.current.hasPreviousChannel === true &&
        canUseDesktopShortcuts(),
      onJumpPreviousChannel: () => cbRef.current.onJumpPreviousChannel?.(),
      canToggleTracks: () =>
        !overlay.liveRef.current.locked &&
        !overlay.liveRef.current.settingsOpen &&
        (overlay.liveRef.current.tracksOpen || overlay.liveRef.current.hasTracks),
      onToggleTracks: () =>
        overlay.liveRef.current.tracksOpen ? overlay.closeTracks() : overlay.openTracks(),
      canToggleMute: () => canUseDesktopShortcuts() && cbRef.current.onToggleMute !== undefined,
      onToggleMute: toggleMute,
      canToggleFullscreen: () =>
        !overlay.liveRef.current.locked && cbRef.current.onToggleFullscreen !== undefined,
      onToggleFullscreen: toggleFullscreen,
      isVod: () => cbRef.current.activeTarget.kind === 'vod',
      canUseShortcuts: canUseDesktopShortcuts,
      onSeekBy: seekBy,
      onSeekToRatio: seekToRatio,
      onSeekToEnd: seekToEnd,
      onTogglePlayPause: togglePlayPause,
      onKeyEvent: handleKeyEvent,
    },
  });

  return {
    ...overlay.publicState,
    previewPositionMs,
    channelDigits,
    muted,
    playbackSpeed,
    isPausedOrEnded: status.kind === 'paused' || status.kind === 'ended',
    retry,
    togglePlayPause,
    toggleFullscreen,
    toggleMute,
    seekStepBack: () => seekBy(-STEP_SEEK_MS),
    seekStepForward: () => seekBy(STEP_SEEK_MS),
    seekToRatio,
    setBarScrubbing,
    jumpToLiveEdge: () => {
      serviceRef.current?.jumpToLiveEdge();
    },
    selectAudio: (id: string) => serviceRef.current?.selectAudioTrack(id),
    selectSubtitle: (id: string | null) => serviceRef.current?.selectSubtitleTrack(id),
    selectSpeed,
    cancelScrub,
    handleBack,
    handleHostKey,
    desktopFallbackKeyProps,
  };
}
