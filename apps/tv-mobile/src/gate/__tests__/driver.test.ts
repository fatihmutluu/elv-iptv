import { createFocusStore, type KeyEvent } from '@elv/focus-core';
import { describe, expect, it } from 'vitest';
import { createAutoDriver } from '../driver';

function harness(moves: number, rate = 20) {
  let clock = 0;
  const queue: { fn: () => void; at: number }[] = [];
  const events: { event: KeyEvent; at: number }[] = [];
  const store = createFocusStore({
    id: 'root',
    lists: [{ id: 'l', count: 100_000, index: 0, orientation: 'vertical', pageSize: 10 }],
    active: 'l',
  });
  const driver = createAutoDriver(
    (event) => {
      events.push({ event, at: clock });
      store.dispatch(event);
    },
    {
      rate,
      moves,
      now: () => clock,
      schedule: (fn, ms) => queue.push({ fn, at: clock + ms }),
    },
  );
  const run = (limit = Number.POSITIVE_INFINITY) => {
    let steps = 0;
    while (queue.length > 0 && steps++ < limit) {
      queue.sort((a, b) => a.at - b.at);
      const next = queue.shift();
      if (!next) break;
      clock = next.at;
      next.fn();
    }
  };
  const index = () => store.getState().scopes[0]?.lists.l?.index;
  return { driver, events, run, index, queue };
}

describe('createAutoDriver', () => {
  it('emits exactly `moves` events at the requested rate and ends at the start index', async () => {
    const h = harness(600, 20);
    const done = h.driver.start();
    h.run();
    await done;
    expect(h.events).toHaveLength(600);
    expect(h.index()).toBe(0);
    const gaps = h.events.slice(1).map((e, i) => e.at - (h.events[i]?.at ?? 0));
    for (const g of gaps) expect(g).toBeCloseTo(50, 5);
  });

  it('uses holds, page jumps and single presses in both directions', async () => {
    const h = harness(600);
    const done = h.driver.start();
    h.run();
    await done;
    const kinds = new Set(h.events.map((e) => `${e.event.key}:${e.event.kind}`));
    for (const k of [
      'down:long',
      'down:repeat',
      'down:press',
      'up:long',
      'up:repeat',
      'up:press',
      'channelDown:press',
      'channelUp:press',
    ]) {
      expect(kinds.has(k)).toBe(true);
    }
  });

  it('goes deep enough to cross list anchors', async () => {
    const h = harness(600);
    let max = 0;
    const done = h.driver.start();
    while (h.queue.length > 0) {
      h.run(1);
      max = Math.max(max, h.index() ?? 0);
    }
    await done;
    expect(max).toBeGreaterThan(100);
  });

  it('returns to the start for odd and tiny move counts', async () => {
    for (const moves of [1, 2, 7, 99, 101]) {
      const h = harness(moves);
      const done = h.driver.start();
      h.run();
      await done;
      expect(h.index()).toBe(0);
      expect(h.events.length).toBeLessThanOrEqual(moves);
      expect(h.events.length).toBeGreaterThanOrEqual(moves - 1);
    }
  });

  it('stamps events with now()', async () => {
    const h = harness(4, 10);
    const done = h.driver.start();
    h.run();
    await done;
    expect(h.events.map((e) => e.event.time)).toEqual(h.events.map((e) => e.at));
  });

  it('emits nothing after stop and still resolves', async () => {
    const h = harness(600);
    const done = h.driver.start();
    h.run(10);
    const seen = h.events.length;
    h.driver.stop();
    h.run();
    await done;
    expect(h.events.length).toBe(seen);
  });
});
