import { describe, expect, it } from 'vitest';
import { isGateMode, parsePresenterArg } from './gate-flag.ts';

describe('isGateMode', () => {
  it('is true only with the argument main adds in gate mode', () => {
    expect(isGateMode(['electron', '--type=renderer', '--elv-gate-mode'])).toBe(true);
    expect(isGateMode(['electron', '--type=renderer'])).toBe(false);
    expect(isGateMode(['--elv-gate-mode=1'])).toBe(false);
    expect(isGateMode([])).toBe(false);
  });
});

describe('parsePresenterArg', () => {
  it('parses valid presenter kinds and ignores malformed flags', () => {
    expect(parsePresenterArg(['--elv-presenter=canvas'])).toBe('canvas');
    expect(parsePresenterArg(['--elv-presenter=child-window'])).toBe('child-window');
    expect(parsePresenterArg(['--elv-presenter=own-window'])).toBe('own-window');
    expect(parsePresenterArg(['--elv-presenter=bogus'])).toBeUndefined();
    expect(parsePresenterArg([])).toBeUndefined();
  });
});
