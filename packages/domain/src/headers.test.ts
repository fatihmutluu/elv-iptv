import { describe, expect, it } from 'vitest';
import {
  sanitizeHeaderName,
  sanitizeHeaders,
  sanitizeHeaderValue,
  transportHeaders,
} from './index';

describe('header sanitization', () => {
  it('validates RFC 7230 token header names and rejects control or delimiter chars', () => {
    expect(sanitizeHeaderName('User-Agent')).toBe('User-Agent');
    expect(sanitizeHeaderName('  x-custom_token!1  ')).toBe('x-custom_token!1');
    expect(sanitizeHeaderName('')).toBeUndefined();
    expect(sanitizeHeaderName('   ')).toBeUndefined();
    expect(sanitizeHeaderName('Bad Header')).toBeUndefined();
    expect(sanitizeHeaderName('Bad:Header')).toBeUndefined();
    expect(sanitizeHeaderName('Bad\r\nHeader')).toBeUndefined();
    expect(sanitizeHeaderName('Bad\0Header')).toBeUndefined();
    expect(sanitizeHeaderName('Bad\x7fHeader')).toBeUndefined();
    expect(sanitizeHeaderName('Üser-Agent')).toBeUndefined();
  });

  it('strips CR, LF, NUL, and ASCII control chars (0x00-0x1F, 0x7F) from header values', () => {
    expect(sanitizeHeaderValue('  Mozilla/5.0\r\nX-Injected: pwn\0\x07\x1f\x7f  ')).toBe(
      'Mozilla/5.0X-Injected: pwn',
    );
    expect(sanitizeHeaderValue('\r\n\0\t')).toBe('');
  });

  it('sanitizes header maps, drops invalid names or empty values, and avoids prototype pollution', () => {
    expect(sanitizeHeaders(undefined)).toEqual({});
    const cleaned = sanitizeHeaders({
      'User-Agent': 'MyPlayer/1.0\r\nEvil: 1',
      'Bad Name': 'ignored',
      'X-Empty': '\r\n\0',
      ['__proto__']: 'safe\nval',
      constructor: 'ctor\0val',
    });
    expect(Object.getPrototypeOf(cleaned)).toBe(Object.prototype);
    expect(cleaned['User-Agent']).toBe('MyPlayer/1.0Evil: 1');
    expect(cleaned['Bad Name']).toBeUndefined();
    expect(cleaned['X-Empty']).toBeUndefined();
    expect(Object.hasOwn(cleaned, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(cleaned, '__proto__')?.value).toBe('safeval');
    expect(cleaned.constructor).toBe('ctorval');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('sanitizes control characters in transportHeaders', () => {
    expect(
      transportHeaders({
        userAgent: 'UA\r\nInjected: 1',
        referer: '\r\n\0',
      }),
    ).toEqual({ 'user-agent': 'UAInjected: 1' });
  });
});
