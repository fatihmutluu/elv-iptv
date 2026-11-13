import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createKeyInterpreter } from './interpreter';
import type { Key, KeyEvent, KeyInterpreter } from './keys';

const down = (key: Key, time: number) => ({ key, action: 'down' as const, time });
const up = (key: Key, time: number) => ({ key, action: 'up' as const, time });

/** Ticks every `step` ms from `from` to `to`, acknowledging each repeat at once unless `ack` is false. */
function run(
  k: KeyInterpreter,
  key: Key,
  from: number,
  to: number,
  step = 1,
  ack = true,
): KeyEvent[] {
  const out: KeyEvent[] = [];
  for (let t = from; t <= to; t += step) {
    for (const e of k.tick(t)) {
      out.push(e);
      if (ack && e.kind === 'repeat') k.acknowledge(key);
    }
  }
  return out;
}

describe('press', () => {
  it('emits one press on up when released before the long threshold', () => {
    const k = createKeyInterpreter();
    expect(k.input(down('select', 100))).toEqual([]);
    expect(k.tick(300)).toEqual([]);
    expect(k.input(up('select', 599))).toEqual([{ key: 'select', kind: 'press', time: 599 }]);
  });

  it('passes press inputs through', () => {
    const k = createKeyInterpreter();
    expect(k.input({ key: 'menu', action: 'press', time: 5 })).toEqual([
      { key: 'menu', kind: 'press', time: 5 },
    ]);
  });

  it('presses keys that are neither long nor repeat however long they are held', () => {
    const k = createKeyInterpreter();
    k.input(down('playPause', 0));
    expect(run(k, 'playPause', 0, 3000, 50)).toEqual([]);
    expect(k.input(up('playPause', 3000))).toEqual([
      { key: 'playPause', kind: 'press', time: 3000 },
    ]);
  });

  it('treats an up without a down as a press', () => {
    const k = createKeyInterpreter();
    expect(k.input(up('back', 9))).toEqual([{ key: 'back', kind: 'press', time: 9 }]);
  });

  it('ignores a repeated down while the key is held', () => {
    const k = createKeyInterpreter();
    k.input(down('select', 0));
    expect(k.input(down('select', 200))).toEqual([]);
    expect(k.tick(500)).toEqual([{ key: 'select', kind: 'long', time: 500 }]);
  });
});

describe('long', () => {
  it('fires exactly one long at 500 ms for select and no press on release', () => {
    const k = createKeyInterpreter();
    k.input(down('select', 1000));
    expect(k.tick(1499)).toEqual([]);
    expect(k.tick(1500)).toEqual([{ key: 'select', kind: 'long', time: 1500 }]);
    expect(run(k, 'select', 1501, 4000, 10)).toEqual([]);
    expect(k.input(up('select', 4000))).toEqual([]);
  });

  it('fires the long on release when no tick saw the threshold', () => {
    const k = createKeyInterpreter();
    k.input(down('back', 0));
    expect(k.input(up('back', 900))).toEqual([{ key: 'back', kind: 'long', time: 500 }]);
  });

  it('does not fire a long twice when released after the tick fired it', () => {
    const k = createKeyInterpreter();
    k.input(down('back', 0));
    k.tick(600);
    expect(k.input(up('back', 900))).toEqual([]);
  });

  it('never fires long or repeat for digits, even when configured', () => {
    const k = createKeyInterpreter({ longKeys: ['digit1'], repeatKeys: ['digit1'] });
    k.input(down('digit1', 0));
    expect(run(k, 'digit1', 0, 5000, 25)).toEqual([]);
    expect(k.input(up('digit1', 5000))).toEqual([{ key: 'digit1', kind: 'press', time: 5000 }]);
  });

  it('honours custom longKeys', () => {
    const k = createKeyInterpreter({ longKeys: ['menu'], repeatKeys: [] });
    k.input(down('menu', 0));
    expect(k.tick(500)).toEqual([{ key: 'menu', kind: 'long', time: 500 }]);
    k.input(down('select', 0));
    expect(k.tick(2000)).toEqual([]);
  });
});

