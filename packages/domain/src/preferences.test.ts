import { describe, expect, it, vi } from 'vitest';
import {
  createKvPreferencesStore,
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  MAX_PREF_FONT_SCALE,
  MAX_PREFERENCES_BYTES,
  MIN_PREF_FONT_SCALE,
  PREFERENCES_SCHEMA_VERSION,
  type PreferencesKvBackend,
  type PreferencesSnapshot,
  parsePreferences,
  serializePreferences,
} from './preferences';

describe('preferences codec', () => {
  it('exposes the expected constants and default snapshot', () => {
    expect(PREFERENCES_SCHEMA_VERSION).toBe(1);
    expect(MAX_PREFERENCES_BYTES).toBe(4096);
    expect(MIN_PREF_FONT_SCALE).toBe(0.9);
    expect(MAX_PREF_FONT_SCALE).toBe(1.2);
    expect(DEFAULT_PREFERENCES).toEqual({
      version: 1,
      themePreset: 'obsidianCrimson',
      locale: 'system',
      fontScale: 1,
      reduceMotion: false,
    });
  });

  it('falls back to defaults for undefined, empty, corrupt, non-object, or wrong-version payloads', () => {
    expect(parsePreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences('')).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences('{not valid json')).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences('null')).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences('[]')).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences('"hello"')).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences('42')).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences(JSON.stringify({ version: 2, locale: 'tr' }))).toEqual(
      DEFAULT_PREFERENCES,
    );
    expect(parsePreferences(JSON.stringify({ locale: 'tr' }))).toEqual(DEFAULT_PREFERENCES);
  });

  it('parses valid snapshots, strips unknown fields, and falls back per invalid field', () => {
    const valid = parsePreferences(
      JSON.stringify({
        version: 1,
        themePreset: 'midnightSlate',
        locale: 'tr-TR',
        fontScale: 1.1,
        reduceMotion: true,
        extra: 'ignored',
      }),
    );
    expect(valid).toEqual({
      version: 1,
      themePreset: 'midnightSlate',
      locale: 'tr-TR',
      fontScale: 1.1,
      reduceMotion: true,
    });

    const partialInvalid = parsePreferences(
      JSON.stringify({
        version: 1,
        themePreset: 123,
        locale: '   ',
        fontScale: 'large',
        reduceMotion: 'true',
      }),
    );
    expect(partialInvalid).toEqual(DEFAULT_PREFERENCES);

    const nonFinite = parsePreferences(
      JSON.stringify({
        version: 1,
        themePreset: 'a'.repeat(64),
        locale: 'en',
        fontScale: Number.NaN,
        reduceMotion: true,
      }),
    );
    expect(nonFinite).toEqual({
      version: 1,
      themePreset: 'a'.repeat(64),
      locale: 'en',
      fontScale: 1,
      reduceMotion: true,
    });
  });

  it('rejects strings longer than 64 chars and clamps fontScale to [0.9, 1.2]', () => {
    const parsed = parsePreferences(
      JSON.stringify({
        version: 1,
        themePreset: 't'.repeat(65),
        locale: 'l'.repeat(65),
        fontScale: 0.4,
        reduceMotion: false,
      }),
    );
    expect(parsed).toEqual({
      version: 1,
      themePreset: 'obsidianCrimson',
      locale: 'system',
      fontScale: 0.9,
      reduceMotion: false,
    });

    const high = parsePreferences(
      JSON.stringify({
        version: 1,
        themePreset: 'arctic',
        locale: 'de',
        fontScale: 3.5,
        reduceMotion: true,
      }),
    );
    expect(high.fontScale).toBe(1.2);
  });

  it('serializes valid snapshots and rejects payloads over 4096 UTF-8 bytes', () => {
    const encoded = serializePreferences({
      version: 1,
      themePreset: 'obsidianCrimson',
      locale: 'tr',
      fontScale: 1.05,
      reduceMotion: true,
    });
    expect(encoded.ok).toBe(true);
    if (encoded.ok) {
      expect(parsePreferences(encoded.value)).toEqual({
        version: 1,
        themePreset: 'obsidianCrimson',
        locale: 'tr',
        fontScale: 1.05,
        reduceMotion: true,
      });
    }

    const asciiOver: PreferencesSnapshot = {
      ...DEFAULT_PREFERENCES,
      themePreset: 'x'.repeat(MAX_PREFERENCES_BYTES),
    };
    expect(serializePreferences(asciiOver)).toEqual({
      ok: false,
      error: { category: 'storage', code: 'preferences-too-large' },
    });

    // Multi-byte UTF-8: 1500 4-byte emoji = 3000 UTF-16 code units (< 4096) but 6000 UTF-8 bytes (> 4096).
    const utf8Over: PreferencesSnapshot = {
      ...DEFAULT_PREFERENCES,
      themePreset: '🎬'.repeat(1500),
    };
    expect(utf8Over.themePreset.length).toBeLessThan(MAX_PREFERENCES_BYTES);
    expect(serializePreferences(utf8Over)).toEqual({
      ok: false,
      error: { category: 'storage', code: 'preferences-too-large' },
    });

    // 2-byte and 3-byte UTF-8 characters within budget succeed.
    const utf8Ok: PreferencesSnapshot = {
      ...DEFAULT_PREFERENCES,
      themePreset: 'şğüöç日本語',
    };
    expect(serializePreferences(utf8Ok).ok).toBe(true);
  });
});

