import type { Key, KeyEvent } from '@elv/focus-core';
import {
  type MediaTracks,
  type PlaybackClock,
  type PlaybackService,
  type PlaybackStatus,
  positionAt,
} from '@elv/playback';
import { type FormFactor, useKeyInterpreter } from '@elv/ui-kit';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import type { TrackPickerCursor } from './TrackPickerModal';

const STEP_SEEK_MS = 10_000;
const HOLD_SEEK_MS = 30_000;

/** Logical OSD button identifiers navigable on TV when the VOD OSD bar is focused. */
export type TvOsdAction = 'back' | 'playPause' | 'seekBack' | 'seekForward' | 'tracks' | 'retry';

const DESKTOP_FALLBACK_KEYS: Readonly<Record<string, Key>> = {
  Escape: 'back',
  Backspace: 'back',
  Enter: 'select',
  ' ': 'select',
  Spacebar: 'select',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  PageUp: 'channelUp',
  PageDown: 'channelDown',
};

function initialPickerCursor(tracks: MediaTracks): TrackPickerCursor {
  if (tracks.audio.length > 0) {
    const idx = tracks.audio.findIndex((t) => t.id === tracks.selectedAudioId);
    return { column: 'audio', index: Math.max(0, idx) };
  }
  if (tracks.selectedSubtitleId === null) {
    return { column: 'subtitles', index: 0 };
  }
  const subIdx = tracks.subtitles.findIndex((t) => t.id === tracks.selectedSubtitleId);
  return { column: 'subtitles', index: subIdx >= 0 ? subIdx + 1 : 0 };
}

function isWebButtonActive(): boolean {
  if ((Platform.OS as string) !== 'web') return false;
  const active = (
    globalThis as {
      document?: { activeElement?: { getAttribute?: (name: string) => string | null } };
    }
  ).document?.activeElement;
  const role = active?.getAttribute?.('role');
  return role === 'button' || role === 'radio';
}

interface PlayerControlsParams {
  formFactor: FormFactor;
  activeTarget: PlayTarget;
  status: PlaybackStatus;
  tracks: MediaTracks;
  hasTracks: boolean;
  showRetry: boolean;
  serviceRef: MutableRefObject<PlaybackService | null>;
  clockRef: MutableRefObject<PlaybackClock>;
  onExitRef: MutableRefObject<() => void>;
  zapByRef: MutableRefObject<(delta: 1 | -1) => void>;
}

/**
 * Coordinates VOD pause/resume, `-10s/+10s` step + `-30s/+30s` hold-repeat seek, TV OSD bar focus,
 * and `TrackPickerModal` state and keyboard/remote routing for {@link PlayerScreen}.
 */
