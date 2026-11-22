/** Minimum user-configurable on-device artwork disk cache ceiling in MiB (`#405`). */
export const ARTWORK_CACHE_MIN_MB = 64;
/** Maximum user-configurable on-device artwork disk cache ceiling in MiB (`#405`). */
export const ARTWORK_CACHE_MAX_MB = 256;
/** Default on-device artwork disk cache ceiling in MiB (`#405`). */
export const DEFAULT_ARTWORK_CACHE_MB = 128;

const DEFAULT_INDEX_MAX_ENTRIES = 10_000;
const DEFAULT_LOADED_URI_MAX_ENTRIES = 1_000;

/** Current occupancy and configured byte budget of an artwork disk cache (`#405`). */
export interface ArtworkCacheStats {
  readonly bytes: number;
  readonly entries: number;
  readonly maxBytes: number;
}

/** Platform-injected bounded artwork disk cache adapter passed through `UiAdaptersProvider` (`#405`). */
export interface ArtworkCacheAdapter {
  resolveUri?(uri: string, maxDecodePx: number): Promise<string | null>;
  setLimitBytes?(maxBytes: number): Promise<void>;
  clear(): Promise<void>;
  stats?(): Promise<ArtworkCacheStats>;
}

/** Serialized LRU entry returned by {@link ArtworkCacheIndex.snapshot}. */
export interface ArtworkCacheIndexEntry {
  readonly key: string;
  readonly bytes: number;
}

/** Options for {@link createArtworkCacheIndex}. */
export interface ArtworkCacheIndexOptions {
  /** Safety cap on distinct entries preventing unbounded growth on zero-byte items (default `10_000`). */
  readonly maxEntries?: number;
}

/** Pure O(1) Map-backed LRU byte-budgeted cache index (`#405`). */
export interface ArtworkCacheIndex {
  has(key: string): boolean;
  get(key: string): number | undefined;
  touch(key: string): boolean;
  put(key: string, bytes: number): string[];
  remove(key: string): boolean;
  setMaxBytes(nextMaxBytes: number): string[];
  clear(): void;
  stats(): ArtworkCacheStats;
  snapshot(): readonly ArtworkCacheIndexEntry[];
}

function normalizeNonNegativeInt(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/**
 * Creates a pure O(1) Map-backed LRU cache index enforcing a strict byte ceiling (`#405`).
 * Rejects oversized single entries (`bytes > maxBytes`) and invalid inputs without thrashing
 * existing entries, and caps entry count to prevent unbounded growth.
 */
export function createArtworkCacheIndex(
  maxBytes: number,
  options?: ArtworkCacheIndexOptions,
): ArtworkCacheIndex {
  let limitBytes = normalizeNonNegativeInt(maxBytes);
  const maxEntries = Math.max(
    1,
    normalizeNonNegativeInt(options?.maxEntries ?? DEFAULT_INDEX_MAX_ENTRIES),
  );
  const map = new Map<string, number>();
  let totalBytes = 0;

  const evictToFit = (incomingBytes: number, reserveSlot: boolean): string[] => {
    const evicted: string[] = [];
    const maxExistingEntries = reserveSlot ? maxEntries - 1 : maxEntries;
    while (
      map.size > 0 &&
      (totalBytes + incomingBytes > limitBytes || map.size > maxExistingEntries)
    ) {
      const oldest = map.entries().next().value as [string, number] | undefined;
      if (oldest === undefined) break;
      map.delete(oldest[0]);
      totalBytes -= oldest[1];
      evicted.push(oldest[0]);
    }
    return evicted;
  };

  return {
    has(key: string): boolean {
      return map.has(key);
    },
    get(key: string): number | undefined {
      return map.get(key);
    },
    touch(key: string): boolean {
      const size = map.get(key);
      if (size === undefined) return false;
      map.delete(key);
      map.set(key, size);
      return true;
    },
    put(key: string, bytes: number): string[] {
      if (key.length === 0 || !Number.isFinite(bytes) || bytes < 0) return [];
      const size = Math.floor(bytes);
      if (size > limitBytes) return [];

      const existing = map.get(key);
      if (existing !== undefined) {
        map.delete(key);
        totalBytes -= existing;
      }

      const evicted = evictToFit(size, true);
      map.set(key, size);
      totalBytes += size;
      return evicted;
    },
    remove(key: string): boolean {
      const existing = map.get(key);
      if (existing === undefined) return false;
      map.delete(key);
      totalBytes -= existing;
      return true;
    },
    setMaxBytes(nextMaxBytes: number): string[] {
      limitBytes = normalizeNonNegativeInt(nextMaxBytes);
      return evictToFit(0, false);
    },
    clear(): void {
      map.clear();
      totalBytes = 0;
    },
    stats(): ArtworkCacheStats {
      return { bytes: totalBytes, entries: map.size, maxBytes: limitBytes };
    },
    snapshot(): readonly ArtworkCacheIndexEntry[] {
      const out: ArtworkCacheIndexEntry[] = [];
      for (const [key, bytes] of map.entries()) {
        out.push({ key, bytes });
      }
      return out;
    },
  };
}

/** Bounded in-memory set of URIs loaded in the current session for zero-flicker revisits (`#405`). */
export interface LoadedUriCache {
  has(uri: string): boolean;
  markLoaded(uri: string): void;
  clear(): void;
  readonly size: number;
}

/** Creates an isolated bounded LRU registry of already-loaded artwork URIs (`#405`). */
export function createLoadedUriCache(
  maxEntries: number = DEFAULT_LOADED_URI_MAX_ENTRIES,
): LoadedUriCache {
  const limit = Math.max(1, normalizeNonNegativeInt(maxEntries));
  const uris = new Set<string>();

  return {
    has(uri: string): boolean {
      const trimmed = uri.trim();
      return trimmed.length > 0 && uris.has(trimmed);
    },
    markLoaded(uri: string): void {
      const trimmed = uri.trim();
      if (trimmed.length === 0) return;
      if (uris.has(trimmed)) {
        uris.delete(trimmed);
      } else if (uris.size >= limit) {
        const oldest = uris.values().next().value;
        if (oldest !== undefined) uris.delete(oldest);
      }
      uris.add(trimmed);
    },
    clear(): void {
      uris.clear();
    },
    get size(): number {
      return uris.size;
    },
  };
}

/** Process-wide default loaded-URI registry shared by {@link ArtworkImage} (`#405`). */
export const defaultLoadedArtworkUris: LoadedUriCache = createLoadedUriCache();
