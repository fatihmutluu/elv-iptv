import { describe, expect, it } from 'vitest';
import { createKeyInterpreter } from './interpreter';
import type { Key } from './keys';

const down = (key: Key, time: number) => ({ key, action: 'down' as const, time });

describe('native long input', () => {
  it('passes a long action through as one long event at its time', () => {
    const k = createKeyInterpreter();
    expect(k.input({ key: 'select', action: 'long', time: 40 })).toEqual([
      { key: 'select', kind: 'long', time: 40 },
    ]);
  });

  it('passes it through for keys outside longKeys', () => {
    const k = createKeyInterpreter({ longKeys: [] });
    expect(k.input({ key: 'menu', action: 'long', time: 7 })).toEqual([
      { key: 'menu', kind: 'long', time: 7 },
    ]);
  });

  it('turns a digit long input into a press', () => {
    const k = createKeyInterpreter();
    expect(k.input({ key: 'digit5', action: 'long', time: 9 })).toEqual([
      { key: 'digit5', kind: 'press', time: 9 },
    ]);
  });
});

describe('large clock jumps', () => {
  it('emits one repeat after a one-hour gap and resumes on the fast grid', () => {
    const k = createKeyInterpreter();
    k.input(down('down', 0));
    expect(k.tick(500)).toEqual([{ key: 'down', kind: 'long', time: 500 }]);
    const hour = 3_600_000;
    expect(k.tick(hour)).toEqual([{ key: 'down', kind: 'repeat', time: 625 }]);
    k.acknowledge('down');
    const next = k.tick(hour + 100);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ key: 'down', kind: 'repeat' });
    expect(next[0]?.time).toBeCloseTo(hour + 1000 / 24, 6);
  });

  it('ignores a non-finite now', () => {
    const k = createKeyInterpreter();
    k.input(down('down', 0));
    expect(k.tick(Number.POSITIVE_INFINITY)).toEqual([]);
    expect(k.tick(Number.NaN)).toEqual([]);
    expect(k.tick(700).map((e) => e.kind)).toEqual(['long', 'repeat']);
  });

  it('crosses from the slow to the fast rate within one jump', () => {
    const k = createKeyInterpreter();
    k.input(down('down', 0));
    expect(k.tick(2100)).toEqual([
      { key: 'down', kind: 'long', time: 500 },
      { key: 'down', kind: 'repeat', time: 625 },
    ]);
    k.acknowledge('down');
    expect(k.tick(2100 + 42)).toEqual([{ key: 'down', kind: 'repeat', time: 2125 }]);
  });
});
