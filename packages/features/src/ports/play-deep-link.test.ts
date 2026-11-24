import { describe, expect, it } from 'vitest';
import { parsePlayDeepLink } from './play-deep-link';

describe('parsePlayDeepLink (#273)', () => {
  it('parses valid live, movie, and episode deep links', () => {
    expect(parsePlayDeepLink('elviptv://play?key=x%3As1%3Alive%3A42&kind=live')).toEqual({
      itemKey: 'x:s1:live:42',
      kind: 'live',
    });
    expect(parsePlayDeepLink('ELVIPTV://PLAY?key=m%3As1%3Amovie%3A9&kind=movie')).toEqual({
      itemKey: 'm:s1:movie:9',
      kind: 'movie',
    });
    expect(parsePlayDeepLink('elviptv://play?kind=episode&key=x%3As1%3Aep%3A7')).toEqual({
      itemKey: 'x:s1:ep:7',
      kind: 'episode',
    });
  });

  it('omits unrecognized kind values while preserving valid itemKey', () => {
    expect(parsePlayDeepLink('elviptv://play?key=x:s1:live:1&kind=series')).toEqual({
      itemKey: 'x:s1:live:1',
    });
    expect(parsePlayDeepLink('elviptv://play?key=x:s1:live:1')).toEqual({
      itemKey: 'x:s1:live:1',
    });
  });

  it('rejects empty, wrong-scheme, malformed, control-char, and oversized deep links', () => {
    expect(parsePlayDeepLink(null)).toBeNull();
    expect(parsePlayDeepLink(undefined)).toBeNull();
    expect(parsePlayDeepLink('')).toBeNull();
    expect(parsePlayDeepLink('https://example.com/play?key=abc')).toBeNull();
    expect(parsePlayDeepLink('elviptv://play')).toBeNull();
    expect(parsePlayDeepLink('elviptv://play?kind=live')).toBeNull();
    expect(parsePlayDeepLink('elviptv://play?key=%E0%A4%A')).toBeNull();
    expect(parsePlayDeepLink('elviptv://play?key=   ')).toBeNull();
    expect(parsePlayDeepLink('elviptv://play?key=bad%0Akey')).toBeNull();
    expect(parsePlayDeepLink('elviptv://play?key=bad%7Fkey')).toBeNull();
    expect(parsePlayDeepLink(`elviptv://play?key=${'a'.repeat(513)}`)).toBeNull();
    expect(parsePlayDeepLink(`elviptv://play?key=${'a'.repeat(2050)}`)).toBeNull();
  });
});
