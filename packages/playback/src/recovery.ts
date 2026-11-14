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

/** Per-tune trouble counters; 30 s of `playing` restores them. */
interface Budget {
  rung: number;
  lastError: EngineError | undefined;
  notFound: boolean;
  vodStart: number | undefined;
  vodAttempt: number;
}

/** Connection-limit backoff, scoped to one account. */
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
    seekDisarmed = false;
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

  /** Position at the failure, kept until the media sends a newer anchor. */
  const resumePosition = (): number | undefined => {
    const { anchor } = ctl.getState();
    if (anchor === undefined) return ctl.request()?.startMs;
    if (anchor !== resumeFrom) {
      resumeFrom = anchor;
      resumeMs = positionAt(anchor, ctl.now());
    }
    return resumeMs;
  };

  const freeze = (): void => {
    if (isVod()) resumePosition();
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
    if (ms <= 0) {
      step();
      return;
    }
    stepTimer = ctl.setTimer(() => {
      stepTimer = undefined;
      step();
    }, ms);
  };

  const watch = (onTimeout: () => void): void => {
    rungTimer = ctl.setTimer(() => {
      rungTimer = undefined;
      onTimeout();
    }, config.rungTimeoutMs);
  };

  const alternateRung = (): RungAction | undefined => {
    const decoder = budget.lastError?.code === 'decoder';
    if (decoder && !softwareAudio && engine.capabilities.softwareAudioFallback) {
      return () => {
        softwareAudio = true;
        reload();
      };
    }
    const next = ctl.request()?.alternates?.[alternate];
    if (next === undefined) return undefined;
    return () => {
      alternate += 1;
      const at = epoch;
      const settle = (result: Result<StreamRequest> | undefined): void => {
        if (at !== epoch) return;
        if (result?.ok) reload(result.value);
        else giveUp();
      };
      new Promise<Result<StreamRequest>>((resolve) => resolve(next())).then(settle, () =>
        settle(undefined),
      );
    };
  };

  const rungAction = (rung: Rung): RungAction | undefined => {
    switch (rung) {
      case 1:
        return (token) => engine.retry(token);
      case 2:
        return () => reload();
      case 3:
        return (token) => {
          const at = epoch;
          if (engine.capabilities.recreate) engine.recreate(token);
          if (at === epoch) reload();
        };
      case 4:
        return alternateRung();
    }
  };

  const goTo = (rung: Rung): void => {
    const action = rungAction(rung);
    if (action === undefined) {
      giveUp();
      return;
    }
    const gap = config.ladderGapsMs[rung - 1] ?? 0;
    ctl.setStatus({ kind: 'recovering', rung, nextAtMs: ctl.now() + gap });
    after(gap, () => {
      budget.rung = rung;
      const token = ctl.nextAttempt();
      watch(() => escalate());
      action(token);
    });
  };

  function escalate(error?: EngineError): void {
    if (error !== undefined) budget.lastError = error;
    cancelSteps();
    freeze();
    const next = RUNGS[budget.rung];
    if (next === undefined) giveUp();
    else goTo(next);
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
    goTo(2);
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
    budget.vodAttempt += 1;
    ctl.setStatus({ kind: 'recovering', rung: 2, nextAtMs: now + delay });
    after(delay, () => {
      ctl.nextAttempt();
      watch(() => reconnectVod(error));
      reload();
    });
  };

  const endLimitWait = (): void => {
    if (!heldFresh) ctl.nextAttempt();
    heldFresh = false;
    ctl.setStatus({ kind: 'tuning' });
    ctl.armStartTimeout(config.startTimeoutMs);
    reload();
  };

  const enterLimit = (): void => {
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
      endLimitWait();
    }, delay);
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
    onSeek() {
      seekDisarmed = true;
      stallTimer = clear(stallTimer);
    },
    onState(state) {
      if (state === 'ended') {
        reset();
        return;
      }
      stableTimer = clear(stableTimer);
      if (state !== 'playing') return;
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
    onError(error) {
      const kind = classifyError(error.code);
      if (kind === 'terminal') failWith(toPlaybackError(error));
      else if (kind === 'limit') enterLimit();
      else if (stepTimer !== undefined || awaitingSurface) budget.lastError = error;
      else if (kind === 'not-found') onNotFound(error);
      else if (error.code === 'surface-lost' && surfaceGone) {
        cancelSteps();
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
      const watching = ctl.getState().status.kind === 'playing' && !seekDisarmed;
      if (!watching || awaitingSurface || stallTimer !== undefined) return;
      stallTimer = ctl.setTimer(() => {
        stallTimer = undefined;
        escalate();
      }, config.liveStallWindowMs);
    },
    onStartTimeout: () => escalate(),
    onSurface(change) {
      surfaceGone = change === 'destroyed';
      if (surfaceGone || !awaitingSurface) return;
      awaitingSurface = false;
      goTo(1);
    },
    onDispose: reset,
  };
}
