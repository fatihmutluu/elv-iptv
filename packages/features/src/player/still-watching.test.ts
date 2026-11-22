import type { PlaybackTimers } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import { createStillWatchingController } from './still-watching';

function createManualScheduler() {
  let nowMs = 0;
  let nextId = 1;
  const tasks = new Map<number, { due: number; fn: () => void }>();
  const timers: PlaybackTimers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      tasks.set(id, { due: nowMs + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(handle) {
      tasks.delete(handle as number);
    },
  };
  return {
    clock: { now: () => nowMs },
    timers,
    advance(ms: number) {
      const target = nowMs + ms;
      while (true) {
        let next: [number, { due: number; fn: () => void }] | undefined;
        for (const entry of tasks.entries()) {
          if (entry[1].due <= target && (!next || entry[1].due < next[1].due)) next = entry;
        }
        if (!next) break;
        const [id, task] = next;
        tasks.delete(id);
        nowMs = task.due;
        task.fn();
      }
      nowMs = target;
    },
  };
}

describe('still-watching (#118)', () => {
  it('shows prompt after configured active playback minutes and stops when countdown expires', () => {
    const sched = createManualScheduler();
    const onStop = vi.fn();
    const ctrl = createStillWatchingController({
      clock: sched.clock,
      timers: sched.timers,
      countdownSeconds: 60,
      onStop,
    });

    ctrl.setState({ timeoutMin: 60, statusKind: 'playing' });
    sched.advance(59 * 60_000);
    expect(ctrl.getState().promptVisible).toBe(false);

    sched.advance(60_000);
    expect(ctrl.getState()).toEqual({ promptVisible: true, remainingSeconds: 60 });

    sched.advance(30_000);
    expect(ctrl.getState()).toEqual({ promptVisible: true, remainingSeconds: 30 });
    expect(onStop).not.toHaveBeenCalled();

    sched.advance(30_000);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(ctrl.getState().promptVisible).toBe(false);
  });

  it('resets on real user activity, pauses accumulation while paused, and respects keepWatching/stopNow', () => {
    const sched = createManualScheduler();
    const onStop = vi.fn();
    const ctrl = createStillWatchingController({
      clock: sched.clock,
      timers: sched.timers,
      countdownSeconds: 10,
      onStop,
    });

    ctrl.setState({ timeoutMin: 60, statusKind: 'playing' });
    sched.advance(40 * 60_000);
    ctrl.recordUserActivity();

    // Another 40 min -> only 40 min since activity, not 80
    sched.advance(40 * 60_000);
    expect(ctrl.getState().promptVisible).toBe(false);

    // Pause for 60 min -> must NOT accumulate while paused
    ctrl.setState({ timeoutMin: 60, statusKind: 'paused' });
    sched.advance(60 * 60_000);
    expect(ctrl.getState().promptVisible).toBe(false);

    // Resume for 20 min -> reaches 60 min total since activity
    ctrl.setState({ timeoutMin: 60, statusKind: 'playing' });
    sched.advance(20 * 60_000);
    expect(ctrl.getState().promptVisible).toBe(true);

    // Keep watching dismisses & resets full 60 min
    ctrl.keepWatching();
    expect(ctrl.getState().promptVisible).toBe(false);
    sched.advance(30 * 60_000);
    expect(ctrl.getState().promptVisible).toBe(false);
    expect(onStop).not.toHaveBeenCalled();

    // Stop now fires onStop immediately
    ctrl.stopNow();
    expect(onStop).toHaveBeenCalledTimes(1);
    ctrl.dispose();
  });

  it('clears countdown timer and dismisses prompt when playback transitions to ended, idle, or failed (#118)', () => {
    for (const terminal of ['ended', 'idle', 'failed'] as const) {
      const sched = createManualScheduler();
      const onStop = vi.fn();
      const ctrl = createStillWatchingController({
        clock: sched.clock,
        timers: sched.timers,
        countdownSeconds: 10,
        onStop,
      });

      ctrl.setState({ timeoutMin: 60, statusKind: 'playing' });
      sched.advance(60 * 60_000);
      expect(ctrl.getState().promptVisible).toBe(true);

      ctrl.setState({ timeoutMin: 60, statusKind: terminal });
      expect(ctrl.getState().promptVisible).toBe(false);

      // Advance well past countdown -> onStop must NOT fire
      sched.advance(30_000);
      expect(onStop).not.toHaveBeenCalled();
      ctrl.dispose();
    }
  });

  it('preserves accumulated binge time across natural episode end -> auto-play next episode', () => {
    const sched = createManualScheduler();
    const onStop = vi.fn();
    const ctrl = createStillWatchingController({
      clock: sched.clock,
      timers: sched.timers,
      onStop,
    });

    ctrl.setState({ timeoutMin: 60, statusKind: 'playing' });
    sched.advance(40 * 60_000);
    expect(ctrl.getState().promptVisible).toBe(false);

    // Episode 1 ends naturally and NextEpisodeBanner auto-advances without user interaction
    ctrl.setState({ timeoutMin: 60, statusKind: 'ended' });
    sched.advance(10_000);
    ctrl.setState({ timeoutMin: 60, statusKind: 'playing' });

    sched.advance(19 * 60_000);
    expect(ctrl.getState().promptVisible).toBe(false);
    sched.advance(60_000);
    expect(ctrl.getState().promptVisible).toBe(true);
    ctrl.dispose();
  });
});
