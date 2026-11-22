import { describe, expect, it } from 'vitest';
import { createCookieJar } from './cookie-jar';

describe('createCookieJar (#171)', () => {
  it('stores and returns cookies strictly for exact origin (ignoring Domain widening)', () => {
    const jar = createCookieJar();
    jar.store(
      'https://panel.example:443/live/index.m3u8',
      'sid=abc123; Domain=.example; Path=/; HttpOnly',
    );

    // Same origin (default port normalized)
    expect(jar.headerFor('https://panel.example/live/seg1.ts')).toBe('sid=abc123');
    expect(jar.headerFor('https://PANEL.EXAMPLE:443/vod/1.mp4')).toBe('sid=abc123');

    // Cross-origin: subdomain, parent domain, sibling host, different port, scheme downgrade -> NEVER leaked
    expect(jar.headerFor('https://cdn.panel.example/live/seg1.ts')).toBeUndefined();
    expect(jar.headerFor('https://example/live/seg1.ts')).toBeUndefined();
    expect(jar.headerFor('https://other.example/live/seg1.ts')).toBeUndefined();
    expect(jar.headerFor('https://panel.example:8443/live/seg1.ts')).toBeUndefined();
    expect(jar.headerFor('http://panel.example/live/seg1.ts')).toBeUndefined();
  });

  it('parses single combined Set-Cookie strings with Expires commas and string arrays', () => {
    const now = Date.UTC(2026, 9, 1, 0, 0, 0); // 2026-10-01
    const jar = createCookieJar({ now: () => now });

    // Single comma-joined header containing IMF-fixdate and RFC 850 commas inside Expires
    jar.store(
      'https://cdn.example/stream/play.m3u8',
      'tok=val1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, edge=eu1; Expires=Sunday, 25-Oct-26 08:49:37 GMT; Path=/stream, flag=ok',
    );
    expect(jar.headerFor('https://cdn.example/stream/seg1.ts')).toBe('edge=eu1; flag=ok; tok=val1');

    // Array of Set-Cookie headers (e.g. Headers.getSetCookie())
    const jar2 = createCookieJar({ now: () => now });
    jar2.store('https://cdn.example/stream/play.m3u8', [
      'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/',
      'b="x,y=z"; Path=/stream',
    ]);
    expect(jar2.headerFor('https://cdn.example/stream/seg.ts')).toBe('b="x,y=z"; a=1');
  });

  it('applies RFC 6265 default path, path matching, and longest-path-first ordering', () => {
    const jar = createCookieJar();
    jar.store('https://panel.example/live/hd/index.m3u8', [
      'root=r; Path=/',
      'def=d', // default path -> /live/hd
      'live=l; Path=/live',
      'slash=s; Path=/live/',
      'rel=x; Path=not-leading-slash', // invalid path -> falls back to default path /live/hd
    ]);

    // Exact and nested path matching + longer paths first
    expect(jar.headerFor('https://panel.example/live/hd/seg1.ts')).toBe(
      'def=d; rel=x; slash=s; live=l; root=r',
    );
    expect(jar.headerFor('https://panel.example/live/sd/seg1.ts')).toBe('slash=s; live=l; root=r');
    expect(jar.headerFor('https://panel.example/live')).toBe('live=l; root=r');
    // /live2 must NOT match Path=/live
    expect(jar.headerFor('https://panel.example/live2/seg1.ts')).toBe('root=r');
    expect(jar.headerFor('https://panel.example/')).toBe('root=r');

    // Default path for top-level file is /
    const jarTop = createCookieJar();
    jarTop.store('https://panel.example/index.m3u8', 'top=1');
    expect(jarTop.headerFor('https://panel.example/other/seg.ts')).toBe('top=1');
  });

  it('enforces Secure flag and never emits Secure cookies over http://', () => {
    const jar = createCookieJar();
    jar.store('https://panel.example/live/1', 'sec=1; Path=/; Secure');
    jar.store('http://panel.example/live/1', ['plain=ok; Path=/', 'badsec=no; Path=/; Secure']);

    expect(jar.headerFor('https://panel.example/live/2')).toBe('sec=1');
    expect(jar.headerFor('http://panel.example/live/2')).toBe('plain=ok');
  });

  it('respects Max-Age precedence over Expires, drops expired cookies immediately, and evicts on expiry', () => {
    let clock = Date.UTC(2026, 9, 1, 0, 0, 0);
    const jar = createCookieJar({ now: () => clock });

    // Max-Age wins over past Expires
    jar.store(
      'https://panel.example/a',
      'alive=1; Path=/; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    );
    // Expires used when Max-Age is absent or invalid
    jar.store(
      'https://panel.example/a',
      'exp=2; Path=/; Max-Age=notanumber; Expires=Thu, 01 Oct 2026 00:00:30 GMT',
    );
    expect(jar.headerFor('https://panel.example/a')).toBe('alive=1; exp=2');

    // Advance 31s -> exp expired, alive still valid
    clock += 31_000;
    expect(jar.headerFor('https://panel.example/a')).toBe('alive=1');

    // Max-Age=0 wins over future Expires and deletes immediately
    jar.store(
      'https://panel.example/a',
      'alive=gone; Path=/; Max-Age=0; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
    );
    expect(jar.headerFor('https://panel.example/a')).toBeUndefined();
    expect(jar.size).toBe(0);

    // Negative Max-Age and past Expires never store and delete existing
    jar.store('https://panel.example/a', 'temp=1; Path=/');
    jar.store('https://panel.example/a', 'temp=0; Path=/; Max-Age=-5');
    expect(jar.headerFor('https://panel.example/a')).toBeUndefined();

    jar.store('https://panel.example/a', 'temp2=1; Path=/');
    jar.store('https://panel.example/a', 'temp2=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(jar.headerFor('https://panel.example/a')).toBeUndefined();
  });

  it('bounds memory at maxCookies (default 128), evicts oldest, and updates existing in place', () => {
    let clock = 1_000_000;
    const jar = createCookieJar({ maxCookies: 3, now: () => clock });

    jar.store('https://panel.example/', 'c1=1; Path=/');
    jar.store('https://panel.example/', 'c2=2; Path=/');
    jar.store('https://panel.example/', 'c3=3; Path=/');
    expect(jar.size).toBe(3);

    // Updating c1 refreshes it so c2 becomes oldest
    jar.store('https://panel.example/', 'c1=1b; Path=/');
    expect(jar.size).toBe(3);

    // Adding c4 evicts c2
    jar.store('https://panel.example/', 'c4=4; Path=/');
    expect(jar.size).toBe(3);
    expect(jar.headerFor('https://panel.example/')).toBe('c3=3; c1=1b; c4=4');

    // Default cap is 128
    const defaultJar = createCookieJar();
    for (let i = 0; i < 150; i++) {
      defaultJar.store('https://panel.example/', `k${i}=${i}; Path=/`);
    }
    expect(defaultJar.size).toBe(128);
    expect(defaultJar.headerFor('https://panel.example/')).not.toContain('k0=0');
    expect(defaultJar.headerFor('https://panel.example/')).toContain('k149=149');

    // Purges expired cookies before evicting live entries
    const expJar = createCookieJar({ maxCookies: 2, now: () => clock });
    expJar.store('https://panel.example/', 'short=1; Path=/; Max-Age=5');
    expJar.store('https://panel.example/', 'long=2; Path=/; Max-Age=60');
    clock += 10_000;
    expJar.store('https://panel.example/', 'fresh=3; Path=/; Max-Age=60');
    expect(expJar.headerFor('https://panel.example/')).toBe('long=2; fresh=3');

    expJar.clear();
    expect(expJar.size).toBe(0);
    expect(expJar.headerFor('https://panel.example/')).toBeUndefined();
  });

  it('ignores malformed headers, control characters, and non-HTTP(S) URLs', () => {
    const jar = createCookieJar();
    jar.store('https://panel.example/', undefined);
    jar.store('file:///etc/passwd', 'a=1; Path=/');
    jar.store('https://panel.example/', [
      'no-equals-sign',
      '=empty-name',
      'bad name=1',
      'good=val\r\nInjected: 1; Path=/',
      'emptyval=; Path=/',
    ]);

    expect(jar.headerFor('file:///etc/passwd')).toBeUndefined();
    expect(jar.headerFor('https://panel.example/')).toBe('good=valInjected: 1; emptyval=');
  });
});
