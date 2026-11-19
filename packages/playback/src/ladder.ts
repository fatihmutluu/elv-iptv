import { type ElvError, elvError, type Result } from '@elv/domain';
import {
  type Budget,
  backoff,
  freshBudget,
  freshLimit,
  type Limit,
  nextLimitDelay,
  type PositionTracker,
  swapLiveContainerUrl,
} from './backoff';
import type { AttemptToken, EngineError, StreamRequest } from './engine';
import { classifyError, toPlaybackError } from './errors';
import type { LiveContainerFormat, ServiceControl } from './seam';

type Rung = 1 | 2 | 3 | 4;
type RungAction = (token: AttemptToken) => void;

const RUNGS: readonly Rung[] = [1, 2, 3, 4];
export const STALLED: EngineError = { code: 'network' };

interface LadderRunnerDeps {
  readonly ctl: ServiceControl;
  readonly positions: PositionTracker;
  cancelAll(): void;
  onResetAll(): void;
}

/** @internal Stateful recovery ladder, VOD reconnect, and connection-limit runner. */
export function createLadderRunner(deps: LadderRunnerDeps) {
  const { ctl, positions } = deps;
  const { config, engine } = ctl;
  let stepTimer: unknown;
  let rungTimer: unknown;
  let limitTimer: unknown;
  let epoch = 0;
  let budget: Budget = freshBudget();
  let limit: Limit = freshLimit();
  let alternate = 0;
  let softwareAudio = false;
  let heldFresh = false;
  let containerFallbackTried = false;
  let pendingFormat: LiveContainerFormat | undefined;

  const inBatch = <T>(fn: () => T): T => (ctl.batch !== undefined ? ctl.batch(fn) : fn());
  const isVod = (): boolean => ctl.request()?.kind === 'vod';
  const clear = (h: unknown): undefined => {
    if (h !== undefined) ctl.clearTimer(h);
    return undefined;
  };

  const failWith = (error: ElvError): void => {
    deps.onResetAll();
    ctl.fail(error);
  };
  const giveUp = (): void => failWith(toPlaybackError(budget.lastError ?? STALLED));
  const freeze = (): void => positions.freeze(isVod());

  const reload = (stream?: StreamRequest): boolean => {
    const startMs = isVod() ? positions.resumePosition() : undefined;
    return ctl.load({
      ...(stream === undefined ? {} : { stream }),
      ...(startMs === undefined ? {} : { startMs }),
      ...(softwareAudio ? { options: { softwareAudio: true } } : {}),
    });
  };

  const canTryContainerFallback = (): boolean => {
    if (isVod() || containerFallbackTried || ctl.getState().firstFrameAt !== undefined) {
      return false;
    }
    const err = budget.lastError;
    if (err === undefined) return false;
    return err.code === 'network' || classifyError(err.code, err.httpStatus) === 'not-found';
  };

  const buildAction = (rung: Rung): RungAction | undefined => {
    if (rung === 1) {
      return (token) => {
        budget.rung = 1;
        engine.retry(token);
      };
    }
    if (rung === 2) {
      return () => {
        budget.rung = 2;
        reload();
      };
    }
    if (rung === 3) {
      return (token) => {
        budget.rung = 3;
        const at = epoch;
        if (engine.capabilities.recreate) engine.recreate(token);
        if (at === epoch) reload();
      };
    }
    if (
      budget.lastError?.code === 'decoder' &&
      !softwareAudio &&
      engine.capabilities.softwareAudioFallback
    ) {
      return () => {
        budget.rung = 4;
        softwareAudio = true;
        reload();
      };
    }
    const next = ctl.request()?.alternates?.[alternate];
    if (next !== undefined) {
      return () => {
        ctl.stopMedia();
        const at = epoch;
        const settle = (result: Result<StreamRequest> | undefined): void => {
          if (at !== epoch) return;
          budget.rung = 4;
          alternate += 1;
          if (result?.ok) reload(result.value);
          else giveUp();
        };
        new Promise<Result<StreamRequest>>((resolve) => resolve(next())).then(settle, () =>
          settle(undefined),
        );
      };
    }
    if (canTryContainerFallback()) {
      const currentStream = ctl.stream?.();
      const swapped =
        currentStream === undefined ? undefined : swapLiveContainerUrl(currentStream.url);
      if (swapped !== undefined && currentStream !== undefined) {
        return () => {
          budget.rung = 4;
          containerFallbackTried = true;
          pendingFormat = swapped.format;
          const acc = ctl.request()?.accountKey;
          if (acc !== undefined) ctl.formatCache?.evict(acc);
          reload({ ...currentStream, url: swapped.url });
        };
      }
    }
    return undefined;
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

  const onSilentTimeout = (): void => escalate(undefined, true);

  function goTo(rung: Rung, onTimeout: () => void = onSilentTimeout, silent = false): void {
    const action = buildAction(rung);
    if (action === undefined) {
      giveUp();
      return;
    }
    const gap = silent ? 0 : (config.ladderGapsMs[rung - 1] ?? 0);
    inBatch(() => {
      ctl.setStatus({ kind: 'recovering', rung, nextAtMs: ctl.now() + gap });
      after(gap, () => {
        inBatch(() => {
          const token = ctl.nextAttempt();
          watch(onTimeout);
          action(token);
        });
      });
    });
  }

  function escalate(error?: EngineError, silent = false): void {
    if (error !== undefined) budget.lastError = error;
    deps.cancelAll();
    freeze();
    const next = RUNGS[budget.rung];
    if (next === undefined) giveUp();
    else goTo(next, onSilentTimeout, silent);
  }

  function onNotFound(error: EngineError): void {
    budget.lastError = error;
    if (budget.notFound || budget.rung >= 2) {
      if (canTryContainerFallback()) {
        const currentStream = ctl.stream?.();
        if (currentStream !== undefined && swapLiveContainerUrl(currentStream.url) !== undefined) {
          deps.cancelAll();
          freeze();
          goTo(4, giveUp, true);
          return;
        }
      }
      failWith(toPlaybackError(error));
      return;
    }
    budget.notFound = true;
    deps.cancelAll();
    freeze();
    goTo(2, () => onNotFound(error));
  }

  function reconnectVod(error: EngineError): void {
    budget.lastError = error;
    deps.cancelAll();
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
      inBatch(() => {
        budget.vodAttempt += 1;
        ctl.nextAttempt();
        watch(() => reconnectVod(error));
        reload();
      });
    });
  }

  function enterLimit(): void {
    deps.cancelAll();
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
      inBatch(() => {
        if (!heldFresh) ctl.nextAttempt();
        heldFresh = false;
        ctl.setStatus({ kind: 'tuning' });
        if (ctl.stream?.() !== undefined) ctl.armStartTimeout(ctl.startTimeoutMs());
        reload();
      });
    }, delay);
  }

  return {
    getBudget: () => budget,
    getLimit: () => limit,
    hasPendingRung: () => stepTimer !== undefined || rungTimer !== undefined,
    hasStepTimer: () => stepTimer !== undefined,
    isHoldingAccount: (accountKey: string) =>
      limitTimer !== undefined && accountKey === limit.account,
    markHeldTune: () => {
      heldFresh = true;
    },
    clearTimers() {
      epoch += 1;
      stepTimer = clear(stepTimer);
      rungTimer = clear(rungTimer);
      limitTimer = clear(limitTimer);
    },
    clearStepAndRung() {
      stepTimer = clear(stepTimer);
      rungTimer = clear(rungTimer);
    },
    resetItem() {
      budget = freshBudget();
      alternate = 0;
      softwareAudio = false;
      containerFallbackTried = false;
      pendingFormat = undefined;
    },
    resetLimit() {
      limit = freshLimit();
      heldFresh = false;
    },
    resetBudgetAndLimit() {
      budget = freshBudget();
      limit = freshLimit();
    },
    commitPendingFormat() {
      if (pendingFormat !== undefined) {
        const acc = ctl.request()?.accountKey;
        if (acc !== undefined) ctl.formatCache?.set(acc, pendingFormat);
        pendingFormat = undefined;
      }
    },
    watchRung4() {
      ctl.setStatus({ kind: 'recovering', rung: 4, nextAtMs: ctl.now() });
      watch(onSilentTimeout);
    },
    reload,
    failWith,
    goTo,
    escalate,
    onNotFound,
    reconnectVod,
    enterLimit,
  };
}
