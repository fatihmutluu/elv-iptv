import type { PlaybackClock, PlaybackStatus, PlaybackTimers } from '@elv/playback';

/** Countdown duration (seconds) after the idle still-watching prompt appears (`#118`). */
export const STILL_WATCHING_COUNTDOWN_SEC = 60;

/** Immutable state snapshot of the idle still-watching prompt (`#118`). */
export interface StillWatchingSnapshot {
  readonly promptVisible: boolean;
  readonly remainingSeconds: number;
}

/** Controller tracking continuous active playback without real user input (`#118`). */
export interface StillWatchingController {
  /** Updates configured timeout (minutes, `0` = off) and current playback status. */
  setState(input: {
    readonly timeoutMin: number;
    readonly statusKind: PlaybackStatus['kind'];
  }): void;
  /** Records real user interaction (keys, pointer, touch, manual zap), resetting idle countdown. */
  recordUserActivity(): void;
  /** User chose "Keep watching" — dismisses prompt and resets idle timer. */
  keepWatching(): void;
  /** User chose "Stop now" — dismisses prompt and fires `onStop`. */
  stopNow(): void;
  getState(): StillWatchingSnapshot;
  dispose(): void;
}

/** Collaborators for {@link createStillWatchingController}. */
export interface StillWatchingControllerDeps {
  readonly clock: PlaybackClock;
  readonly timers: PlaybackTimers;
  readonly countdownSeconds?: number;
  readonly onStop: () => void;
  readonly onChange?: (snapshot: StillWatchingSnapshot) => void;
}

function isActivePlaybackStatus(kind: PlaybackStatus['kind']): boolean {
  return kind === 'playing' || kind === 'tuning' || kind === 'recovering';
}

/**
 * Creates a deterministic controller for the `#118` "Are you still watching?" idle prompt.
 * Only accumulates time while playback is actively running (`playing | tuning | recovering`).
 * Automatic episode transitions do NOT call `recordUserActivity()`, so binge auto-play still triggers
 * the prompt after the configured threshold.
 */
export function createStillWatchingController(
  deps: StillWatchingControllerDeps,
): StillWatchingController {
  const countdownSec = Math.max(
    1,
    Math.round(deps.countdownSeconds ?? STILL_WATCHING_COUNTDOWN_SEC),
  );
  let timeoutMin = 0;
  let activePlayback = false;
  let accumulatedMs = 0;
  let segmentStartMs: number | null = null;
  let promptVisible = false;
  let remainingSeconds = countdownSec;
  let idleTimer: unknown = null;
  let countdownTimer: unknown = null;
  let disposed = false;

  const clearIdleTimer = (): void => {
    if (idleTimer !== null) {
      deps.timers.clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const clearCountdownTimer = (): void => {
    if (countdownTimer !== null) {
      deps.timers.clearTimeout(countdownTimer);
      countdownTimer = null;
    }
  };

  const snapshot = (): StillWatchingSnapshot => ({
    promptVisible,
    remainingSeconds,
  });

  const emit = (): void => {
    deps.onChange?.(snapshot());
  };

  const pauseAccumulation = (): void => {
    if (segmentStartMs !== null) {
      accumulatedMs += Math.max(0, deps.clock.now() - segmentStartMs);
      segmentStartMs = null;
    }
  };

  const scheduleCountdownTick = (): void => {
    clearCountdownTimer();
    if (disposed || !promptVisible) return;
    countdownTimer = deps.timers.setTimeout(() => {
      countdownTimer = null;
      if (disposed || !promptVisible) return;
      remainingSeconds = Math.max(0, remainingSeconds - 1);
      if (remainingSeconds <= 0) {
        promptVisible = false;
        accumulatedMs = 0;
        segmentStartMs = null;
        emit();
        deps.onStop();
        return;
      }
      emit();
      scheduleCountdownTick();
    }, 1_000);
  };

  const armIdleTimer = (): void => {
    clearIdleTimer();
    if (disposed || promptVisible || !activePlayback || timeoutMin <= 0) return;
    const thresholdMs = timeoutMin * 60_000;
    const now = deps.clock.now();
    const currentElapsed =
      accumulatedMs + (segmentStartMs !== null ? Math.max(0, now - segmentStartMs) : 0);
    const remainingMs = Math.max(0, thresholdMs - currentElapsed);
    idleTimer = deps.timers.setTimeout(() => {
      idleTimer = null;
      if (disposed || !activePlayback || timeoutMin <= 0) return;
      pauseAccumulation();
      promptVisible = true;
      remainingSeconds = countdownSec;
      emit();
      scheduleCountdownTick();
    }, remainingMs);
  };

  const resetProgress = (): void => {
    clearIdleTimer();
    clearCountdownTimer();
    accumulatedMs = 0;
    segmentStartMs = activePlayback ? deps.clock.now() : null;
    const wasPrompt = promptVisible;
    promptVisible = false;
    remainingSeconds = countdownSec;
    if (wasPrompt) emit();
    armIdleTimer();
  };

  return {
    setState(input): void {
      if (disposed) return;
      const nextTimeout =
        Number.isFinite(input.timeoutMin) && input.timeoutMin > 0
          ? Math.round(input.timeoutMin)
          : 0;
      const nextActive = isActivePlaybackStatus(input.statusKind);

      if (nextTimeout <= 0) {
        timeoutMin = 0;
        activePlayback = nextActive;
        clearIdleTimer();
        clearCountdownTimer();
        accumulatedMs = 0;
        segmentStartMs = null;
        if (promptVisible) {
          promptVisible = false;
          remainingSeconds = countdownSec;
          emit();
        }
        return;
      }

      const isTerminal =
        input.statusKind === 'ended' ||
        input.statusKind === 'idle' ||
        input.statusKind === 'failed';
      if (isTerminal) {
        timeoutMin = nextTimeout;
        pauseAccumulation();
        activePlayback = false;
        clearIdleTimer();
        clearCountdownTimer();
        if (promptVisible) {
          accumulatedMs = 0;
          promptVisible = false;
          remainingSeconds = countdownSec;
          emit();
        }
        return;
      }

      const activeChanged = nextActive !== activePlayback;
      const timeoutChanged = nextTimeout !== timeoutMin;
      timeoutMin = nextTimeout;
      activePlayback = nextActive;

      if (activeChanged) {
        if (nextActive) {
          segmentStartMs = deps.clock.now();
          armIdleTimer();
        } else {
          pauseAccumulation();
          clearIdleTimer();
        }
      } else if (timeoutChanged) {
        armIdleTimer();
      }
    },

    recordUserActivity(): void {
      if (disposed || promptVisible) return;
      accumulatedMs = 0;
      segmentStartMs = activePlayback ? deps.clock.now() : null;
      armIdleTimer();
    },

    keepWatching(): void {
      if (disposed) return;
      resetProgress();
    },

    stopNow(): void {
      if (disposed) return;
      clearIdleTimer();
      clearCountdownTimer();
      accumulatedMs = 0;
      segmentStartMs = null;
      const wasPrompt = promptVisible;
      promptVisible = false;
      remainingSeconds = countdownSec;
      if (wasPrompt) emit();
      deps.onStop();
    },

    getState: snapshot,

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearIdleTimer();
      clearCountdownTimer();
      segmentStartMs = null;
      promptVisible = false;
    },
  };
}
