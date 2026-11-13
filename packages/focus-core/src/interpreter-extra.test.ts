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
  it('emits at most one repeat after a one-hour gap and resumes on the grid', () => {
    const k = createKeyInterpreter();
    k.input(down('down', 0));
    k.tick(500);
    const hour = 3_600_000;
    const events = k.tick(hour);
    expect(events.filter((e) => e.kind === 'repeat')).toHaveLength(1);
    k.acknowledge('down');
    const next = k.tick(hour + 100);
    expect(next.every((e) => e.time > hour)).toBe(true);
    expect(next.length).toBeLessThanOrEqual(1);
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
    expect(k.tick(2100).filter((e) => e.kind === 'repeat')).toHaveLength(1);
    k.acknowledge('down');
    const next = k.tick(2100 + 42);
    expect(next.filter((e) => e.kind === 'repeat').length).toBeLessThanOrEqual(1);
  });
});
