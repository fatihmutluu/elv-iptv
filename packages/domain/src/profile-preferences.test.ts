import { describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_PROFILE_PREF_KEY,
  createProfilePreferencesManager,
  DEFAULT_PREFERENCES,
  PROFILE_ID_RE,
  type PreferencesKvBackend,
  type PreferencesSnapshot,
  profilePreferencesKey,
  serializePreferences,
} from './index';

function createMemoryBackend(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  const get = vi.fn(async (key: string) => map.get(key));
  const set = vi.fn(async (key: string, value: string) => {
    map.set(key, value);
  });
  const del = vi.fn(async (key: string) => {
    map.delete(key);
  });
  const backend: PreferencesKvBackend = { get, set, delete: del };
  return { backend, map, get, set, del };
}

function createFakeTimers() {
  let nextId = 1;
  const tasks = new Map<number, () => void>();
  const setTimeout = vi.fn((fn: () => void, _ms: number) => {
    const id = nextId++;
    tasks.set(id, fn);
    return id as unknown as ReturnType<typeof globalThis.setTimeout>;
  });
  const clearTimeout = vi.fn((handle: ReturnType<typeof globalThis.setTimeout>) => {
    tasks.delete(handle as unknown as number);
  });
  const runAll = () => {
    const entries = [...tasks.entries()];
    tasks.clear();
    for (const [, fn] of entries) fn();
  };
  return { timers: { setTimeout, clearTimeout }, tasks, runAll };
}

function encodePrefs(patch: Partial<PreferencesSnapshot>): string {
  const res = serializePreferences({ ...DEFAULT_PREFERENCES, ...patch });
  if (!res.ok) throw new Error('Failed to encode test preferences');
  return res.value;
}

describe('profilePreferencesKey and constants', () => {
  it('exports the active profile key and strict profile ID regex', () => {
    expect(ACTIVE_PROFILE_PREF_KEY).toBe('elv.active-profile.v1');
    expect(PROFILE_ID_RE.test('default')).toBe(true);
    expect(PROFILE_ID_RE.test('p_abc123.v1-test')).toBe(true);
    expect(PROFILE_ID_RE.test('')).toBe(false);
    expect(PROFILE_ID_RE.test('bad/id')).toBe(false);
    expect(PROFILE_ID_RE.test('bad id')).toBe(false);
    expect(PROFILE_ID_RE.test('a'.repeat(64))).toBe(true);
    expect(PROFILE_ID_RE.test('a'.repeat(65))).toBe(false);
  });

  it('maps default and invalid/empty profile IDs to the backwards-compatible v1 key', () => {
    expect(profilePreferencesKey('default')).toBe('elv.preferences.v1');
    expect(profilePreferencesKey('  default  ')).toBe('elv.preferences.v1');
    expect(profilePreferencesKey('')).toBe('elv.preferences.v1');
    expect(profilePreferencesKey('   ')).toBe('elv.preferences.v1');
    expect(profilePreferencesKey('invalid/key')).toBe('elv.preferences.v1');
    expect(profilePreferencesKey('has space')).toBe('elv.preferences.v1');
    expect(profilePreferencesKey('a'.repeat(65))).toBe('elv.preferences.v1');
  });

  it('maps valid non-default profile IDs to scoped KV-safe keys', () => {
    expect(profilePreferencesKey('p_kids_1')).toBe('elv.preferences.v1.p_kids_1');
    expect(profilePreferencesKey('  profile.01-tv  ')).toBe('elv.preferences.v1.profile.01-tv');
  });
});

