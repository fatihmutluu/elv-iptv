import { describe, expect, it } from 'vitest';
import {
  ARTWORK_CACHE_MAX_BYTES,
  ARTWORK_CACHE_MAX_MB,
  ARTWORK_CACHE_MIN_BYTES,
  ARTWORK_CACHE_MIN_MB,
  ARTWORK_CHANNELS,
  ARTWORK_PROTOCOL_ORIGIN,
  ARTWORK_PROTOCOL_SCHEME,
  clampArtworkCacheLimitBytes,
  DEFAULT_ARTWORK_CACHE_BYTES,
  DEFAULT_ARTWORK_CACHE_MB,
  formatArtworkProtocolUrl,
  isArtworkProtocolUrl,
  isArtworkSetLimitBytes,
  isDesktopArtworkCacheStats,
  isSafeArtworkUrl,
  parseArtworkProtocolKey,
} from './artwork-ipc.ts';

const SAMPLE_KEY = 'a'.repeat(64);

describe('artwork-ipc contract and runtime guards (#405)', () => {
  it('defines expected channel names, protocol scheme, and MiB byte ceilings', () => {
    expect(ARTWORK_CHANNELS).toEqual({
      clear: 'artwork:clear',
      resolve: 'artwork:resolve',
      setLimit: 'artwork:set-limit',
      stats: 'artwork:stats',
    });
    expect(ARTWORK_PROTOCOL_SCHEME).toBe('elv-art');
    expect(ARTWORK_PROTOCOL_ORIGIN).toBe('elv-art://cache');
    expect(ARTWORK_CACHE_MIN_MB).toBe(64);
    expect(ARTWORK_CACHE_MAX_MB).toBe(512);
    expect(DEFAULT_ARTWORK_CACHE_MB).toBe(128);
    expect(ARTWORK_CACHE_MIN_BYTES).toBe(64 * 1024 * 1024);
    expect(ARTWORK_CACHE_MAX_BYTES).toBe(512 * 1024 * 1024);
    expect(DEFAULT_ARTWORK_CACHE_BYTES).toBe(128 * 1024 * 1024);
  });

  it('formats and strictly validates canonical elv-art://cache/<sha256> URLs', () => {
    const valid = formatArtworkProtocolUrl(SAMPLE_KEY);
    expect(valid).toBe(`elv-art://cache/${SAMPLE_KEY}`);
    expect(parseArtworkProtocolKey(valid)).toBe(SAMPLE_KEY);
    expect(isArtworkProtocolUrl(valid)).toBe(true);

    expect(() => formatArtworkProtocolUrl('not-a-sha256')).toThrow();
    expect(parseArtworkProtocolKey(`elv-art://cache/${'A'.repeat(64)}`)).toBeNull();
    expect(parseArtworkProtocolKey('elv-art://cache/../secret')).toBeNull();
    expect(parseArtworkProtocolKey(`elv-art://cache/${SAMPLE_KEY}?x=1`)).toBeNull();
    expect(parseArtworkProtocolKey(`elv-art://cache/${SAMPLE_KEY}#frag`)).toBeNull();
    expect(parseArtworkProtocolKey(`elv-art://other/${SAMPLE_KEY}`)).toBeNull();
    expect(parseArtworkProtocolKey(`https://cache/${SAMPLE_KEY}`)).toBeNull();
    expect(isArtworkProtocolUrl(null)).toBe(false);
    expect(isArtworkProtocolUrl(`elv-art://cache/${'a'.repeat(63)}`)).toBe(false);
  });

  it('blocks full IPv6 link-local fe80::/10 range (fe80..febf) and ULA while allowing public IPv6', () => {
    expect(isSafeArtworkUrl('http://[fe80::1]/logo.png')).toBe(false);
    expect(isSafeArtworkUrl('http://[fe90::1]/logo.png')).toBe(false);
    expect(isSafeArtworkUrl('http://[fea0::1]/logo.png')).toBe(false);
    expect(isSafeArtworkUrl('http://[febf::1]/logo.png')).toBe(false);
    expect(isSafeArtworkUrl('http://[febf:ffff::1]/logo.png')).toBe(false);
    expect(isSafeArtworkUrl('http://[fc00::1]/logo.png')).toBe(false);
    expect(isSafeArtworkUrl('http://[fd12:3456::1]/logo.png')).toBe(false);
    expect(isSafeArtworkUrl('http://[::]/logo.png')).toBe(false);
    expect(isSafeArtworkUrl('http://[::ffff:7f00:1]/logo.png')).toBe(false);

    expect(isSafeArtworkUrl('https://[2001:4860:4860::8888]/logo.png')).toBe(true);
    expect(isSafeArtworkUrl('https://[fe7f::1]/logo.png')).toBe(true);
    expect(isSafeArtworkUrl('https://[fec0::1]/logo.png')).toBe(true);
  });

  it('validates set-limit byte payloads and clamps to 64..512 MiB', () => {
    expect(isArtworkSetLimitBytes(ARTWORK_CACHE_MIN_BYTES)).toBe(true);
    expect(isArtworkSetLimitBytes(DEFAULT_ARTWORK_CACHE_BYTES)).toBe(true);
    expect(isArtworkSetLimitBytes(ARTWORK_CACHE_MAX_BYTES)).toBe(true);
    expect(isArtworkSetLimitBytes(0)).toBe(false);
    expect(isArtworkSetLimitBytes(-10)).toBe(false);
    expect(isArtworkSetLimitBytes(Number.NaN)).toBe(false);
    expect(isArtworkSetLimitBytes(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isArtworkSetLimitBytes('128')).toBe(false);

    expect(clampArtworkCacheLimitBytes(1024)).toBe(ARTWORK_CACHE_MIN_BYTES);
    expect(clampArtworkCacheLimitBytes(512 * 1024 * 1024)).toBe(512 * 1024 * 1024);
    expect(clampArtworkCacheLimitBytes(1024 * 1024 * 1024)).toBe(ARTWORK_CACHE_MAX_BYTES);
    expect(clampArtworkCacheLimitBytes(DEFAULT_ARTWORK_CACHE_BYTES)).toBe(
      DEFAULT_ARTWORK_CACHE_BYTES,
    );
    expect(clampArtworkCacheLimitBytes(Number.NaN)).toBe(DEFAULT_ARTWORK_CACHE_BYTES);
  });

  it('validates DesktopArtworkCacheStats payloads strictly', () => {
    expect(
      isDesktopArtworkCacheStats({
        bytes: 1024,
        entries: 3,
        maxBytes: DEFAULT_ARTWORK_CACHE_BYTES,
      }),
    ).toBe(true);
    expect(isDesktopArtworkCacheStats(null)).toBe(false);
    expect(isDesktopArtworkCacheStats({ bytes: -1, entries: 0, maxBytes: 100 })).toBe(false);
    expect(isDesktopArtworkCacheStats({ bytes: 0, entries: 1.5, maxBytes: 100 })).toBe(false);
    expect(isDesktopArtworkCacheStats({ bytes: 0, entries: 0, maxBytes: Number.NaN })).toBe(false);
  });
});