describe('createMemoryPreferencesStore', () => {
  it('loads defaults or clamped initial values, updates, resets, and notifies subscribers', async () => {
    const store = createMemoryPreferencesStore({ fontScale: 5, locale: 'tr' });
    expect(await store.load()).toEqual({
      version: 1,
      themePreset: 'obsidianCrimson',
      locale: 'tr',
      fontScale: 1.2,
      reduceMotion: false,
    });

    const seen: PreferencesSnapshot[] = [];
    const throwing = vi.fn(() => {
      throw new Error('subscriber boom');
    });
    const unsubThrow = store.subscribe(throwing);
    const unsub = store.subscribe((snap) => seen.push(snap));

    const updated = await store.update({ reduceMotion: true, fontScale: 0.5 });
    expect(updated).toEqual({
      ok: true,
      value: {
        version: 1,
        themePreset: 'obsidianCrimson',
        locale: 'tr',
        fontScale: 0.9,
        reduceMotion: true,
      },
    });
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);

    const resetRes = await store.reset();
    expect(resetRes).toEqual({ ok: true, value: DEFAULT_PREFERENCES });
    expect(seen.at(-1)).toEqual(DEFAULT_PREFERENCES);

    unsubThrow();
    unsub();
    await store.update({ locale: 'de' });
    expect(seen).toHaveLength(2);
  });

  it('rejects oversized updates without mutating state or notifying subscribers', async () => {
    const store = createMemoryPreferencesStore({ locale: 'en' });
    const listener = vi.fn();
    store.subscribe(listener);

    const res = await store.update({ themePreset: 'x'.repeat(MAX_PREFERENCES_BYTES + 10) });
    expect(res).toEqual({
      ok: false,
      error: { category: 'storage', code: 'preferences-too-large' },
    });
    expect(listener).not.toHaveBeenCalled();
    expect(await store.load()).toEqual({ ...DEFAULT_PREFERENCES, locale: 'en' });
  });
});

