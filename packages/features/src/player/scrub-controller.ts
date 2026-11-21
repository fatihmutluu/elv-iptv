import type { Key } from '@elv/focus-core';
import type { PlaybackStatus, PlaybackTimers } from '@elv/playback';

/** Quiet time in ms after the last scrub step before the preview is committed with one seek. */
export const SCRUB_SETTLE_MS = 750;

/** Step size in ms for a single seek tap or on-screen `-10s` / `+10s` button. */
export const STEP_SEEK_MS = 10_000;

/** Coarse seek step in ms for Desktop `Shift + ArrowLeft/ArrowRight`. */
export const COARSE_SEEK_MS = 30_000;

/** Initial hold delay in ms before held desktop key repeats start firing. */
export const LONG_HOLD_MS = 350;

/** Minimum cadence in ms between repeated desktop key dispatches after long-hold. */
export const AUTOREPEAT_MS = 160;

const HOLD_STEP_MS = 30_000;
const SUSTAINED_STEP_MS = 60_000;
const SUSTAINED_AFTER_REPEATS = 8;
const SCRUB_KEY_SET: ReadonlySet<Key> = new Set(['left', 'right', 'rewind', 'fastForward']);
const DIGIT_KEY_RATIOS: Readonly<Partial<Record<Key, number>>> = {
  digit0: 0,
  digit1: 0.1,
  digit2: 0.2,
  digit3: 0.3,
  digit4: 0.4,
  digit5: 0.5,
  digit6: 0.6,
  digit7: 0.7,
  digit8: 0.8,
  digit9: 0.9,
};
const PAUSABLE_STATUSES: ReadonlySet<PlaybackStatus['kind']> = new Set([
  'playing',
  'recovering',
  'tuning',
]);
const SCRUB_CANCEL_STATUSES: ReadonlySet<PlaybackStatus['kind']> = new Set([
  'idle',
  'tuning',
  'paused',
  'ended',
  'failed',
  'limited',
]);
const DESKTOP_FALLBACK_KEYS: Readonly<Record<string, Key>> = {
  Escape: 'back',
  Backspace: 'back',
  Enter: 'select',
  ' ': 'select',
  Spacebar: 'select',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  PageUp: 'channelUp',
  PageDown: 'channelDown',
  '0': 'digit0',
  '1': 'digit1',
  '2': 'digit2',
  '3': 'digit3',
  '4': 'digit4',
  '5': 'digit5',
  '6': 'digit6',
  '7': 'digit7',
  '8': 'digit8',
  '9': 'digit9',
};

/** Playback position the scrub starts from; `durationMs` clamps the preview when known. */
export interface ScrubPosition {
  readonly positionMs: number;
  readonly durationMs?: number;
}

/** Dependencies of {@link createScrubController}. */
export interface ScrubControllerDeps {
  readonly timers: PlaybackTimers;
  /** Current playback position, or `undefined` while it is unknown (nothing is seeked then). */
  readonly readPosition: () => ScrubPosition | undefined;
  readonly seek: (positionMs: number) => void;
  readonly onPreviewChange: (previewPositionMs: number | undefined) => void;
}

/** VOD preview-seek state machine: steps move a preview, and one seek commits it. */
export interface ScrubController {
  /** Pending preview position, `undefined` when no scrub is in progress. */
  readonly previewPositionMs: number | undefined;
  /** Moves the preview by one press or held-repeat step and restarts the settle timer. */
  step(direction: 1 | -1, kind: 'press' | 'repeat'): void;
  /** Seeks to the pending preview now (key release); a no-op without one. */
  commit(): void;
  /** Drops the pending preview without seeking. */
  cancel(): void;
}

/** Whether `key` is a horizontal VOD scrub key (`left`, `right`, `rewind`, `fastForward`). */
export function isScrubKey(key: Key): boolean {
  return SCRUB_KEY_SET.has(key);
}

/** Maps a remote digit key (`digit0`–`digit9`) to a VOD timeline ratio (`0.0`–`0.9`). */
export function digitKeyToRatio(key: Key): number | undefined {
  return DIGIT_KEY_RATIOS[key];
}

