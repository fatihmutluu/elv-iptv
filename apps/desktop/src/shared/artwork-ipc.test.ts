import { describe, expect, it } from 'vitest';
import {
  ARTWORK_CACHE_MAX_BYTES,
  ARTWORK_CACHE_MAX_MB,
  ARTWORK_CACHE_MIN_BYTES,
  ARTWORK_CACHE_MIN_MB,
  ARTWORK_CHANNELS,
  clampArtworkCacheLimitBytes,
  DEFAULT_ARTWORK_CACHE_BYTES,
  DEFAULT_ARTWORK_CACHE_MB,
  isArtworkSetLimitBytes,
  isDesktopArtworkCacheStats,
} from './artwork-ipc.ts';

describe('artwork-ipc contract and runtime guards (#405)', () => {
  it('defines expected channel names and MiB byte ceilings', () => {
    expect(ARTWORK_CHANNELS).toEqual({
      clear: 'artwork:clear',
      setLimit: 'artwork:set-limit',
      stats: 'artwork:stats',
    });
    expect(ARTWORK_CACHE_MIN_MB).toBe(64);
    expect(ARTWORK_CACHE_MAX_MB).toBe(256);
    expect(DEFAULT_ARTWORK_CACHE_MB).toBe(128);
    expect(ARTWORK_CACHE_MIN_BYTES).toBe(64 * 1024 * 1024);
    expect(ARTWORK_CACHE_MAX_BYTES).toBe(256 * 1024 * 1024);
    expect(DEFAULT_ARTWORK_CACHE_BYTES).toBe(128 * 1024 * 1024);
  });

  it('validates set-limit byte payloads and clamps to 64..256 MiB', () => {
    expect(isArtworkSetLimitBytes(ARTWORK_CACHE_MIN_BYTES)).toBe(true);
    expect(isArtworkSetLimitBytes(DEFAULT_ARTWORK_CACHE_BYTES)).toBe(true);
    expect(isArtworkSetLimitBytes(0)).toBe(false);
    expect(isArtworkSetLimitBytes(-10)).toBe(false);
    expect(isArtworkSetLimitBytes(Number.NaN)).toBe(false);
    expect(isArtworkSetLimitBytes(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isArtworkSetLimitBytes('128')).toBe(false);

    expect(clampArtworkCacheLimitBytes(1024)).toBe(ARTWORK_CACHE_MIN_BYTES);
    expect(clampArtworkCacheLimitBytes(512 * 1024 * 1024)).toBe(ARTWORK_CACHE_MAX_BYTES);
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
