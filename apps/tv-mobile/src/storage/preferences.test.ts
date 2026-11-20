import { DEFAULT_PREFERENCES } from '@elv/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  os: 'ios' as string,
  settingsValues: {} as Record<string, unknown>,
  settingsGet: vi.fn((key: string): unknown => mocks.settingsValues[key]),
  settingsSet: vi.fn((values: Record<string, unknown>) => {
    Object.assign(mocks.settingsValues, values);
  }),
  secureData: new Map<string, string>(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mocks.os;
    },
  },
  Settings: {
    get: mocks.settingsGet,
    set: mocks.settingsSet,
  },
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: mocks.getItemAsync,
  setItemAsync: mocks.setItemAsync,
  deleteItemAsync: mocks.deleteItemAsync,
}));

import { createDevicePreferencesStore } from './preferences';

beforeEach(() => {
  mocks.os = 'ios';
  mocks.settingsValues = {};
  mocks.settingsGet
    .mockReset()
    .mockImplementation((key: string): unknown => mocks.settingsValues[key]);
  mocks.settingsSet.mockReset().mockImplementation((values: Record<string, unknown>) => {
    Object.assign(mocks.settingsValues, values);
  });

  mocks.secureData.clear();
  mocks.getItemAsync
    .mockReset()
    .mockImplementation(async (key: string) => mocks.secureData.get(key) ?? null);
  mocks.setItemAsync.mockReset().mockImplementation(async (key: string, value: string) => {
    mocks.secureData.set(key, value);
  });
  mocks.deleteItemAsync.mockReset().mockImplementation(async (key: string) => {
    mocks.secureData.delete(key);
  });
});

