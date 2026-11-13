import { describe, expect, it } from 'vitest';
import { elvError, err, ok } from './result';

describe('result', () => {
  it('wraps a value', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
  });
  it('wraps an error', () => {
    expect(err(elvError('auth', 'x'))).toEqual({
      ok: false,
      error: { category: 'auth', code: 'x' },
    });
  });
  it('omits an undefined detail', () => {
    expect('detail' in elvError('network', 'y', undefined)).toBe(false);
    expect(elvError('network', 'y', 'd')).toEqual({ category: 'network', code: 'y', detail: 'd' });
  });
});
