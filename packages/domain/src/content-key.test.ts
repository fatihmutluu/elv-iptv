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
    expect(normalizeStreamUrl('http://h/timeshift/u/p/60/2026-01-01:10-00/12.ts?x=1')).toBe(
      'http://h/timeshift/*/*/60/2026-01-01:10-00/12.ts',
    );
    expect(normalizeStreamUrl('https://h/hls/x.m3u8?t=1')).toBe('https://h/hls/x.m3u8');
  });
  it('returns an unparsable url trimmed', () => {
    expect(normalizeStreamUrl('  not a url  ')).toBe('not a url');
  });
  it('ignores credentials and query strings', () => {
    const word = fc.stringMatching(/^[a-z0-9]{1,8}$/);
    fc.assert(
      fc.property(word, word, word, word, (user, pass, key, val) => {
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
    const a = m3uKey('s1', 'http://u:p@h/live/a/b/1.ts?x=1', 'News');
    expect(m3uKey('s1', 'http://h/live/c/d/1.ts?x=2', 'News')).toBe(a);
    expect(m3uKey('s1', 'http://h/timeshift/a/b/60/t/1.ts', 'N')).toBe(
      m3uKey('s1', 'http://h/timeshift/c/d/60/t/1.ts', 'N'),
    );
    expect(m3uKey('s1', 'http://h/live/c/d/1.ts', 'Sports')).not.toBe(a);
  });
});
