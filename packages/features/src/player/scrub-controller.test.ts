import { DIGIT_KEYS } from '@elv/focus-core';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTOREPEAT_MS,
  COARSE_SEEK_MS,
  canPauseStatus,
  clampSeekPosition,
  createKeyRepeatThrottle,
  createScrubController,
  digitKeyToRatio,
  isScrubKey,
  LONG_HOLD_MS,
  mapDesktopFallbackKey,
  SCRUB_SETTLE_MS,
  type ScrubPosition,
  STEP_SEEK_MS,
  scrubStepMs,
  shouldCancelScrubOnStatus,
} from './scrub-controller';

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number): unknown => {
        const id = nextId++;
        tasks.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (handle: unknown): void => {
        tasks.delete(handle as number);
      },
    },
    pending: () => tasks.size,
    advance(ms: number): void {
      now += ms;
      for (const [id, task] of [...tasks]) {
        if (task.at <= now) {
          tasks.delete(id);
          task.fn();
        }
      }
    },
  };
}

function setup(position: ScrubPosition | undefined = { positionMs: 50_000, durationMs: 600_000 }) {
  const clock = fakeTimers();
  const seek = vi.fn<(ms: number) => void>();
  const previews: (number | undefined)[] = [];
  let current: ScrubPosition | undefined = position;
  const scrub = createScrubController({
    timers: clock.timers,
    readPosition: () => current,
    seek,
    onPreviewChange: (ms) => previews.push(ms),
  });
  return {
    clock,
    seek,
    previews,
    scrub,
    setPosition: (next: ScrubPosition | undefined) => {
      current = next;
    },
  };
}

describe('scrubStepMs', () => {
  it('uses 10s for a press, 30s for early repeats and 60s for sustained repeats', () => {
    expect(scrubStepMs('press', 0)).toBe(STEP_SEEK_MS);
    expect(scrubStepMs('repeat', 1)).toBe(30_000);
    expect(scrubStepMs('repeat', 8)).toBe(30_000);
    expect(scrubStepMs('repeat', 9)).toBe(60_000);
  });

  it('recognizes horizontal scrub keys and clamps seek positions', () => {
    expect(isScrubKey('left')).toBe(true);
    expect(isScrubKey('fastForward')).toBe(true);
    expect(isScrubKey('select')).toBe(false);
    expect(clampSeekPosition(-5_000, 30_000)).toBe(0);
    expect(clampSeekPosition(50_000, 30_000)).toBe(30_000);
    expect(clampSeekPosition(50_000, undefined)).toBe(50_000);
    expect(mapDesktopFallbackKey('ArrowRight')).toBe('right');
    expect(mapDesktopFallbackKey('Escape')).toBe('back');
    expect(mapDesktopFallbackKey('PageUp')).toBe('channelUp');
    expect(mapDesktopFallbackKey('Tab')).toBeUndefined();
    expect(mapDesktopFallbackKey(42)).toBeUndefined();
    expect(canPauseStatus('playing')).toBe(true);
    expect(canPauseStatus('ended')).toBe(false);
    expect(canPauseStatus(undefined)).toBe(false);
    expect(shouldCancelScrubOnStatus('playing', 'paused')).toBe(true);
    expect(shouldCancelScrubOnStatus('paused', 'paused')).toBe(false);
    expect(shouldCancelScrubOnStatus('paused', 'playing')).toBe(false);
  });
});