/** Rate-limiter gating held key repeats by initial hold delay and repeat cadence. */
export interface KeyRepeatThrottle {
  allow(key: string, repeat: boolean): boolean;
  reset(): void;
}

/** Creates a pure key-repeat throttle using the caller-provided clock. */
export function createKeyRepeatThrottle(opts: {
  readonly now: () => number;
  readonly longHoldMs?: number;
  readonly repeatIntervalMs?: number;
}): KeyRepeatThrottle {
  const longHoldMs = opts.longHoldMs ?? LONG_HOLD_MS;
  const repeatIntervalMs = opts.repeatIntervalMs ?? AUTOREPEAT_MS;
  let lastKey: string | undefined;
  let holdStart = 0;
  let lastEmit = 0;

  return {
    allow(key, repeat) {
      const now = opts.now();
      if (!repeat || key !== lastKey) {
        lastKey = key;
        holdStart = now;
        lastEmit = now;
        return true;
      }
      if (now - holdStart < longHoldMs || now - lastEmit < repeatIntervalMs) {
        return false;
      }
      lastEmit = now;
      return true;
    },
    reset() {
      lastKey = undefined;
      holdStart = 0;
      lastEmit = 0;
    },
  };
}

/** Maps a non-web desktop `onKeyDown` / `onKeyUp` key string to a logical {@link Key}. */
export function mapDesktopFallbackKey(rawKey: unknown): Key | undefined {
  return typeof rawKey === 'string' ? DESKTOP_FALLBACK_KEYS[rawKey] : undefined;
}

/** Whether `kind` accepts a user `pause()` command. */
export function canPauseStatus(kind: PlaybackStatus['kind'] | undefined): boolean {
  return kind !== undefined && PAUSABLE_STATUSES.has(kind);
}

/** Whether transitioning from `prev` to `next` must cancel an in-flight scrub preview. */
export function shouldCancelScrubOnStatus(
  prev: PlaybackStatus['kind'],
  next: PlaybackStatus['kind'],
): boolean {
  return prev !== next && SCRUB_CANCEL_STATUSES.has(next);
}

/** Step size for a press, or for the `repeatCount`-th held repeat (1-based) since the last press. */
export function scrubStepMs(kind: 'press' | 'repeat', repeatCount: number): number {
  if (kind === 'press') return STEP_SEEK_MS;
  return repeatCount > SUSTAINED_AFTER_REPEATS ? SUSTAINED_STEP_MS : HOLD_STEP_MS;
}

/** Clamps a millisecond seek target to `[0, durationMs]` when a positive duration is known. */
export function clampSeekPosition(positionMs: number, durationMs: number | undefined): number {
  const upper = durationMs !== undefined && durationMs > 0 ? durationMs : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(upper, positionMs));
}

/** Creates a {@link ScrubController}; time comes only from the injected timers. */
export function createScrubController(deps: ScrubControllerDeps): ScrubController {
  let preview: number | undefined;
  let durationMs: number | undefined;
  let repeatCount = 0;
  let settle: unknown;

  const clearSettle = (): void => {
    if (settle === undefined) return;
    deps.timers.clearTimeout(settle);
    settle = undefined;
  };

  const finish = (seekTo: boolean): void => {
    clearSettle();
    const target = preview;
    if (target === undefined) return;
    preview = undefined;
    repeatCount = 0;
    if (seekTo) deps.seek(target);
    deps.onPreviewChange(undefined);
  };

  const commit = (): void => finish(true);

  return {
    get previewPositionMs() {
      return preview;
    },
    step(direction, kind) {
      let base = preview;
      if (base === undefined) {
        const start = deps.readPosition();
        if (start === undefined || !Number.isFinite(start.positionMs)) return;
        base = start.positionMs;
        durationMs = start.durationMs;
        repeatCount = 0;
      }
      repeatCount = kind === 'press' ? 0 : repeatCount + 1;
      preview = clampSeekPosition(base + direction * scrubStepMs(kind, repeatCount), durationMs);
      clearSettle();
      settle = deps.timers.setTimeout(commit, SCRUB_SETTLE_MS);
      deps.onPreviewChange(preview);
    },
    commit,
    cancel: () => finish(false),
  };
}