describe('createProfilePreferencesManager', () => {
  it('defaults to the default profile and persists/loads activeProfileId with validation', async () => {
    const { backend, map } = createMemoryBackend();
    const manager = createProfilePreferencesManager(backend);

    expect(manager.getActiveProfileId()).toBe('default');
    expect(await manager.loadActiveProfileId()).toBe('default');

    await manager.saveActiveProfileId('p_alice');
    expect(map.get(ACTIVE_PROFILE_PREF_KEY)).toBe('p_alice');
    expect(await manager.loadActiveProfileId()).toBe('p_alice');

    // Invalid persisted value falls back to default.
    map.set(ACTIVE_PROFILE_PREF_KEY, 'bad/value!');
    expect(await manager.loadActiveProfileId()).toBe('default');

    // Saving an invalid profileId normalizes to default.
    await manager.saveActiveProfileId('bad/id');
    expect(map.get(ACTIVE_PROFILE_PREF_KEY)).toBe('default');
  });

  it('falls back to default when backend.get throws in loadActiveProfileId', async () => {
    const backend: PreferencesKvBackend = {
      get: vi.fn(async () => {
        throw new Error('storage unavailable');
      }),
      set: vi.fn(async () => undefined),
    };
    const manager = createProfilePreferencesManager(backend);
    expect(await manager.loadActiveProfileId()).toBe('default');
  });

  it('accepts initialProfileId and sanitizes invalid initialProfileId to default', () => {
    const { backend } = createMemoryBackend();
    expect(
      createProfilePreferencesManager(backend, { initialProfileId: 'p_kids' }).getActiveProfileId(),
    ).toBe('p_kids');
    expect(
      createProfilePreferencesManager(backend, { initialProfileId: 'bad/id' }).getActiveProfileId(),
    ).toBe('default');
  });

  it('isolates preferences per profile while remaining backwards-compatible with default key', async () => {
    const { backend, map } = createMemoryBackend({
      'elv.preferences.v1': encodePrefs({ themePreset: 'abyssalSapphire', locale: 'tr' }),
      'elv.preferences.v1.p_kids': encodePrefs({ themePreset: 'theaterAmber', locale: 'en' }),
    });
    const manager = createProfilePreferencesManager(backend);

    const defSnap = await manager.load();
    expect(defSnap.themePreset).toBe('abyssalSapphire');
    expect(defSnap.locale).toBe('tr');

    const kidsSnap = await manager.switchProfile('p_kids');
    expect(manager.getActiveProfileId()).toBe('p_kids');
    expect(kidsSnap.themePreset).toBe('theaterAmber');
    expect(kidsSnap.locale).toBe('en');

    const updated = await manager.update({ fontScale: 1.15 });
    expect(updated.ok).toBe(true);
    expect(map.get('elv.preferences.v1.p_kids')).toContain('"fontScale":1.15');
    expect(map.get('elv.preferences.v1')).not.toContain('"fontScale":1.15');

    const backToDef = await manager.switchProfile('default');
    expect(backToDef.themePreset).toBe('abyssalSapphire');
    expect(backToDef.fontScale).toBe(1);
  });

  it('flushes pending debounced writes on outgoing profile and notifies subscribers once atomically on switchProfile', async () => {
    const { backend, map, get, set } = createMemoryBackend({
      'elv.preferences.v1.p_bob': encodePrefs({ themePreset: 'velvetViolet', locale: 'tr' }),
    });
    const { timers } = createFakeTimers();
    const manager = createProfilePreferencesManager(backend, {
      debounceMs: 250,
      timers,
    });

    const received: PreferencesSnapshot[] = [];
    const throwingListener = vi.fn(() => {
      throw new Error('subscriber boom');
    });
    const unsub1 = manager.subscribe(throwingListener);
    const unsub2 = manager.subscribe((snap) => received.push(snap));

    await manager.load();
    const pendingUpdate = manager.update({ themePreset: 'pitchEmerald', fontScale: 1.1 });
    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    // Debounced: in-memory state notified immediately, but not written to backend yet.
    expect(received[0]?.themePreset).toBe('pitchEmerald');
    expect(set).not.toHaveBeenCalled();

    received.length = 0;
    const bobSnap = await manager.switchProfile('p_bob');
    const updateRes = await pendingUpdate;

    // Outgoing profile write was flushed before switching.
    expect(updateRes.ok).toBe(true);
    expect(set).toHaveBeenCalledTimes(1);
    expect(map.get('elv.preferences.v1')).toContain('"themePreset":"pitchEmerald"');

    // Subscribers received exactly one atomic notification with Bob's hydrated snapshot.
    expect(received).toHaveLength(1);
    expect(received[0]?.themePreset).toBe('velvetViolet');
    expect(received[0]?.locale).toBe('tr');
    expect(bobSnap).toEqual(received[0]);

    // Switching back to default uses the in-memory cache without re-reading backend.
    const getCountBefore = get.mock.calls.length;
    received.length = 0;
    const defAgain = await manager.switchProfile('default');
    expect(get.mock.calls.length).toBe(getCountBefore);
    expect(received).toHaveLength(1);
    expect(defAgain.themePreset).toBe('pitchEmerald');
    expect(defAgain.fontScale).toBe(1.1);

    unsub1();
    unsub2();
  });

  it('serializes concurrent switchProfile calls deterministically without out-of-order clobbering', async () => {
    let resolveSlow!: (v: string | undefined) => void;
    const slowPromise = new Promise<string | undefined>((resolve) => {
      resolveSlow = resolve;
    });
    const backend: PreferencesKvBackend = {
      get: vi.fn((key: string) => {
        if (key === 'elv.preferences.v1.p_slow') return slowPromise;
        if (key === 'elv.preferences.v1.p_fast') {
          return encodePrefs({ themePreset: 'theaterAmber', locale: 'en' });
        }
        return undefined;
      }),
      set: vi.fn(async () => undefined),
    };

    const manager = createProfilePreferencesManager(backend);
    const seenThemes: string[] = [];
    manager.subscribe((s) => seenThemes.push(s.themePreset));

    const first = manager.switchProfile('p_slow');
    const second = manager.switchProfile('p_fast');

    resolveSlow(encodePrefs({ themePreset: 'velvetViolet', locale: 'tr' }));

    const [slowSnap, fastSnap] = await Promise.all([first, second]);
    expect(slowSnap.themePreset).toBe('velvetViolet');
    expect(fastSnap.themePreset).toBe('theaterAmber');
    expect(manager.getActiveProfileId()).toBe('p_fast');
    expect(seenThemes).toEqual(['velvetViolet', 'theaterAmber']);
  });

  it('supports reset() and flush() on the active profile', async () => {
    const { backend, map } = createMemoryBackend({
      'elv.preferences.v1.p_kids': encodePrefs({ themePreset: 'theaterAmber', fontScale: 1.2 }),
    });
    const { timers } = createFakeTimers();
    const manager = createProfilePreferencesManager(backend, {
      initialProfileId: 'p_kids',
      debounceMs: 100,
      timers,
    });

    await manager.load();
    const p = manager.update({ themePreset: 'pitchEmerald' });
    await manager.flush?.();
    expect((await p).ok).toBe(true);
    expect(map.get('elv.preferences.v1.p_kids')).toContain('"themePreset":"pitchEmerald"');

    const resetRes = await manager.reset();
    expect(resetRes.ok).toBe(true);
    if (resetRes.ok) {
      expect(resetRes.value.themePreset).toBe(DEFAULT_PREFERENCES.themePreset);
      expect(resetRes.value.fontScale).toBe(DEFAULT_PREFERENCES.fontScale);
    }
    expect(map.has('elv.preferences.v1.p_kids')).toBe(false);
  });

  it('deleteProfilePreferences evicts cache and deletes backend key for non-default profiles only', async () => {
    const { backend, map, del } = createMemoryBackend({
      'elv.preferences.v1': encodePrefs({ themePreset: 'abyssalSapphire' }),
      'elv.preferences.v1.p_temp': encodePrefs({ themePreset: 'theaterAmber' }),
    });
    const { timers } = createFakeTimers();
    const manager = createProfilePreferencesManager(backend, {
      debounceMs: 100,
      timers,
    });

    // Hydrate p_temp into cache, then switch away.
    const tempSnap = await manager.switchProfile('p_temp');
    expect(tempSnap.themePreset).toBe('theaterAmber');
    const pendingTemp = manager.update({ fontScale: 1.2 });
    await manager.switchProfile('default');
    await pendingTemp;

    // Deleting 'default' or invalid IDs is a safe no-op.
    await manager.deleteProfilePreferences('default');
    await manager.deleteProfilePreferences('');
    await manager.deleteProfilePreferences('bad/id');
    expect(del).not.toHaveBeenCalled();
    expect(map.has('elv.preferences.v1')).toBe(true);

    // Deleting non-default profile evicts cache and deletes backend key.
    await manager.deleteProfilePreferences('p_temp');
    expect(del).toHaveBeenCalledWith('elv.preferences.v1.p_temp');
    expect(map.has('elv.preferences.v1.p_temp')).toBe(false);

    // Switching to p_temp again hydrates fresh defaults (not stale cache).
    const freshSnap = await manager.switchProfile('p_temp');
    expect(freshSnap.themePreset).toBe(DEFAULT_PREFERENCES.themePreset);
    expect(freshSnap.fontScale).toBe(DEFAULT_PREFERENCES.fontScale);
  });
});