describe('createScrubController', () => {
  it('moves the preview on a press without seeking and commits once on settle', () => {
    const { clock, seek, previews, scrub } = setup();
    scrub.step(1, 'press');
    expect(scrub.previewPositionMs).toBe(60_000);
    expect(previews).toEqual([60_000]);
    expect(seek).not.toHaveBeenCalled();

    clock.advance(SCRUB_SETTLE_MS - 1);
    expect(seek).not.toHaveBeenCalled();
    clock.advance(1);
    expect(seek).toHaveBeenCalledTimes(1);
    expect(seek).toHaveBeenCalledWith(60_000);
    expect(scrub.previewPositionMs).toBeUndefined();
    expect(previews).toEqual([60_000, undefined]);
  });

  it('accelerates over held repeats and commits a single seek on release', () => {
    const { clock, seek, scrub } = setup({ positionMs: 0, durationMs: 3_600_000 });
    scrub.step(1, 'press');
    for (let i = 0; i < 10; i += 1) {
      clock.advance(125);
      scrub.step(1, 'repeat');
    }
    expect(seek).not.toHaveBeenCalled();
    expect(scrub.previewPositionMs).toBe(10_000 + 8 * 30_000 + 2 * 60_000);

    scrub.commit();
    expect(seek).toHaveBeenCalledTimes(1);
    expect(seek).toHaveBeenCalledWith(370_000);
    expect(clock.pending()).toBe(0);
  });

  it('restarts the settle window on every step', () => {
    const { clock, seek, scrub } = setup();
    scrub.step(-1, 'press');
    clock.advance(SCRUB_SETTLE_MS - 10);
    scrub.step(-1, 'press');
    clock.advance(SCRUB_SETTLE_MS - 10);
    expect(seek).not.toHaveBeenCalled();
    clock.advance(10);
    expect(seek).toHaveBeenCalledExactlyOnceWith(30_000);
  });

  it('resets acceleration when a new press arrives', () => {
    const { scrub } = setup({ positionMs: 0, durationMs: 3_600_000 });
    scrub.step(1, 'press');
    for (let i = 0; i < 9; i += 1) scrub.step(1, 'repeat');
    const afterHold = scrub.previewPositionMs ?? 0;
    scrub.step(1, 'press');
    scrub.step(1, 'repeat');
    expect(scrub.previewPositionMs).toBe(afterHold + 10_000 + 30_000);
  });

  it('starts a repeat-only scrub at the repeat step', () => {
    const { scrub } = setup();
    scrub.step(1, 'repeat');
    expect(scrub.previewPositionMs).toBe(80_000);
  });

  it('clamps the preview to zero and the known duration', () => {
    const { scrub, seek } = setup({ positionMs: 4_000, durationMs: 20_000 });
    scrub.step(-1, 'press');
    expect(scrub.previewPositionMs).toBe(0);
    scrub.step(1, 'repeat');
    expect(scrub.previewPositionMs).toBe(20_000);
    scrub.commit();
    expect(seek).toHaveBeenCalledWith(20_000);
  });

  it('only clamps at zero while the duration is unknown', () => {
    const { scrub } = setup({ positionMs: 5_000 });
    scrub.step(1, 'repeat');
    expect(scrub.previewPositionMs).toBe(35_000);
    const zeroDuration = setup({ positionMs: 5_000, durationMs: 0 });
    zeroDuration.scrub.step(1, 'press');
    expect(zeroDuration.scrub.previewPositionMs).toBe(15_000);
  });

  it('never seeks blindly before the position is known', () => {
    const { clock, seek, previews, scrub, setPosition } = setup();
    setPosition(undefined);
    scrub.step(1, 'press');
    scrub.step(1, 'repeat');
    clock.advance(SCRUB_SETTLE_MS);
    scrub.commit();
    expect(scrub.previewPositionMs).toBeUndefined();
    expect(previews).toEqual([]);
    expect(seek).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });

  it('ignores a non-finite position', () => {
    const { scrub, seek } = setup({ positionMs: Number.NaN });
    scrub.step(1, 'press');
    scrub.commit();
    expect(seek).not.toHaveBeenCalled();
  });

  it('continues from the preview, not the live position, while scrubbing', () => {
    const { scrub, setPosition } = setup();
    scrub.step(1, 'press');
    setPosition({ positionMs: 90_000, durationMs: 600_000 });
    scrub.step(1, 'press');
    expect(scrub.previewPositionMs).toBe(70_000);
  });

  it('cancels without seeking and clears the settle timer', () => {
    const { clock, seek, previews, scrub } = setup();
    scrub.step(1, 'press');
    scrub.cancel();
    expect(scrub.previewPositionMs).toBeUndefined();
    expect(previews).toEqual([60_000, undefined]);
    expect(clock.pending()).toBe(0);
    clock.advance(SCRUB_SETTLE_MS);
    expect(seek).not.toHaveBeenCalled();
  });

  it('treats commit and cancel without a pending scrub as no-ops', () => {
    const { seek, previews, scrub } = setup();
    scrub.commit();
    scrub.cancel();
    expect(seek).not.toHaveBeenCalled();
    expect(previews).toEqual([]);
  });

  it('starts a fresh scrub from the live position after a commit', () => {
    const { scrub, seek, setPosition } = setup();
    scrub.step(1, 'press');
    scrub.commit();
    setPosition({ positionMs: 200_000, durationMs: 600_000 });
    scrub.step(-1, 'press');
    scrub.commit();
    expect(seek.mock.calls).toEqual([[60_000], [190_000]]);
  });
});

