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
  isScrubKey,
  type ScrubController,
  STEP_SEEK_MS,
  shouldCancelScrubOnStatus,
} from './scrub-controller';
import { routeSettingsMenuKey, type SettingsMenuState } from './settings-menu-nav';
import { routePickerKey } from './track-picker-nav';
import { initialTvOsdAction, routeTvOsdKey } from './tv-osd-nav';
import { type DesktopShortcutGuard, useDesktopPlayerShortcuts } from './useDesktopPlayerShortcuts';
import { usePlayerOverlayState } from './usePlayerOverlayState';

export type { TvOsdAction } from './tv-osd-nav';

function isWebButtonActive(): boolean {
  if ((Platform.OS as string) !== 'web') return false;
  const active = (
    globalThis as { document?: { activeElement?: { getAttribute?: (n: string) => string | null } } }
  ).document?.activeElement;
  const role = active?.getAttribute?.('role');
  return role === 'button' || role === 'radio' || role === 'adjustable' || role === 'switch';
}

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
  serviceRef: MutableRefObject<PlaybackService | null>;
  clockRef: MutableRefObject<PlaybackClock>;
  timersRef: MutableRefObject<PlaybackTimers>;
  onExitRef: MutableRefObject<() => void>;
  zapByRef: MutableRefObject<(delta: 1 | -1, repeat?: boolean) => void>;
  onSeekCommit?: (positionMs: number) => void;
  onPlayNextEpisode?: () => void;
  onJumpPreviousChannel?: () => void;
}

/**
 * Coordinates VOD transport, decoupled preview-seek (`#292`), TV OSD bar focus,
 * `TrackPickerModal`, 2-level `PlayerSettingsSheet`, and touch-only lock for `PlayerScreen`.
 */
