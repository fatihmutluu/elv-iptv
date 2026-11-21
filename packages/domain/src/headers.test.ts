import { describe, expect, it } from 'vitest';
import {
  hasCredentialHeaders,
  originOf,
  sameOrigin,
  sanitizeHeaderName,
  sanitizeHeaders,
  sanitizeHeaderValue,
  scopeCredentialHeaders,
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

describe('exact-origin credential header scoping', () => {
  it('parses and normalizes origins with default-port stripping, userinfo removal, and IPv6 support', () => {
    expect(originOf('HTTP://Example.COM:80/a/b?x=1#frag')).toBe('http://example.com');
    expect(originOf('https://Example.COM:443/live/1.ts')).toBe('https://example.com');
    expect(originOf('https://Example.COM:8443/live/1.ts')).toBe('https://example.com:8443');
    expect(originOf('http://Example.COM:443/live')).toBe('http://example.com:443');
    expect(originOf('https://Example.COM:80/live')).toBe('https://example.com:80');
    expect(originOf('http://Example.COM:0080/live')).toBe('http://example.com');
    expect(originOf('http://Example.COM:08080/live')).toBe('http://example.com:8080');
    expect(originOf('http://Example.COM:/live')).toBe('http://example.com');
    expect(originOf('http://user:p@ss@Example.COM:80/path')).toBe('http://example.com');
    expect(originOf('http://[::1]:80/a')).toBe('http://[::1]');
    expect(originOf('https://[2001:DB8::1]:443/a')).toBe('https://[2001:db8::1]');
    expect(originOf('https://[2001:DB8::1]:8443/a')).toBe('https://[2001:db8::1]:8443');
    expect(originOf('http://evil.example\\@good.example/a')).toBe('http://evil.example');
  });

  it.each([
    '',
    '/relative/path',
    '//protocol-relative.example/path',
    'data:text/plain,hello',
    'javascript:alert(1)',
    'javascript://foo.com/%0aalert(1)',
    'file://host/etc/passwd',
    'file:///etc/passwd',
    'ftp://example.com/stream.ts',
    'ws://example.com/socket',
    'http://',
    'http:///path',
    'http://user:pass@/path',
    'http://:80/path',
    'http://example.com:99999/a',
    'http://example.com:abc/a',
    'http://[::1/a',
    'http://[::1]extra/a',
    'http://[]/a',
    'http://bad host/a',
    'http://bad\r\nhost/a',
    '1bad://example.com/a',
  ])('returns undefined for invalid or non-origin URL %j', (raw) => {
    expect(originOf(raw)).toBeUndefined();
  });

  it('compares origins accurately with sameOrigin', () => {
    expect(sameOrigin('HTTP://A.Example:80/one', 'http://user:pw@a.example/two?q=1#h')).toBe(true);
    expect(sameOrigin('https://a.example:443/x', 'https://a.example/y')).toBe(true);
    expect(sameOrigin('http://a.example/x', 'https://a.example/x')).toBe(false);
    expect(sameOrigin('http://a.example:8080/x', 'http://a.example:8081/x')).toBe(false);
    expect(sameOrigin('http://sub.a.example/x', 'http://a.example/x')).toBe(false);
    expect(sameOrigin('file://host/a', 'file://host/b')).toBe(false);
    expect(sameOrigin('ftp://a.example/x', 'ftp://a.example/y')).toBe(false);
    expect(sameOrigin('/relative', '/relative')).toBe(false);
  });

  it('detects credential headers case-insensitively and ignores empty or non-credential headers', () => {
    expect(hasCredentialHeaders(undefined)).toBe(false);
    expect(hasCredentialHeaders({})).toBe(false);
    expect(hasCredentialHeaders({ 'User-Agent': 'ELV/1.0', Referer: 'https://a.example' })).toBe(
      false,
    );
    expect(hasCredentialHeaders({ Authorization: '\r\n   ' })).toBe(false);
    expect(hasCredentialHeaders({ Authorization: 'Bearer tok' })).toBe(true);
    expect(hasCredentialHeaders({ authorization: 'Basic abc' })).toBe(true);
    expect(hasCredentialHeaders({ 'Proxy-Authorization': 'Basic xyz' })).toBe(true);
    expect(hasCredentialHeaders({ Cookie: 'sid=1' })).toBe(true);
    expect(hasCredentialHeaders({ ' cookie ': 'sid=1' })).toBe(true);
  });

  it('keeps sanitized credentials on same-origin requests and strips them cross-origin', () => {
    const raw = {
      Authorization: 'Bearer secret\r\nX-Evil: 1',
      'Proxy-Authorization': 'Basic proxy',
      Cookie: 'sid=abc',
      'User-Agent': 'ELV/1.0\n',
      'Bad Header': 'dropped',
    };

    expect(
      scopeCredentialHeaders(raw, 'https://Origin.Example:443/a', 'https://origin.example/b'),
    ).toEqual({
      Authorization: 'Bearer secretX-Evil: 1',
      'Proxy-Authorization': 'Basic proxy',
      Cookie: 'sid=abc',
      'User-Agent': 'ELV/1.0',
    });

    expect(
      scopeCredentialHeaders(raw, 'https://origin.example/a', 'https://cdn.example/b'),
    ).toEqual({
      'User-Agent': 'ELV/1.0',
    });

    expect(
      scopeCredentialHeaders(raw, 'https://origin.example/a', 'http://origin.example/b'),
    ).toEqual({
      'User-Agent': 'ELV/1.0',
    });

    expect(
      scopeCredentialHeaders(raw, 'https://origin.example/a', 'https://origin.example:8443/b'),
    ).toEqual({
      'User-Agent': 'ELV/1.0',
    });
  });
});
