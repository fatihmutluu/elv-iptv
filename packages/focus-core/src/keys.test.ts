import { describe, expect, it } from 'vitest';
import {
  ARROW_KEYS,
  DIGIT_KEYS,
  isDigitKey,
  LONG_PRESS_MS,
  REPEAT_FAST_HZ,
  REPEAT_RAMP_MS,
  REPEAT_START_HZ,
} from './keys';

describe('key constants', () => {
  it('pins the documented thresholds', () => {
    expect(LONG_PRESS_MS).toBe(500);
    expect(REPEAT_START_HZ).toBe(8);
    expect(REPEAT_FAST_HZ).toBe(24);
    expect(REPEAT_RAMP_MS).toBe(1500);
  });

  it('lists ten digits and four arrows', () => {
    expect(DIGIT_KEYS).toHaveLength(10);
    expect(ARROW_KEYS).toEqual(['up', 'down', 'left', 'right']);
  });

  it('recognises digit keys only', () => {
    expect(isDigitKey('digit7')).toBe(true);
    expect(isDigitKey('select')).toBe(false);
  });
});
