import {
  type PlaybackClock,
  type PlaybackService,
  type PlaybackStatus,
  type PlaybackTimers,
  positionAt,
  resolveLiveTimeShiftWindow,
} from '@elv/playback';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { PlayTarget } from '../ports/play-target';
import { computeLiveTimeShiftTargetMs } from './live-timeshift-model';
import {
  canPauseStatus,
  clampSeekPosition,
  createScrubController,
  type ScrubController,
  STEP_SEEK_MS,
  shouldCancelScrubOnStatus,
} from './scrub-controller';

/** Owns VOD & bounded live time-shift scrub state, step/ratio/end seeking, and play/pause toggling. */
export function usePlayerScrub(params: {
  activeTarget: PlayTarget;
  statusKind: PlaybackStatus['kind'];
  serviceRef: MutableRefObject<PlaybackService | null>;
  clockRef: MutableRefObject<PlaybackClock>;
  timersRef: MutableRefObject<PlaybackTimers>;
  stepSeekMs?: number | undefined;
  onSeekCommit?: ((positionMs: number, priorPositionMs?: number) => void) | undefined;
  onTimeShiftUnavailable?: (() => void) | undefined;
}) {
  const { statusKind, serviceRef, clockRef, timersRef } = params;
  const cbRef = useRef(params);
  cbRef.current = params;

  const [previewPositionMs, setPreviewPositionMs] = useState<number | undefined>(undefined);
  const [timeShiftUnavailableVisible, setTimeShiftUnavailableVisible] = useState(false);
  const hintTimerRef = useRef<unknown>(undefined);

  const clearTimeShiftHint = useCallback((): void => {
    if (hintTimerRef.current !== undefined) {
      timersRef.current.clearTimeout(hintTimerRef.current);
      hintTimerRef.current = undefined;
    }
    setTimeShiftUnavailableVisible(false);
  }, [timersRef]);

  const notifyTimeShiftUnavailable = (): void => {
    setTimeShiftUnavailableVisible(true);
    if (hintTimerRef.current !== undefined) {
      timersRef.current.clearTimeout(hintTimerRef.current);
    }
    hintTimerRef.current = timersRef.current.setTimeout(() => {
      hintTimerRef.current = undefined;
      setTimeShiftUnavailableVisible(false);
    }, 3_000);
    cbRef.current.onTimeShiftUnavailable?.();
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: clear live time-shift hint on item change
  useEffect(() => {
    clearTimeShiftHint();
    return clearTimeShiftHint;
  }, [params.activeTarget.itemKey, clearTimeShiftHint]);

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
          const anchor = serviceRef.current?.getState().anchor;
          const priorMs =
            anchor !== undefined ? positionAt(anchor, clockRef.current.now()) : undefined;
          serviceRef.current?.seek(ms);
          cbRef.current.onSeekCommit?.(ms, priorMs);
        }
      },
      onPreviewChange: setPreviewPositionMs,
      stepSeekMs: () => cbRef.current.stepSeekMs ?? STEP_SEEK_MS,
    });
  }
  const scrub = scrubRef.current;
  const cancelScrub = useCallback(() => scrub.cancel(), [scrub]);

  const prevStatusRef = useRef(statusKind);
  useEffect(() => {
    if (shouldCancelScrubOnStatus(prevStatusRef.current, statusKind)) scrub.cancel();
    prevStatusRef.current = statusKind;
  }, [scrub, statusKind]);

  const togglePlayPause = (): void => {
    const svc = serviceRef.current;
    if (svc === null) return;
    scrub.cancel();
    const kind = svc.getState().status.kind;
    if (kind === 'paused' || kind === 'ended') svc.play();
    else if (canPauseStatus(kind)) svc.pause();
  };

  const commitVodSeek = (targetMs: number, priorMs?: number): void => {
    serviceRef.current?.seek(targetMs);
    cbRef.current.onSeekCommit?.(targetMs, priorMs);
  };

  const seekBy = (deltaMs: number): void => {
    const svc = serviceRef.current;
    scrub.cancel();
    if (svc === null) return;
    if (cbRef.current.activeTarget.kind === 'live') {
      const anchor = svc.getState().anchor;
      const win = resolveLiveTimeShiftWindow(anchor, clockRef.current.now());
      if (win === null) {
        notifyTimeShiftUnavailable();
        return;
      }
      if (svc.seekBy !== undefined) {
        svc.seekBy(deltaMs);
      } else {
        svc.seek(Math.min(win.endMs, Math.max(win.startMs, win.positionMs + deltaMs)));
      }
      return;
    }
    const anchor = svc.getState().anchor;
    if (anchor === undefined) return;
    const priorMs = positionAt(anchor, clockRef.current.now());
    commitVodSeek(clampSeekPosition(priorMs + deltaMs, anchor.durationMs), priorMs);
  };

  const seekWithDuration = (compute: (dur: number) => number): void => {
    const svc = serviceRef.current;
    if (svc === null || cbRef.current.activeTarget.kind !== 'vod') return;
    scrub.cancel();
    const anchor = svc.getState().anchor;
    const dur = anchor?.durationMs;
    if (anchor !== undefined && dur !== undefined && dur > 0) {
      commitVodSeek(compute(dur), positionAt(anchor, clockRef.current.now()));
    }
  };

  const seekToRatio = (ratio: number): void => {
    if (!Number.isFinite(ratio)) return;
    if (cbRef.current.activeTarget.kind === 'live') {
      const svc = serviceRef.current;
      if (svc === null) return;
      scrub.cancel();
      const targetMs = computeLiveTimeShiftTargetMs(
        svc.getState().anchor,
        clockRef.current.now(),
        ratio,
      );
      if (targetMs === undefined) {
        notifyTimeShiftUnavailable();
        return;
      }
      svc.seek(targetMs);
      return;
    }
    seekWithDuration((dur) => Math.round(Math.max(0, Math.min(1, ratio)) * dur));
  };

  const seekToEnd = (): void =>
    seekWithDuration((dur) => (dur > STEP_SEEK_MS ? dur - STEP_SEEK_MS : dur));

  return {
    scrub,
    previewPositionMs,
    timeShiftUnavailableVisible,
    cancelScrub,
    togglePlayPause,
    seekBy,
    seekToRatio,
    seekToEnd,
  };
}
