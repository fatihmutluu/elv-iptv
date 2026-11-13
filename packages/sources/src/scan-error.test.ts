import { describe, expect, it } from 'vitest';
import { toElvError } from './scan-error';

describe('toElvError', () => {
  it('keeps ElvError-shaped values and maps the rest', () => {
    expect(toElvError({ category: 'auth', code: 'x', detail: 'd' })).toEqual({
      category: 'auth',
      code: 'x',
      detail: 'd',
    });
    expect(toElvError({ category: 'network', code: 'aborted' })).toEqual({
      category: 'network',
      code: 'aborted',
    });
    expect(toElvError(Object.assign(new Error('x'), { name: 'AbortError' }))).toEqual({
      category: 'network',
      code: 'aborted',
    });
    expect(toElvError(new Error('boom'))).toEqual({ category: 'network', code: 'stream-failed' });
    expect(toElvError(null)).toEqual({ category: 'network', code: 'stream-failed' });
    expect(toElvError({ category: 'bogus', code: 'x' })).toEqual({
      category: 'network',
      code: 'stream-failed',
    });
  });
});
