import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpeningGate } from './opening-gate.ts';

afterEach(() => vi.useRealTimers());

describe('createOpeningGate', () => {
  it('holds a waiting load until file-loaded or openWaitMs and tracks maxHoldMs', async () => {
    vi.useFakeTimers();
    let clock = 1000;
    const gate = createOpeningGate<{ entryId?: number }>({
      now: () => clock,
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
    });

    const slot1: { entryId?: number } = { entryId: 1 };
    gate.begin(slot1);
    expect(gate.isOpening()).toBe(true);
    gate.onStarted(1, 1000);

    let unblocked = false;
    const waiting = gate
      .waitUntilClear(() => true)
      .then(() => {
        unblocked = true;
      });

    clock = 1420;
    gate.onFileLoaded(1);
    await waiting;
    expect(unblocked).toBe(true);
    expect(gate.isOpening()).toBe(false);
    expect(gate.maxHoldMs).toBe(420);
  });

  it('wakes a superseded load immediately without updating maxHoldMs', async () => {
    let clock = 500;
    const gate = createOpeningGate<{ entryId?: number }>({
      now: () => clock,
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
    });

    gate.begin({ entryId: 1 });
    let active = true;
    const waiting = gate.waitUntilClear(() => active);
    clock = 900;
    active = false;
    gate.wake();
    await waiting;
    expect(gate.maxHoldMs).toBe(0);
  });
});
