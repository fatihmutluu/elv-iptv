import type { PlaybackTimers } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import { createSleepTimerController, SLEEP_TIMER_PRESETS_MIN } from './sleep-timer';

function createManualScheduler() {
  let nowMs = 1_000;
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
        let nextEntry: [number, { due: number; fn: () => void }] | undefined;
        for (const entry of tasks.entries()) {
          if (entry[1].due <= target && (!nextEntry || entry[1].due < nextEntry[1].due)) {
            nextEntry = entry;
          }
        }
        if (!nextEntry) break;
        const [id, task] = nextEntry;
        tasks.delete(id);
        nowMs = task.due;
        task.fn();
      }
      nowMs = target;
    },
  };
}

describe('sleep-timer (#118)', () => {
  it('exposes canonical presets and expires cleanly with the selected action', () => {
    expect(SLEEP_TIMER_PRESETS_MIN).toEqual([0, 15, 30, 45, 60, 90, 120, 180, 360]);

    const sched = createManualScheduler();
    const onExpire = vi.fn();
    const onChange = vi.fn();
    const ctrl = createSleepTimerController({
      clock: sched.clock,
      timers: sched.timers,
      initialAction: 'stop',
      onExpire,
      onChange,
    });

    expect(ctrl.getState()).toMatchObject({ active: false, remainingMinutes: 0, action: 'stop' });

    ctrl.start(15);
    expect(ctrl.getState()).toMatchObject({
      active: true,
      totalMinutes: 15,
      remainingMinutes: 15,
      action: 'stop',
    });

    sched.advance(5 * 60_000);
    expect(ctrl.getState().remainingMinutes).toBe(10);
    expect(onExpire).not.toHaveBeenCalled();

    // Switching action while running applies when timer fires
    ctrl.setAction('pause');
    expect(ctrl.getState().action).toBe('pause');

    sched.advance(10 * 60_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onExpire).toHaveBeenCalledWith('pause');
    expect(ctrl.getState().active).toBe(false);
  });

  it('cancels cleanly on 0 preset, cancel(), and dispose() without firing onExpire', () => {
    const sched = createManualScheduler();
    const onExpire = vi.fn();
    const ctrl = createSleepTimerController({
      clock: sched.clock,
      timers: sched.timers,
      onExpire,
    });

    ctrl.start(30, 'stop');
    expect(ctrl.getState().active).toBe(true);
    ctrl.start(0);
    expect(ctrl.getState().active).toBe(false);
    sched.advance(35 * 60_000);
    expect(onExpire).not.toHaveBeenCalled();

    ctrl.start(15, 'stop');
    ctrl.cancel();
    sched.advance(20 * 60_000);
    expect(onExpire).not.toHaveBeenCalled();

    ctrl.start(15, 'stop');
    ctrl.dispose();
    sched.advance(20 * 60_000);
    expect(onExpire).not.toHaveBeenCalled();
  });
});
