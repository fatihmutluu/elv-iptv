import {
  createKvPreferencesStore,
  createMemoryPreferencesStore,
  type PreferencesKvBackend,
  type PreferencesStore,
} from '@elv/domain';

type WebStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function safeWindowLocalStorage(): WebStorageLike | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const candidate = window.localStorage;
    if (
      candidate !== null &&
      candidate !== undefined &&
      typeof candidate.getItem === 'function' &&
      typeof candidate.setItem === 'function' &&
      typeof candidate.removeItem === 'function'
    ) {
      return candidate;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function createWebStorageBackend(storage: WebStorageLike): PreferencesKvBackend {
  return {
    get(key) {
      const value = storage.getItem(key);
      return typeof value === 'string' ? value : undefined;
    },
    set(key, value) {
      storage.setItem(key, value);
    },
    delete(key) {
      storage.removeItem(key);
    },
  };
}

/**
 * Creates the desktop renderer {@link PreferencesStore}, backed by `window.localStorage`
 * (or an injected Web Storage implementation) with an automatic in-memory fallback when
 * browser storage is unavailable or blocked by privacy settings.
 */
export function createDesktopPreferencesStore(storage?: WebStorageLike): PreferencesStore {
  const resolved = storage ?? safeWindowLocalStorage();
  if (resolved === undefined) {
    return createMemoryPreferencesStore();
  }
  return createKvPreferencesStore(createWebStorageBackend(resolved), undefined, {
    coalesceMs: 500,
  });
}