export function usePlayerControls(params: PlayerControlsParams) {
  const { formFactor, activeTarget, status, tracks, hasTracks, showRetry } = params;
  const { serviceRef, clockRef, onExitRef, zapByRef } = params;
  const isTv = formFactor === 'tv';
  const [tracksOpen, setTracksOpen] = useState(false);
  const [pickerCursor, setPickerCursor] = useState<TrackPickerCursor>({
    column: 'audio',
    index: 0,
  });
  const [tvOsdFocused, setTvOsdFocused] = useState(false);
  const [tvOsdAction, setTvOsdAction] = useState<TvOsdAction>('playPause');

  const liveRef = useRef({
    tracksOpen,
    pickerCursor,
    tvOsdFocused,
    tvOsdAction,
    tracks,
    hasTracks,
    showRetry,
    activeTarget,
  });
  liveRef.current = {
    tracksOpen,
    pickerCursor,
    tvOsdFocused,
    tvOsdAction,
    tracks,
    hasTracks,
    showRetry,
    activeTarget,
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset modal & TV OSD focus whenever tuned item changes
  useEffect(() => {
    liveRef.current.tracksOpen = false;
    liveRef.current.tvOsdFocused = false;
    setTracksOpen(false);
    setTvOsdFocused(false);
  }, [activeTarget.itemKey]);

  const togglePlayPause = useCallback((): void => {
    const svc = serviceRef.current;
    if (svc === null || liveRef.current.activeTarget.kind !== 'vod') return;
    const kind = svc.getState().status.kind;
    if (kind === 'paused') svc.play();
    else if (kind === 'ended') svc.retry();
    else if (kind === 'playing' || kind === 'recovering' || kind === 'tuning') svc.pause();
  }, [serviceRef]);

  const seekBy = useCallback(
    (deltaMs: number): void => {
      const svc = serviceRef.current;
      if (svc === null || liveRef.current.activeTarget.kind !== 'vod') return;
      const { anchor } = svc.getState();
      const baseMs = anchor === undefined ? 0 : positionAt(anchor, clockRef.current.now());
      const durationMs = anchor?.durationMs;
      const unclamped = baseMs + deltaMs;
      const clamped = Math.max(
        0,
        durationMs !== undefined && durationMs > 0 ? Math.min(unclamped, durationMs) : unclamped,
      );
      svc.seek(clamped);
    },
    [clockRef, serviceRef],
  );

  const seekToRatio = useCallback(
    (ratio: number): void => {
      const svc = serviceRef.current;
      if (svc === null || liveRef.current.activeTarget.kind !== 'vod' || !Number.isFinite(ratio))
        return;
      const durationMs = svc.getState().anchor?.durationMs;
      if (durationMs === undefined || durationMs <= 0) return;
      svc.seek(Math.round(Math.max(0, Math.min(1, ratio)) * durationMs));
    },
    [serviceRef],
  );

  const openTracks = useCallback((): void => {
    if (!liveRef.current.hasTracks) return;
    const initial = initialPickerCursor(liveRef.current.tracks);
    liveRef.current.pickerCursor = initial;
    liveRef.current.tracksOpen = true;
    liveRef.current.tvOsdFocused = false;
    setPickerCursor(initial);
    setTvOsdFocused(false);
    setTracksOpen(true);
  }, []);

  const closeTracks = useCallback((): void => {
    liveRef.current.tracksOpen = false;
    setTracksOpen(false);
  }, []);

  const selectAudio = useCallback(
    (id: string): void => serviceRef.current?.selectAudioTrack(id),
    [serviceRef],
  );
  const selectSubtitle = useCallback(
    (id: string | null): void => serviceRef.current?.selectSubtitleTrack(id),
    [serviceRef],
  );

  const handleBack = useCallback((): void => {
    if (liveRef.current.tracksOpen) {
      closeTracks();
      return;
    }
    if (isTv && liveRef.current.tvOsdFocused) {
      liveRef.current.tvOsdFocused = false;
      setTvOsdFocused(false);
      return;
    }
    onExitRef.current();
  }, [closeTracks, isTv, onExitRef]);

  const handleKeyEvent = useCallback(
    (event: KeyEvent): void => {
      const s = liveRef.current;
      if (event.kind === 'press' && event.key === 'back') {
        handleBack();
        return;
      }
      if (event.kind === 'press' && event.key === 'select' && isWebButtonActive()) return;

      if (s.tracksOpen) {
        const currentTracks = s.tracks;
        const cur = s.pickerCursor;
        if (event.kind === 'press' && event.key === 'left' && currentTracks.audio.length > 0) {
          const idx = Math.max(
            0,
            currentTracks.audio.findIndex((t) => t.id === currentTracks.selectedAudioId),
          );
          const next: TrackPickerCursor = { column: 'audio', index: idx };
          s.pickerCursor = next;
          setPickerCursor(next);
          return;
        }
        if (event.kind === 'press' && event.key === 'right') {
          const subIdx =
            currentTracks.selectedSubtitleId === null
              ? 0
              : Math.max(
                  0,
                  currentTracks.subtitles.findIndex(
                    (t) => t.id === currentTracks.selectedSubtitleId,
                  ) + 1,
                );
          const next: TrackPickerCursor = { column: 'subtitles', index: subIdx };
          s.pickerCursor = next;
          setPickerCursor(next);
          return;
        }
        if (
          (event.kind === 'press' || event.kind === 'repeat') &&
          (event.key === 'up' || event.key === 'down')
        ) {
          const count =
            cur.column === 'audio'
              ? currentTracks.audio.length
              : currentTracks.subtitles.length + 1;
          if (count <= 0) return;
          const nextIdx = Math.max(
            0,
            Math.min(count - 1, cur.index + (event.key === 'down' ? 1 : -1)),
          );
          const next: TrackPickerCursor = { column: cur.column, index: nextIdx };
          s.pickerCursor = next;
          setPickerCursor(next);
          return;
        }
        if (event.kind === 'press' && event.key === 'select') {
          if (cur.column === 'audio') {
            const audio = currentTracks.audio[cur.index];
            if (audio !== undefined) selectAudio(audio.id);
          } else if (cur.index === 0) {
            selectSubtitle(null);
          } else {
            const sub = currentTracks.subtitles[cur.index - 1];
            if (sub !== undefined) selectSubtitle(sub.id);
          }
        }
        return;
      }

      if (isTv && s.tvOsdFocused) {
        const actions: TvOsdAction[] = [
          'back',
          'playPause',
          'seekBack',
          'seekForward',
          ...(s.hasTracks ? (['tracks'] as const) : []),
          ...(s.showRetry ? (['retry'] as const) : []),
        ];
        if (event.kind === 'press' && event.key === 'up') {
          s.tvOsdFocused = false;
          setTvOsdFocused(false);
          return;
        }
        if (
          (event.kind === 'press' || event.kind === 'repeat') &&
          (event.key === 'left' || event.key === 'right')
        ) {
          const idx = Math.max(0, actions.indexOf(s.tvOsdAction));
          const delta = event.key === 'right' ? 1 : -1;
          const next = actions[Math.max(0, Math.min(actions.length - 1, idx + delta))] ?? 'back';
          s.tvOsdAction = next;
          setTvOsdAction(next);
          return;
        }
        if (event.kind === 'press' && event.key === 'select') {
          const act = s.tvOsdAction;
          if (act === 'back') onExitRef.current();
          else if (act === 'playPause') togglePlayPause();
          else if (act === 'seekBack') seekBy(-STEP_SEEK_MS);
          else if (act === 'seekForward') seekBy(STEP_SEEK_MS);
          else if (act === 'tracks') openTracks();
          else if (act === 'retry') serviceRef.current?.retry();
        }
        return;
      }

      if (event.kind === 'press' && event.key === 'menu') {
        openTracks();
        return;
      }

      const svc = serviceRef.current;
      if (
        event.kind === 'press' &&
        event.key === 'select' &&
        svc?.getState().status.kind === 'failed'
      ) {
        svc.retry();
        return;
      }

      if (s.activeTarget.kind === 'vod') {
        if (event.kind === 'press' && (event.key === 'select' || event.key === 'playPause')) {
          togglePlayPause();
        } else if (event.kind === 'press' && event.key === 'play') {
          svc?.play();
        } else if (event.kind === 'press' && event.key === 'pause') {
          svc?.pause();
        } else if (
          (event.kind === 'press' || event.kind === 'repeat') &&
          (event.key === 'left' ||
            event.key === 'rewind' ||
            event.key === 'right' ||
            event.key === 'fastForward')
        ) {
          const sign = event.key === 'left' || event.key === 'rewind' ? -1 : 1;
          seekBy(sign * (event.kind === 'repeat' ? HOLD_SEEK_MS : STEP_SEEK_MS));
        } else if (isTv && event.kind === 'press' && event.key === 'down') {
          const initialAction: TvOsdAction = s.hasTracks ? 'tracks' : 'playPause';
          s.tvOsdAction = initialAction;
          s.tvOsdFocused = true;
          setTvOsdAction(initialAction);
          setTvOsdFocused(true);
        }
        return;
      }

      if (isTv && event.kind === 'press' && event.key === 'left' && s.hasTracks) {
        openTracks();
        return;
      }

      if (event.kind === 'press' || event.kind === 'repeat') {
        if (event.key === 'channelUp' || event.key === 'up') zapByRef.current(1);
        else if (event.key === 'channelDown' || event.key === 'down') zapByRef.current(-1);
      }
    },
    [
      handleBack,
      isTv,
      onExitRef,
      openTracks,
      seekBy,
      selectAudio,
      selectSubtitle,
      serviceRef,
      togglePlayPause,
      zapByRef,
    ],
  );

  useKeyInterpreter(handleKeyEvent);

  const desktopFallbackKeyProps: Record<string, unknown> =
    formFactor === 'desktop' && (Platform.OS as string) !== 'web'
      ? {
          onKeyDown: (e: { key?: unknown; repeat?: unknown; preventDefault?: () => void }) => {
            const mapped = typeof e.key === 'string' ? DESKTOP_FALLBACK_KEYS[e.key] : undefined;
            if (!mapped) return;
            e.preventDefault?.();
            handleKeyEvent({
              key: mapped,
              kind: e.repeat === true ? 'repeat' : 'press',
              time: clockRef.current.now(),
            });
          },
        }
      : {};

  return {
    tracksOpen,
    pickerCursor,
    tvOsdFocused,
    tvOsdAction,
    isPausedOrEnded: status.kind === 'paused' || status.kind === 'ended',
    togglePlayPause,
    seekStepBack: () => seekBy(-STEP_SEEK_MS),
    seekStepForward: () => seekBy(STEP_SEEK_MS),
    seekToRatio,
    openTracks,
    closeTracks,
    selectAudio,
    selectSubtitle,
    handleBack,
    desktopFallbackKeyProps,
  };
}