export function usePlayerControls(params: PlayerControlsParams) {
  const { formFactor, activeTarget, status, tracks, hasTracks, showRetry, hasService } = params;
  const { serviceRef, clockRef, timersRef, onExitRef, zapByRef } = params;
  const isTv = formFactor === 'tv';
  const hasPreviousChannel = params.hasPreviousChannel ?? false;

  const targetRef = useRef(activeTarget);
  targetRef.current = activeTarget;
  const hasPrevChannelRef = useRef(hasPreviousChannel);
  hasPrevChannelRef.current = hasPreviousChannel;
  const onSeekCommitRef = useRef(params.onSeekCommit);
  onSeekCommitRef.current = params.onSeekCommit;
  const onPlayNextEpisodeRef = useRef(params.onPlayNextEpisode);
  onPlayNextEpisodeRef.current = params.onPlayNextEpisode;
  const onJumpPreviousChannelRef = useRef(params.onJumpPreviousChannel);
  onJumpPreviousChannelRef.current = params.onJumpPreviousChannel;

  const [previewPositionMs, setPreviewPositionMs] = useState<number | undefined>(undefined);

  const scrubRef = useRef<ScrubController | null>(null);
  if (scrubRef.current === null) {
    scrubRef.current = createScrubController({
      timers: {
        setTimeout: (fn, ms) => timersRef.current.setTimeout(fn, ms),
        clearTimeout: (handle) => timersRef.current.clearTimeout(handle),
      },
      readPosition: () => {
        const svc = serviceRef.current;
        const anchor = targetRef.current.kind === 'vod' ? svc?.getState().anchor : undefined;
        return anchor === undefined
          ? undefined
          : {
              positionMs: positionAt(anchor, clockRef.current.now()),
              ...(anchor.durationMs === undefined ? {} : { durationMs: anchor.durationMs }),
            };
      },
      seek: (ms) => {
        if (targetRef.current.kind === 'vod') {
          serviceRef.current?.seek(ms);
          onSeekCommitRef.current?.(ms);
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
    tracks,
    hasTracks,
    hasService,
    showRetry,
    hasSettings: params.hasSettings ?? false,
    hasNextEpisode: params.hasNextEpisode ?? false,
    hasPreviousChannel,
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
    serviceRef.current?.retry();
  };

  const togglePlayPause = (): void => {
    const svc = serviceRef.current;
    if (svc === null || targetRef.current.kind !== 'vod') return;
    scrub.cancel();
    const kind = svc.getState().status.kind;
    if (kind === 'paused' || kind === 'ended') svc.play();
    else if (canPauseStatus(kind)) svc.pause();
  };

  const seekBy = (deltaMs: number): void => {
    const svc = serviceRef.current;
    const anchor = targetRef.current.kind === 'vod' ? svc?.getState().anchor : undefined;
    scrub.cancel();
    if (svc === null || anchor === undefined) return;
    const targetMs = clampSeekPosition(
      positionAt(anchor, clockRef.current.now()) + deltaMs,
      anchor.durationMs,
    );
    svc.seek(targetMs);
    onSeekCommitRef.current?.(targetMs);
  };

  const seekToRatio = (ratio: number): void => {
    const svc = serviceRef.current;
    if (svc === null || targetRef.current.kind !== 'vod' || !Number.isFinite(ratio)) return;
    scrub.cancel();
    const dur = svc.getState().anchor?.durationMs;
    if (dur !== undefined && dur > 0) {
      const targetMs = Math.round(Math.max(0, Math.min(1, ratio)) * dur);
      svc.seek(targetMs);
      onSeekCommitRef.current?.(targetMs);
    }
  };

  const handleBack = (): void => {
    scrub.cancel();
    const s = overlay.liveRef.current;
    if (s.locked) overlay.unlockControls();
    else if (s.settingsOpen) {
      if (s.settingsMenu.view !== 'root') {
        const next: SettingsMenuState = {
          view: 'root',
          index: s.settingsMenu.view === 'subtitles' ? 0 : 1,
        };
        overlay.updateSettingsMenu(next);
      } else overlay.closeSettings();
    } else if (s.tracksOpen) overlay.closeTracks();
    else if (isTv && s.tvOsdFocused) overlay.blurTvOsd();
    else onExitRef.current();
  };

  const handleKeyEvent = (event: KeyEvent): void => {
    const s = overlay.liveRef.current;
    if (event.kind === 'press' && event.key === 'back') return void handleBack();
    if (s.locked) return;
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

    if (isTv && s.tvOsdFocused) {
      const intent = routeTvOsdKey(event, s.tvOsdAction, s.availableOsd);
      if (intent?.kind === 'blur') overlay.blurTvOsd();
      else if (intent?.kind === 'focus') overlay.focusTvOsd(intent.action);
      else if (intent?.kind === 'activate') {
        const act = intent.action;
        if (act === 'back') onExitRef.current();
        else if (act === 'playPause') togglePlayPause();
        else if (act === 'seekBack') seekBy(-STEP_SEEK_MS);
        else if (act === 'seekForward') seekBy(STEP_SEEK_MS);
        else if (act === 'prevChannel') {
          overlay.blurTvOsd();
          onJumpPreviousChannelRef.current?.();
        } else if (act === 'tracks') overlay.openTracks();
        else if (act === 'settings') overlay.openSettings();
        else if (act === 'nextEpisode') {
          overlay.blurTvOsd();
          onPlayNextEpisodeRef.current?.();
        } else if (act === 'retry') retry();
      }
      return;
    }

    const svc = serviceRef.current;
    const statusKind = svc?.getState().status.kind;
    if (event.kind === 'press' && event.key === 'select' && statusKind === 'failed') {
      retry();
      return;
    }

    if (targetRef.current.kind === 'vod') {
      if (event.kind === 'press' && (event.key === 'select' || event.key === 'playPause')) {
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

  const desktopGuardRef = useRef<DesktopShortcutGuard>({
    canJumpPreviousChannel: () => false,
    onJumpPreviousChannel: () => undefined,
    onKeyEvent: () => undefined,
  });
  desktopGuardRef.current = {
    canJumpPreviousChannel: () => {
      const s = overlay.liveRef.current;
      return (
        targetRef.current.kind === 'live' &&
        hasPrevChannelRef.current &&
        !s.tracksOpen &&
        !s.settingsOpen &&
        !s.locked
      );
    },
    onJumpPreviousChannel: () => onJumpPreviousChannelRef.current?.(),
    onKeyEvent: handleKeyEvent,
  };
  const desktopFallbackKeyProps = useDesktopPlayerShortcuts({
    formFactor,
    clockRef,
    scrub,
    guardRef: desktopGuardRef,
  });

  return {
    tracksOpen: overlay.tracksOpen,
    pickerCursor: overlay.pickerCursor,
    settingsOpen: overlay.settingsOpen,
    settingsMenu: overlay.settingsMenu,
    statsVisible: overlay.statsVisible,
    canLock: overlay.canLock,
    locked: overlay.locked,
    tvOsdFocused: overlay.tvOsdFocused,
    tvOsdAction: overlay.tvOsdAction,
    previewPositionMs,
    isPausedOrEnded: status.kind === 'paused' || status.kind === 'ended',
    retry,
    togglePlayPause,
    seekStepBack: () => seekBy(-STEP_SEEK_MS),
    seekStepForward: () => seekBy(STEP_SEEK_MS),
    seekToRatio,
    openTracks: overlay.openTracks,
    closeTracks: overlay.closeTracks,
    openSettings: overlay.openSettings,
    closeSettings: overlay.closeSettings,
    openSettingsView: overlay.openSettingsView,
    toggleStats: overlay.toggleStats,
    lockControls: overlay.lockControls,
    unlockControls: overlay.unlockControls,
    selectAudio: (id: string) => serviceRef.current?.selectAudioTrack(id),
    selectSubtitle: (id: string | null) => serviceRef.current?.selectSubtitleTrack(id),
    cancelScrub,
    handleBack,
    desktopFallbackKeyProps,
  };
}
