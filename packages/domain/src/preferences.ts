import { elvError, err, ok, type Result } from './result';

/** Schema version stored inside serialized preferences payloads. */
export const PREFERENCES_SCHEMA_VERSION = 1 as const;

/** Maximum serialized UTF-8 byte budget for user preferences (well under tvOS's 500 KB UserDefaults limit). */
export const MAX_PREFERENCES_BYTES = 4096;

/** Minimum supported UI font scale multiplier. */
export const MIN_PREF_FONT_SCALE = 0.9;

/** Maximum supported UI font scale multiplier. */
export const MAX_PREF_FONT_SCALE = 1.2;

const MAX_PREF_STRING_LENGTH = 64;
const DEFAULT_PREFERENCES_KEY = 'elv.preferences.v1';

/** Immutable snapshot of user-configurable app preferences. */
export interface PreferencesSnapshot {
  readonly version: typeof PREFERENCES_SCHEMA_VERSION;
  readonly themePreset: string;
  readonly locale: string;
  readonly fontScale: number;
  readonly reduceMotion: boolean;
}

/** Default preferences applied on fresh installs, reset, or corrupt storage recovery. */
export const DEFAULT_PREFERENCES: PreferencesSnapshot = Object.freeze({
  version: PREFERENCES_SCHEMA_VERSION,
  themePreset: 'obsidianCrimson',
  locale: 'system',
  fontScale: 1,
  reduceMotion: false,
});

/** Partial update applied on top of the current {@link PreferencesSnapshot}. */
export type PreferencesPatch = Partial<Omit<PreferencesSnapshot, 'version'>>;

/** Minimal key-value storage backend for persisting serialized preferences. */
export interface PreferencesKvBackend {
  get(key: string): Promise<string | undefined> | string | undefined;
  set(key: string, value: string): Promise<void> | void;
  delete?(key: string): Promise<void> | void;
}

/** Port for reading, updating, resetting, and observing user preferences. */
export interface PreferencesStore {
  load(): Promise<PreferencesSnapshot>;
  update(patch: PreferencesPatch): Promise<Result<PreferencesSnapshot>>;
  reset(): Promise<Result<PreferencesSnapshot>>;
  subscribe(listener: (snapshot: PreferencesSnapshot) => void): () => void;
}

function clampFontScale(value: number): number {
  return Math.min(MAX_PREF_FONT_SCALE, Math.max(MIN_PREF_FONT_SCALE, value));
}

function isValidShortString(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_PREF_STRING_LENGTH
  );
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decodes a serialized preferences payload, falling back cleanly to {@link DEFAULT_PREFERENCES}
 * on missing/invalid JSON, mismatched schema versions, invalid field types, or strings over 64 characters.
 * Clamps `fontScale` to `[MIN_PREF_FONT_SCALE, MAX_PREF_FONT_SCALE]`.
 */
export function parsePreferences(raw: string | undefined): PreferencesSnapshot {
  if (raw === undefined || raw === '') return DEFAULT_PREFERENCES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFERENCES;
  }
  if (!isRecord(parsed) || parsed.version !== PREFERENCES_SCHEMA_VERSION) {
    return DEFAULT_PREFERENCES;
  }
  const themePreset = isValidShortString(parsed.themePreset)
    ? parsed.themePreset
    : DEFAULT_PREFERENCES.themePreset;
  const locale = isValidShortString(parsed.locale) ? parsed.locale : DEFAULT_PREFERENCES.locale;
  const fontScale =
    typeof parsed.fontScale === 'number' && Number.isFinite(parsed.fontScale)
      ? clampFontScale(parsed.fontScale)
      : DEFAULT_PREFERENCES.fontScale;
  const reduceMotion =
    typeof parsed.reduceMotion === 'boolean'
      ? parsed.reduceMotion
      : DEFAULT_PREFERENCES.reduceMotion;

  return Object.freeze({
    version: PREFERENCES_SCHEMA_VERSION,
    themePreset,
    locale,
    fontScale,
    reduceMotion,
  });
}

/**
 * Encodes a {@link PreferencesSnapshot} to JSON while enforcing {@link MAX_PREFERENCES_BYTES}
 * in UTF-8 byte length. Returns `storage/preferences-too-large` if the serialized payload exceeds budget.
 */
export function serializePreferences(snapshot: PreferencesSnapshot): Result<string> {
  const payload = JSON.stringify({
    version: PREFERENCES_SCHEMA_VERSION,
    themePreset: snapshot.themePreset,
    locale: snapshot.locale,
    fontScale: Number.isFinite(snapshot.fontScale)
      ? clampFontScale(snapshot.fontScale)
      : DEFAULT_PREFERENCES.fontScale,
    reduceMotion: Boolean(snapshot.reduceMotion),
  });
  if (utf8ByteLength(payload) > MAX_PREFERENCES_BYTES) {
    return err(elvError('storage', 'preferences-too-large'));
  }
  return ok(payload);
}

