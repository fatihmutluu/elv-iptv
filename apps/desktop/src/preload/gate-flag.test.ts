import { describe, expect, it } from 'vitest';
import { isGateMode } from './gate-flag.ts';

describe('isGateMode', () => {
  it('is true only with the argument main adds in gate mode', () => {
    expect(isGateMode(['electron', '--type=renderer', '--elv-gate-mode'])).toBe(true);
    expect(isGateMode(['electron', '--type=renderer'])).toBe(false);
    expect(isGateMode(['--elv-gate-mode=1'])).toBe(false);
    expect(isGateMode([])).toBe(false);
  });
});
