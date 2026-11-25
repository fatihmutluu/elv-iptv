import type {
  ClockAnchor,
  PlaybackClock,
  PlaybackService,
  PlaybackStatus,
  PlaybackTimers,
} from '@elv/playback';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { shouldShowLiveJumpToLive } from './live-timeshift-model';

const JUMP_TO_LIVE_TIMEOUT_MS = 4_000;
const TERMINAL_STATUSES = new Set<PlaybackStatus['kind']>(['idle', 'ended', 'failed', 'limited']);

/**
 * Tracks active Jump-to-Live syncing feedback for a live stream, clearing automatically when a
 * subsequent `clock` / `playing` update confirms live-edge sync, on stream change/unmount, or
 * after a bounded `4_000 ms` safety timeout.
 */
export function useJumpToLiveState(params: {
  readonly activeTargetKey: string;
  readonly serviceRef: MutableRefObject<PlaybackService | null>;
  readonly clockRef: MutableRefObject<PlaybackClock>;
  readonly timersRef: MutableRefObject<PlaybackTimers>;
}): {
  readonly jumpingToLive: boolean;
  readonly jumpToLiveEdge: () => void;
} {
  const { activeTargetKey, serviceRef, clockRef, timersRef } = params;
  const [jumpingToLive, setJumpingToLive] = useState(false);
  const jumpingRef = useRef(false);
  const timerHandleRef = useRef<unknown>(undefined);
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined);

  const clearJumpingToLive = useCallback((): void => {
    if (timerHandleRef.current !== undefined) {
      timersRef.current.clearTimeout(timerHandleRef.current);
      timerHandleRef.current = undefined;
    }
    if (unsubscribeRef.current !== undefined) {
      unsubscribeRef.current();
      unsubscribeRef.current = undefined;
    }
    if (jumpingRef.current) {
      jumpingRef.current = false;
      setJumpingToLive(false);
    }
  }, [timersRef]);

  useEffect(() => {
    void activeTargetKey;
    clearJumpingToLive();
    return clearJumpingToLive;
  }, [activeTargetKey, clearJumpingToLive]);

  const jumpToLiveEdge = useCallback((): void => {
    if (jumpingRef.current) return;
    const svc = serviceRef.current;
    if (svc === null) return;
    const wasPaused = svc.getState().status.kind === 'paused';
    const jumped = svc.jumpToLiveEdge();
    if (!jumped && wasPaused) svc.play();
    if (!jumped && !wasPaused) return;

    const baselineState = svc.getState();
    const baselineAnchor: ClockAnchor | undefined = baselineState.anchor;
    const baselineStatus: PlaybackStatus['kind'] = baselineState.status.kind;

    jumpingRef.current = true;
    setJumpingToLive(true);

    timerHandleRef.current = timersRef.current.setTimeout(() => {
      timerHandleRef.current = undefined;
      clearJumpingToLive();
    }, JUMP_TO_LIVE_TIMEOUT_MS);

    unsubscribeRef.current = svc.subscribe((next) => {
      if (TERMINAL_STATUSES.has(next.status.kind)) {
        clearJumpingToLive();
        return;
      }
      const anchorChanged = next.anchor !== baselineAnchor;
      const becamePlaying = baselineStatus !== 'playing' && next.status.kind === 'playing';
      if (
        (anchorChanged || becamePlaying) &&
        next.status.kind === 'playing' &&
        !shouldShowLiveJumpToLive(next.anchor, clockRef.current.now(), false)
      ) {
        clearJumpingToLive();
      }
    });
  }, [clearJumpingToLive, clockRef, serviceRef, timersRef]);

  return { jumpingToLive, jumpToLiveEdge };
}
