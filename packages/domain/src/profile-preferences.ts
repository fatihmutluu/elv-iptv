import {
  createKvPreferencesStore,
  type PreferencesKvBackend,
  type PreferencesPatch,
  type PreferencesSnapshot,
  type PreferencesStore,
  type PreferencesStoreOptions,
} from './preferences';
import type { Result } from './result';

const DEFAULT_PROFILE_ID = 'default';
const DEFAULT_PREFERENCES_KEY = 'elv.preferences.v1';

/** KV storage key holding the currently active local profile ID. */
export const ACTIVE_PROFILE_PREF_KEY = 'elv.active-profile.v1';

/**
 * Strict profile identifier pattern (`1–64` ASCII letters, digits, `.`, `_`, `-`).
 * Safe across SQLite, `expo-secure-store`, `NSUserDefaults`, `localStorage`, and Electron IPC.
 */
export const PROFILE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Injectable timer pair for deterministic tests. */
export interface ProfilePreferencesTimers {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Options for {@link createProfilePreferencesManager}. */
export interface ProfilePreferencesManagerOptions extends PreferencesStoreOptions {
  /** Initial active profile ID (validated against {@link PROFILE_ID_RE}; defaults to `'default'`). */
  initialProfileId?: string;
  /** Debounce window (ms) for coalescing rapid `update()` writes. Alias for `coalesceMs`. */
  debounceMs?: number;
  /** Injectable timers for deterministic tests (alternative to `setTimeoutFn` / `clearTimeoutFn`). */
  timers?: ProfilePreferencesTimers;
}

/**
 * Multi-profile preferences manager extending {@link PreferencesStore} so UI providers
 * can switch profiles atomically without remounting or flashing defaults.
 */
export interface ProfilePreferencesManager extends PreferencesStore {
  /** Returns the currently active profile ID. */
  getActiveProfileId(): string;
  /** Reads and validates the persisted active profile ID, defaulting to `'default'`. */
  loadActiveProfileId(): Promise<string>;
  /** Persists the validated active profile ID under {@link ACTIVE_PROFILE_PREF_KEY}. */
  saveActiveProfileId(profileId: string): Promise<void>;
  /**
   * Flushes any pending debounced write on the outgoing profile, switches the active profile,
   * hydrates the target profile snapshot from cache or backend, and notifies all subscribers once.
   */
  switchProfile(profileId: string): Promise<PreferencesSnapshot>;
  /**
   * Evicts cached preferences for a non-default profile and deletes its backend KV entry.
   * Passing `'default'` or an invalid ID is a safe no-op.
   */
  deleteProfilePreferences(profileId: string): Promise<void>;
}

function normalizeProfileId(profileId: string | undefined): string {
  if (typeof profileId !== 'string') return DEFAULT_PROFILE_ID;
  const trimmed = profileId.trim();
  if (trimmed.length === 0 || !PROFILE_ID_RE.test(trimmed)) return DEFAULT_PROFILE_ID;
  return trimmed;
}

/**
 * Maps a profile ID to its KV storage key.
 * Returns `'elv.preferences.v1'` for `'default'` or invalid/empty IDs (100% backwards-compatible
 * with existing single-profile installs), and `'elv.preferences.v1.<profileId>'` otherwise.
 */
export function profilePreferencesKey(profileId: string): string {
  const normalized = normalizeProfileId(profileId);
  return normalized === DEFAULT_PROFILE_ID
    ? DEFAULT_PREFERENCES_KEY
    : `${DEFAULT_PREFERENCES_KEY}.${normalized}`;
}

/**
 * Creates a {@link ProfilePreferencesManager} backed by a {@link PreferencesKvBackend}.
 * Maintains per-profile {@link PreferencesStore} instances and an in-memory hydrated snapshot cache
 * so switching profiles flushes pending writes, avoids redundant backend reads, and notifies
 * subscribers in a single atomic flip.
 */
export function createProfilePreferencesManager(
  backend: PreferencesKvBackend,
  opts?: ProfilePreferencesManagerOptions,
): ProfilePreferencesManager {
  const storeOpts: PreferencesStoreOptions = {};
  const coalesceMs = opts?.debounceMs ?? opts?.coalesceMs;
  if (coalesceMs !== undefined) storeOpts.coalesceMs = coalesceMs;
  const setTimeoutFn = opts?.timers?.setTimeout ?? opts?.setTimeoutFn;
  if (setTimeoutFn !== undefined) storeOpts.setTimeoutFn = setTimeoutFn;
  const clearTimeoutFn = opts?.timers?.clearTimeout ?? opts?.clearTimeoutFn;
  if (clearTimeoutFn !== undefined) storeOpts.clearTimeoutFn = clearTimeoutFn;

  let activeProfileId = normalizeProfileId(opts?.initialProfileId);
  let tail: Promise<unknown> = Promise.resolve();
  let suppressForwarding = false;

  interface ProfileEntry {
    store: PreferencesStore;
    unsubscribe: () => void;
  }

  const entries = new Map<string, ProfileEntry>();
  const cache = new Map<string, PreferencesSnapshot>();
  const listeners = new Set<(snapshot: PreferencesSnapshot) => void>();

  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const result = tail.then(job);
    tail = result.catch(() => undefined);
    return result;
  };

