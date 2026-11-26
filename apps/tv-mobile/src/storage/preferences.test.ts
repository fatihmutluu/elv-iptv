import { DEFAULT_PREFERENCES } from '@elv/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  os: 'ios' as string,
  isTV: false,
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
    get isTV() {
      return mocks.isTV;
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

const MOBILE_DEFAULT_PREFERENCES = {
  ...DEFAULT_PREFERENCES,
  artworkCacheLimitMb: 256,
};

const TV_DEFAULT_PREFERENCES = {
  ...DEFAULT_PREFERENCES,
  artworkCacheLimitMb: 128,
};

beforeEach(() => {
  mocks.os = 'ios';
  mocks.isTV = false;
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
      expect(await store.load()).toEqual(MOBILE_DEFAULT_PREFERENCES);

      mocks.settingsValues['elv.preferences.v1'] = 12345;
      expect(await store.load()).toEqual(MOBILE_DEFAULT_PREFERENCES);

      mocks.settingsGet.mockImplementationOnce(() => {
        throw new Error('SettingsManager unavailable');
      });
      expect(await store.load()).toEqual(MOBILE_DEFAULT_PREFERENCES);
    });

    it('defaults artworkCacheLimitMb to 128 on TV form factors', async () => {
      mocks.isTV = true;
      const store = createDevicePreferencesStore();
      expect(await store.load()).toEqual(TV_DEFAULT_PREFERENCES);
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
        ...MOBILE_DEFAULT_PREFERENCES,
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
      expect(res).toEqual({ ok: true, value: MOBILE_DEFAULT_PREFERENCES });
      expect(mocks.settingsSet).toHaveBeenLastCalledWith({ 'elv.preferences.v1': null });
      expect(await createDevicePreferencesStore().load()).toEqual(MOBILE_DEFAULT_PREFERENCES);
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
      expect(await store.load()).toEqual(MOBILE_DEFAULT_PREFERENCES);

      mocks.getItemAsync.mockRejectedValueOnce(new Error('Keystore locked'));
      expect(await store.load()).toEqual(MOBILE_DEFAULT_PREFERENCES);
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
        ...MOBILE_DEFAULT_PREFERENCES,
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
      expect(res).toEqual({ ok: true, value: MOBILE_DEFAULT_PREFERENCES });
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
      expect(await store.load()).toEqual(MOBILE_DEFAULT_PREFERENCES);
      const updated = await store.update({ locale: 'tr', reduceMotion: true });
      expect(updated.ok).toBe(true);
      expect(await store.load()).toEqual({
        ...MOBILE_DEFAULT_PREFERENCES,
        locale: 'tr',
        reduceMotion: true,
      });
      expect(await store.reset()).toEqual({ ok: true, value: MOBILE_DEFAULT_PREFERENCES });
      expect(mocks.settingsGet).not.toHaveBeenCalled();
      expect(mocks.settingsSet).not.toHaveBeenCalled();
      expect(mocks.getItemAsync).not.toHaveBeenCalled();
      expect(mocks.setItemAsync).not.toHaveBeenCalled();
    });
  });

  describe('per-profile preferences isolation (#15)', () => {
    it('isolates profile snapshots and persists active profile ID on iOS Settings', async () => {
      mocks.os = 'ios';
      const manager = createDevicePreferencesStore();
      await manager.update({ locale: 'en', themePreset: 'obsidianCrimson' });

      await manager.switchProfile('p_kids');
      await manager.update({ locale: 'tr', themePreset: 'theaterAmber' });
      await manager.saveActiveProfileId('p_kids');

      expect(mocks.settingsValues['elv.active-profile.v1']).toBe('p_kids');
      expect(typeof mocks.settingsValues['elv.preferences.v1.p_kids']).toBe('string');

      const reloaded = createDevicePreferencesStore();
      expect(await reloaded.loadActiveProfileId()).toBe('p_kids');
      const kidsSnap = await reloaded.switchProfile('p_kids');
      expect(kidsSnap.locale).toBe('tr');
      expect(kidsSnap.themePreset).toBe('theaterAmber');

      const defaultSnap = await reloaded.switchProfile('default');
      expect(defaultSnap.locale).toBe('en');

      await reloaded.deleteProfilePreferences('p_kids');
      expect(mocks.settingsValues['elv.preferences.v1.p_kids']).toBeNull();
    });

    it('isolates profile snapshots and deletes profile entries on Android SecureStore', async () => {
      mocks.os = 'android';
      const manager = createDevicePreferencesStore();
      await manager.switchProfile('p_guest');
      await manager.update({ locale: 'tr' });
      await manager.saveActiveProfileId('p_guest');

      expect(mocks.secureData.get('elv.active-profile.v1')).toBe('p_guest');
      expect(mocks.secureData.has('elv.preferences.v1.p_guest')).toBe(true);

      await manager.switchProfile('default');
      await manager.deleteProfilePreferences('p_guest');
      expect(mocks.deleteItemAsync).toHaveBeenCalledWith('elv.preferences.v1.p_guest');
      expect(mocks.secureData.has('elv.preferences.v1.p_guest')).toBe(false);
    });
  });
});
