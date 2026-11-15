import { type ElvError, elvError, type Result } from '@elv/domain';
import { positionAt } from './clock';
import type { PlaybackConfig } from './config';
import type { AttemptToken, ClockAnchor, EngineError, StreamRequest } from './engine';
import { classifyError, toPlaybackError } from './errors';
import type { RecoveryHooks, ServiceControl } from './seam';

type Rung = 1 | 2 | 3 | 4;
type RungAction = (token: AttemptToken) => void;

const RUNGS: readonly Rung[] = [1, 2, 3, 4];
const STALLED: EngineError = { code: 'network' };

interface Budget {
  rung: number;
  lastError: EngineError | undefined;
  notFound: boolean;
  vodStart: number | undefined;
  vodAttempt: number;
}

interface Limit {
  start: number | undefined;
  attempt: number;
  account: string | undefined;
}

const freshBudget = (): Budget => ({
  rung: 0,
  lastError: undefined,
  notFound: false,
  vodStart: undefined,
  vodAttempt: 0,
});
const freshLimit = (): Limit => ({ start: undefined, attempt: 0, account: undefined });

function backoff(
  elapsedMs: number,
  attempt: number,
  steps: readonly number[],
  totalMs: number,
): number | undefined {
  const step = steps[Math.min(attempt, steps.length - 1)];
  return step === undefined || elapsedMs + step > totalMs ? undefined : step;
}

/**
 * Wait before the next connection-limit attempt (2 s, 4 s, 8 s, then 15 s by default), or undefined
 * when that attempt would start after the total budget (60 s) and the service should give up.
 */
export function nextLimitDelay(
  elapsedMs: number,
  attempt: number,
  config: PlaybackConfig,
): number | undefined {
  return backoff(elapsedMs, attempt, config.limitBackoffMs, config.limitTotalMs);
}

/**
 * @internal Builds the recovery ladder (spec section 5.4), the stall watchdog and the provider
 * connection-limit path (section 5.5) on top of the service controls.
 */
