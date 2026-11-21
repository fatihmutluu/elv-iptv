import type { ClockAnchor } from './engine';
import type { PlaybackClock, PlaybackTimers } from './types';

const STALE_CLOCK_GUARD_MS = 400;
const SEEK_TOLERANCE_MS = 5000;

/** @internal Coalesces rapid `service.seek()` calls and filters pre-seek clock ticks (`#108`). */
export interface SeekCoalescer {
  request(positionMs: number, dispatch: (targetMs: number) => void): void;
  shouldAcceptClock(anchor: ClockAnchor): boolean;
  isPending(): boolean;
  reset(): void;
}

export function createSeekCoalescer(
  clock: PlaybackClock,
  timers: PlaybackTimers,
  coalesceMs: number,
  onIdle?: () => void,
): SeekCoalescer {
  let timer: unknown;
  let queuedMs: number | undefined;
  let targetMs: number | undefined;
  let guardUntilMs = 0;
  let lastDispatchAtMs = 0;
  let inMicrotaskBurst = false;

  const clearTimer = (): void => {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
  };

  const markBurstTurn = (): void => {
    if (inMicrotaskBurst) return;
    inMicrotaskBurst = true;
    void Promise.resolve().then(() => {
      inMicrotaskBurst = false;
    });
  };

  const armWindow = (dispatch: (ms: number) => void): void => {
    if (coalesceMs <= 0) return;
    timer = timers.setTimeout(() => {
      timer = undefined;
      if (queuedMs === undefined) {
        if (targetMs !== undefined && clock.now() > guardUntilMs) targetMs = undefined;
        if (targetMs === undefined) onIdle?.();
        return;
      }
      const next = queuedMs;
      queuedMs = undefined;
      const now = clock.now();
      targetMs = next;
      lastDispatchAtMs = now;
      guardUntilMs = now + STALE_CLOCK_GUARD_MS;
      dispatch(next);
      armWindow(dispatch);
    }, coalesceMs);
  };

  return {
    request(positionMs, dispatch) {
      const now = clock.now();
      targetMs = positionMs;
      guardUntilMs = now + STALE_CLOCK_GUARD_MS;
      if (timer !== undefined) {
        const elapsed = now - lastDispatchAtMs;
        if (inMicrotaskBurst || (elapsed > 0 && elapsed < coalesceMs)) {
          queuedMs = positionMs;
          return;
        }
        clearTimer();
        queuedMs = undefined;
      }
      lastDispatchAtMs = now;
      markBurstTurn();
      dispatch(positionMs);
      armWindow(dispatch);
    },

    shouldAcceptClock(anchor) {
      if (targetMs === undefined) return true;
      if (queuedMs !== undefined) return false;
      const now = clock.now();
      if (now > guardUntilMs) {
        targetMs = undefined;
        return true;
      }
      if (Math.abs(anchor.positionMs - targetMs) <= SEEK_TOLERANCE_MS) {
        targetMs = undefined;
        return true;
      }
      return false;
    },

    isPending() {
      if (queuedMs !== undefined || timer !== undefined) return true;
      if (targetMs === undefined) return false;
      if (clock.now() > guardUntilMs) {
        targetMs = undefined;
        return false;
      }
      return true;
    },

    reset() {
      clearTimer();
      queuedMs = undefined;
      targetMs = undefined;
      guardUntilMs = 0;
      lastDispatchAtMs = 0;
      inMicrotaskBurst = false;
    },
  };
}
