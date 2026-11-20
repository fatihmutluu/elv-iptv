import {
  type ClockAnchor,
  type PlaybackClock,
  type PlaybackService,
  positionAt,
} from '@elv/playback';
import { useEffect, useRef, useState } from 'react';

/** `frame` re-renders every animation frame; `second` wakes on each media-second boundary. */
export type TickerMode = 'frame' | 'second';

/** Frame and timer primitives, injectable so tests can count scheduled ticks. */
export interface TickerScheduler {
  requestFrame(cb: () => void): unknown;
  cancelFrame(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const GLOBAL_SCHEDULER: TickerScheduler = {
  requestFrame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (handle) => cancelAnimationFrame(handle as number),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** True only when the anchor exists, advances (`rate > 0`) and the caller is active. */
export function isPlaybackTicking(anchor: ClockAnchor | undefined, active = true): boolean {
  return active && anchor !== undefined && anchor.rate > 0;
}

/** Starts a gated tick loop and returns its stop function; schedules nothing for a still anchor. */
export function startPlaybackTicker(params: {
  anchor: ClockAnchor | undefined;
  mode: TickerMode;
  clock: PlaybackClock;
  scheduler?: TickerScheduler;
  onTick: () => void;
}): () => void {
  const { anchor, mode, clock, onTick, scheduler = GLOBAL_SCHEDULER } = params;
  if (anchor === undefined || !isPlaybackTicking(anchor)) return () => undefined;
  let stopped = false;
  let handle: unknown;

  if (mode === 'frame') {
    const frame = (): void => {
      if (stopped) return;
      onTick();
      handle = scheduler.requestFrame(frame);
    };
    handle = scheduler.requestFrame(frame);
    return () => {
      stopped = true;
      scheduler.cancelFrame(handle);
    };
  }

  const arm = (): void => {
    const remainder = positionAt(anchor, clock.now()) % 1000;
    handle = scheduler.setTimeout(
      () => {
        if (stopped) return;
        onTick();
        arm();
      },
      Math.ceil((1000 - remainder) / anchor.rate) + 1,
    );
  };
  arm();
  return () => {
    stopped = true;
    scheduler.clearTimeout(handle);
  };
}

/**
 * Derives a value from the service `ClockAnchor`, re-deriving on service updates and on a gated
 * tick that runs only while playback advances, and re-renders only when `isEqual` reports a change.
 */
export function usePlaybackTicker<T>(params: {
  service: PlaybackService | null;
  clock: PlaybackClock;
  mode: TickerMode;
  active?: boolean;
  derive: (anchor: ClockAnchor | undefined, nowMs: number) => T;
  isEqual: (a: T, b: T) => boolean;
}): T {
  const { service, clock, mode, active = true } = params;
  const deriveRef = useRef(params.derive);
  deriveRef.current = params.derive;
  const isEqualRef = useRef(params.isEqual);
  isEqualRef.current = params.isEqual;

  const [anchor, setAnchor] = useState(() => service?.getState().anchor);
  const [value, setValue] = useState(() => params.derive(anchor, clock.now()));

  useEffect(() => {
    setAnchor(service?.getState().anchor);
    if (service === null) return;
    return service.subscribe((state) => setAnchor(state.anchor));
  }, [service]);

  useEffect(() => {
    const sync = (): void => {
      const next = deriveRef.current(anchor, clock.now());
      setValue((prev) => (isEqualRef.current(prev, next) ? prev : next));
    };
    sync();
    if (!isPlaybackTicking(anchor, active)) return;
    return startPlaybackTicker({ anchor, mode, clock, onTick: sync });
  }, [active, anchor, clock, mode]);

  return value;
}
