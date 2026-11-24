import type { PreferencesKvBackend } from './preferences';
import { isRecord, utf8ByteLength } from './preferences-validators';
import { PROFILE_ID_RE } from './profile-preferences';
import { elvError, err, ok, type Result } from './result';

const DEFAULT_PROFILE_ID = 'default';
const MAX_ACTION_ID_LENGTH = 64;
const MAX_KEY_NAME_LENGTH = 32;

/** Base KV storage key for persisted remote keymap overrides (`#33`). */
export const KEYMAP_STORAGE_KEY = 'elv.keymap.v1';

/** Schema version stored inside serialized keymap payloads. */
export const KEYMAP_SCHEMA_VERSION = 1 as const;

/** Maximum serialized UTF-8 byte budget for sparse keymap overrides (fits inside Android `expo-secure-store`'s 2048 B cap). */
export const MAX_KEYMAP_BYTES = 2048;

/** Plain key trigger representation stored in `@elv/domain` without depending on `@elv/focus-core`. */
export interface RawKeyTrigger {
  readonly key: string;
  readonly kind: 'press' | 'long';
}

/** Sparse map of action IDs to trigger overrides (`null` = explicitly unbound). */
export type RawKeymapOverrides = Readonly<Record<string, RawKeyTrigger | null>>;

/** Immutable keymap snapshot for the currently active profile. */
export interface KeymapSnapshot {
  readonly version: typeof KEYMAP_SCHEMA_VERSION;
  readonly profileId: string;
  readonly overrides: RawKeymapOverrides;
}

/** Options for {@link createKeymapStore}. */
export interface KeymapStoreOptions {
  /** Initial active profile ID (validated against {@link PROFILE_ID_RE}; defaults to `'default'`). */
  initialProfileId?: string;
}

/** Profile-aware persistent store for sparse remote keymap overrides (`#33`). */
export interface KeymapStore {
  /** Returns the current in-memory snapshot synchronously. */
  getSnapshot(): KeymapSnapshot;
  /** Loads the active profile's keymap overrides from the KV backend. */
  load(): Promise<KeymapSnapshot>;
  /** Persists sparse overrides for the active profile, enforcing {@link MAX_KEYMAP_BYTES}. */
  setOverrides(overrides: RawKeymapOverrides): Promise<Result<KeymapSnapshot>>;
  /** Clears all overrides for the active profile and deletes its KV entry when supported. */
  reset(): Promise<Result<KeymapSnapshot>>;
  /** Switches active profile, hydrating its overrides from cache or backend and notifying subscribers. */
  switchProfile(profileId: string): Promise<KeymapSnapshot>;
  /** Evicts cached overrides and deletes the KV entry for a non-default profile. */
  deleteProfileKeymap(profileId: string): Promise<void>;
  /** Subscribes to keymap snapshot changes; returns an unsubscribe callback. */
  subscribe(listener: (snapshot: KeymapSnapshot) => void): () => void;
  /** Waits for any queued async storage operations to settle. */
  flush(): Promise<void>;
}

function normalizeProfileId(profileId: string | undefined): string {
  if (typeof profileId !== 'string') return DEFAULT_PROFILE_ID;
  const trimmed = profileId.trim();
  if (trimmed.length === 0 || !PROFILE_ID_RE.test(trimmed)) return DEFAULT_PROFILE_ID;
  return trimmed;
}

/**
 * Maps a profile ID to its dedicated keymap KV storage key.
 * Returns `'elv.keymap.v1'` for `'default'` or empty/invalid IDs, and `'elv.keymap.v1.<profileId>'` otherwise.
 */
export function keymapStorageKey(profileId?: string): string {
  const normalized = normalizeProfileId(profileId);
  return normalized === DEFAULT_PROFILE_ID
    ? KEYMAP_STORAGE_KEY
    : `${KEYMAP_STORAGE_KEY}.${normalized}`;
}

function sanitizeOverrides(raw: unknown): RawKeymapOverrides {
  if (!isRecord(raw)) return Object.freeze({});
  const out: Record<string, RawKeyTrigger | null> = {};
  for (const [actionId, value] of Object.entries(raw)) {
    if (
      actionId.length === 0 ||
      actionId.length > MAX_ACTION_ID_LENGTH ||
      actionId === '__proto__' ||
      actionId === 'constructor' ||
      actionId === 'prototype'
    ) {
      continue;
    }
    if (value === null) {
      out[actionId] = null;
      continue;
    }
    if (!isRecord(value)) continue;
    const key = value.key;
    const kind = value.kind;
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_NAME_LENGTH) continue;
    if (kind !== 'press' && kind !== 'long') continue;
    out[actionId] = Object.freeze({ key, kind });
  }
  return Object.freeze(out);
}

function parseStoredKeymap(raw: string | null | undefined): RawKeymapOverrides {
  if (typeof raw !== 'string' || raw.length === 0) return Object.freeze({});
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return Object.freeze({});
    if (parsed.v !== KEYMAP_SCHEMA_VERSION) return Object.freeze({});
    return sanitizeOverrides(parsed.overrides);
  } catch {
    return Object.freeze({});
  }
}

