import {
  ARTWORK_CACHE_MAX_MB,
  ARTWORK_CACHE_MIN_MB,
  createArtworkCacheIndex,
  createLoadedUriCache,
  DEFAULT_ARTWORK_CACHE_MB,
} from '../artwork-cache';

describe('artwork-cache constants & pure LRU index (#405)', () => {
  it('exports the expected MiB bounds and default', () => {
    expect(ARTWORK_CACHE_MIN_MB).toBe(64);
    expect(ARTWORK_CACHE_MAX_MB).toBe(512);
    expect(DEFAULT_ARTWORK_CACHE_MB).toBe(128);
  });

  it('tracks bytes/entries and evicts least-recently-used keys when exceeding maxBytes', () => {
    const index = createArtworkCacheIndex(100);
    expect(index.stats()).toEqual({ bytes: 0, entries: 0, maxBytes: 100 });

    expect(index.put('a', 40)).toEqual([]);
    expect(index.put('b', 40)).toEqual([]);
    expect(index.stats()).toEqual({ bytes: 80, entries: 2, maxBytes: 100 });

    // Touch 'a' so 'b' becomes LRU
    expect(index.touch('a')).toBe(true);
    expect(index.touch('missing')).toBe(false);

    // Adding 'c' (40 bytes) must evict 'b' first
    expect(index.put('c', 40)).toEqual(['b']);
    expect(index.has('b')).toBe(false);
    expect(index.has('a')).toBe(true);
    expect(index.has('c')).toBe(true);
    expect(index.stats()).toEqual({ bytes: 80, entries: 2, maxBytes: 100 });
    expect(index.snapshot()).toEqual([
      { key: 'a', bytes: 40 },
      { key: 'c', bytes: 40 },
    ]);
  });

  it('rejects oversized single entries (> maxBytes) and invalid inputs without thrashing', () => {
    const index = createArtworkCacheIndex(100);
    index.put('a', 60);
    index.put('b', 30);

    expect(index.put('giant', 101)).toEqual([]);
    expect(index.has('giant')).toBe(false);
    expect(index.has('a')).toBe(true);
    expect(index.has('b')).toBe(true);
    expect(index.stats()).toEqual({ bytes: 90, entries: 2, maxBytes: 100 });

    expect(index.put('', 10)).toEqual([]);
    expect(index.put('neg', -5)).toEqual([]);
    expect(index.put('nan', Number.NaN)).toEqual([]);
    expect(index.put('inf', Number.POSITIVE_INFINITY)).toEqual([]);
    expect(index.stats()).toEqual({ bytes: 90, entries: 2, maxBytes: 100 });
  });

  it('updates size & MRU order on overwrite and supports remove, setMaxBytes, and clear', () => {
    const index = createArtworkCacheIndex(100);
    index.put('a', 30);
    index.put('b', 30);
    index.put('c', 30);

    // Overwriting 'a' to 50 bytes promotes 'a' and evicts 'b' (total 90 + 20 = 110 > 100)
    expect(index.put('a', 50)).toEqual(['b']);
    expect(index.stats()).toEqual({ bytes: 80, entries: 2, maxBytes: 100 });
    expect(index.get('a')).toBe(50);

    // Shrinking limit evicts oldest ('c') first
    expect(index.setMaxBytes(50)).toEqual(['c']);
    expect(index.stats()).toEqual({ bytes: 50, entries: 1, maxBytes: 50 });

    // Expanding limit preserves entries
    expect(index.setMaxBytes(200)).toEqual([]);
    expect(index.stats()).toEqual({ bytes: 50, entries: 1, maxBytes: 200 });

    // Remove and clear
    expect(index.remove('a')).toBe(true);
    expect(index.remove('a')).toBe(false);
    expect(index.stats()).toEqual({ bytes: 0, entries: 0, maxBytes: 200 });

    index.put('d', 40);
    index.clear();
    expect(index.stats()).toEqual({ bytes: 0, entries: 0, maxBytes: 200 });
  });

  it('enforces maxEntries ceiling so 0-byte entries cannot grow unbounded', () => {
    const index = createArtworkCacheIndex(1024, { maxEntries: 3 });
    index.put('k1', 0);
    index.put('k2', 0);
    index.put('k3', 0);
    expect(index.put('k4', 0)).toEqual(['k1']);
    expect(index.stats()).toEqual({ bytes: 0, entries: 3, maxBytes: 1024 });
  });
});

describe('createLoadedUriCache (#405)', () => {
  it('tracks loaded URIs synchronously with bounded LRU eviction and clear', () => {
    const cache = createLoadedUriCache(2);
    expect(cache.has('https://img.example/1.jpg')).toBe(false);

    cache.markLoaded('https://img.example/1.jpg');
    cache.markLoaded('https://img.example/2.jpg');
    expect(cache.has('https://img.example/1.jpg')).toBe(true);
    expect(cache.size).toBe(2);

    // Re-marking 1 refreshes it so 2 is evicted on 3
    cache.markLoaded('https://img.example/1.jpg');
    cache.markLoaded('https://img.example/3.jpg');
    expect(cache.has('https://img.example/1.jpg')).toBe(true);
    expect(cache.has('https://img.example/2.jpg')).toBe(false);
    expect(cache.has('https://img.example/3.jpg')).toBe(true);

    // Empty / whitespace URIs are ignored
    cache.markLoaded('   ');
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has('https://img.example/1.jpg')).toBe(false);
  });
});