describe('createDevicePreferencesStore', () => {
  describe('iOS / iPadOS / tvOS (Settings / NSUserDefaults)', () => {
    beforeEach(() => {
      mocks.os = 'ios';
    });

    it('reads defaults when missing, non-string, or Settings.get throws', async () => {
      const store = createDevicePreferencesStore();
      expect(await store.load()).toEqual(DEFAULT_PREFERENCES);

      mocks.settingsValues['elv.preferences.v1'] = 12345;
      expect(await store.load()).toEqual(DEFAULT_PREFERENCES);

      mocks.settingsGet.mockImplementationOnce(() => {
        throw new Error('SettingsManager unavailable');
      });
      expect(await store.load()).toEqual(DEFAULT_PREFERENCES);
    });

    it('persists updates via Settings.set and reloads them across instances', async () => {
      const first = createDevicePreferencesStore();
      const updated = await first.update({
        themePreset: 'highContrast',
        locale: 'tr',
        fontScale: 1.15,
        reduceMotion: true,
      });
      expect(updated.ok).toBe(true);
      expect(mocks.settingsSet).toHaveBeenCalledWith({
        'elv.preferences.v1': expect.any(String),
      });
      expect(mocks.setItemAsync).not.toHaveBeenCalled();

      const second = createDevicePreferencesStore();
      const loaded = await second.load();
      expect(loaded).toEqual({
        version: 1,
        themePreset: 'highContrast',
        locale: 'tr',
        fontScale: 1.15,
        reduceMotion: true,
      });
    });

    it('clears the key with null on reset', async () => {
      const store = createDevicePreferencesStore();
      await store.update({ locale: 'tr' });
      const res = await store.reset();
      expect(res).toEqual({ ok: true, value: DEFAULT_PREFERENCES });
      expect(mocks.settingsSet).toHaveBeenLastCalledWith({ 'elv.preferences.v1': null });
      expect(await createDevicePreferencesStore().load()).toEqual(DEFAULT_PREFERENCES);
    });

    it('returns storage/preferences-write-failed when Settings.set throws', async () => {
      const store = createDevicePreferencesStore();
      mocks.settingsSet.mockImplementationOnce(() => {
        throw new Error('NSUserDefaults quota exceeded');
      });
      const updateRes = await store.update({ locale: 'tr' });
      expect(updateRes.ok).toBe(false);
      if (!updateRes.ok) {
        expect(updateRes.error.category).toBe('storage');
        expect(updateRes.error.code).toBe('preferences-write-failed');
      }

      mocks.settingsSet.mockImplementationOnce(() => {
        throw new Error('NSUserDefaults quota exceeded');
      });
      const resetRes = await store.reset();
      expect(resetRes.ok).toBe(false);
      if (!resetRes.ok) {
        expect(resetRes.error.category).toBe('storage');
        expect(resetRes.error.code).toBe('preferences-write-failed');
      }
    });
  });

  describe('Android (expo-secure-store)', () => {
    beforeEach(() => {
      mocks.os = 'android';
    });

    it('reads defaults when empty or SecureStore.getItemAsync rejects', async () => {
      const store = createDevicePreferencesStore();
      expect(await store.load()).toEqual(DEFAULT_PREFERENCES);

      mocks.getItemAsync.mockRejectedValueOnce(new Error('Keystore locked'));
      expect(await store.load()).toEqual(DEFAULT_PREFERENCES);
    });

    it('persists updates via SecureStore and reloads them across instances', async () => {
      const first = createDevicePreferencesStore();
      const updated = await first.update({
        themePreset: 'midnightCobalt',
        locale: 'en',
        fontScale: 1.1,
      });
      expect(updated.ok).toBe(true);
      expect(mocks.setItemAsync).toHaveBeenCalledWith('elv.preferences.v1', expect.any(String));
      expect(mocks.settingsSet).not.toHaveBeenCalled();

      const second = createDevicePreferencesStore();
      expect(await second.load()).toEqual({
        version: 1,
        themePreset: 'midnightCobalt',
        locale: 'en',
        fontScale: 1.1,
        reduceMotion: false,
      });
    });

    it('deletes the key via SecureStore.deleteItemAsync on reset', async () => {
      const store = createDevicePreferencesStore();
      await store.update({ reduceMotion: true });
      const res = await store.reset();
      expect(res).toEqual({ ok: true, value: DEFAULT_PREFERENCES });
      expect(mocks.deleteItemAsync).toHaveBeenCalledWith('elv.preferences.v1');
      expect(mocks.secureData.has('elv.preferences.v1')).toBe(false);
    });

    it('returns storage/preferences-write-failed when SecureStore write or delete rejects', async () => {
      const store = createDevicePreferencesStore();
      mocks.setItemAsync.mockRejectedValueOnce(new Error('Keystore error'));
      const updateRes = await store.update({ locale: 'tr' });
      expect(updateRes.ok).toBe(false);
      if (!updateRes.ok) {
        expect(updateRes.error.category).toBe('storage');
        expect(updateRes.error.code).toBe('preferences-write-failed');
      }

      mocks.deleteItemAsync.mockRejectedValueOnce(new Error('Keystore error'));
      const resetRes = await store.reset();
      expect(resetRes.ok).toBe(false);
      if (!resetRes.ok) {
        expect(resetRes.error.category).toBe('storage');
        expect(resetRes.error.code).toBe('preferences-write-failed');
      }
    });
  });

  describe('fallback platform', () => {
    it('falls back to in-memory preferences store on unsupported platforms', async () => {
      mocks.os = 'web';
      const store = createDevicePreferencesStore();
      expect(await store.load()).toEqual(DEFAULT_PREFERENCES);
      const updated = await store.update({ locale: 'tr', reduceMotion: true });
      expect(updated.ok).toBe(true);
      expect(await store.load()).toEqual({
        ...DEFAULT_PREFERENCES,
        locale: 'tr',
        reduceMotion: true,
      });
      expect(await store.reset()).toEqual({ ok: true, value: DEFAULT_PREFERENCES });
      expect(mocks.settingsGet).not.toHaveBeenCalled();
      expect(mocks.settingsSet).not.toHaveBeenCalled();
      expect(mocks.getItemAsync).not.toHaveBeenCalled();
      expect(mocks.setItemAsync).not.toHaveBeenCalled();
    });
  });
});
