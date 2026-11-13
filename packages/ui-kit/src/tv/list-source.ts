/** Read-only data behind a windowed list. Items are fetched by index; nothing is materialised up front. */
export interface ListSource<T> {
  count(): number;
  /** The item at `index`, or `undefined` when out of range or not loaded yet. */
  get(index: number): T | undefined;
  /** Hint that `[start, end)` will be read soon. */
  prefetch(start: number, end: number): void;
  /** Subscribes to data changes (count or items). Returns an unsubscribe function. */
  onChange(listener: () => void): () => void;
}

/**
 * A source that computes items on demand and keeps the last `cacheSize` of them (least recently used), so repeated
 * reads return the same object. For gates and tests with synthetic catalogs; it never changes.
 */
export function createSyntheticSource<T>(
  count: number,
  make: (index: number) => T,
  cacheSize = 256,
): ListSource<T> {
  const cache = new Map<number, T>();
  return {
    count: () => count,
    get(index) {
      if (!Number.isInteger(index) || index < 0 || index >= count) return undefined;
      const hit = cache.get(index);
      if (hit !== undefined) {
        cache.delete(index);
        cache.set(index, hit);
        return hit;
      }
      const item = make(index);
      cache.set(index, item);
      if (cache.size > cacheSize) cache.delete(cache.keys().next().value as number);
      return item;
    },
    prefetch() {},
    onChange: () => () => {},
  };
}
