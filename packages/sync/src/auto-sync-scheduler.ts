/** Default debounce delay (ms) after local vault mutations before pushing (`#510`). */
export const DEFAULT_MUTATION_DEBOUNCE_MS = 3_000;

/** Default debounce delay (ms) after playback pause before pushing (`#510`). */
export const DEFAULT_PAUSE_DEBOUNCE_MS = 2_000;

/** Default periodic viewing heartbeat interval (ms, 3 minutes) while playback is active (`#510`). */
export const DEFAULT_VIEWING_HEARTBEAT_MS = 180_000;

/** Default minimum background away duration (ms, 60 seconds) required to trigger a foreground pull. */
export const DEFAULT_FOREGROUND_MIN_AWAY_MS = 60_000;

/** Default maximum wait (ms) for bounded background / quit flush (`#510`). */
export const DEFAULT_BACKGROUND_FLUSH_TIMEOUT_MS = 5_000;

/** Default exponential backoff retry schedule (ms): 5s -> 15s -> 45s -> 120s (capped). */
export const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [5_000, 15_000, 45_000, 120_000];

/** Accepted return values from `syncPush` / `syncPull` callbacks. */
export type AutoSyncResultLike = undefined | boolean | { readonly ok: boolean };

/** Async callback invoked by {@link AutoSyncScheduler} to push or pull encrypted vault state. */
export type AutoSyncCallback = () => Promise<void> | Promise<AutoSyncResultLike>;

/** High-level scheduler status surfaced to Account UI sync badges. */
export type AutoSyncState = 'idle' | 'syncing' | 'pending' | 'error';

/** Observable snapshot of {@link AutoSyncScheduler} state. */
export interface AutoSyncStatus {
  readonly state: AutoSyncState;
  readonly dirty: boolean;
  readonly inFlight: boolean;
  readonly consecutiveFailures: number;
  readonly lastSyncedAt: number | null;
  readonly lastErrorAt: number | null;
}

/** Injectable timer handle type compatible with browser, Node, and Hermes. */
export type SchedulerTimerHandle = ReturnType<typeof setTimeout>;

/** Options for {@link createAutoSyncScheduler}. */
export interface AutoSyncSchedulerOptions {
  readonly syncPush: AutoSyncCallback;
  readonly syncPull: AutoSyncCallback;
  readonly isSignedIn: () => boolean;
  readonly now?: () => number;
  readonly mutationDebounceMs?: number;
  readonly pauseDebounceMs?: number;
  readonly viewingHeartbeatMs?: number;
  readonly foregroundMinAwayMs?: number;
  readonly retryBackoffMs?: readonly number[];
  readonly setTimeoutFn?: (fn: () => void, ms: number) => SchedulerTimerHandle;
  readonly clearTimeoutFn?: (handle: SchedulerTimerHandle) => void;
  readonly setIntervalFn?: (fn: () => void, ms: number) => SchedulerTimerHandle;
  readonly clearIntervalFn?: (handle: SchedulerTimerHandle) => void;
}

/** Platform-agnostic automatic background E2EE sync scheduler (`#510`). */
export interface AutoSyncScheduler {
  /** Marks local vault state dirty without scheduling an immediate debounce push (flushed by heartbeat/exit). */
  markDirty(): void;
  /** Records a user mutation and schedules a 3s debounced push. */
  notifyMutation(): void;
  /** Records playback pause and schedules a 2s debounced push. */
  notifyPlaybackPause(): void;
  /** Records playback exit, completion, or channel switch; cancels pending timers and pushes immediately. */
  notifyPlaybackExitOrSwitch(): void;
  /** Enables or disables the 3-minute periodic viewing heartbeat push while dirty. */
  setViewingActive(active: boolean): void;
  /** Triggers an immediate startup pull when signed in. */
  notifyStartup(): void;
  /** Triggers a pull when returning to foreground after `awayMs >= 60_000`. */
  notifyForeground(awayMs: number): void;
  /** Resets backoff and triggers a pull plus dirty push flush on network reconnect. */
  notifyReconnect(): void;
  /** Performs a bounded immediate push if dirty (never hangs past `timeoutMs`). */
  flushBeforeBackground(timeoutMs?: number): Promise<void>;
  /** Returns current immutable scheduler status. */
  getStatus(): AutoSyncStatus;
  /** Subscribes to status transitions; returns an unsubscribe callback. */
  subscribe(listener: (status: AutoSyncStatus) => void): () => void;
  /** Cancels all pending timers, clears dirty/retry/viewing state, and returns to `'idle'` without disposing. */
  reset(): void;
  /** Clears all timers and permanently stops scheduling further work. */
  dispose(): void;
}

