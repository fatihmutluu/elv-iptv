import { createPositionTracker, isBudgetUsed, nextLimitDelay } from './backoff';
import { classifyError, toPlaybackError } from './errors';
import { createLadderRunner, STALLED } from './ladder';
import type { RecoveryHooks, ServiceControl } from './seam';
import { createStallWatchdog } from './stall-watchdog';

export { nextLimitDelay };

/**
 * @internal Builds the recovery ladder (spec section 5.4), bounded stall & frame-silence watchdog
 * (`#108`, `#148`), single-attempt live clean-end reconnect (`#148`), live stale-pause reload
 * (`#190`), pre-playback `.ts <-> .m3u8` fallback (`#200`), paused `surface-lost` parking (`#280`),
 * and provider connection-limit backoff (section 5.5).
 */
export function createRecovery(ctl: ServiceControl): RecoveryHooks {
  const { config } = ctl;
  let surfaceGone = false;
  let awaitingSurface = false;
  let surfaceDeferred = false;
  let paused = false;
  let pausedAt: number | undefined;
  let deferred = false;
  let errorWhilePaused = false;
  let liveCleanEndRetried = false;
  let liveFrozenResetTried = false;

  const inBatch = <T>(fn: () => T): T => (ctl.batch !== undefined ? ctl.batch(fn) : fn());
  const isVod = (): boolean => ctl.request()?.kind === 'vod';
  const hasStream = (): boolean => ctl.stream === undefined || ctl.stream() !== undefined;
  const canWatchStall = (): boolean =>
    ctl.getState().status.kind === 'playing' && !paused && !awaitingSurface;
  const positions = createPositionTracker(ctl);

  const reloadLiveEdge = (): boolean =>
    inBatch(() => {
      const prevStatus = ctl.getState().status;
      ctl.nextAttempt();
      ctl.setStatus({ kind: 'tuning' });
      if (!ladder.reload()) {
        ctl.setStatus(prevStatus);
        return false;
      }
      if (ctl.getState().status.kind === 'tuning') ctl.armStartTimeout(ctl.startTimeoutMs());
      return true;
    });

  const watchdog = createStallWatchdog(
    ctl,
    () => ladder.escalate(undefined, true),
    () => {
      ladder.resetBudgetAndLimit();
      liveCleanEndRetried = false;
      liveFrozenResetTried = false;
    },
    () => {
      if (ctl.request()?.kind === 'live' && !liveFrozenResetTried && hasStream()) {
        cancelSteps();
        positions.freeze(false);
        if (reloadLiveEdge()) {
          liveFrozenResetTried = true;
          return;
        }
      }
      ladder.escalate(undefined, true);
    },
    () => ladder.escalate({ code: 'decoder' }, true),
  );

  const clearRecoveryTimers = (): void => {
    watchdog.cancel();
    ladder.clearTimers();
    ctl.clearStartTimeout();
  };

  const cancelSteps = (): void => {
    clearRecoveryTimers();
    awaitingSurface = false;
    surfaceDeferred = false;
  };

  const resetItem = (): void => {
    ladder.resetItem();
    positions.reset();
    watchdog.reset();
    paused = false;
    pausedAt = undefined;
    deferred = false;
    errorWhilePaused = false;
    liveCleanEndRetried = false;
    liveFrozenResetTried = false;
  };

  const reset = (): void => {
    cancelSteps();
    resetItem();
    ladder.resetLimit();
  };

  const ladder = createLadderRunner({
    ctl,
    positions,
    cancelAll: cancelSteps,
    onResetAll: reset,
  });

  const pause = (): void => {
    positions.freeze(isVod());
    if (ladder.hasPendingRung()) {
      deferred = true;
      ctl.setStatus({ kind: 'paused' });
    }
    if (!paused) pausedAt = ctl.now();
    paused = true;
    const waitingSurface = awaitingSurface;
    const readySurface = surfaceDeferred;
    cancelSteps();
    awaitingSurface = waitingSurface;
    surfaceDeferred = readySurface;
  };

  return {
    onTune(request) {
      if (ladder.isHoldingAccount(request.accountKey)) {
        resetItem();
        ladder.markHeldTune();
        return true;
      }
      reset();
      return false;
    },
    onReset: reset,
    onSeek(positionMs) {
      const clamped = Math.max(0, positionMs);
      watchdog.onSeek();
      if (!isVod()) {
        positions.onSeek(clamped);
        return;
      }
      const budget = ladder.getBudget();
      const kind = ctl.getState().status.kind;
      const shouldReload =
        kind === 'ended' ||
        (!paused &&
          (kind === 'recovering' || (budget.vodStart !== undefined && kind !== 'playing')));
      positions.onSeek(clamped);
      if (!shouldReload) {
        budget.vodStart = undefined;
        budget.vodAttempt = 0;
        return;
      }
      cancelSteps();
      ladder.resetItem();
      inBatch(() => {
        ctl.nextAttempt();
        ctl.setStatus({ kind: 'tuning' });
        if (ladder.reload()) ctl.armStartTimeout(ctl.startTimeoutMs());
      });
    },
    onPause: pause,
    onPlay() {
      if (!paused) return;
      const waited = pausedAt === undefined ? 0 : Math.max(0, ctl.now() - pausedAt);
      paused = false;
      pausedAt = undefined;
      const budget = ladder.getBudget();
      if (budget.vodStart !== undefined) budget.vodStart += waited;

      if (awaitingSurface) return;
      if (surfaceDeferred) {
        surfaceDeferred = false;
        ladder.goTo(1);
        return;
      }
      if (deferred) {
        deferred = false;
        const hadErrorWhilePaused = errorWhilePaused;
        errorWhilePaused = false;
        const err = budget.lastError;
        if (isVod() && (err?.code === 'network' || budget.vodStart !== undefined)) {
          ladder.reconnectVod(err ?? STALLED);
        } else if (err !== undefined && classifyError(err.code, err.httpStatus) === 'not-found') {
          budget.notFound = true;
          if (budget.rung < 2) ladder.goTo(2, () => ladder.onNotFound(err));
          else ladder.onNotFound(err);
        } else if (budget.rung >= 4 && !hadErrorWhilePaused && (ctl.isLoaded?.() ?? false)) {
          ladder.watchRung4();
        } else {
          ladder.escalate();
        }
        return;
      }
      if (
        !isVod() &&
        ctl.getState().firstFrameAt !== undefined &&
        waited >= config.liveStalePauseMs
      ) {
        cancelSteps();
        ctl.setStatus({ kind: 'tuning' });
        if (ladder.reload()) ctl.armStartTimeout(ctl.startTimeoutMs());
        return;
      }
      if (ctl.getState().status.kind !== 'playing') {
        ctl.armStartTimeout(ctl.startTimeoutMs());
      }
    },
    onState(state) {
      if (state === 'ended') {
        reset();
        return;
      }
      if (state === 'paused') {
        pause();
        return;
      }
      watchdog.onNonPlayingState();
      if (state !== 'playing') return;
      paused = false;
      pausedAt = undefined;
      deferred = false;
      errorWhilePaused = false;
      ladder.clearStepAndRung();
      ladder.commitPendingFormat();
      watchdog.onPlaying(
        isBudgetUsed(ladder.getBudget(), ladder.getLimit()) ||
          liveCleanEndRetried ||
          liveFrozenResetTried,
      );
    },
    onLiveEnded() {
      const statusKind = ctl.getState().status.kind;
      if (
        ctl.request()?.kind !== 'live' ||
        liveCleanEndRetried ||
        paused ||
        awaitingSurface ||
        statusKind === 'idle' ||
        statusKind === 'ended' ||
        statusKind === 'failed' ||
        statusKind === 'limited' ||
        !hasStream()
      ) {
        return false;
      }
      cancelSteps();
      if (!reloadLiveEdge()) return false;
      liveCleanEndRetried = true;
      return true;
    },
    onClock(anchor) {
      watchdog.onClock(anchor, canWatchStall());
      positions.onClock(anchor);
    },
    onError(error) {
      const budget = ladder.getBudget();
      const kind = classifyError(error.code, error.httpStatus);
      if (kind === 'terminal') {
        ladder.failWith(toPlaybackError(error));
      } else if (kind === 'limit') {
        paused = false;
        pausedAt = undefined;
        deferred = false;
        errorWhilePaused = false;
        ladder.enterLimit();
      } else if (error.code === 'surface-lost' && surfaceGone) {
        clearRecoveryTimers();
        positions.freeze(isVod());
        budget.lastError = error;
        awaitingSurface = true;
        surfaceDeferred = false;
      } else if (paused) {
        budget.lastError = error;
        deferred = true;
        errorWhilePaused = true;
      } else if (ladder.hasStepTimer() || awaitingSurface) {
        budget.lastError = error;
      } else if (kind === 'not-found') {
        ladder.onNotFound(error);
      } else if (error.code === 'network' && isVod()) {
        ladder.reconnectVod(error);
      } else {
        ladder.escalate(error);
      }
    },
    onStall(phase) {
      watchdog.onStall(phase, canWatchStall());
    },
    onProgress(atMs, bytesReceived) {
      watchdog.onProgress(atMs, bytesReceived);
    },
    onStartTimeout() {
      const budget = ladder.getBudget();
      if (!isVod() && ctl.getState().firstFrameAt === undefined) {
        budget.rung = Math.max(budget.rung, 1);
      }
      ladder.escalate(undefined, true);
    },
    onSurface(change) {
      surfaceGone = change === 'destroyed';
      if (surfaceGone || !awaitingSurface) return;
      awaitingSurface = false;
      if (paused) surfaceDeferred = true;
      else ladder.goTo(1);
    },
    onDispose: reset,
  };
}
