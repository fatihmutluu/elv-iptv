/** Default play/pause volume ramp duration in milliseconds (`#254`). */
export const DEFAULT_AUDIO_RAMP_MS = 175;
/** Default number of discrete volume steps across the ramp duration (7 x 25 ms = 175 ms). */
const DEFAULT_AUDIO_RAMP_STEPS = 7;

const MAX_PENDING_ECHOES = 32;
const ECHO_EPSILON = 0.05;

/** Timer primitives injected into {@link createAudioRamp}. */
export interface AudioRampTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Configuration for {@link createAudioRamp}. */
export interface AudioRampOptions {
  timers: AudioRampTimers;
  /** Optional monotonic clock (ms) used to compensate for OS timer-tick overshoot. */
  now?(): number;
  /** Sends a ramp volume write (`['set_property', 'volume', volume]`). */
  setVolume(volume: number): void;
  /** Optional restore sender used when cancelling an attenuated ramp. Defaults to `setVolume`. */
  restoreVolume?(volume: number): void;
  /** Total ramp duration in milliseconds (defaults to `175`; `<= 0` disables stepping). */
  durationMs?: number;
  /** Number of volume steps (defaults to `7`). */
  steps?: number;
}

/** Pure cancellable play/pause audio ramp controller (`#254`). */
export interface AudioRamp {
  readonly savedVolume: number;
  readonly muted: boolean;
  readonly isRamping: boolean;
  readonly isAttenuated: boolean;
  /** Processes observed mpv `'volume'` and `'mute'` property changes, ignoring self-emitted ramp echoes. */
  onProperty(name: 'volume' | 'mute', value: unknown): void;
  /** Records an explicit user `setVolume` call, cancelling any active ramp without restoring the old volume. */
  onUserVolume(volume: number): void;
  /** Ramps volume down to `0`, calls `onComplete()`, then restores `savedVolume`. */
  rampPause(onComplete: () => void): void;
  /**
   * Sets volume to `0` (or continues smoothly from the current attenuated volume if interrupting a pause ramp),
   * calls `onUnpause()`, then ramps volume up to `savedVolume`.
   */
  rampPlay(onUnpause: () => void): void;
  /**
   * Cancels pending ramp timers immediately. If `restoreVolume` is true and volume is currently attenuated,
   * restores `savedVolume` via `sendRestore`, `options.restoreVolume`, or `options.setVolume`.
   */
  cancel(restoreVolume: boolean, sendRestore?: (volume: number) => void): void;
}

const roundVolume = (v: number): number => Math.round(v * 100) / 100;

