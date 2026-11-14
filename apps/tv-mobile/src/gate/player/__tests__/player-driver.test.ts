import { describe, expect, it } from 'vitest';
import { createZapDriver } from '../player-driver';

function harness(opts: { channels: number; zaps: number; rate: number }) {
  const queue: { fn: () => void; ms: number }[] = [];
  const calls: [number, boolean][] = [];
  const driver = createZapDriver((index, zap) => calls.push([index, zap]), {
    ...opts,
    schedule: (fn, ms) => queue.push({ fn, ms }),
  });
  const run = () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) next.fn();
  };
  return { driver, calls, queue, run };
}

describe('createZapDriver', () => {
  it('tunes channel 0, then zaps round the list at the rate', async () => {
    const h = harness({ channels: 3, zaps: 4, rate: 0.5 });
    const done = h.driver.start();
    expect(h.calls).toEqual([[0, false]]);
    expect(h.queue[0]?.ms).toBe(2000);
    h.run();
    await done;
    expect(h.calls).toEqual([
      [0, false],
      [1, true],
      [2, true],
      [0, true],
      [1, true],
    ]);
  });

  it('stops without dispatching more and resolves', async () => {
    const h = harness({ channels: 2, zaps: 10, rate: 1 });
    const done = h.driver.start();
    h.queue.shift()?.fn();
    h.driver.stop();
    h.run();
    await done;
    expect(h.calls).toEqual([
      [0, false],
      [1, true],
    ]);
  });

  it('works with one channel', async () => {
    const h = harness({ channels: 1, zaps: 2, rate: 5 });
    const done = h.driver.start();
    h.run();
    await done;
    expect(h.calls.map(([index]) => index)).toEqual([0, 0, 0]);
  });
});
