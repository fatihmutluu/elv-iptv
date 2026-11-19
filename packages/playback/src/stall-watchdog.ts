import type { ClockAnchor } from './engine';
import type { ServiceControl } from './seam';

/** @internal Bounded seek-settle and playback stall watchdog (`#108`). */
export interface StallWatchdog {
  cancel(): void;
  reset(): void;
  onSeek(): void;
  onClock(anchor: ClockAnchor): void;
  onPlaying(budgetUsed: boolean): void;
  onNonPlayingState(): void;
  onStall(phase: 'start' | 'end', canWatch: boolean): void;
}

/**
 * @internal Manages the 4 s mid-stream stall timer, the 30 s stable-playback budget restore timer,
 * and the bounded seek-settle deadline so seeks neither falsely trigger stalls nor permanently
 * blind stall detection.
 */
export function createStallWatchdog(
  ctl: ServiceControl,
  onStallEscalate: () => void,
  onStableRestore: () => void,
): StallWatchdog {
  const { config } = ctl;
  let stallTimer: unknown;
  let stableTimer: unknown;
  let seekSettleTimer: unknown;
  let seekSettling = false;
  let stalledDuringSeek = false;

  const clear = (handle: unknown): undefined => {
    if (handle !== undefined) ctl.clearTimer(handle);
    return undefined;
  };

  const clearSeekSettle = (): void => {
    seekSettleTimer = clear(seekSettleTimer);
    seekSettling = false;
    stalledDuringSeek = false;
  };

  const cancel = (): void => {
    stallTimer = clear(stallTimer);
    stableTimer = clear(stableTimer);
    seekSettleTimer = clear(seekSettleTimer);
    stalledDuringSeek = false;
  };

  return {
    cancel,

    reset() {
      cancel();
      seekSettling = false;
    },

    onSeek() {
      stallTimer = clear(stallTimer);
      seekSettleTimer = clear(seekSettleTimer);
      seekSettling = true;
      stalledDuringSeek = false;
      seekSettleTimer = ctl.setTimer(() => {
        seekSettleTimer = undefined;
        const stillStalled = stalledDuringSeek;
        seekSettling = false;
        stalledDuringSeek = false;
        if (stillStalled) onStallEscalate();
      }, config.seekSettleTimeoutMs);
    },

    onClock(anchor) {
      if (seekSettling && !stalledDuringSeek && anchor.rate > 0) {
        clearSeekSettle();
      }
    },

    onPlaying(budgetUsed) {
      stallTimer = clear(stallTimer);
      stableTimer = clear(stableTimer);
      clearSeekSettle();
      if (!budgetUsed) return;
      stableTimer = ctl.setTimer(() => {
        stableTimer = undefined;
        onStableRestore();
      }, config.stableRestoreMs);
    },

    onNonPlayingState() {
      stableTimer = clear(stableTimer);
    },

    onStall(phase, canWatch) {
      if (phase === 'end') {
        stallTimer = clear(stallTimer);
        if (seekSettling) clearSeekSettle();
        return;
      }
      stableTimer = clear(stableTimer);
      if (seekSettling) {
        if (canWatch) stalledDuringSeek = true;
        return;
      }
      if (!canWatch || stallTimer !== undefined) return;
      stallTimer = ctl.setTimer(() => {
        stallTimer = undefined;
        onStallEscalate();
      }, config.liveStallWindowMs);
    },
  };
}
