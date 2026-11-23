import { describe, expect, it } from 'vitest';
import { createKeyInterpreter } from './interpreter';
import {
  ARROW_KEYS,
  COLOR_KEYS,
  DIGIT_KEYS,
  isColorKey,
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

  it('lists ten digits, four arrows, and four programmable color keys', () => {
    expect(DIGIT_KEYS).toHaveLength(10);
    expect(ARROW_KEYS).toEqual(['up', 'down', 'left', 'right']);
    expect(COLOR_KEYS).toEqual(['colorRed', 'colorGreen', 'colorYellow', 'colorBlue']);
  });

  it('recognises digit keys and color keys accurately', () => {
    expect(isDigitKey('digit7')).toBe(true);
    expect(isDigitKey('select')).toBe(false);
    expect(isDigitKey('play')).toBe(false);
    expect(isDigitKey('pause')).toBe(false);
    expect(isDigitKey('stop')).toBe(false);
    expect(isDigitKey('rewind')).toBe(false);
    expect(isDigitKey('fastForward')).toBe(false);
    expect(isDigitKey('next')).toBe(false);
    expect(isDigitKey('previous')).toBe(false);
    expect(isDigitKey('captions')).toBe(false);
    expect(isDigitKey('audioTrack')).toBe(false);
    expect(isDigitKey('guide')).toBe(false);
    expect(isDigitKey('info')).toBe(false);
    expect(isDigitKey('search')).toBe(false);
    expect(isDigitKey('lastChannel')).toBe(false);

    for (const key of COLOR_KEYS) {
      expect(isColorKey(key)).toBe(true);
      expect(isDigitKey(key)).toBe(false);
    }
    expect(isColorKey('select')).toBe(false);
    expect(isColorKey('digit0')).toBe(false);
  });

  it('interprets programmable color keys as press on release without default repeat', () => {
    const interpreter = createKeyInterpreter();
    for (const key of COLOR_KEYS) {
      expect(interpreter.input({ key, action: 'down', time: 100 })).toEqual([]);
      expect(interpreter.tick(1000)).toEqual([]);
      expect(interpreter.input({ key, action: 'up', time: 1100 })).toEqual([
        { key, kind: 'press', time: 1100 },
      ]);
    }
  });
});