describe('digitKeyToRatio and desktop digit fallback', () => {
  it('maps digit0..digit9 to exact 0.0..0.9 ratios and returns undefined for non-digits', () => {
    expect(COARSE_SEEK_MS).toBe(30_000);
    expect(LONG_HOLD_MS).toBe(350);
    expect(AUTOREPEAT_MS).toBe(160);

    DIGIT_KEYS.forEach((key, n) => {
      expect(digitKeyToRatio(key)).toBe(n / 10);
      expect(mapDesktopFallbackKey(String(n))).toBe(key);
    });

    expect(digitKeyToRatio('left')).toBeUndefined();
    expect(digitKeyToRatio('select')).toBeUndefined();
    expect(digitKeyToRatio('back')).toBeUndefined();
    expect(digitKeyToRatio('channelUp')).toBeUndefined();
  });
});

describe('createKeyRepeatThrottle', () => {
  it('allows non-repeat presses and gates repeats by longHoldMs and repeatIntervalMs', () => {
    let now = 1_000;
    const throttle = createKeyRepeatThrottle({ now: () => now });

    expect(throttle.allow('ArrowRight', false)).toBe(true);

    now += LONG_HOLD_MS - 1;
    expect(throttle.allow('ArrowRight', true)).toBe(false);

    now += 1;
    expect(throttle.allow('ArrowRight', true)).toBe(true);

    now += AUTOREPEAT_MS - 1;
    expect(throttle.allow('ArrowRight', true)).toBe(false);

    now += 1;
    expect(throttle.allow('ArrowRight', true)).toBe(true);

    now += 20;
    expect(throttle.allow('ArrowRight', false)).toBe(true);
    now += AUTOREPEAT_MS;
    expect(throttle.allow('ArrowRight', true)).toBe(false);
  });

  it('treats a different key or post-reset repeat as a fresh press and honors custom windows', () => {
    let now = 5_000;
    const throttle = createKeyRepeatThrottle({
      now: () => now,
      longHoldMs: 100,
      repeatIntervalMs: 250,
    });

    expect(throttle.allow('j', false)).toBe(true);
    now += 150;
    // Past longHoldMs (100) but still within repeatIntervalMs (250)
    expect(throttle.allow('j', true)).toBe(false);
    now += 100;
    expect(throttle.allow('j', true)).toBe(true);

    // Switching key while repeat=true resets as fresh press
    now += 10;
    expect(throttle.allow('l', true)).toBe(true);
    now += 50;
    expect(throttle.allow('l', true)).toBe(false);

    // reset() clears lastKey so next repeat is allowed immediately
    throttle.reset();
    expect(throttle.allow('l', true)).toBe(true);
  });
});
