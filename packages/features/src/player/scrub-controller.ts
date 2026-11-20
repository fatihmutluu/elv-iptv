import type { Key } from '@elv/focus-core';
import type { PlaybackStatus, PlaybackTimers } from '@elv/playback';

/** Quiet time in ms after the last scrub step before the preview is committed with one seek. */
export const SCRUB_SETTLE_MS = 750;

/** Step size in ms for a single seek tap or on-screen `-10s` / `+10s` button. */
export const STEP_SEEK_MS = 10_000;

const HOLD_STEP_MS = 30_000;
const SUSTAINED_STEP_MS = 60_000;
const SUSTAINED_AFTER_REPEATS = 8;
const SCRUB_KEY_SET: ReadonlySet<Key> = new Set(['left', 'right', 'rewind', 'fastForward']);
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