  const notify = (snapshot: PreferencesSnapshot): void => {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener(snapshot);
      } catch {
        // Isolate throwing subscribers so one listener cannot break others.
      }
    }
  };

  const getOrCreateStore = (profileId: string): PreferencesStore => {
    const existing = entries.get(profileId);
    if (existing !== undefined) return existing.store;
    const store = createKvPreferencesStore(backend, profilePreferencesKey(profileId), storeOpts);
    const unsubscribe = store.subscribe((snapshot) => {
      cache.set(profileId, snapshot);
      if (profileId === activeProfileId && !suppressForwarding) {
        notify(snapshot);
      }
    });
    entries.set(profileId, { store, unsubscribe });
    return store;
  };

  return {
    getActiveProfileId(): string {
      return activeProfileId;
    },

    async loadActiveProfileId(): Promise<string> {
      try {
        const raw = await backend.get(ACTIVE_PROFILE_PREF_KEY);
        return normalizeProfileId(raw);
      } catch {
        return DEFAULT_PROFILE_ID;
      }
    },

    async saveActiveProfileId(profileId: string): Promise<void> {
      await backend.set(ACTIVE_PROFILE_PREF_KEY, normalizeProfileId(profileId));
    },

    load(): Promise<PreferencesSnapshot> {
      return enqueue(async () => {
        const id = activeProfileId;
        const snapshot = await getOrCreateStore(id).load();
        cache.set(id, snapshot);
        return snapshot;
      });
    },

    update(patch: PreferencesPatch): Promise<Result<PreferencesSnapshot>> {
      return enqueue(async () => ({
        commit: getOrCreateStore(activeProfileId).update(patch),
      })).then(({ commit }) => commit);
    },

    reset(): Promise<Result<PreferencesSnapshot>> {
      return enqueue(async () => {
        const id = activeProfileId;
        const result = await getOrCreateStore(id).reset();
        if (result.ok) {
          cache.set(id, result.value);
        }
        return result;
      });
    },

    flush(): Promise<void> {
      return enqueue(async () => {
        const entry = entries.get(activeProfileId);
        if (entry?.store.flush !== undefined) {
          await entry.store.flush();
        }
      });
    },

    switchProfile(profileId: string): Promise<PreferencesSnapshot> {
      return enqueue(async () => {
        const targetId = normalizeProfileId(profileId);
        const outgoing = entries.get(activeProfileId);
        if (outgoing?.store.flush !== undefined) {
          await outgoing.store.flush();
        }

        activeProfileId = targetId;
        const cached = cache.get(targetId);
        let snapshot: PreferencesSnapshot;
        if (cached !== undefined) {
          snapshot = cached;
        } else {
          suppressForwarding = true;
          try {
            snapshot = await getOrCreateStore(targetId).load();
          } finally {
            suppressForwarding = false;
          }
          cache.set(targetId, snapshot);
        }

        notify(snapshot);
        return snapshot;
      });
    },

    deleteProfilePreferences(profileId: string): Promise<void> {
      return enqueue(async () => {
        const id = normalizeProfileId(profileId);
        if (id === DEFAULT_PROFILE_ID) return;

        const existing = entries.get(id);
        if (existing !== undefined) {
          existing.unsubscribe();
          if (existing.store.flush !== undefined) {
            await existing.store.flush();
          }
          entries.delete(id);
        }
        cache.delete(id);
        if (backend.delete !== undefined) {
          await backend.delete(profilePreferencesKey(id));
        }
      });
    },

    subscribe(listener: (snapshot: PreferencesSnapshot) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
