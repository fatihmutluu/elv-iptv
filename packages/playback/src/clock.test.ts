import { describe, expect, it } from 'vitest';
import { positionAt } from './clock';

describe('positionAt', () => {
  it('advances by elapsed time times rate', () => {
    expect(positionAt({ positionMs: 1000, atMs: 500, rate: 1 }, 1500)).toBe(2000);
    expect(positionAt({ positionMs: 1000, atMs: 500, rate: 2 }, 1500)).toBe(3000);
  });

  it('holds still at rate 0', () => {
    expect(positionAt({ positionMs: 1000, atMs: 500, rate: 0 }, 9000)).toBe(1000);
  });

  it('clamps to the duration when known', () => {
    expect(positionAt({ positionMs: 1000, atMs: 0, rate: 1, durationMs: 1800 }, 5000)).toBe(1800);
  });

  it('never returns a negative position', () => {
    expect(positionAt({ positionMs: 100, atMs: 0, rate: -1 }, 5000)).toBe(0);
    expect(positionAt({ positionMs: 100, atMs: 1000, rate: 1 }, 0)).toBe(0);
  });
});
