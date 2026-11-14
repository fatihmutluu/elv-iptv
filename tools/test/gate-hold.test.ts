import { LONG_PRESS_MS, REPEAT_FAST_HZ, REPEAT_RAMP_MS, REPEAT_START_HZ } from '@elv/focus-core';
import { describe, expect, it } from 'vitest';
import { expectedHoldMoves, HOLD_CONSTANTS } from '../src/gates/hold.ts';

describe('expectedHoldMoves', () => {
  it.each([
    [400, 1],
    [500, 2],
    [625, 2],
    [626, 3],
    [2000, 13],
    [2100, 16],
  ])('a %i ms hold gives %i moves', (holdMs, moves) => {
    expect(expectedHoldMoves(holdMs)).toBe(moves);
  });

  it('mirrors the focus-core constants', () => {
    expect(HOLD_CONSTANTS).toEqual({
      longPressMs: LONG_PRESS_MS,
      repeatStartHz: REPEAT_START_HZ,
      repeatFastHz: REPEAT_FAST_HZ,
      repeatRampMs: REPEAT_RAMP_MS,
    });
  });
});
