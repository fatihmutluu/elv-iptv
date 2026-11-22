/** Default maximum number of per-screen focus snapshots retained in memory (`#440`). */
export const DEFAULT_BROWSE_FOCUS_MAX_ENTRIES = 32;

/** Bounded in-memory TV browse focus store surviving `PlayerScreen` mount/unmount (`#440`). */
export interface BrowseFocusMemory {
  get<T>(screenId: string): T | undefined;
  set<T>(screenId: string, snapshot: T): void;
  delete(screenId: string): void;
  clear(): void;
}

/** Creates a bounded LRU {@link BrowseFocusMemory} store keyed by browse screen id. */
export function createBrowseFocusMemory(
  maxEntries = DEFAULT_BROWSE_FOCUS_MAX_ENTRIES,
): BrowseFocusMemory {
  const cap = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 1;
  const entries = new Map<string, unknown>();

  return {
    get<T>(screenId: string): T | undefined {
      if (!entries.has(screenId)) return undefined;
      const value = entries.get(screenId) as T;
      entries.delete(screenId);
      entries.set(screenId, value);
      return value;
    },
    set<T>(screenId: string, snapshot: T): void {
      if (entries.has(screenId)) entries.delete(screenId);
      entries.set(screenId, snapshot);
      while (entries.size > cap) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey === undefined) break;
        entries.delete(oldestKey);
      }
    },
    delete(screenId: string): void {
      entries.delete(screenId);
    },
    clear(): void {
      entries.clear();
    },
  };
}
