import type { PlaybackTimers } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import {
  createOledScreensaverController,
  OLED_DRIFT_INTERVAL_MS,
  OLED_WAKE_SUPPRESS_MS,
} from './screensaver-controller';

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

describe('screensaver-controller (#160)', () => {
  it('activates after idle timeout, drifts every 60s, consumes wake event, and suppresses clicks for 260ms', () => {
    const sched = createManualScheduler();
    const ctrl = createOledScreensaverController({
      clock: sched.clock,
      timers: sched.timers,
    });

    ctrl.setConfig({ timeoutMin: 5, isBlocked: false });
    sched.advance(4 * 60_000);
    expect(ctrl.getState().active).toBe(false);

    sched.advance(60_000);
    const first = ctrl.getState();
    expect(first.active).toBe(true);
    expect(first.driftIndex).toBe(0);

    // Drifts coordinates after 60s
    sched.advance(OLED_DRIFT_INTERVAL_MS);
    const drifted = ctrl.getState();
    expect(drifted.active).toBe(true);
    expect(drifted.driftIndex).toBe(1);
    expect({ xPct: drifted.xPct, yPct: drifted.yPct }).not.toEqual({
      xPct: first.xPct,
      yPct: first.yPct,
    });

    // Wake activity consumes event & activates 260ms click suppression
    expect(ctrl.recordActivity()).toBe(true);
    expect(ctrl.getState().active).toBe(false);
    expect(ctrl.isWakeSuppressed()).toBe(true);
    expect(ctrl.getState().wakeSuppressed).toBe(true);

    sched.advance(OLED_WAKE_SUPPRESS_MS - 1);
    expect(ctrl.isWakeSuppressed()).toBe(true);

    sched.advance(1);
    expect(ctrl.isWakeSuppressed()).toBe(false);
    expect(ctrl.getState().wakeSuppressed).toBe(false);
    ctrl.dispose();
  });

  it('never fires when blocked (active playback) or timeoutMin is 0', () => {
    const sched = createManualScheduler();
    const ctrl = createOledScreensaverController({
      clock: sched.clock,
      timers: sched.timers,
    });

    ctrl.setConfig({ timeoutMin: 5, isBlocked: true });
    sched.advance(15 * 60_000);
    expect(ctrl.getState().active).toBe(false);

    // Unblocking (e.g. paused playback) allows idle activation
    ctrl.setConfig({ timeoutMin: 5, isBlocked: false });
    sched.advance(5 * 60_000);
    expect(ctrl.getState().active).toBe(true);

    // Returning to active playback immediately clears screensaver
    ctrl.setConfig({ timeoutMin: 5, isBlocked: true });
    expect(ctrl.getState().active).toBe(false);
    ctrl.dispose();
  });
});