function isResultSuccess(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'object' && value !== null && 'ok' in value) {
    return (value as { readonly ok: unknown }).ok === true;
  }
  return true;
}

/**
 * Creates a platform-agnostic automatic E2EE sync scheduler with single-flight execution,
 * mutation/pause debouncing, viewing heartbeat, foreground/reconnect pulls, bounded background
 * flush, and capped exponential backoff retry (`#510`).
 */
export function createAutoSyncScheduler(options: AutoSyncSchedulerOptions): AutoSyncScheduler {
  const nowFn = options.now ?? (() => Date.now());
  const mutationDebounceMs = Math.max(
    0,
    options.mutationDebounceMs ?? DEFAULT_MUTATION_DEBOUNCE_MS,
  );
  const pauseDebounceMs = Math.max(0, options.pauseDebounceMs ?? DEFAULT_PAUSE_DEBOUNCE_MS);
  const viewingHeartbeatMs = Math.max(
    1_000,
    options.viewingHeartbeatMs ?? DEFAULT_VIEWING_HEARTBEAT_MS,
  );
  const foregroundMinAwayMs = Math.max(
    0,
    options.foregroundMinAwayMs ?? DEFAULT_FOREGROUND_MIN_AWAY_MS,
  );
  const retryBackoffMs =
    options.retryBackoffMs !== undefined && options.retryBackoffMs.length > 0
      ? options.retryBackoffMs
      : DEFAULT_RETRY_BACKOFF_MS;

  const setTimer =
    options.setTimeoutFn ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearTimer =
    options.clearTimeoutFn ??
    ((handle: SchedulerTimerHandle) => {
      globalThis.clearTimeout(handle);
    });
  const setPeriodic =
    options.setIntervalFn ?? ((fn: () => void, ms: number) => globalThis.setInterval(fn, ms));
  const clearPeriodic =
    options.clearIntervalFn ??
    ((handle: SchedulerTimerHandle) => {
      globalThis.clearInterval(handle);
    });

  let disposed = false;
  let dirty = false;
  let mutationSeq = 0;
  let inFlightPushSeq = 0;
  let resetEpoch = 0;
  let pendingPull = false;
  let pendingPush = false;
  let inFlight = false;
  let consecutiveFailures = 0;
  let lastSyncedAt: number | null = null;
  let lastErrorAt: number | null = null;

  let mutationTimer: SchedulerTimerHandle | undefined;
  let pauseTimer: SchedulerTimerHandle | undefined;
  let retryTimer: SchedulerTimerHandle | undefined;
  let heartbeatTimer: SchedulerTimerHandle | undefined;
  let drainPromise: Promise<void> | null = null;
  const activeFlushTimers = new Set<SchedulerTimerHandle>();
  const listeners = new Set<(status: AutoSyncStatus) => void>();

  const computeStatus = (): AutoSyncStatus => {
    const state: AutoSyncState = inFlight
      ? 'syncing'
      : consecutiveFailures > 0
        ? 'error'
        : dirty || pendingPush || pendingPull
          ? 'pending'
          : 'idle';
    return Object.freeze({
      state,
      dirty,
      inFlight,
      consecutiveFailures,
      lastSyncedAt,
      lastErrorAt,
    });
  };

  let lastStatus: AutoSyncStatus = computeStatus();

  const emitStatus = (): void => {
    const next = computeStatus();
    if (
      next.state === lastStatus.state &&
      next.dirty === lastStatus.dirty &&
      next.inFlight === lastStatus.inFlight &&
      next.consecutiveFailures === lastStatus.consecutiveFailures &&
      next.lastSyncedAt === lastStatus.lastSyncedAt &&
      next.lastErrorAt === lastStatus.lastErrorAt
    ) {
      return;
    }
    lastStatus = next;
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener(next);
      } catch {
        // Isolate subscriber exceptions so scheduler loop never breaks.
      }
    }
  };

  const clearMutationTimer = (): void => {
    if (mutationTimer !== undefined) {
      clearTimer(mutationTimer);
      mutationTimer = undefined;
    }
  };

  const clearPauseTimer = (): void => {
    if (pauseTimer !== undefined) {
      clearTimer(pauseTimer);
      pauseTimer = undefined;
    }
  };

  const clearRetryTimer = (): void => {
    if (retryTimer !== undefined) {
      clearTimer(retryTimer);
      retryTimer = undefined;
    }
  };

  const clearHeartbeatTimer = (): void => {
    if (heartbeatTimer !== undefined) {
      clearPeriodic(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };

  const scheduleRetry = (kind: 'pull' | 'push'): void => {
    if (disposed || !options.isSignedIn()) return;
    consecutiveFailures += 1;
    lastErrorAt = nowFn();
    const idx = Math.min(consecutiveFailures - 1, retryBackoffMs.length - 1);
    const delayMs = Math.max(0, retryBackoffMs[idx] ?? 120_000);
    clearRetryTimer();
    retryTimer = setTimer(() => {
      retryTimer = undefined;
      if (disposed || !options.isSignedIn()) return;
      if (kind === 'pull') pendingPull = true;
      else pendingPush = true;
      kickDrain();
    }, delayMs);
    emitStatus();
  };

  const runLoop = async (): Promise<void> => {
    const loopEpoch = resetEpoch;
    inFlight = true;
    emitStatus();
    try {
      while (!disposed && loopEpoch === resetEpoch) {
        if (!options.isSignedIn()) {
          pendingPull = false;
          pendingPush = false;
          clearRetryTimer();
          break;
        }
        if (pendingPull) {
          pendingPull = false;
          let ok = false;
          try {
            ok = isResultSuccess(await options.syncPull());
          } catch {
            ok = false;
          }
          if (disposed || loopEpoch !== resetEpoch) break;
          if (ok) {
            consecutiveFailures = 0;
            clearRetryTimer();
            lastSyncedAt = nowFn();
            emitStatus();
          } else {
            scheduleRetry('pull');
            break;
          }
          continue;
        }
        if (pendingPush) {
          pendingPush = false;
          const seqAtStart = mutationSeq;
          inFlightPushSeq = seqAtStart;
          let ok = false;
          try {
            ok = isResultSuccess(await options.syncPush());
          } catch {
            ok = false;
          } finally {
            if (loopEpoch === resetEpoch) {
              inFlightPushSeq = 0;
            }
          }
          if (disposed || loopEpoch !== resetEpoch) break;
          if (ok) {
            consecutiveFailures = 0;
            clearRetryTimer();
            lastSyncedAt = nowFn();
            if (mutationSeq === seqAtStart) {
              dirty = false;
            } else {
              pendingPush = true;
            }
            emitStatus();
          } else {
            dirty = true;
            scheduleRetry('push');
            break;
          }
          continue;
        }
        break;
      }
    } finally {
      if (loopEpoch === resetEpoch) {
        inFlight = false;
        inFlightPushSeq = 0;
        drainPromise = null;
        emitStatus();
        if (
          !disposed &&
          options.isSignedIn() &&
          (pendingPull || pendingPush) &&
          retryTimer === undefined
        ) {
          kickDrain();
        }
      }
    }
  };

  const kickDrain = (): Promise<void> => {
    if (disposed || !options.isSignedIn()) return Promise.resolve();
    if (drainPromise === null) {
      drainPromise = runLoop();
    }
    return drainPromise;
  };

  const triggerImmediatePush = (): Promise<void> => {
    clearMutationTimer();
    clearPauseTimer();
    if (disposed || !options.isSignedIn()) return Promise.resolve();
    pendingPush = true;
    emitStatus();
    return kickDrain();
  };

  return {
    markDirty(): void {
      if (disposed) return;
      dirty = true;
      mutationSeq += 1;
      emitStatus();
    },

    notifyMutation(): void {
      if (disposed) return;
      dirty = true;
      mutationSeq += 1;
      emitStatus();
      if (!options.isSignedIn()) return;
      clearMutationTimer();
      mutationTimer = setTimer(() => {
        mutationTimer = undefined;
        void triggerImmediatePush();
      }, mutationDebounceMs);
    },

    notifyPlaybackPause(): void {
      if (disposed) return;
      dirty = true;
      mutationSeq += 1;
      emitStatus();
      if (!options.isSignedIn()) return;
      clearPauseTimer();
      pauseTimer = setTimer(() => {
        pauseTimer = undefined;
        void triggerImmediatePush();
      }, pauseDebounceMs);
    },

    notifyPlaybackExitOrSwitch(): void {
      if (disposed) return;
      dirty = true;
      mutationSeq += 1;
      void triggerImmediatePush();
    },

    setViewingActive(active: boolean): void {
      if (disposed) return;
      if (!active) {
        clearHeartbeatTimer();
        return;
      }
      if (heartbeatTimer !== undefined) return;
      heartbeatTimer = setPeriodic(() => {
        if (disposed || !dirty || !options.isSignedIn()) return;
        void triggerImmediatePush();
      }, viewingHeartbeatMs);
    },

    notifyStartup(): void {
      if (disposed || !options.isSignedIn()) return;
      pendingPull = true;
      emitStatus();
      void kickDrain();
    },

    notifyForeground(awayMs: number): void {
      if (disposed || !options.isSignedIn()) return;
      if (!Number.isFinite(awayMs) || awayMs < foregroundMinAwayMs) return;
      pendingPull = true;
      emitStatus();
      void kickDrain();
    },

    notifyReconnect(): void {
      if (disposed || !options.isSignedIn()) return;
      consecutiveFailures = 0;
      clearRetryTimer();
      clearMutationTimer();
      clearPauseTimer();
      pendingPull = true;
      if (dirty) pendingPush = true;
      emitStatus();
      void kickDrain();
    },

    async flushBeforeBackground(timeoutMs = DEFAULT_BACKGROUND_FLUSH_TIMEOUT_MS): Promise<void> {
      clearMutationTimer();
      clearPauseTimer();
      if (disposed || !dirty || !options.isSignedIn()) return;
      const boundedMs = Math.max(
        0,
        Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_BACKGROUND_FLUSH_TIMEOUT_MS,
      );
      let pushRun: Promise<void>;
      if (inFlightPushSeq < mutationSeq) {
        pendingPush = true;
        emitStatus();
        pushRun = kickDrain();
      } else {
        pushRun = drainPromise ?? Promise.resolve();
      }
      if (boundedMs === 0) return;

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimer(handle);
          activeFlushTimers.delete(handle);
          resolve();
        };
        const handle = setTimer(finish, boundedMs);
        activeFlushTimers.add(handle);
        void pushRun.then(finish, finish);
      });
    },

    getStatus(): AutoSyncStatus {
      return lastStatus;
    },

    subscribe(listener: (status: AutoSyncStatus) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    reset(): void {
      if (disposed) return;
      resetEpoch += 1;
      dirty = false;
      pendingPull = false;
      pendingPush = false;
      inFlight = false;
      inFlightPushSeq = 0;
      consecutiveFailures = 0;
      lastSyncedAt = null;
      lastErrorAt = null;
      drainPromise = null;
      clearMutationTimer();
      clearPauseTimer();
      clearRetryTimer();
      clearHeartbeatTimer();
      emitStatus();
    },

    dispose(): void {
      disposed = true;
      pendingPull = false;
      pendingPush = false;
      clearMutationTimer();
      clearPauseTimer();
      clearRetryTimer();
      clearHeartbeatTimer();
      for (const handle of activeFlushTimers) {
        clearTimer(handle);
      }
      activeFlushTimers.clear();
      listeners.clear();
    },
  };
}