/** Creates a cancellable 175 ms play/pause audio volume ramp controller. */
export function createAudioRamp(opts: AudioRampOptions): AudioRamp {
  const durationMs = opts.durationMs ?? DEFAULT_AUDIO_RAMP_MS;
  const steps = Math.max(1, Math.round(opts.steps ?? DEFAULT_AUDIO_RAMP_STEPS));
  const stepMs = durationMs > 0 ? durationMs / steps : 0;
  const now = opts.now ?? (() => Date.now());

  let savedVolume = 100;
  let currentVolume = 100;
  let muted = false;
  let mode: 'idle' | 'pause' | 'play' = 'idle';
  let attenuated = false;
  let timer: unknown;
  let pauseOnComplete: (() => void) | undefined;
  const pendingEchoes: number[] = [];

  const clearTimer = (): void => {
    if (timer === undefined) return;
    opts.timers.clearTimeout(timer);
    timer = undefined;
  };

  const nextDelayMs = (startedAt: number, nextStepIdx: number): number => {
    const elapsed = now() - startedAt;
    if (elapsed <= 0) return stepMs;
    const target = nextStepIdx * stepMs;
    return Math.min(stepMs, Math.max(1, Math.round(target - elapsed)));
  };

  const emitVolume = (value: number, sender: (v: number) => void = opts.setVolume): void => {
    currentVolume = value;
    pendingEchoes.push(value);
    if (pendingEchoes.length > MAX_PENDING_ECHOES) pendingEchoes.shift();
    sender(value);
  };

  const startUpRamp = (startVol: number, totalSteps: number): void => {
    mode = 'play';
    const startedAt = now();
    const totalDurationMs = totalSteps * stepMs;
    const runStep = (stepIdx: number): void => {
      timer = undefined;
      if (mode !== 'play') return;
      const elapsed = now() - startedAt;
      if (stepIdx < totalSteps && elapsed < totalDurationMs) {
        const nextVol = roundVolume(startVol + ((savedVolume - startVol) * stepIdx) / totalSteps);
        emitVolume(nextVol);
        timer = opts.timers.setTimeout(
          () => runStep(stepIdx + 1),
          nextDelayMs(startedAt, stepIdx + 1),
        );
        return;
      }
      mode = 'idle';
      attenuated = false;
      emitVolume(savedVolume);
    };
    timer = opts.timers.setTimeout(() => runStep(1), stepMs);
  };

  const cancel = (restoreVolume: boolean, sendRestore?: (volume: number) => void): void => {
    clearTimer();
    mode = 'idle';
    pauseOnComplete = undefined;
    if (restoreVolume && attenuated) {
      attenuated = false;
      emitVolume(savedVolume, sendRestore ?? opts.restoreVolume ?? opts.setVolume);
    } else if (!restoreVolume) {
      attenuated = false;
      currentVolume = savedVolume;
    }
  };

  return {
    get savedVolume() {
      return savedVolume;
    },
    get muted() {
      return muted;
    },
    get isRamping() {
      return mode !== 'idle';
    },
    get isAttenuated() {
      return attenuated;
    },
    onProperty(name, value) {
      if (name === 'mute') {
        if (typeof value === 'boolean') muted = value;
        else if (value === 'yes' || value === 'no') muted = value === 'yes';
        return;
      }
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return;
      if (mode !== 'idle') {
        const idx = pendingEchoes.findIndex((v) => Math.abs(v - value) < ECHO_EPSILON);
        if (idx !== -1) pendingEchoes.splice(0, idx + 1);
        return;
      }
      if (pendingEchoes.length > 0) {
        const idx = pendingEchoes.findIndex((v) => Math.abs(v - value) < ECHO_EPSILON);
        if (idx !== -1) {
          pendingEchoes.splice(0, idx + 1);
          return;
        }
        pendingEchoes.length = 0;
      }
      savedVolume = value;
      currentVolume = value;
      attenuated = false;
    },
    onUserVolume(volume) {
      if (!Number.isFinite(volume) || volume < 0) return;
      clearTimer();
      mode = 'idle';
      pauseOnComplete = undefined;
      attenuated = false;
      savedVolume = volume;
      currentVolume = volume;
    },
    rampPause(onComplete) {
      if (mode === 'pause') {
        pauseOnComplete = onComplete;
        return;
      }
      if (durationMs <= 0 || muted || savedVolume <= 0) {
        cancel(true);
        onComplete();
        return;
      }
      let startVol: number;
      if (mode === 'play') {
        clearTimer();
        startVol = currentVolume;
      } else {
        startVol = savedVolume;
        currentVolume = savedVolume;
      }
      if (startVol <= 0) {
        mode = 'idle';
        attenuated = false;
        pauseOnComplete = undefined;
        onComplete();
        emitVolume(savedVolume);
        return;
      }
      const totalSteps = Math.max(1, Math.min(steps, Math.ceil((steps * startVol) / savedVolume)));
      mode = 'pause';
      pauseOnComplete = onComplete;
      const startedAt = now();
      const totalDurationMs = totalSteps * stepMs;
      const runStep = (stepIdx: number): void => {
        timer = undefined;
        if (mode !== 'pause') return;
        attenuated = true;
        const elapsed = now() - startedAt;
        if (stepIdx < totalSteps && elapsed < totalDurationMs) {
          const nextVol = roundVolume(startVol * (1 - stepIdx / totalSteps));
          emitVolume(nextVol);
          timer = opts.timers.setTimeout(
            () => runStep(stepIdx + 1),
            nextDelayMs(startedAt, stepIdx + 1),
          );
          return;
        }
        emitVolume(0);
        const done = pauseOnComplete;
        mode = 'idle';
        pauseOnComplete = undefined;
        attenuated = false;
        done?.();
        emitVolume(savedVolume);
      };
      timer = opts.timers.setTimeout(() => runStep(1), stepMs);
    },
    rampPlay(onUnpause) {
      if (durationMs <= 0 || muted || savedVolume <= 0) {
        cancel(true);
        onUnpause();
        return;
      }
      if (mode === 'pause') {
        clearTimer();
        pauseOnComplete = undefined;
        const startVol = currentVolume;
        onUnpause();
        if (!attenuated || startVol >= savedVolume) {
          mode = 'idle';
          attenuated = false;
          currentVolume = savedVolume;
          return;
        }
        const totalSteps = Math.max(
          1,
          Math.min(steps, Math.ceil((steps * (savedVolume - startVol)) / savedVolume)),
        );
        startUpRamp(startVol, totalSteps);
        return;
      }
      if (mode === 'play') {
        onUnpause();
        return;
      }
      attenuated = true;
      emitVolume(0);
      onUnpause();
      startUpRamp(0, steps);
    },
    cancel,
  };
}