function mergeCandidate(base: PreferencesSnapshot, patch: PreferencesPatch): PreferencesSnapshot {
  const themePreset = isValidShortString(patch.themePreset) ? patch.themePreset : base.themePreset;
  const locale = isValidShortString(patch.locale) ? patch.locale : base.locale;
  const fontScale =
    typeof patch.fontScale === 'number' && Number.isFinite(patch.fontScale)
      ? clampFontScale(patch.fontScale)
      : base.fontScale;
  const reduceMotion =
    typeof patch.reduceMotion === 'boolean' ? patch.reduceMotion : base.reduceMotion;
  return Object.freeze({
    version: PREFERENCES_SCHEMA_VERSION,
    themePreset,
    locale,
    fontScale,
    reduceMotion,
  });
}

function mergeRawCandidate(
  base: PreferencesSnapshot,
  patch: PreferencesPatch,
): PreferencesSnapshot {
  return {
    version: PREFERENCES_SCHEMA_VERSION,
    themePreset:
      typeof patch.themePreset === 'string' && patch.themePreset.trim().length > 0
        ? patch.themePreset
        : base.themePreset,
    locale:
      typeof patch.locale === 'string' && patch.locale.trim().length > 0
        ? patch.locale
        : base.locale,
    fontScale:
      typeof patch.fontScale === 'number' && Number.isFinite(patch.fontScale)
        ? clampFontScale(patch.fontScale)
        : base.fontScale,
    reduceMotion: typeof patch.reduceMotion === 'boolean' ? patch.reduceMotion : base.reduceMotion,
  };
}

/**
 * Creates a {@link PreferencesStore} backed by a {@link PreferencesKvBackend}.
 * Concurrent `load`, `update`, and `reset` calls are serialized via an internal promise queue so rapid
 * toggles never race or clobber one another; subscriber exceptions are isolated.
 */
export function createKvPreferencesStore(
  backend: PreferencesKvBackend,
  key = DEFAULT_PREFERENCES_KEY,
): PreferencesStore {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new Error('Preferences key must be a non-empty string');
  }
  let current: PreferencesSnapshot = DEFAULT_PREFERENCES;
  let hydrated = false;
  let tail: Promise<unknown> = Promise.resolve();
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
        // Isolate throwing subscribers so one listener cannot break others or fail persistence.
      }
    }
  };

  const readFromBackend = async (): Promise<PreferencesSnapshot> => {
    try {
      const raw = await backend.get(key);
      current = parsePreferences(raw);
      hydrated = true;
      return current;
    } catch {
      return current;
    }
  };

  return {
    load(): Promise<PreferencesSnapshot> {
      return enqueue(() => readFromBackend());
    },

    update(patch: PreferencesPatch): Promise<Result<PreferencesSnapshot>> {
      return enqueue(async () => {
        if (!hydrated) {
          await readFromBackend();
        }
        const rawEncoded = serializePreferences(mergeRawCandidate(current, patch));
        if (!rawEncoded.ok) return rawEncoded;

        const next = mergeCandidate(current, patch);
        const encoded = serializePreferences(next);
        if (!encoded.ok) return encoded;

        try {
          await backend.set(key, encoded.value);
        } catch {
          return err(elvError('storage', 'preferences-write-failed'));
        }
        current = next;
        hydrated = true;
        notify(current);
        return ok(current);
      });
    },

    reset(): Promise<Result<PreferencesSnapshot>> {
      return enqueue(async () => {
        try {
          if (backend.delete !== undefined) {
            await backend.delete(key);
          } else {
            const encoded = serializePreferences(DEFAULT_PREFERENCES);
            if (!encoded.ok) return encoded;
            await backend.set(key, encoded.value);
          }
        } catch {
          return err(elvError('storage', 'preferences-write-failed'));
        }
        current = DEFAULT_PREFERENCES;
        hydrated = true;
        notify(current);
        return ok(current);
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

/**
 * Creates an in-memory {@link PreferencesStore}, useful for tests and ephemeral previews.
 */
export function createMemoryPreferencesStore(initial?: PreferencesPatch): PreferencesStore {
  const storage = new Map<string, string>();
  if (initial !== undefined) {
    const seed = parsePreferences(
      JSON.stringify({
        ...DEFAULT_PREFERENCES,
        ...initial,
      }),
    );
    const encoded = serializePreferences(seed);
    if (encoded.ok) storage.set(DEFAULT_PREFERENCES_KEY, encoded.value);
  }
  return createKvPreferencesStore(
    {
      get: (k) => storage.get(k),
      set: (k, v) => {
        storage.set(k, v);
      },
      delete: (k) => {
        storage.delete(k);
      },
    },
    DEFAULT_PREFERENCES_KEY,
  );
}
