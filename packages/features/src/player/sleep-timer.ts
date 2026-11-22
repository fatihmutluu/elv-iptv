import type { SleepTimerAction } from '@elv/domain';
import type { PlaybackClock, PlaybackTimers } from '@elv/playback';

/** Canonical sleep timer duration presets in minutes (`0` = Off, `#118`). */
export const SLEEP_TIMER_PRESETS_MIN = [0, 15, 30, 45, 60, 90, 120, 180, 360] as const;

/** Immutable snapshot of the active player sleep timer (`#118`). */
export interface SleepTimerSnapshot {
  readonly active: boolean;
  readonly totalMinutes: number;
  readonly remainingMinutes: number;
  readonly remainingMs: number;
  readonly action: SleepTimerAction;
}

/** Controller managing a single player-scoped sleep timer with clean cleanup (`#118`). */
export interface SleepTimerController {
  start(minutes: number, action?: SleepTimerAction): void;
  setAction(action: SleepTimerAction): void;
  cancel(): void;
  getState(): SleepTimerSnapshot;
  dispose(): void;
}

/** Collaborators for {@link createSleepTimerController}. */
export interface SleepTimerControllerDeps {
  readonly clock: PlaybackClock;
  readonly timers: PlaybackTimers;
  readonly initialAction?: SleepTimerAction;
  readonly onExpire: (action: SleepTimerAction) => void;
  readonly onChange?: (snapshot: SleepTimerSnapshot) => void;
}

const TICK_INTERVAL_MS = 30_000;

/**
 * Creates a deterministic player sleep timer controller (`#118`).
 * Schedules exact expiration at `minutes * 60_000 ms` while periodically updating
 * `remainingMinutes` so Settings badges stay fresh without 1Hz wakeups.
 */
export function createSleepTimerController(deps: SleepTimerControllerDeps): SleepTimerController {
  let action: SleepTimerAction = deps.initialAction ?? 'stop';
  let totalMinutes = 0;
  let expiresAtMs: number | null = null;
  let expireHandle: unknown = null;
  let tickHandle: unknown = null;
  let disposed = false;

  const clearTimers = (): void => {
    if (expireHandle !== null) {
      deps.timers.clearTimeout(expireHandle);
      expireHandle = null;
    }
    if (tickHandle !== null) {
      deps.timers.clearTimeout(tickHandle);
      tickHandle = null;
    }
  };

  const buildSnapshot = (): SleepTimerSnapshot => {
    if (expiresAtMs === null) {
      return {
        active: false,
        totalMinutes: 0,
        remainingMinutes: 0,
        remainingMs: 0,
        action,
      };
    }
    const remainingMs = Math.max(0, Math.round(expiresAtMs - deps.clock.now()));
    const remainingMinutes = remainingMs > 0 ? Math.max(1, Math.ceil(remainingMs / 60_000)) : 0;
    return {
      active: true,
      totalMinutes,
      remainingMinutes,
      remainingMs,
      action,
    };
  };

  const emit = (): void => {
    deps.onChange?.(buildSnapshot());
  };

  const scheduleTick = (): void => {
    if (disposed || expiresAtMs === null) return;
    const rem = expiresAtMs - deps.clock.now();
    if (rem <= 0) return;
    const delay = Math.min(TICK_INTERVAL_MS, rem);
    tickHandle = deps.timers.setTimeout(() => {
      tickHandle = null;
      if (disposed || expiresAtMs === null) return;
      emit();
      if (expiresAtMs - deps.clock.now() > 0) scheduleTick();
    }, delay);
  };

  const cancel = (): void => {
    const wasActive = expiresAtMs !== null;
    clearTimers();
    expiresAtMs = null;
    totalMinutes = 0;
    if (wasActive && !disposed) emit();
  };

  return {
    start(minutes: number, nextAction?: SleepTimerAction): void {
      if (disposed) return;
      if (nextAction !== undefined) action = nextAction;
      clearTimers();
      if (!Number.isFinite(minutes) || minutes <= 0) {
        expiresAtMs = null;
        totalMinutes = 0;
        emit();
        return;
      }
      const roundedMin = Math.round(minutes);
      const durationMs = roundedMin * 60_000;
      totalMinutes = roundedMin;
      expiresAtMs = deps.clock.now() + durationMs;
      expireHandle = deps.timers.setTimeout(() => {
        expireHandle = null;
        clearTimers();
        expiresAtMs = null;
        totalMinutes = 0;
        if (disposed) return;
        const firedAction = action;
        emit();
        deps.onExpire(firedAction);
      }, durationMs);
      scheduleTick();
      emit();
    },

    setAction(nextAction: SleepTimerAction): void {
      if (disposed || action === nextAction) return;
      action = nextAction;
      emit();
    },

    cancel,
    getState: buildSnapshot,

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimers();
      expiresAtMs = null;
      totalMinutes = 0;
    },
  };
}
