import {
  type PlaybackClock,
  type PlaybackService,
  type PlaybackStatus,
  type PlaybackTimers,
  positionAt,
} from '@elv/playback';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { PlayTarget } from '../ports/play-target';
import {
  canPauseStatus,
  clampSeekPosition,
  createScrubController,
  type ScrubController,
  STEP_SEEK_MS,
  shouldCancelScrubOnStatus,
} from './scrub-controller';

/** Owns VOD scrub preview state, step/ratio/end seeking, and play/pause toggling. */
export function usePlayerScrub(params: {
  activeTarget: PlayTarget;
  statusKind: PlaybackStatus['kind'];
  serviceRef: MutableRefObject<PlaybackService | null>;
  clockRef: MutableRefObject<PlaybackClock>;
  timersRef: MutableRefObject<PlaybackTimers>;
  onSeekCommit?: ((positionMs: number, priorPositionMs?: number) => void) | undefined;
}) {
  const { statusKind, serviceRef, clockRef, timersRef } = params;
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
          const anchor = serviceRef.current?.getState().anchor;
          const priorMs =
            anchor !== undefined ? positionAt(anchor, clockRef.current.now()) : undefined;
          serviceRef.current?.seek(ms);
          cbRef.current.onSeekCommit?.(ms, priorMs);
        }
      },
      onPreviewChange: setPreviewPositionMs,
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
    const anchor = cbRef.current.activeTarget.kind === 'vod' ? svc?.getState().anchor : undefined;
    scrub.cancel();
    if (svc === null || anchor === undefined) return;
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
    seekWithDuration((dur) => Math.round(Math.max(0, Math.min(1, ratio)) * dur));
  };

  const seekToEnd = (): void =>
    seekWithDuration((dur) => (dur > STEP_SEEK_MS ? dur - STEP_SEEK_MS : dur));

  return {
    scrub,
    previewPositionMs,
    cancelScrub,
    togglePlayPause,
    seekBy,
    seekToRatio,
    seekToEnd,
  };
}
