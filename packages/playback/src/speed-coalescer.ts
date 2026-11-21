import type { PlaybackTimers } from './types';

/** Minimum supported playback speed multiplier (`#302`). */
export const MIN_PLAYBACK_SPEED = 0.25;
/** Maximum supported playback speed multiplier (`#302`). */
export const MAX_PLAYBACK_SPEED = 4.0;
/** Default settle window (ms) between consecutive speed transitions (`#302`). */
export const DEFAULT_SPEED_SETTLE_MS = 80;

const MAX_SEEK_WAIT_RETRIES = 10;

/**
 * Clamps a valid positive finite playback speed to `[0.25, 4.0]`.
 * Returns `undefined` for `NaN`, `±Infinity`, or `<= 0`.
 */
export function clampPlaybackSpeed(rate: number): number | undefined {
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  return Math.min(MAX_PLAYBACK_SPEED, Math.max(MIN_PLAYBACK_SPEED, rate));
}

/** Dependencies of {@link createSpeedCoalescer}. */
export interface SpeedCoalescerOptions {
  readonly timers: PlaybackTimers;
  isSeekPending(): boolean;
  apply(rate: number): void;
  readonly settleMs?: number;
}

/** Coalesces rapid playback-speed changes across active seeks and in-flight speed transitions (`#302`). */
export interface SpeedCoalescer {
  request(rate: number): number | undefined;
  flush(): void;
  notifySettled(): void;
  isPending(): boolean;
  pendingSpeed(): number | undefined;
  reset(): void;
}

/** Creates a {@link SpeedCoalescer} that stores only the latest speed while seeking or transitioning. */
export function createSpeedCoalescer(opts: SpeedCoalescerOptions): SpeedCoalescer {
  const settleMs = Math.max(0, opts.settleMs ?? DEFAULT_SPEED_SETTLE_MS);
  let pending: number | undefined;
  let inFlight = false;
  let timer: unknown;
  let seekRetries = 0;

  const clearTimer = (): void => {
    if (timer !== undefined) opts.timers.clearTimeout(timer);
    timer = undefined;
  };

  const armTimer = (): void => {
    if (settleMs <= 0 || timer !== undefined) return;
    timer = opts.timers.setTimeout(() => {
      timer = undefined;
      inFlight = false;
      flushPending();
    }, settleMs);
  };

  const dispatch = (rate: number): void => {
    seekRetries = 0;
    if (settleMs > 0) {
      inFlight = true;
      armTimer();
    }
    opts.apply(rate);
  };

  const flushPending = (): void => {
    if (pending === undefined || inFlight) return;
    if (opts.isSeekPending()) {
      if (settleMs > 0 && seekRetries < MAX_SEEK_WAIT_RETRIES) {
        seekRetries += 1;
        armTimer();
      }
      return;
    }
    const next = pending;
    pending = undefined;
    dispatch(next);
  };

  return {
    request(rate) {
      const clamped = clampPlaybackSpeed(rate);
      if (clamped === undefined) return undefined;
      if (inFlight || opts.isSeekPending()) {
        pending = clamped;
        seekRetries = 0;
        armTimer();
        return clamped;
      }
      dispatch(clamped);
      return clamped;
    },

    flush() {
      flushPending();
    },

    notifySettled() {
      clearTimer();
      inFlight = false;
      flushPending();
    },

    isPending() {
      return inFlight || pending !== undefined;
    },

    pendingSpeed() {
      return pending;
    },

    reset() {
      clearTimer();
      pending = undefined;
      inFlight = false;
      seekRetries = 0;
    },
  };
}
