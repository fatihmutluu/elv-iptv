import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { m3uKey, normalizeStreamUrl, xtreamKey } from './content-key';
import { transportHeaders } from './source';

describe('transportHeaders', () => {
  it('maps settings to lower-case headers', () => {
    expect(transportHeaders({ userAgent: 'A', referer: 'R' })).toEqual({
      'user-agent': 'A',
      referer: 'R',
    });
    expect(transportHeaders({ xtreamFormat: 'ts' })).toEqual({});
    expect(transportHeaders(undefined)).toEqual({});
  });
});

describe('normalizeStreamUrl', () => {
  it('strips credentials, default port, query, fragment and masks path credentials', () => {
    expect(normalizeStreamUrl('HTTP://User:Pw@Example.COM:80/live/u/p/12.ts?token=1#x')).toBe(
      'http://example.com/live/*/*/12.ts',
    );
    expect(normalizeStreamUrl('https://h/u/p/12')).toBe('https://h/*/*/12');
    expect(normalizeStreamUrl('https://h:443/movie/u/p/7.mkv')).toBe('https://h/movie/*/*/7.mkv');
    expect(normalizeStreamUrl('https://h:8443/movie/u/p/7.mkv')).toBe(
      'https://h:8443/movie/*/*/7.mkv',
    );
    expect(normalizeStreamUrl('https://h/series/u/p/9.mp4')).toBe('https://h/series/*/*/9.mp4');
    expect(normalizeStreamUrl('http://h/timeshift/u/p/60/2026-01-01:10-00/12.ts?sig=1')).toBe(
      'http://h/timeshift/*/*/60/2026-01-01:10-00/12.ts',
    );
    expect(normalizeStreamUrl('https://h/hls/x.m3u8?t=1')).toBe('https://h/hls/x.m3u8?t=1');
  });
  it('returns an unparsable url trimmed', () => {
    expect(normalizeStreamUrl('  not a url  ')).toBe('not a url');
  });
  it('keeps distinct streams apart', () => {
    const a = normalizeStreamUrl('http://h/play/index.m3u8?channel=7');
    const b = normalizeStreamUrl('http://h/play/index.m3u8?channel=8');
    expect(a).not.toBe(b);
    expect(a).toBe('http://h/play/index.m3u8?channel=7');
    expect(normalizeStreamUrl('http://h/a/b/index.m3u8')).not.toBe(
      normalizeStreamUrl('http://h/c/b/index.m3u8'),
    );
    expect(normalizeStreamUrl('http://h/live/u/p/news.m3u8')).not.toBe(
      normalizeStreamUrl('http://h/live/u/p/sport.m3u8'),
    );
    expect(normalizeStreamUrl('http://h/x/y/7/extra')).toBe('http://h/x/y/7/extra');
    expect(normalizeStreamUrl('http://h/x/y/7')).toBe('http://h/*/*/7');
  });
  it('drops only credential and token parameters and sorts the rest', () => {
    expect(
      normalizeStreamUrl('http://h/p.m3u8?z=1&Token=a&b=2&SIG=x&e=9&St=1&hash=h&Key=k&auth=a'),
    ).toBe('http://h/p.m3u8?b=2&z=1');
    expect(normalizeStreamUrl('http://h/p?username=u&password=p&pass=1&user=2&pwd=3')).toBe(
      'http://h/p',
    );
    expect(normalizeStreamUrl('http://h/p?b=2&a=1')).toBe(normalizeStreamUrl('http://h/p?a=1&b=2'));
  });
  it('strips userinfo from an unparsable value', () => {
    expect(normalizeStreamUrl('  zz/u:p@host/x ')).toBe('host/x');
    expect(normalizeStreamUrl('user:pw@host')).toBe('host');
  });
  it('ignores credentials and token parameters', () => {
    const word = fc.stringMatching(/^[a-z0-9]{1,8}$/);
    const names = fc.constantFrom('token', 'password', 'username', 'sig', 'auth', 'Key', 'e');
    fc.assert(
      fc.property(word, word, names, word, (user, pass, key, val) => {
        const base = normalizeStreamUrl('http://h.example/live/a/b/5.ts');
        expect(
          normalizeStreamUrl(`http://${user}:${pass}@h.example/live/a/b/5.ts?${key}=${val}`),
        ).toBe(base);
      }),
    );
  });
});

describe('keys', () => {
  it('builds xtream keys', () => {
    expect(xtreamKey('s1', 'live', 42)).toBe(xtreamKey('s1', 'live', '42'));
    expect(xtreamKey('s1', 'live', 42)).not.toBe(xtreamKey('s2', 'live', 42));
    expect(xtreamKey('s1', 'live', 42)).not.toBe(xtreamKey('s1', 'movie', 42));
  });
  it('builds stable m3u keys', () => {
    const a = m3uKey('s1', 'http://u:p@h/live/a/b/1.ts?token=1', 'News');
    expect(m3uKey('s1', 'http://h/live/c/d/1.ts?token=2', 'News')).toBe(a);
    expect(m3uKey('s1', 'http://h/timeshift/a/b/60/t/1.ts', 'N')).toBe(
      m3uKey('s1', 'http://h/timeshift/c/d/60/t/1.ts', 'N'),
    );
    expect(m3uKey('s1', 'http://h/live/c/d/1.ts', 'Sports')).not.toBe(a);
  });
});