describe('step keys (arrows and channel keys)', () => {
  it.each<Key>(['up', 'down', 'left', 'right', 'channelUp', 'channelDown'])(
    'presses %s on down, stamped with the down time, and emits nothing on a quick up',
    (key) => {
      const k = createKeyInterpreter();
      expect(k.input(down(key, 100))).toEqual([{ key, kind: 'press', time: 100 }]);
      expect(k.tick(300)).toEqual([]);
      expect(k.input(up(key, 400))).toEqual([]);
    },
  );

  it('ignores a repeated down of a held arrow', () => {
    const k = createKeyInterpreter();
    expect(k.input(down('up', 0))).toEqual([{ key: 'up', kind: 'press', time: 0 }]);
    expect(k.input(down('up', 200))).toEqual([]);
    expect(k.tick(500)).toEqual([{ key: 'up', kind: 'long', time: 500 }]);
  });

  it('emits nothing for an arrow up without a down', () => {
    const k = createKeyInterpreter();
    expect(k.input(up('down', 9))).toEqual([]);
    expect(k.input(up('channelDown', 9))).toEqual([]);
  });

  it('steps on down, then fires long at 500 ms and repeats while held, and nothing on release', () => {
    const k = createKeyInterpreter();
    expect(k.input(down('down', 0))).toEqual([{ key: 'down', kind: 'press', time: 0 }]);
    expect(run(k, 'down', 0, 760).map((e) => [e.kind, e.time])).toEqual([
      ['long', 500],
      ['repeat', 625],
      ['repeat', 750],
    ]);
    expect(k.input(up('down', 760))).toEqual([]);
  });

  it('still fires the long on release of an arrow held past the threshold without a tick', () => {
    const k = createKeyInterpreter();
    k.input(down('left', 0));
    expect(k.input(up('left', 900))).toEqual([{ key: 'left', kind: 'long', time: 500 }]);
  });

  it('keeps select, back, menu, playPause and digits pressing on up', () => {
    const k = createKeyInterpreter();
    for (const key of ['select', 'back', 'menu', 'playPause', 'digit7'] as const) {
      expect(k.input(down(key, 0))).toEqual([]);
      expect(k.input(up(key, 100))).toEqual([{ key, kind: 'press', time: 100 }]);
    }
  });
});

describe('repeat', () => {
  it('long at 500 ms then repeats every 125 ms until the ramp, then every 1000/24 ms', () => {
    const k = createKeyInterpreter();
    expect(k.input(down('down', 0))).toEqual([{ key: 'down', kind: 'press', time: 0 }]);
    const events = run(k, 'down', 0, 3000);
    expect(events[0]).toEqual({ key: 'down', kind: 'long', time: 500 });
    const repeats = events.filter((e) => e.kind === 'repeat').map((e) => e.time);
    expect(repeats.slice(0, 4)).toEqual([625, 750, 875, 1000]);
    expect(repeats.filter((t) => t < 2000)).toHaveLength(11);
    const fast = repeats.filter((t) => t >= 2000);
    expect(fast.length).toBeGreaterThan(20);
    for (let i = 1; i < fast.length; i++) {
      expect((fast[i] as number) - (fast[i - 1] as number)).toBeCloseTo(1000 / 24, 5);
    }
    expect(events.filter((e) => e.kind === 'long')).toHaveLength(1);
  });

  it('gives no press on release after repeating', () => {
    const k = createKeyInterpreter();
    k.input(down('left', 0));
    run(k, 'left', 0, 1000);
    expect(k.input(up('left', 1000))).toEqual([]);
  });

  it('repeats channel keys after the threshold without a long', () => {
    const k = createKeyInterpreter();
    expect(k.input(down('channelUp', 0))).toEqual([{ key: 'channelUp', kind: 'press', time: 0 }]);
    const events = run(k, 'channelUp', 0, 700);
    expect(events.map((e) => [e.kind, e.time])).toEqual([['repeat', 625]]);
    expect(k.input(up('channelUp', 700))).toEqual([]);
  });

  it('coalesces repeats while unacknowledged', () => {
    const k = createKeyInterpreter();
    k.input(down('right', 0));
    const events = run(k, 'right', 0, 2000, 1, false);
    expect(events.filter((e) => e.kind === 'repeat')).toHaveLength(1);
    k.acknowledge('right');
    expect(k.tick(2100).filter((e) => e.kind === 'repeat')).toHaveLength(1);
    expect(k.tick(2200)).toEqual([]);
  });

  it('emits at most one repeat for a long gap between ticks', () => {
    const k = createKeyInterpreter();
    k.input(down('up', 0));
    k.tick(500);
    expect(k.tick(10_000).filter((e) => e.kind === 'repeat')).toHaveLength(1);
  });

  it('keeps pending state per key', () => {
    const k = createKeyInterpreter();
    k.input(down('up', 0));
    k.input(down('down', 0));
    expect(k.tick(625).map((e) => `${e.key}:${e.kind}`)).toEqual([
      'up:long',
      'up:repeat',
      'down:long',
      'down:repeat',
    ]);
    k.acknowledge('up');
    expect(k.tick(750).map((e) => `${e.key}:${e.kind}`)).toEqual(['up:repeat']);
  });

  it('forgets pending repeats when the key is released and pressed again', () => {
    const k = createKeyInterpreter();
    k.input(down('up', 0));
    k.tick(625);
    k.input(up('up', 700));
    k.input(down('up', 800));
    expect(k.tick(1425).map((e) => e.kind)).toEqual(['long', 'repeat']);
  });
});