describe('createKvPreferencesStore', () => {
  function makeKv(initial?: Record<string, string>) {
    const map = new Map<string, string>(Object.entries(initial ?? {}));
    const backend: PreferencesKvBackend = {
      get: vi.fn((key: string) => map.get(key)),
      set: vi.fn((key: string, value: string) => {
        map.set(key, value);
      }),
      delete: vi.fn((key: string) => {
        map.delete(key);
      }),
    };
    return { map, backend };
  }

  it('uses default key, loads valid or corrupt JSON, and persists updates and resets', async () => {
    const { map, backend } = makeKv({ 'elv.preferences.v1': '{corrupt' });
    const store = createKvPreferencesStore(backend);

    expect(await store.load()).toEqual(DEFAULT_PREFERENCES);
    expect(backend.get).toHaveBeenCalledWith('elv.preferences.v1');

    const up = await store.update({ locale: 'tr', fontScale: 1.15 });
    expect(up.ok).toBe(true);
    expect(backend.set).toHaveBeenCalledWith('elv.preferences.v1', expect.any(String));
    expect(parsePreferences(map.get('elv.preferences.v1'))).toEqual({
      ...DEFAULT_PREFERENCES,
      locale: 'tr',
      fontScale: 1.15,
    });

    const reset = await store.reset();
    expect(reset).toEqual({ ok: true, value: DEFAULT_PREFERENCES });
    expect(backend.delete).toHaveBeenCalledWith('elv.preferences.v1');
    expect(map.has('elv.preferences.v1')).toBe(false);
  });

  it('falls back to set() on reset() when backend.delete is omitted and supports custom keys', async () => {
    const map = new Map<string, string>();
    const backend: PreferencesKvBackend = {
      get: (k) => map.get(k),
      set: (k, v) => {
        map.set(k, v);
      },
    };
    const store = createKvPreferencesStore(backend, 'custom.prefs');
    await store.update({ reduceMotion: true });
    expect(parsePreferences(map.get('custom.prefs')).reduceMotion).toBe(true);

    const reset = await store.reset();
    expect(reset).toEqual({ ok: true, value: DEFAULT_PREFERENCES });
    expect(parsePreferences(map.get('custom.prefs'))).toEqual(DEFAULT_PREFERENCES);
  });

  it('serializes concurrent updates so rapid toggles never race or clobber each other', async () => {
    const map = new Map<string, string>();
    let setCalls = 0;
    const backend: PreferencesKvBackend = {
      get: async (key) => {
        await new Promise((r) => setTimeout(r, 5));
        return map.get(key);
      },
      set: async (key, value) => {
        setCalls += 1;
        // First write is slower than later writes to expose any race if unserialized.
        const delay = setCalls === 1 ? 25 : 2;
        await new Promise((r) => setTimeout(r, delay));
        map.set(key, value);
      },
    };
    const store = createKvPreferencesStore(backend);

    const [r1, r2, r3, r4] = await Promise.all([
      store.update({ reduceMotion: true }),
      store.update({ locale: 'tr' }),
      store.update({ fontScale: 1.15 }),
      store.update({ themePreset: 'midnightSlate' }),
    ]);

    expect(r1.ok && r2.ok && r3.ok && r4.ok).toBe(true);
    const expected: PreferencesSnapshot = {
      version: 1,
      themePreset: 'midnightSlate',
      locale: 'tr',
      fontScale: 1.15,
      reduceMotion: true,
    };
    expect(r4.ok && r4.value).toEqual(expected);
    expect(await store.load()).toEqual(expected);
    expect(parsePreferences(map.get('elv.preferences.v1'))).toEqual(expected);
  });

  it('returns preferences-write-failed and rolls back state on backend failure without notifying', async () => {
    const { map, backend } = makeKv();
    const store = createKvPreferencesStore(backend);
    await store.update({ locale: 'en' });

    const listener = vi.fn();
    store.subscribe(listener);

    vi.mocked(backend.set).mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const failed = await store.update({ locale: 'tr' });
    expect(failed).toEqual({
      ok: false,
      error: { category: 'storage', code: 'preferences-write-failed' },
    });
    expect(listener).not.toHaveBeenCalled();
    expect(await store.load()).toEqual({ ...DEFAULT_PREFERENCES, locale: 'en' });
    expect(parsePreferences(map.get('elv.preferences.v1')).locale).toBe('en');

    // Queue remains healthy after failure; next update succeeds.
    const recovered = await store.update({ reduceMotion: true });
    expect(recovered).toEqual({
      ok: true,
      value: { ...DEFAULT_PREFERENCES, locale: 'en', reduceMotion: true },
    });
    expect(listener).toHaveBeenCalledTimes(1);

    // Failing delete on reset also preserves state and returns preferences-write-failed.
    vi.mocked(backend.delete as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      Promise.reject(new Error('locked')),
    );
    const resetFailed = await store.reset();
    expect(resetFailed).toEqual({
      ok: false,
      error: { category: 'storage', code: 'preferences-write-failed' },
    });
    expect(await store.load()).toEqual({
      ...DEFAULT_PREFERENCES,
      locale: 'en',
      reduceMotion: true,
    });
  });

  it('handles backend.get throwing gracefully and isolates throwing subscribers', async () => {
    const map = new Map<string, string>();
    const backend: PreferencesKvBackend = {
      get: vi.fn(() => {
        throw new Error('storage unreadable');
      }),
      set: vi.fn((k, v) => {
        map.set(k, v);
      }),
    };
    const store = createKvPreferencesStore(backend);
    expect(await store.load()).toEqual(DEFAULT_PREFERENCES);

    const seen: PreferencesSnapshot[] = [];
    store.subscribe(() => {
      throw new Error('bad subscriber');
    });
    store.subscribe((s) => seen.push(s));

    const res = await store.update({ reduceMotion: true });
    expect(res.ok).toBe(true);
    expect(seen).toEqual([{ ...DEFAULT_PREFERENCES, reduceMotion: true }]);
  });

  it('enforces > 4 KB guard before touching backend.set and preserves valid values on 65..4000-byte patches', async () => {
    const { backend } = makeKv();
    const store = createKvPreferencesStore(backend);
    await store.update({ themePreset: 'abyssalSapphire', locale: 'tr' });

    const tooLong = await store.update({ themePreset: 'x'.repeat(100), locale: 'y'.repeat(100) });
    expect(tooLong).toEqual({
      ok: true,
      value: { ...DEFAULT_PREFERENCES, themePreset: 'abyssalSapphire', locale: 'tr' },
    });

    vi.mocked(backend.set).mockClear();
    const res = await store.update({ themePreset: 'a'.repeat(5000) });
    expect(res).toEqual({
      ok: false,
      error: { category: 'storage', code: 'preferences-too-large' },
    });
    expect(backend.set).not.toHaveBeenCalled();
  });

  it('rejects blank keys and skips listeners unsubscribed during notification', async () => {
    const { backend } = makeKv();
    expect(() => createKvPreferencesStore(backend, '   ')).toThrow('Preferences key');
    const store = createKvPreferencesStore(backend);
    const second = vi.fn();
    let unsubSecond: (() => void) | undefined;
    store.subscribe(() => {
      unsubSecond?.();
    });
    unsubSecond = store.subscribe(second);
    await store.update({ reduceMotion: true });
    expect(second).not.toHaveBeenCalled();
  });
});
