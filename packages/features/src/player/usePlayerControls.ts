import type { KeyEvent, KeyInput } from '@elv/focus-core';
import {
  type MediaTracks,
  type PlaybackClock,
  type PlaybackService,
  type PlaybackStatus,
  type PlaybackTimers,
  positionAt,
} from '@elv/playback';
import { type FormFactor, useKeyInterpreter, useTvKeySource } from '@elv/ui-kit';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import {
  canPauseStatus,
  clampSeekPosition,
  createScrubController,
  digitKeyToRatio,
  isScrubKey,
  type ScrubController,
  STEP_SEEK_MS,
  shouldCancelScrubOnStatus,
} from './scrub-controller';
import { routeSettingsMenuKey } from './settings-menu-nav';
import { routePickerKey } from './track-picker-nav';
import {
  clampTvOsdAction,
  initialTvOsdAction,
  routeTvOsdKey,
  routeTvScrubberKey,
} from './tv-osd-nav';
import { isWebButtonActive, useDesktopPlayerShortcuts } from './useDesktopPlayerShortcuts';
import { usePlayerOverlayState } from './usePlayerOverlayState';

export type { TvOsdAction } from './tv-osd-nav';

/** Parameters of {@link usePlayerControls}. */
export interface PlayerControlsParams {
  formFactor: FormFactor;
  activeTarget: PlayTarget;
  status: PlaybackStatus;
  tracks: MediaTracks;
  hasTracks: boolean;
  showRetry: boolean;
  hasService: boolean;
  hasSettings?: boolean;
  hasNextEpisode?: boolean;
  hasPreviousChannel?: boolean;
  initialOsdHidden?: boolean | undefined;
  autoHideOsdMs?: number | undefined;
  serviceRef: MutableRefObject<PlaybackService | null>;
  clockRef: MutableRefObject<PlaybackClock>;
  timersRef: MutableRefObject<PlaybackTimers>;
  onExitRef: MutableRefObject<() => void>;
  zapByRef: MutableRefObject<(delta: 1 | -1, repeat?: boolean) => void>;
  onSeekCommit?: (positionMs: number) => void;
  onPlayNextEpisode?: () => void;
  onJumpPreviousChannel?: () => void;
  onToggleFullscreen?: (() => void) | undefined;
  onToggleMute?: (() => void) | undefined;
}

/**
 * Coordinates VOD transport, decoupled preview-seek (`#292`), TV OSD bar focus,
 * `TrackPickerModal`, 2-level `PlayerSettingsSheet`, and touch-only lock for `PlayerScreen`.
 */
