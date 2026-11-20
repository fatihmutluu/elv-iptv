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
import { type MutableRefObject, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import {
  canPauseStatus,
  clampSeekPosition,
  createScrubController,
  isScrubKey,
  mapDesktopFallbackKey,
  type ScrubController,
  STEP_SEEK_MS,
  shouldCancelScrubOnStatus,
} from './scrub-controller';
import {
  clampPickerCursor,
  initialPickerCursor,
  routePickerKey,
  type TrackPickerCursor,
} from './track-picker-nav';
import {
  availableTvOsdActions,
  clampTvOsdAction,
  initialTvOsdAction,
  routeTvOsdKey,
  type TvOsdAction,
} from './tv-osd-nav';

export type { TvOsdAction } from './tv-osd-nav';

function isWebButtonActive(): boolean {
  if ((Platform.OS as string) !== 'web') return false;
  const active = (
    globalThis as { document?: { activeElement?: { getAttribute?: (n: string) => string | null } } }
  ).document?.activeElement;
  const role = active?.getAttribute?.('role');
  return role === 'button' || role === 'radio' || role === 'adjustable';
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
  serviceRef: MutableRefObject<PlaybackService | null>;
  clockRef: MutableRefObject<PlaybackClock>;
  timersRef: MutableRefObject<PlaybackTimers>;
  onExitRef: MutableRefObject<() => void>;
  zapByRef: MutableRefObject<(delta: 1 | -1, repeat?: boolean) => void>;
}

/**
 * Coordinates VOD transport, decoupled preview-seek (`#292`), TV OSD bar focus, and
 * `TrackPickerModal` navigation for `PlayerScreen`.
 */
export function usePlayerControls(params: PlayerControlsParams) {
  const { formFactor, activeTarget, status, tracks, hasTracks, showRetry, hasService } = params;
  const { serviceRef, clockRef, timersRef, onExitRef, zapByRef } = params;
  const isTv = formFactor === 'tv';

  const [rawTracksOpen, setTracksOpen] = useState(false);
  const [rawPickerCursor, setPickerCursor] = useState<TrackPickerCursor>({
    column: 'audio',
    index: 0,
  });
  const [tvOsdFocused, setTvOsdFocused] = useState(false);
  const [rawTvOsdAction, setTvOsdAction] = useState<TvOsdAction>('playPause');
  const [previewPositionMs, setPreviewPositionMs] = useState<number | undefined>(undefined);

  const tracksOpen = rawTracksOpen && hasTracks;
  const pickerCursor = clampPickerCursor(rawPickerCursor, tracks);
  const availableOsd = availableTvOsdActions({
    isVod: activeTarget.kind === 'vod',
    hasService,
    hasTracks,
    showRetry,
  });
  const tvOsdAction = clampTvOsdAction(rawTvOsdAction, availableOsd);
  const live = {
    tracksOpen,
    pickerCursor,
    tvOsdFocused,
    tvOsdAction,
    availableOsd,
    tracks,
    hasTracks,
    activeTarget,
  };
  const liveRef = useRef(live);
  liveRef.current = live;

  const scrubRef = useRef<ScrubController | null>(null);
  if (scrubRef.current === null) {
    scrubRef.current = createScrubController({
      timers: {
        setTimeout: (fn, ms) => timersRef.current.setTimeout(fn, ms),
        clearTimeout: (handle) => timersRef.current.clearTimeout(handle),
      },
      readPosition: () => {
        const svc = serviceRef.current;
        const anchor =
          liveRef.current.activeTarget.kind === 'vod' ? svc?.getState().anchor : undefined;
        return anchor === undefined
          ? undefined
          : {
              positionMs: positionAt(anchor, clockRef.current.now()),
              ...(anchor.durationMs === undefined ? {} : { durationMs: anchor.durationMs }),
            };
      },
      seek: (ms) => {
        if (liveRef.current.activeTarget.kind === 'vod') serviceRef.current?.seek(ms);
      },
      onPreviewChange: setPreviewPositionMs,
    });
  }
  const scrub = scrubRef.current;

  useEffect(() => {
    if (rawTracksOpen && !hasTracks) setTracksOpen(false);
    else if (tracksOpen && pickerCursor !== rawPickerCursor) setPickerCursor(pickerCursor);
    if (tvOsdAction !== rawTvOsdAction) setTvOsdAction(tvOsdAction);
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset overlays & scrub whenever tuned item changes or unmounts
  useEffect(() => {
    scrub.cancel();
    liveRef.current.tracksOpen = false;
    liveRef.current.tvOsdFocused = false;
    setTracksOpen(false);
    setTvOsdFocused(false);
    return () => scrub.cancel();
  }, [activeTarget.itemKey, scrub]);

  const prevStatusRef = useRef(status.kind);
  useEffect(() => {
    if (shouldCancelScrubOnStatus(prevStatusRef.current, status.kind)) scrub.cancel();
    prevStatusRef.current = status.kind;
  }, [scrub, status.kind]);

  const retry = (): void => {
    scrub.cancel();
    liveRef.current.tvOsdFocused = false;
    setTvOsdFocused(false);
    serviceRef.current?.retry();
  };

  const togglePlayPause = (): void => {
    const svc = serviceRef.current;
    if (svc === null || liveRef.current.activeTarget.kind !== 'vod') return;
    scrub.cancel();
    const kind = svc.getState().status.kind;
    if (kind === 'paused' || kind === 'ended') svc.play();
    else if (canPauseStatus(kind)) svc.pause();
  };

  const seekBy = (deltaMs: number): void => {
    const svc = serviceRef.current;
    const anchor = liveRef.current.activeTarget.kind === 'vod' ? svc?.getState().anchor : undefined;
    scrub.cancel();
    if (svc === null || anchor === undefined) return;
    svc.seek(
      clampSeekPosition(positionAt(anchor, clockRef.current.now()) + deltaMs, anchor.durationMs),
    );
  };

  const seekToRatio = (ratio: number): void => {
    const svc = serviceRef.current;
    if (svc === null || liveRef.current.activeTarget.kind !== 'vod' || !Number.isFinite(ratio))
      return;
    scrub.cancel();
    const dur = svc.getState().anchor?.durationMs;
    if (dur !== undefined && dur > 0) svc.seek(Math.round(Math.max(0, Math.min(1, ratio)) * dur));
  };

  const openTracks = (): void => {
    if (!liveRef.current.hasTracks) return;
    scrub.cancel();
    const initial = initialPickerCursor(liveRef.current.tracks);
    liveRef.current.pickerCursor = initial;
    liveRef.current.tracksOpen = true;
    liveRef.current.tvOsdFocused = false;
    setPickerCursor(initial);
    setTvOsdFocused(false);
    setTracksOpen(true);
  };

  const closeTracks = (): void => {
    liveRef.current.tracksOpen = false;
    setTracksOpen(false);
  };

  const handleBack = (): void => {
    scrub.cancel();
    if (liveRef.current.tracksOpen) closeTracks();
    else if (isTv && liveRef.current.tvOsdFocused) {
      liveRef.current.tvOsdFocused = false;
      setTvOsdFocused(false);
    } else onExitRef.current();
  };

  const handleKeyEvent = (event: KeyEvent): void => {
    const s = liveRef.current;
    if (event.kind === 'press' && event.key === 'back') return void handleBack();
    if (event.kind === 'press' && event.key === 'select' && isWebButtonActive()) return;
    if (event.kind === 'press' && event.key === 'menu') {
      return void (s.tracksOpen ? closeTracks() : openTracks());
    }

    if (s.tracksOpen) {
      const intent = routePickerKey(event, s.pickerCursor, s.tracks);
      if (intent?.kind === 'move') {
        s.pickerCursor = intent.cursor;
        setPickerCursor(intent.cursor);
      } else if (intent?.kind === 'audio') serviceRef.current?.selectAudioTrack(intent.id);
      else if (intent?.kind === 'subtitle') serviceRef.current?.selectSubtitleTrack(intent.id);
      return;
    }

    if (isTv && s.tvOsdFocused) {
      const intent = routeTvOsdKey(event, s.tvOsdAction, s.availableOsd);
      if (intent?.kind === 'blur') {
        s.tvOsdFocused = false;
        setTvOsdFocused(false);
      } else if (intent?.kind === 'focus') {
        s.tvOsdAction = intent.action;
        setTvOsdAction(intent.action);
      } else if (intent?.kind === 'activate') {
        const act = intent.action;
        if (act === 'back') onExitRef.current();
        else if (act === 'playPause') togglePlayPause();
        else if (act === 'seekBack') seekBy(-STEP_SEEK_MS);
        else if (act === 'seekForward') seekBy(STEP_SEEK_MS);
        else if (act === 'tracks') openTracks();
        else if (act === 'retry') retry();
      }
      return;
    }

    const svc = serviceRef.current;
    const statusKind = svc?.getState().status.kind;
    if (event.kind === 'press' && event.key === 'select' && statusKind === 'failed') {
      retry();
      return;
    }

    if (s.activeTarget.kind === 'vod') {
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
        const initialAction = initialTvOsdAction(s.availableOsd);
        s.tvOsdAction = initialAction;
        s.tvOsdFocused = true;
        setTvOsdAction(initialAction);
        setTvOsdFocused(true);
      }
      return;
    }

    if (isTv && event.kind === 'press' && event.key === 'left' && s.hasTracks) openTracks();
    else if (event.kind === 'press' || event.kind === 'repeat') {
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

  const desktopFallbackKeyProps: Record<string, unknown> =
    formFactor === 'desktop' && (Platform.OS as string) !== 'web'
      ? {
          onKeyDown: (e: { key?: unknown; repeat?: unknown; preventDefault?: () => void }) => {
            const mapped = mapDesktopFallbackKey(e.key);
            if (!mapped) return;
            e.preventDefault?.();
            handleKeyEvent({
              key: mapped,
              kind: e.repeat === true ? 'repeat' : 'press',
              time: clockRef.current.now(),
            });
          },
          onKeyUp: (e: { key?: unknown }) => {
            const mapped = mapDesktopFallbackKey(e.key);
            if (mapped && isScrubKey(mapped)) scrub.commit();
          },
        }
      : {};

  return {
    tracksOpen,
    pickerCursor,
    tvOsdFocused,
    tvOsdAction,
    previewPositionMs,
    isPausedOrEnded: status.kind === 'paused' || status.kind === 'ended',
    retry,
    togglePlayPause,
    seekStepBack: () => seekBy(-STEP_SEEK_MS),
    seekStepForward: () => seekBy(STEP_SEEK_MS),
    seekToRatio,
    openTracks,
    closeTracks,
    selectAudio: (id: string) => serviceRef.current?.selectAudioTrack(id),
    selectSubtitle: (id: string | null) => serviceRef.current?.selectSubtitleTrack(id),
    handleBack,
    desktopFallbackKeyProps,
  };
}
