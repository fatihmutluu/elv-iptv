import { type ElvError, elvError, normalizeStreamUrl, type Result } from '@elv/domain';
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
import type { AttemptToken, EngineError, LoadOptions, StreamRequest } from './engine';
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
  const usedInlineIndices = new Set<number>();
  let inlineAlternates: readonly StreamRequest[] | undefined;
  let primaryCaptured = false;
  let softwareAudio = false;
  let heldFresh = false;
  let containerFallbackTried = false;
  let pendingFormat: LiveContainerFormat | undefined;
  const failedCanonicalUrls = new Set<string>();

  const inBatch = <T>(fn: () => T): T => (ctl.batch !== undefined ? ctl.batch(fn) : fn());
  const isVod = (): boolean => ctl.request()?.kind === 'vod';
  const clear = (h: unknown): undefined => {
    if (h !== undefined) ctl.clearTimer(h);
    return undefined;
  };

  const canonicalKey = (url: string | undefined): string | undefined => {
    const trimmed = url?.trim();
    return trimmed ? normalizeStreamUrl(trimmed) : undefined;
  };

  const recordFailedUrl = (url: string | undefined): void => {
    const key = canonicalKey(url);
    if (key !== undefined) failedCanonicalUrls.add(key);
  };

  const recordCurrentFailure = (error?: EngineError): void => {
    const current = ctl.stream?.();
    if (!primaryCaptured && current !== undefined) {
      primaryCaptured = true;
      inlineAlternates = current.alternates;
    }
    recordFailedUrl(current?.url);
    recordFailedUrl(current?.finalUrl);
    recordFailedUrl(error?.finalUrl);
  };

  const isFailedCanonical = (s: StreamRequest): boolean => {
    const u = canonicalKey(s.url);
    const f = canonicalKey(s.finalUrl);
    return (
      (u !== undefined && failedCanonicalUrls.has(u)) ||
      (f !== undefined && failedCanonicalUrls.has(f))
    );
  };

  const canUseAlternate = (candidate: StreamRequest): boolean => {
    if (isFailedCanonical(candidate)) return false;
    const candidateAcc = candidate.accountKey;
    const activeAcc = ctl.stream?.()?.accountKey ?? ctl.request()?.accountKey;
    if (
      candidateAcc !== undefined &&
      candidateAcc !== activeAcc &&
      ctl.canAcquireAlternate !== undefined
    ) {
      return ctl.canAcquireAlternate(candidateAcc, candidate.maxConnections ?? 1);
    }
    return true;
  };

  const eligibleInlineAlternates = (): {
    readonly index: number;
    readonly stream: StreamRequest;
  }[] => {
    if (inlineAlternates === undefined) return [];
    const remaining: { readonly index: number; readonly stream: StreamRequest }[] = [];
    for (let i = 0; i < inlineAlternates.length; i += 1) {
      if (usedInlineIndices.has(i)) continue;
      const candidate = inlineAlternates[i];
      if (candidate !== undefined && canUseAlternate(candidate)) {
        remaining.push({ index: i, stream: candidate });
      }
    }
    if (remaining.length <= 1 || ctl.healthScorer === undefined) return remaining;
    return ctl.healthScorer.rankAlternates(
      remaining,
      (entry) => entry.stream.finalUrl ?? entry.stream.url,
      ctl.now(),
    );
  };

  const hasMoreAlternates = (): boolean =>
    alternate < (ctl.request()?.alternates?.length ?? 0) || eligibleInlineAlternates().length > 0;

  const failWith = (error: ElvError): void => {
    deps.onResetAll();
    ctl.fail(error);
  };
  const giveUp = (): void => failWith(toPlaybackError(budget.lastError ?? STALLED));
  const freeze = (): void => positions.freeze(isVod());

  const reload = (stream?: StreamRequest): boolean => {
    const startMs = isVod() ? positions.resumePosition() : undefined;
    const bufferPreset = ctl.request()?.bufferPreset;
    const preferHevcFallback =
      softwareAudio || (budget.lastError?.code === 'decoder' && budget.rung >= 2);
    const options: LoadOptions = {
      ...(bufferPreset === undefined ? {} : { bufferPreset }),
      ...(softwareAudio ? { softwareAudio: true } : {}),
      ...(preferHevcFallback ? { preferHevcOverDolbyVision: true } : {}),
    };
    return ctl.load({
      ...(stream === undefined ? {} : { stream }),
      ...(startMs === undefined ? {} : { startMs }),
      ...(Object.keys(options).length > 0 ? { options } : {}),
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

  const nextContainerFallback = ():
    | { stream: StreamRequest; format: LiveContainerFormat }
    | undefined => {
    if (!canTryContainerFallback()) return undefined;
    const currentStream = ctl.stream?.();
    if (currentStream === undefined) return undefined;
    const swapped = swapLiveContainerUrl(currentStream.url);
    if (swapped === undefined) return undefined;
    const { alternates: _alts, finalUrl: _final, ...rest } = currentStream;
    const candidate: StreamRequest = { ...rest, url: swapped.url };
    if (isFailedCanonical(candidate)) return undefined;
    return { stream: candidate, format: swapped.format };
  };

  const tryContainerFallbackNow = (): boolean => {
    const fallback = nextContainerFallback();
    if (fallback === undefined) return false;
    budget.rung = 4;
    containerFallbackTried = true;
    pendingFormat = fallback.format;
    const acc = ctl.request()?.accountKey;
    if (acc !== undefined) ctl.formatCache?.evict(acc);
    reload(fallback.stream);
    return true;
  };

  const advanceAlternates = (at: number, resetTransientRetries = false): void => {
    const reqAlts = ctl.request()?.alternates;
    if (reqAlts !== undefined && alternate < reqAlts.length) {
      const next = reqAlts[alternate] as () => Promise<Result<StreamRequest>>;
      const settle = (result: Result<StreamRequest> | undefined): void => {
        if (at !== epoch) return;
        alternate += 1;
        if (result?.ok && canUseAlternate(result.value)) {
          if (!resetTransientRetries) budget.rung = 4;
          reload(result.value);
        } else {
          advanceAlternates(at, resetTransientRetries);
        }
      };
      new Promise<Result<StreamRequest>>((resolve) => resolve(next())).then(settle, () =>
        settle(undefined),
      );
      return;
    }
    const nextInline = eligibleInlineAlternates()[0];
    if (nextInline !== undefined) {
      usedInlineIndices.add(nextInline.index);
      if (!resetTransientRetries) budget.rung = 4;
      reload(nextInline.stream);
      return;
    }
    budget.rung = 4;
    if (!tryContainerFallbackNow()) giveUp();
  };

  const hasEligibleRollingAlternate = (): boolean =>
    alternate < (ctl.request()?.alternates?.length ?? 0) || eligibleInlineAlternates().length > 0;

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
        if (budget.lastError?.code === 'decoder') {
          ctl.bumpSurfaceRecreationToken?.();
        }
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
    if (hasMoreAlternates()) {
      return () => {
        ctl.stopMedia();
        advanceAlternates(epoch);
      };
    }
    if (nextContainerFallback() !== undefined) {
      return () => {
        if (!tryContainerFallbackNow()) giveUp();
      };
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
    recordCurrentFailure(error);
    deps.cancelAll();
    freeze();
    const next =
      budget.rung === 4
        ? !softwareAudio && (hasMoreAlternates() || nextContainerFallback() !== undefined)
          ? 4
          : undefined
        : RUNGS[budget.rung];
    if (next === undefined) giveUp();
    else goTo(next, onSilentTimeout, silent);
  }

  function onNotFound(error: EngineError): void {
    budget.lastError = error;
    recordCurrentFailure(error);
    if (budget.notFound || budget.rung >= 2) {
      if (nextContainerFallback() !== undefined) {
        deps.cancelAll();
        freeze();
        goTo(4, giveUp, true);
        return;
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

  function escalateRollingRebuffer(): boolean {
    const current = ctl.stream?.();
    if (!primaryCaptured && current !== undefined) {
      primaryCaptured = true;
      inlineAlternates = current.alternates;
    }
    recordCurrentFailure(STALLED);
    if (!hasEligibleRollingAlternate()) return false;
    deps.cancelAll();
    freeze();
    budget = freshBudget();
    budget.lastError = STALLED;
    inBatch(() => {
      ctl.setStatus({ kind: 'recovering', rung: 4, nextAtMs: ctl.now() });
      ctl.nextAttempt();
      watch(onSilentTimeout);
      ctl.stopMedia();
      advanceAlternates(epoch, true);
    });
    return true;
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
      usedInlineIndices.clear();
      inlineAlternates = undefined;
      primaryCaptured = false;
      softwareAudio = false;
      containerFallbackTried = false;
      pendingFormat = undefined;
      failedCanonicalUrls.clear();
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
    escalateRollingRebuffer,
    onNotFound,
    reconnectVod,
    enterLimit,
  };
}