function serializeKeymap(overrides: RawKeymapOverrides): Result<string> {
  const encoded = JSON.stringify({
    v: KEYMAP_SCHEMA_VERSION,
    overrides,
  });
  if (utf8ByteLength(encoded) > MAX_KEYMAP_BYTES) {
    return err(elvError('storage', 'keymap-too-large'));
  }
  return ok(encoded);
}

function makeSnapshot(profileId: string, overrides: RawKeymapOverrides): KeymapSnapshot {
  return Object.freeze({
    version: KEYMAP_SCHEMA_VERSION,
    profileId,
    overrides,
  });
}

/**
 * Creates a dedicated sparse {@link KeymapStore} stored separately from `elv.preferences.v1`
 * so Android `expo-secure-store`'s 2048-byte entry cap is never breached.
 */
export function createKeymapStore(
  backend: PreferencesKvBackend,
  opts?: KeymapStoreOptions,
): KeymapStore {
  let activeProfileId = normalizeProfileId(opts?.initialProfileId);
  let current: KeymapSnapshot = makeSnapshot(activeProfileId, Object.freeze({}));
  let tail: Promise<unknown> = Promise.resolve();

  const cache = new Map<string, KeymapSnapshot>();
  const listeners = new Set<(snapshot: KeymapSnapshot) => void>();

  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const result = tail.then(job);
    tail = result.catch(() => undefined);
    return result;
  };

  const notify = (snapshot: KeymapSnapshot): void => {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener(snapshot);
      } catch {
        // Isolate throwing subscribers so one listener cannot break others.
      }
    }
  };

  const readProfileFromBackend = async (profileId: string): Promise<KeymapSnapshot> => {
    try {
      const raw = await backend.get(keymapStorageKey(profileId));
      const overrides = parseStoredKeymap(raw);
      return makeSnapshot(profileId, overrides);
    } catch {
      return makeSnapshot(profileId, Object.freeze({}));
    }
  };

  return {
    getSnapshot(): KeymapSnapshot {
      return current;
    },

    load(): Promise<KeymapSnapshot> {
      return enqueue(async () => {
        const id = activeProfileId;
        const snapshot = await readProfileFromBackend(id);
        cache.set(id, snapshot);
        current = snapshot;
        notify(current);
        return snapshot;
      });
    },

    setOverrides(overrides: RawKeymapOverrides): Promise<Result<KeymapSnapshot>> {
      return enqueue(async () => {
        const id = activeProfileId;
        const sanitized = sanitizeOverrides(overrides);
        const encoded = serializeKeymap(sanitized);
        if (!encoded.ok) return encoded;

        const key = keymapStorageKey(id);
        try {
          if (Object.keys(sanitized).length === 0 && backend.delete !== undefined) {
            await backend.delete(key);
          } else {
            await backend.set(key, encoded.value);
          }
        } catch {
          return err(elvError('storage', 'keymap-write-failed'));
        }

        const snapshot = makeSnapshot(id, sanitized);
        cache.set(id, snapshot);
        current = snapshot;
        notify(current);
        return ok(snapshot);
      });
    },

    reset(): Promise<Result<KeymapSnapshot>> {
      return enqueue(async () => {
        const id = activeProfileId;
        const empty = Object.freeze({});
        const key = keymapStorageKey(id);
        try {
          if (backend.delete !== undefined) {
            await backend.delete(key);
          } else {
            const encoded = serializeKeymap(empty);
            if (!encoded.ok) return encoded;
            await backend.set(key, encoded.value);
          }
        } catch {
          return err(elvError('storage', 'keymap-write-failed'));
        }

        const snapshot = makeSnapshot(id, empty);
        cache.set(id, snapshot);
        current = snapshot;
        notify(current);
        return ok(snapshot);
      });
    },

    switchProfile(profileId: string): Promise<KeymapSnapshot> {
      return enqueue(async () => {
        const targetId = normalizeProfileId(profileId);
        activeProfileId = targetId;
        const cached = cache.get(targetId);
        const snapshot = cached ?? (await readProfileFromBackend(targetId));
        cache.set(targetId, snapshot);
        current = snapshot;
        notify(current);
        return snapshot;
      });
    },

    deleteProfileKeymap(profileId: string): Promise<void> {
      return enqueue(async () => {
        const id = normalizeProfileId(profileId);
        if (id === DEFAULT_PROFILE_ID) return;
        cache.delete(id);
        if (backend.delete !== undefined) {
          await backend.delete(keymapStorageKey(id));
        }
        if (activeProfileId === id) {
          current = makeSnapshot(id, Object.freeze({}));
          notify(current);
        }
      });
    },

    subscribe(listener: (snapshot: KeymapSnapshot) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async flush(): Promise<void> {
      await tail;
    },
  };
}