describe('reset', () => {
  it('clears held keys so nothing fires afterwards', () => {
    const k = createKeyInterpreter();
    k.input(down('up', 0));
    k.input(down('select', 0));
    k.reset();
    expect(k.tick(5000)).toEqual([]);
    expect(k.input(up('select', 5001))).toEqual([{ key: 'select', kind: 'press', time: 5001 }]);
  });
});

describe('properties', () => {
  const keyArb = fc.constantFrom<Key>(
    'up',
    'down',
    'select',
    'back',
    'digit3',
    'menu',
    'channelUp',
  );
  const stepArb = fc.record({
    key: keyArb,
    op: fc.constantFrom('down', 'up', 'tick', 'ack'),
    dt: fc.integer({ min: 0, max: 400 }),
  });

  it('never emits a second repeat for a key before it is acknowledged or released', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 120 }), (steps) => {
        const k = createKeyInterpreter();
        const pending = new Set<Key>();
        let now = 0;
        for (const s of steps) {
          now += s.dt;
          let events: KeyEvent[] = [];
          if (s.op === 'down') events = k.input(down(s.key, now));
          else if (s.op === 'up') {
            events = k.input(up(s.key, now));
            pending.delete(s.key);
          } else if (s.op === 'tick') events = k.tick(now);
          else {
            k.acknowledge(s.key);
            pending.delete(s.key);
          }
          for (const e of events) {
            if (e.kind !== 'repeat') continue;
            expect(pending.has(e.key)).toBe(false);
            pending.add(e.key);
          }
        }
      }),
    );
  });

  it('presses a step key once per fresh down at its time, never on up; other keys never on down', () => {
    const steps = new Set<Key>(['up', 'down', 'channelUp']);
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 120 }), (script) => {
        const k = createKeyInterpreter();
        const held = new Set<Key>();
        let now = 0;
        for (const s of script) {
          now += s.dt;
          if (s.op === 'down') {
            const expected =
              steps.has(s.key) && !held.has(s.key)
                ? [{ key: s.key, kind: 'press', time: now }]
                : [];
            expect(k.input(down(s.key, now))).toEqual(expected);
            held.add(s.key);
          } else if (s.op === 'up') {
            const presses = k.input(up(s.key, now)).filter((e) => e.kind === 'press');
            expect(presses.length).toBeLessThanOrEqual(steps.has(s.key) ? 0 : 1);
            held.delete(s.key);
          } else if (s.op === 'tick') {
            expect(k.tick(now).every((e) => e.kind !== 'press')).toBe(true);
          } else {
            k.acknowledge(s.key);
          }
        }
      }),
    );
  });
});