export function createRecovery(ctl: ServiceControl): RecoveryHooks {
  const { config, engine } = ctl;
  let stallTimer: unknown;
  let stepTimer: unknown;
  let rungTimer: unknown;
  let stableTimer: unknown;
  let limitTimer: unknown;
  let epoch = 0;
  let budget = freshBudget();
  let limit = freshLimit();
  let alternate = 0;
  let softwareAudio = false;
  let resumeFrom: ClockAnchor | undefined;
  let resumeMs: number | undefined;
  let heldFresh = false;
  let seekDisarmed = false;
  let surfaceGone = false;
  let awaitingSurface = false;
  let paused = false;
  let pausedAt: number | undefined;
  let deferred = false;

  const clear = (handle: unknown): undefined => {
    if (handle !== undefined) ctl.clearTimer(handle);
    return undefined;
  };

  const cancelSteps = (): void => {
    epoch += 1;
    stallTimer = clear(stallTimer);
    stepTimer = clear(stepTimer);
    rungTimer = clear(rungTimer);
    stableTimer = clear(stableTimer);
    limitTimer = clear(limitTimer);
    awaitingSurface = false;
    ctl.clearStartTimeout();
  };

  const resetItem = (): void => {
    budget = freshBudget();
    alternate = 0;
    softwareAudio = false;
    resumeFrom = undefined;
    resumeMs = undefined;
    seekDisarmed = false;
    paused = false;
    pausedAt = undefined;
    deferred = false;
  };

  const reset = (): void => {
    cancelSteps();
    resetItem();
    limit = freshLimit();
    heldFresh = false;
  };

  const failWith = (error: ElvError): void => {
    reset();
    ctl.fail(error);
  };
  const giveUp = (): void => failWith(toPlaybackError(budget.lastError ?? STALLED));
  const isVod = (): boolean => ctl.request()?.kind === 'vod';

  const resumePosition = (): number | undefined => {
    if (resumeFrom !== undefined) {
      resumeMs = positionAt(resumeFrom, ctl.now());
      resumeFrom = undefined;
    }
    if (resumeMs !== undefined) return resumeMs;
    const anchored = ctl.getState().anchor;
    if (anchored !== undefined && anchored.positionMs > 0) {
      return positionAt(anchored, ctl.now());
    }
    return ctl.request()?.startMs;
  };

  const freeze = (): void => {
    if (isVod()) resumePosition();
    ctl.freezeAnchor();
  };

  const reload = (stream?: StreamRequest): void => {
    const startMs = isVod() ? resumePosition() : undefined;
    ctl.load({
      ...(stream === undefined ? {} : { stream }),
      ...(startMs === undefined ? {} : { startMs }),
      ...(softwareAudio ? { options: { softwareAudio: true } } : {}),
    });
  };

  const after = (ms: number, step: () => void): void => {
    if (ms <= 0) step();
    else {
      stepTimer = ctl.setTimer(() => {
        stepTimer = undefined;
        step();
      }, ms);
    }
  };

  const watch = (onTimeout: () => void): void => {
    rungTimer = ctl.setTimer(() => {
      rungTimer = undefined;
      onTimeout();
    }, config.rungTimeoutMs);
  };

  const alternateRung = (): RungAction | undefined => {
    if (
      budget.lastError?.code === 'decoder' &&
      !softwareAudio &&
      engine.capabilities.softwareAudioFallback
    ) {
      return () => {
        softwareAudio = true;
        reload();
      };
    }
    const next = ctl.request()?.alternates?.[alternate];
    if (next === undefined) return undefined;
    return () => {
      ctl.stopMedia();
      const at = epoch;
      const settle = (result: Result<StreamRequest> | undefined): void => {
        if (at !== epoch) return;
        alternate += 1;
        if (result?.ok) reload(result.value);
        else giveUp();
      };
      new Promise<Result<StreamRequest>>((resolve) => resolve(next())).then(settle, () =>
        settle(undefined),
      );
    };
  };

  const rungAction = (rung: Rung): RungAction | undefined => {
    if (rung === 1) return (token) => engine.retry(token);
    if (rung === 2) return () => reload();
    if (rung === 3) {
      return (token) => {
        const at = epoch;
        if (engine.capabilities.recreate) engine.recreate(token);
        if (at === epoch) reload();
      };
    }
    return alternateRung();
  };

  const onSilentTimeout = (): void => {
    escalate(undefined, true);
  };

  const goTo = (rung: Rung, onTimeout: () => void = onSilentTimeout, silent = false): void => {
    const action = rungAction(rung);
    if (action === undefined) {
      giveUp();
      return;
    }
    const gap = silent ? 0 : (config.ladderGapsMs[rung - 1] ?? 0);
    ctl.setStatus({ kind: 'recovering', rung, nextAtMs: ctl.now() + gap });
    after(gap, () => {
      budget.rung = rung;
      const token = ctl.nextAttempt();
      watch(onTimeout);
      action(token);
    });
  };

  function escalate(error?: EngineError, silent = false): void {
    if (error !== undefined) budget.lastError = error;
    cancelSteps();
    freeze();
    const next = RUNGS[budget.rung];
    if (next === undefined) giveUp();
    else goTo(next, onSilentTimeout, silent);
  }

  const onNotFound = (error: EngineError): void => {
    if (budget.notFound || budget.rung >= 2) {
      failWith(toPlaybackError(error));
      return;
    }
    budget.lastError = error;
    budget.notFound = true;
    cancelSteps();
    freeze();
    goTo(2, giveUp);
  };

  const reconnectVod = (error: EngineError): void => {
    budget.lastError = error;
    cancelSteps();
    freeze();
    const now = ctl.now();
    budget.vodStart ??= now;
    const delay = backoff(
      now - budget.vodStart,
      budget.vodAttempt,
      config.limitBackoffMs,
      config.vodReconnectWindowMs,
    );
    if (delay === undefined) {
      failWith(toPlaybackError(error));
      return;
    }
    ctl.setStatus({ kind: 'recovering', rung: 2, nextAtMs: now + delay });
    after(delay, () => {
      budget.vodAttempt += 1;
      ctl.nextAttempt();
      watch(() => reconnectVod(error));
      reload();
    });
  };

  const enterLimit = (): void => {
    paused = false;
    pausedAt = undefined;
    deferred = false;
    cancelSteps();
    freeze();
    const now = ctl.now();
    limit.start ??= now;
    limit.account = ctl.request()?.accountKey;
    const delay = nextLimitDelay(now - limit.start, limit.attempt, config);
    if (delay === undefined) {
      failWith(elvError('playback', 'connection-limit'));
      return;
    }
    limit.attempt += 1;
    ctl.stopMedia();
    ctl.setStatus({ kind: 'limited', nextAtMs: now + delay });
    limitTimer = ctl.setTimer(() => {
      limitTimer = undefined;
      if (!heldFresh) ctl.nextAttempt();
      heldFresh = false;
      ctl.setStatus({ kind: 'tuning' });
      ctl.armStartTimeout(ctl.startTimeoutMs());
      reload();
    }, delay);
  };

  const pause = (): void => {
    freeze();
    if (stepTimer !== undefined || rungTimer !== undefined) {
      deferred = true;
      ctl.setStatus({ kind: 'paused' });
    }
    if (!paused) pausedAt = ctl.now();
    paused = true;
    const waitingSurface = awaitingSurface;
    cancelSteps();
    awaitingSurface = waitingSurface;
  };

  const budgetUsed = (): boolean =>
    budget.rung > 0 ||
    budget.notFound ||
    budget.vodStart !== undefined ||
    limit.start !== undefined;

  return {
    onTune(request) {
      if (limitTimer !== undefined && request.accountKey === limit.account) {
        resetItem();
        heldFresh = true;
        return true;
      }
      reset();
      return false;
    },
    onReset: reset,
    onSeek(positionMs) {
      const clamped = Math.max(0, positionMs);
      seekDisarmed = true;
      stallTimer = clear(stallTimer);
      resumeFrom = undefined;
      resumeMs = clamped;
      if (!isVod()) return;
      const kind = ctl.getState().status.kind;
      if (
        kind === 'ended' ||
        (!paused &&
          (kind === 'recovering' || (budget.vodStart !== undefined && kind !== 'playing')))
      ) {
        cancelSteps();
        budget = freshBudget();
        ctl.nextAttempt();
        ctl.setStatus({ kind: 'tuning' });
        ctl.armStartTimeout(ctl.startTimeoutMs());
        reload();
        return;
      }
      budget.vodStart = undefined;
      budget.vodAttempt = 0;
    },
    onPause: pause,
    onPlay() {
      if (!paused) return;
      const waited = pausedAt === undefined ? 0 : Math.max(0, ctl.now() - pausedAt);
      paused = false;
      pausedAt = undefined;
      if (budget.vodStart !== undefined) budget.vodStart += waited;
      if (deferred) {
        deferred = false;
        const err = budget.lastError;
        if (isVod() && (err?.code === 'network' || budget.vodStart !== undefined)) {
          reconnectVod(err ?? STALLED);
        } else if (err !== undefined && classifyError(err.code) === 'not-found') {
          budget.notFound = true;
          if (budget.rung < 2) goTo(2, giveUp);
          else giveUp();
        } else escalate();
      } else if (ctl.getState().status.kind !== 'playing') {
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
      stableTimer = clear(stableTimer);
      if (state !== 'playing') return;
      paused = false;
      pausedAt = undefined;
      deferred = false;
      stepTimer = clear(stepTimer);
      rungTimer = clear(rungTimer);
      stallTimer = clear(stallTimer);
      seekDisarmed = false;
      if (!budgetUsed()) return;
      stableTimer = ctl.setTimer(() => {
        stableTimer = undefined;
        budget = freshBudget();
        limit = freshLimit();
      }, config.stableRestoreMs);
    },
    onClock(anchor) {
      if (ctl.getState().status.kind === 'playing' || anchor.rate > 0) {
        resumeFrom = anchor;
        resumeMs = positionAt(anchor, ctl.now());
      }
    },
    onError(error) {
      const kind = classifyError(error.code);
      if (kind === 'terminal') failWith(toPlaybackError(error));
      else if (kind === 'limit') enterLimit();
      else if (paused) {
        budget.lastError = error;
        deferred = true;
      } else if (stepTimer !== undefined || awaitingSurface) budget.lastError = error;
      else if (kind === 'not-found') onNotFound(error);
      else if (error.code === 'surface-lost' && surfaceGone) {
        cancelSteps();
        freeze();
        budget.lastError = error;
        awaitingSurface = true;
      } else if (error.code === 'network' && isVod()) reconnectVod(error);
      else escalate(error);
    },
    onStall(phase) {
      if (phase === 'end') {
        stallTimer = clear(stallTimer);
        return;
      }
      stableTimer = clear(stableTimer);
      const watching = ctl.getState().status.kind === 'playing' && !seekDisarmed && !paused;
      if (!watching || awaitingSurface || stallTimer !== undefined) return;
      stallTimer = ctl.setTimer(() => {
        stallTimer = undefined;
        escalate(undefined, true);
      }, config.liveStallWindowMs);
    },
    onStartTimeout() {
      if (!isVod() && ctl.getState().firstFrameAt === undefined) {
        budget.rung = Math.max(budget.rung, 1);
      }
      escalate(undefined, true);
    },
    onSurface(change) {
      surfaceGone = change === 'destroyed';
      if (surfaceGone || !awaitingSurface) return;
      awaitingSurface = false;
      if (paused) deferred = true;
      else goTo(1);
    },
    onDispose: reset,
  };
}
