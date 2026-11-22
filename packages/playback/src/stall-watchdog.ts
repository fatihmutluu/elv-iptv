import type { ClockAnchor } from './engine';
import type { ServiceControl } from './seam';

/** @internal Bounded seek-settle, frame-silence, black-screen, and stall watchdog (`#108`, `#148`, `#321`). */
export interface StallWatchdog {
  cancel(): void;
  reset(): void;
  onSeek(): void;
  onClock(anchor: ClockAnchor, canWatch: boolean): void;
  onProgress(atMs: number, bytesReceived?: number): void;
  onPlaying(budgetUsed: boolean): void;
  onNonPlayingState(): void;
  onStall(phase: 'start' | 'end', canWatch: boolean): void;
}

/**
 * @internal Manages the 4 s mid-stream stall timer with bounded network-activity deferrals,
 * live frozen-clock frame-silence detection, zero-decoded-frame black-screen detection,
 * the 30 s stable-playback budget restore timer, and the bounded seek-settle deadline so seeks
 * neither falsely trigger stalls nor permanently blind stall detection.
 */
export function createStallWatchdog(
  ctl: ServiceControl,
  onStallEscalate: () => void,
  onStableRestore: () => void,
  onFrozenClock: () => void,
  onDecoderStall: () => void,
): StallWatchdog {
  const { config } = ctl;
  let stallTimer: unknown;
  let stableTimer: unknown;
  let seekSettleTimer: unknown;
  let seekSettling = false;
  let stalledDuringSeek = false;
  let lastClockPosMs: number | undefined;
  let frozenSinceMs: number | undefined;
  let zeroFrameSinceMs: number | undefined;
  let lastZeroFramePosMs: number | undefined;
  let zeroFramePosAdvanced = false;
  let lastNetworkActivityAtMs: number | undefined;
  let lastStallProgressBytes: number | undefined;
  let stallDeferrals = 0;

  const clear = (handle: unknown): undefined => {
    if (handle !== undefined) ctl.clearTimer(handle);
    return undefined;
  };

  const clearFrozenClock = (): void => {
    lastClockPosMs = undefined;
    frozenSinceMs = undefined;
  };

  const clearZeroFrame = (): void => {
    zeroFrameSinceMs = undefined;
    lastZeroFramePosMs = undefined;
    zeroFramePosAdvanced = false;
  };

  const clearSeekSettle = (): void => {
    seekSettleTimer = clear(seekSettleTimer);
    seekSettling = false;
    stalledDuringSeek = false;
  };

  const armStallTimer = (): void => {
    stallTimer = ctl.setTimer(() => {
      stallTimer = undefined;
      const age =
        lastNetworkActivityAtMs === undefined ? undefined : ctl.now() - lastNetworkActivityAtMs;
      const recentNetwork = age !== undefined && age >= 0 && age < config.liveStallWindowMs;
      if (recentNetwork && stallDeferrals < config.maxStallDeferrals) {
        stallDeferrals += 1;
        armStallTimer();
        return;
      }
      stallDeferrals = 0;
      onStallEscalate();
    }, config.liveStallWindowMs);
  };

  const cancel = (): void => {
    stallTimer = clear(stallTimer);
    stableTimer = clear(stableTimer);
    seekSettleTimer = clear(seekSettleTimer);
    stalledDuringSeek = false;
    clearFrozenClock();
    clearZeroFrame();
    lastNetworkActivityAtMs = undefined;
    lastStallProgressBytes = undefined;
    stallDeferrals = 0;
  };

  const checkZeroDecodedFrames = (anchor: ClockAnchor, canWatch: boolean): boolean => {
    if (
      !canWatch ||
      anchor.hasVideoTrack !== true ||
      anchor.decodedVideoFrames !== 0 ||
      !(anchor.rate > 0) ||
      !Number.isFinite(anchor.rate) ||
      !Number.isFinite(anchor.positionMs) ||
      !Number.isFinite(anchor.atMs)
    ) {
      clearZeroFrame();
      return false;
    }
    if (zeroFrameSinceMs === undefined || lastZeroFramePosMs === undefined) {
      zeroFrameSinceMs = anchor.atMs;
      lastZeroFramePosMs = anchor.positionMs;
      zeroFramePosAdvanced = false;
      return false;
    }
    if (anchor.atMs < zeroFrameSinceMs) {
      zeroFrameSinceMs = anchor.atMs;
      lastZeroFramePosMs = anchor.positionMs;
      zeroFramePosAdvanced = false;
      return false;
    }
    if (anchor.positionMs > lastZeroFramePosMs) zeroFramePosAdvanced = true;
    lastZeroFramePosMs = anchor.positionMs;
    if (zeroFramePosAdvanced && anchor.atMs - zeroFrameSinceMs >= config.zeroFrameWindowMs) {
      clearZeroFrame();
      clearFrozenClock();
      stallTimer = clear(stallTimer);
      stableTimer = clear(stableTimer);
      onDecoderStall();
      return true;
    }
    return false;
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
      clearFrozenClock();
      clearZeroFrame();
      lastStallProgressBytes = undefined;
      stallDeferrals = 0;
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

    onClock(anchor, canWatch) {
      if (seekSettling) {
        if (!stalledDuringSeek && anchor.rate > 0) {
          clearSeekSettle();
        } else {
          clearFrozenClock();
          clearZeroFrame();
          return;
        }
      }
      if (checkZeroDecodedFrames(anchor, canWatch)) return;
      if (
        !canWatch ||
        ctl.request()?.kind !== 'live' ||
        ctl.getState().firstFrameAt === undefined ||
        !(anchor.rate > 0) ||
        !Number.isFinite(anchor.rate) ||
        !Number.isFinite(anchor.positionMs) ||
        !Number.isFinite(anchor.atMs)
      ) {
        clearFrozenClock();
        return;
      }
      if (
        lastClockPosMs === undefined ||
        frozenSinceMs === undefined ||
        anchor.positionMs !== lastClockPosMs
      ) {
        lastClockPosMs = anchor.positionMs;
        frozenSinceMs = anchor.atMs;
        return;
      }
      if (anchor.atMs < frozenSinceMs) {
        frozenSinceMs = anchor.atMs;
        return;
      }
      if (anchor.atMs - frozenSinceMs >= config.liveStallWindowMs) {
        clearFrozenClock();
        stallTimer = clear(stallTimer);
        stableTimer = clear(stableTimer);
        onFrozenClock();
      }
    },

    onProgress(atMs, bytesReceived) {
      if (!Number.isFinite(atMs)) return;
      if (bytesReceived !== undefined) {
        if (!Number.isFinite(bytesReceived) || bytesReceived <= 0) return;
        if (lastStallProgressBytes !== undefined && bytesReceived <= lastStallProgressBytes) return;
        lastStallProgressBytes = bytesReceived;
      }
      if (lastNetworkActivityAtMs === undefined || atMs > lastNetworkActivityAtMs) {
        lastNetworkActivityAtMs = atMs;
      }
    },

    onPlaying(budgetUsed) {
      stallTimer = clear(stallTimer);
      stableTimer = clear(stableTimer);
      clearSeekSettle();
      clearFrozenClock();
      clearZeroFrame();
      lastStallProgressBytes = undefined;
      stallDeferrals = 0;
      if (!budgetUsed) return;
      stableTimer = ctl.setTimer(() => {
        stableTimer = undefined;
        onStableRestore();
      }, config.stableRestoreMs);
    },

    onNonPlayingState() {
      stableTimer = clear(stableTimer);
      clearFrozenClock();
      clearZeroFrame();
    },

    onStall(phase, canWatch) {
      if (phase === 'end') {
        stallTimer = clear(stallTimer);
        lastStallProgressBytes = undefined;
        stallDeferrals = 0;
        if (seekSettling) clearSeekSettle();
        return;
      }
      stableTimer = clear(stableTimer);
      if (seekSettling) {
        if (canWatch) stalledDuringSeek = true;
        return;
      }
      if (!canWatch || stallTimer !== undefined) return;
      armStallTimer();
    },
  };
}
