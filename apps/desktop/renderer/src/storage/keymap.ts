import {
  createKeymapStore,
  type KeymapStore,
  type KeymapStoreOptions,
  type PreferencesKvBackend,
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

function createMemoryKvBackend(): PreferencesKvBackend {
  const data = new Map<string, string>();
  return {
    get: (key) => data.get(key),
    set: (key, value) => {
      data.set(key, value);
    },
    delete: (key) => {
      data.delete(key);
    },
  };
}

/**
 * Creates the desktop renderer {@link KeymapStore} (`#33`), backed by `window.localStorage`
 * (or an injected Web Storage implementation) with an automatic in-memory fallback when
 * browser storage is unavailable or blocked.
 */
export function createDesktopKeymapStore(
  storage?: WebStorageLike,
  opts?: KeymapStoreOptions,
): KeymapStore {
  const resolved = storage ?? safeWindowLocalStorage();
  const backend =
    resolved === undefined ? createMemoryKvBackend() : createWebStorageBackend(resolved);
  return createKeymapStore(backend, opts);
}
