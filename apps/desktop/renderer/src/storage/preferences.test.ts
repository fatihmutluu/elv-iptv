import { DEFAULT_PREFERENCES } from '@elv/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopPreferencesStore } from './preferences.ts';

function createFakeStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createDesktopPreferencesStore', () => {
  it('round-trips load, update, and reset against an injected Storage', async () => {
    const storage = createFakeStorage();
    const store = createDesktopPreferencesStore(storage);

    expect(await store.load()).toEqual(DEFAULT_PREFERENCES);

    const updated = await store.update({
      themePreset: 'highContrast',
      locale: 'tr',
      fontScale: 1.2,
      reduceMotion: true,
    });
    expect(updated.ok).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith('elv.preferences.v1', expect.any(String));

    const reloaded = createDesktopPreferencesStore(storage);
    expect(await reloaded.load()).toEqual({
      version: 1,
      themePreset: 'highContrast',
      locale: 'tr',
      fontScale: 1.2,
      reduceMotion: true,
    });

    const reset = await store.reset();
    expect(reset).toEqual({ ok: true, value: DEFAULT_PREFERENCES });
    expect(storage.removeItem).toHaveBeenCalledWith('elv.preferences.v1');
    expect(storage.data.size).toBe(0);
  });

  it('uses window.localStorage by default when available', async () => {
    const storage = createFakeStorage();
    vi.stubGlobal('window', { localStorage: storage });

    const store = createDesktopPreferencesStore();
    await store.update({ locale: 'tr' });
    expect(storage.setItem).toHaveBeenCalledWith('elv.preferences.v1', expect.any(String));
    expect((await createDesktopPreferencesStore().load()).locale).toBe('tr');
  });

  it('falls back cleanly to memory store when window is undefined', async () => {
    vi.stubGlobal('window', undefined);
    const store = createDesktopPreferencesStore();
    expect(await store.load()).toEqual(DEFAULT_PREFERENCES);
    const res = await store.update({ locale: 'tr' });
    expect(res.ok).toBe(true);
    expect((await store.load()).locale).toBe('tr');
  });

  it('falls back cleanly to memory store when accessing window.localStorage throws', async () => {
    const blockedWindow = {};
    Object.defineProperty(blockedWindow, 'localStorage', {
      get() {
        throw new Error('SecurityError: storage disabled');
      },
    });
    vi.stubGlobal('window', blockedWindow);

    const store = createDesktopPreferencesStore();
    expect(await store.load()).toEqual(DEFAULT_PREFERENCES);
    const res = await store.update({ reduceMotion: true });
    expect(res.ok).toBe(true);
    expect((await store.load()).reduceMotion).toBe(true);
  });

  it('returns storage/preferences-write-failed when storage.setItem or removeItem throws', async () => {
    const storage = createFakeStorage();
    storage.setItem.mockImplementationOnce(() => {
      throw new Error('QuotaExceededError');
    });
    const store = createDesktopPreferencesStore(storage);

    const updateRes = await store.update({ locale: 'tr' });
    expect(updateRes.ok).toBe(false);
    if (!updateRes.ok) {
      expect(updateRes.error.category).toBe('storage');
      expect(updateRes.error.code).toBe('preferences-write-failed');
    }

    storage.removeItem.mockImplementationOnce(() => {
      throw new Error('SecurityError');
    });
    const resetRes = await store.reset();
    expect(resetRes.ok).toBe(false);
    if (!resetRes.ok) {
      expect(resetRes.error.category).toBe('storage');
      expect(resetRes.error.code).toBe('preferences-write-failed');
    }
  });
});