export function usePlayerControls(params: PlayerControlsParams) {
  const { formFactor, activeTarget, status, tracks, hasTracks, showRetry, hasService } = params;
  const { serviceRef, clockRef, timersRef, onExitRef, zapByRef } = params;
  const isTv = formFactor === 'tv';
  const isWebDesktop = formFactor === 'desktop' && (Platform.OS as string) === 'web';
  const hasPreviousChannel = params.hasPreviousChannel ?? false;

  const cbRef = useRef(params);
  cbRef.current = params;

  const [previewPositionMs, setPreviewPositionMs] = useState<number | undefined>(undefined);

  const scrubRef = useRef<ScrubController | null>(null);
  if (scrubRef.current === null) {
    scrubRef.current = createScrubController({
      timers: {
        setTimeout: (fn, ms) => timersRef.current.setTimeout(fn, ms),
        clearTimeout: (handle) => timersRef.current.clearTimeout(handle),
      },
      readPosition: () => {
        const anchor =
          cbRef.current.activeTarget.kind === 'vod'
            ? serviceRef.current?.getState().anchor
            : undefined;
        return anchor === undefined
          ? undefined
          : {
              positionMs: positionAt(anchor, clockRef.current.now()),
              ...(anchor.durationMs === undefined ? {} : { durationMs: anchor.durationMs }),
            };
      },
      seek: (ms) => {
        if (cbRef.current.activeTarget.kind === 'vod') {
          serviceRef.current?.seek(ms);
          cbRef.current.onSeekCommit?.(ms);
        }
      },
      onPreviewChange: setPreviewPositionMs,
    });
  }
  const scrub = scrubRef.current;
  const cancelScrub = useCallback(() => scrub.cancel(), [scrub]);

  const overlay = usePlayerOverlayState({
    formFactor,
    itemKey: activeTarget.itemKey,
    isVod: activeTarget.kind === 'vod',
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
    isScrubbing: previewPositionMs !== undefined,
    clockRef,
    timersRef,
    cancelScrub,
  });

  const prevStatusRef = useRef(status.kind);
  useEffect(() => {
    if (shouldCancelScrubOnStatus(prevStatusRef.current, status.kind)) scrub.cancel();
    prevStatusRef.current = status.kind;
  }, [scrub, status.kind]);

  const retry = (): void => {
    scrub.cancel();
    overlay.blurTvOsd();
    overlay.blurTvScrubber();
    serviceRef.current?.retry();
  };

  const togglePlayPause = (): void => {
    const svc = serviceRef.current;
    if (svc === null || cbRef.current.activeTarget.kind !== 'vod') return;
    scrub.cancel();
    const kind = svc.getState().status.kind;
    if (kind === 'paused' || kind === 'ended') svc.play();
    else if (canPauseStatus(kind)) svc.pause();
  };

  const commitVodSeek = (targetMs: number): void => {
    serviceRef.current?.seek(targetMs);
    cbRef.current.onSeekCommit?.(targetMs);
  };

  const seekBy = (deltaMs: number): void => {
    const svc = serviceRef.current;
    const anchor = cbRef.current.activeTarget.kind === 'vod' ? svc?.getState().anchor : undefined;
    scrub.cancel();
    if (svc === null || anchor === undefined) return;
    commitVodSeek(
      clampSeekPosition(positionAt(anchor, clockRef.current.now()) + deltaMs, anchor.durationMs),
    );
  };

  const seekWithDuration = (compute: (dur: number) => number): void => {
    const svc = serviceRef.current;
    if (svc === null || cbRef.current.activeTarget.kind !== 'vod') return;
    scrub.cancel();
    const dur = svc.getState().anchor?.durationMs;
    if (dur !== undefined && dur > 0) commitVodSeek(compute(dur));
  };

  const seekToRatio = (ratio: number): void => {
    if (!Number.isFinite(ratio)) return;
    seekWithDuration((dur) => Math.round(Math.max(0, Math.min(1, ratio)) * dur));
  };

  const seekToEnd = (): void =>
    seekWithDuration((dur) => (dur > STEP_SEEK_MS ? dur - STEP_SEEK_MS : dur));

  const handleBack = (): void => {
    scrub.cancel();
    const s = overlay.liveRef.current;
    if (s.locked) overlay.unlockControls();
    else if (s.settingsOpen) {
      if (s.settingsMenu.view !== 'root') {
        overlay.updateSettingsMenu({
          view: 'root',
          index: s.settingsMenu.view === 'subtitles' ? 0 : 1,
        });
      } else overlay.closeSettings();
    } else if (s.tracksOpen) overlay.closeTracks();
    else if (isTv && s.tvScrubberFocused) overlay.blurTvScrubber();
    else if (isTv && s.tvOsdFocused) overlay.blurTvOsd();
    else onExitRef.current();
  };

  const activateTvOsd = (act: ReturnType<typeof clampTvOsdAction>): void => {
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

  const handleKeyEvent = (event: KeyEvent): void => {
    const s = overlay.liveRef.current;
    if (event.kind === 'press' && event.key === 'back') return void handleBack();
    if (s.locked) return;
    if (isTv && s.osdHidden) {
      if (
        cbRef.current.activeTarget.kind === 'live' &&
        (event.kind === 'press' || event.kind === 'repeat') &&
        (event.key === 'channelUp' || event.key === 'channelDown')
      ) {
        zapByRef.current(event.key === 'channelUp' ? 1 : -1, event.kind === 'repeat');
        return;
      }
      overlay.showOsd();
      return;
    }
    if (isTv) overlay.notifyOsdActivity();
    if (event.kind === 'press' && event.key === 'select' && isWebButtonActive()) return;
    if (event.kind === 'press' && event.key === 'menu') {
      if (s.settingsOpen) return void overlay.closeSettings();
      return void (s.tracksOpen ? overlay.closeTracks() : overlay.openTracks());
    }

    if (s.settingsOpen) {
      const intent = routeSettingsMenuKey(event, s.settingsMenu, s.tracks);
      if (intent?.kind === 'close') overlay.closeSettings();
      else if (intent?.kind === 'state') overlay.updateSettingsMenu(intent.state);
      else if (intent?.kind === 'toggleStats') overlay.toggleStats();
      else if (intent?.kind === 'audio') serviceRef.current?.selectAudioTrack(intent.id);
      else if (intent?.kind === 'subtitle') serviceRef.current?.selectSubtitleTrack(intent.id);
      return;
    }

    if (s.tracksOpen) {
      const intent = routePickerKey(event, s.pickerCursor, s.tracks);
      if (intent?.kind === 'move') overlay.updatePickerCursor(intent.cursor);
      else if (intent?.kind === 'audio') serviceRef.current?.selectAudioTrack(intent.id);
      else if (intent?.kind === 'subtitle') serviceRef.current?.selectSubtitleTrack(intent.id);
      return;
    }

    if (isTv && s.tvScrubberFocused) {
      const intent = routeTvScrubberKey(event);
      if (intent?.kind === 'step') scrub.step(intent.direction, intent.stepKind);
      else if (intent?.kind === 'commitOrToggle') {
        if (scrub.previewPositionMs !== undefined) scrub.commit();
        else togglePlayPause();
      } else if (intent?.kind === 'togglePlayPause') togglePlayPause();
      else if (intent?.kind === 'toOsd') {
        scrub.cancel();
        overlay.focusTvOsd(clampTvOsdAction(s.tvOsdAction, s.availableOsd));
      } else if (intent?.kind === 'blur') {
        scrub.cancel();
        overlay.blurTvScrubber();
      }
      return;
    }

    if (isTv && s.tvOsdFocused) {
      const intent = routeTvOsdKey(event, s.tvOsdAction, s.availableOsd);
      if (intent?.kind === 'blur') {
        if (cbRef.current.activeTarget.kind === 'vod') overlay.focusTvScrubber();
        else overlay.blurTvOsd();
      } else if (intent?.kind === 'focus') overlay.focusTvOsd(intent.action);
      else if (intent?.kind === 'activate') activateTvOsd(intent.action);
      return;
    }

    const svc = serviceRef.current;
    const statusKind = svc?.getState().status.kind;
    if (event.kind === 'press' && event.key === 'select' && statusKind === 'failed') {
      retry();
      return;
    }

    if (cbRef.current.activeTarget.kind === 'vod') {
      const digitRatio =
        !isWebDesktop && event.kind === 'press' ? digitKeyToRatio(event.key) : undefined;
      if (digitRatio !== undefined) {
        seekToRatio(digitRatio);
      } else if (event.kind === 'press' && (event.key === 'select' || event.key === 'playPause')) {
        if (event.key === 'select' && scrub.previewPositionMs !== undefined) scrub.commit();
        else togglePlayPause();
      } else if (event.kind === 'press' && event.key === 'play') {
        if (statusKind === 'paused' || statusKind === 'ended') {
          scrub.cancel();
          svc?.play();
        } else if (statusKind === 'failed') retry();
      } else if (event.kind === 'press' && event.key === 'pause') {
        scrub.cancel();
        if (canPauseStatus(statusKind)) svc?.pause();
      } else if ((event.kind === 'press' || event.kind === 'repeat') && isScrubKey(event.key)) {
        scrub.step(event.key === 'left' || event.key === 'rewind' ? -1 : 1, event.kind);
      } else if (isTv && event.kind === 'press' && event.key === 'up') {
        overlay.hideOsd();
      } else if (isTv && event.kind === 'press' && event.key === 'down') {
        overlay.focusTvOsd(initialTvOsdAction(s.availableOsd));
      }
      return;
    }

    if (isTv && event.kind === 'press' && event.key === 'left' && s.hasTracks) overlay.openTracks();
    else if (isTv && event.kind === 'press' && (event.key === 'select' || event.key === 'right')) {
      overlay.focusTvOsd(initialTvOsdAction(s.availableOsd));
    } else if (event.kind === 'press' || event.kind === 'repeat') {
      const repeat = event.kind === 'repeat';
      if (event.key === 'channelUp' || event.key === 'up') zapByRef.current(1, repeat);
      else if (event.key === 'channelDown' || event.key === 'down') zapByRef.current(-1, repeat);
    }
  };

  const interpreterInputRef = useRef<(input: KeyInput) => void>(() => undefined);
  useTvKeySource((input) => {
    interpreterInputRef.current(input);
    if (isScrubKey(input.key)) {
      if (input.action === 'up') scrub.commit();
      else if (input.action === 'cancel') scrub.cancel();
    }
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
  const toggleMute = (): void => cbRef.current.onToggleMute?.();
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
    isPausedOrEnded: status.kind === 'paused' || status.kind === 'ended',
    retry,
    togglePlayPause,
    toggleFullscreen,
    toggleMute,
    seekStepBack: () => seekBy(-STEP_SEEK_MS),
    seekStepForward: () => seekBy(STEP_SEEK_MS),
    seekToRatio,
    selectAudio: (id: string) => serviceRef.current?.selectAudioTrack(id),
    selectSubtitle: (id: string | null) => serviceRef.current?.selectSubtitleTrack(id),
    cancelScrub,
    handleBack,
    desktopFallbackKeyProps,
  };
}
