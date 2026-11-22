import type { PlaybackClock, PlaybackTimers } from '@elv/playback';

/** Wake-click suppression duration (ms) after dismissing the OLED screensaver (`#160`). */
export const OLED_WAKE_SUPPRESS_MS = 260;

/** Interval (ms) between anti-burn-in coordinate shifts while the OLED screensaver is active (`#160`). */
export const OLED_DRIFT_INTERVAL_MS = 60_000;

/** Deterministic safe-zone drift waypoints (percentage offsets) avoiding edge burn-in. */
export const OLED_DRIFT_WAYPOINTS: ReadonlyArray<{ readonly xPct: number; readonly yPct: number }> =
  [
    { xPct: 50, yPct: 45 },
    { xPct: 24, yPct: 26 },
    { xPct: 74, yPct: 68 },
    { xPct: 28, yPct: 70 },
    { xPct: 72, yPct: 28 },
    { xPct: 50, yPct: 72 },
    { xPct: 24, yPct: 48 },
    { xPct: 76, yPct: 48 },
  ];

/** Immutable snapshot of the OLED screensaver state (`#160`). */
export interface OledScreensaverSnapshot {
  readonly active: boolean;
  readonly wakeSuppressed: boolean;
  readonly driftIndex: number;
  readonly xPct: number;
  readonly yPct: number;
}

/** Pure controller driving idle detection, OLED pixel drift, and wake-click suppression (`#160`). */
export interface OledScreensaverController {
  setConfig(config: { readonly timeoutMin: number; readonly isBlocked: boolean }): void;
  /**
   * Records user activity (key, pointer, touch).
   * Returns `true` when the event woke the screensaver and MUST be consumed (never activating underlying UI).
   */
  recordActivity(): boolean;
  isWakeSuppressed(): boolean;
  getState(): OledScreensaverSnapshot;
  dispose(): void;
}

/** Collaborators for {@link createOledScreensaverController}. */
export interface OledScreensaverControllerDeps {
  readonly clock: PlaybackClock;
  readonly timers: PlaybackTimers;
  readonly wakeSuppressMs?: number;
  readonly driftIntervalMs?: number;
  readonly onChange?: (snapshot: OledScreensaverSnapshot) => void;
}

/**
 * Creates a deterministic OLED screensaver controller (`#160`).
 * Never activates when `timeoutMin <= 0` or `isBlocked === true` (e.g. active playback).
 */
export function createOledScreensaverController(
  deps: OledScreensaverControllerDeps,
): OledScreensaverController {
  const wakeSuppressMs = Math.max(0, Math.round(deps.wakeSuppressMs ?? OLED_WAKE_SUPPRESS_MS));
  const driftIntervalMs = Math.max(
    1_000,
    Math.round(deps.driftIntervalMs ?? OLED_DRIFT_INTERVAL_MS),
  );

  let timeoutMin = 0;
  let isBlocked = false;
  let active = false;
  let wakeSuppressed = false;
  let wakeSuppressUntilMs = 0;
  let driftIndex = 0;
  let idleTimer: unknown = null;
  let driftTimer: unknown = null;
  let wakeTimer: unknown = null;
  let disposed = false;

  const clearIdle = (): void => {
    if (idleTimer !== null) {
      deps.timers.clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const clearDrift = (): void => {
    if (driftTimer !== null) {
      deps.timers.clearTimeout(driftTimer);
      driftTimer = null;
    }
  };
  const clearWake = (): void => {
    if (wakeTimer !== null) {
      deps.timers.clearTimeout(wakeTimer);
      wakeTimer = null;
    }
  };

  const snapshot = (): OledScreensaverSnapshot => {
    const wp = OLED_DRIFT_WAYPOINTS[driftIndex % OLED_DRIFT_WAYPOINTS.length] ?? {
      xPct: 50,
      yPct: 45,
    };
    return {
      active,
      wakeSuppressed,
      driftIndex,
      xPct: wp.xPct,
      yPct: wp.yPct,
    };
  };

  const emit = (): void => {
    deps.onChange?.(snapshot());
  };

  const scheduleDrift = (): void => {
    clearDrift();
    if (disposed || !active) return;
    driftTimer = deps.timers.setTimeout(() => {
      driftTimer = null;
      if (disposed || !active) return;
      driftIndex = (driftIndex + 1) % OLED_DRIFT_WAYPOINTS.length;
      emit();
      scheduleDrift();
    }, driftIntervalMs);
  };

  const armIdle = (): void => {
    clearIdle();
    if (disposed || active || isBlocked || timeoutMin <= 0) return;
    idleTimer = deps.timers.setTimeout(() => {
      idleTimer = null;
      if (disposed || isBlocked || timeoutMin <= 0) return;
      active = true;
      driftIndex = 0;
      emit();
      scheduleDrift();
    }, timeoutMin * 60_000);
  };

  const armWakeSuppression = (): void => {
    clearWake();
    if (wakeSuppressMs <= 0) {
      wakeSuppressed = false;
      wakeSuppressUntilMs = 0;
      return;
    }
    wakeSuppressed = true;
    wakeSuppressUntilMs = deps.clock.now() + wakeSuppressMs;
    wakeTimer = deps.timers.setTimeout(() => {
      wakeTimer = null;
      wakeSuppressed = false;
      wakeSuppressUntilMs = 0;
      if (!disposed) emit();
    }, wakeSuppressMs);
  };

  return {
    setConfig(config): void {
      if (disposed) return;
      const nextTimeout =
        Number.isFinite(config.timeoutMin) && config.timeoutMin > 0
          ? Math.round(config.timeoutMin)
          : 0;
      const nextBlocked = config.isBlocked === true;
      const changed = nextTimeout !== timeoutMin || nextBlocked !== isBlocked;
      timeoutMin = nextTimeout;
      isBlocked = nextBlocked;

      if (timeoutMin <= 0 || isBlocked) {
        clearIdle();
        clearDrift();
        if (active) {
          active = false;
          emit();
        }
        return;
      }

      if (changed && !active) armIdle();
    },

    recordActivity(): boolean {
      if (disposed) return false;
      if (active) {
        active = false;
        clearDrift();
        armWakeSuppression();
        armIdle();
        emit();
        return true;
      }
      armIdle();
      return wakeSuppressed && deps.clock.now() < wakeSuppressUntilMs;
    },

    isWakeSuppressed(): boolean {
      return wakeSuppressed && deps.clock.now() < wakeSuppressUntilMs;
    },

    getState: snapshot,

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearIdle();
      clearDrift();
      clearWake();
      active = false;
      wakeSuppressed = false;
    },
  };
}
