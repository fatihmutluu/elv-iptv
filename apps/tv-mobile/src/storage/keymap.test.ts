import { KEYMAP_STORAGE_KEY } from '@elv/domain';
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

import { createDeviceKeymapStore } from './keymap';

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

describe('createDeviceKeymapStore', () => {
  describe('iOS / iPadOS / tvOS (Settings / NSUserDefaults)', () => {
    beforeEach(() => {
      mocks.os = 'ios';
    });

    it('reads empty overrides when missing, non-string, or Settings.get throws', async () => {
      const store = createDeviceKeymapStore();
      expect((await store.load()).overrides).toEqual({});

      mocks.settingsValues[KEYMAP_STORAGE_KEY] = 42;
      expect((await store.load()).overrides).toEqual({});

      mocks.settingsGet.mockImplementationOnce(() => {
        throw new Error('SettingsManager unavailable');
      });
      expect((await store.load()).overrides).toEqual({});
    });

    it('persists sparse overrides under elv.keymap.v1 without touching elv.preferences.v1', async () => {
      const first = createDeviceKeymapStore();
      const saved = await first.setOverrides({
        'player.toggleGuide': { key: 'info', kind: 'press' },
        'player.toggleMute': null,
      });
      expect(saved.ok).toBe(true);
      expect(mocks.settingsSet).toHaveBeenCalledWith({
        [KEYMAP_STORAGE_KEY]: expect.any(String),
      });
      expect(mocks.settingsValues['elv.preferences.v1']).toBeUndefined();
      expect(mocks.setItemAsync).not.toHaveBeenCalled();

      const second = createDeviceKeymapStore();
      const loaded = await second.load();
      expect(loaded.overrides).toEqual({
        'player.toggleGuide': { key: 'info', kind: 'press' },
        'player.toggleMute': null,
      });
    });

    it('deletes the key with null on reset and empty override write', async () => {
      const store = createDeviceKeymapStore();
      await store.setOverrides({ 'live.toggleGuide': { key: 'select', kind: 'long' } });
      const res = await store.reset();
      expect(res.ok).toBe(true);
      expect(mocks.settingsSet).toHaveBeenLastCalledWith({ [KEYMAP_STORAGE_KEY]: null });

      await store.setOverrides({ 'live.toggleGuide': { key: 'select', kind: 'long' } });
      await store.setOverrides({});
      expect(mocks.settingsSet).toHaveBeenLastCalledWith({ [KEYMAP_STORAGE_KEY]: null });
    });

    it('returns storage/keymap-write-failed when Settings.set throws', async () => {
      const store = createDeviceKeymapStore();
      mocks.settingsSet.mockImplementationOnce(() => {
        throw new Error('NSUserDefaults error');
      });
      const res = await store.setOverrides({ 'player.openInfo': { key: 'info', kind: 'press' } });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.category).toBe('storage');
        expect(res.error.code).toBe('keymap-write-failed');
      }
    });

    it('isolates per-profile keymaps under elv.keymap.v1.<profileId>', async () => {
      const store = createDeviceKeymapStore();
      await store.setOverrides({ 'player.openInfo': { key: 'info', kind: 'press' } });

      await store.switchProfile('p_kids');
      await store.setOverrides({ 'live.lastChannel': { key: 'back', kind: 'long' } });

      expect(typeof mocks.settingsValues['elv.keymap.v1']).toBe('string');
      expect(typeof mocks.settingsValues['elv.keymap.v1.p_kids']).toBe('string');

      const reloaded = createDeviceKeymapStore();
      expect((await reloaded.switchProfile('p_kids')).overrides).toEqual({
        'live.lastChannel': { key: 'back', kind: 'long' },
      });
      expect((await reloaded.switchProfile('default')).overrides).toEqual({
        'player.openInfo': { key: 'info', kind: 'press' },
      });

      await reloaded.deleteProfileKeymap('p_kids');
      expect(mocks.settingsValues['elv.keymap.v1.p_kids']).toBeNull();
    });
  });

  describe('Android (expo-secure-store)', () => {
    beforeEach(() => {
      mocks.os = 'android';
    });

    it('reads empty overrides when missing or SecureStore.getItemAsync rejects', async () => {
      const store = createDeviceKeymapStore();
      expect((await store.load()).overrides).toEqual({});

      mocks.getItemAsync.mockRejectedValueOnce(new Error('Keystore locked'));
      expect((await store.load()).overrides).toEqual({});
    });

    it('persists sparse overrides under elv.keymap.v1 separately from elv.preferences.v1', async () => {
      const first = createDeviceKeymapStore();
      const saved = await first.setOverrides({
        'player.channelUp': { key: 'up', kind: 'long' },
      });
      expect(saved.ok).toBe(true);
      expect(mocks.setItemAsync).toHaveBeenCalledWith(KEYMAP_STORAGE_KEY, expect.any(String));
      expect(mocks.secureData.has('elv.preferences.v1')).toBe(false);
      expect(mocks.settingsSet).not.toHaveBeenCalled();

      const second = createDeviceKeymapStore();
      expect((await second.load()).overrides).toEqual({
        'player.channelUp': { key: 'up', kind: 'long' },
      });
    });

    it('deletes keymap entries on reset and deleteProfileKeymap', async () => {
      const store = createDeviceKeymapStore();
      await store.switchProfile('p_guest');
      await store.setOverrides({ 'global.openSearch': { key: 'search', kind: 'press' } });
      expect(mocks.secureData.has('elv.keymap.v1.p_guest')).toBe(true);

      await store.reset();
      expect(mocks.deleteItemAsync).toHaveBeenCalledWith('elv.keymap.v1.p_guest');
      expect(mocks.secureData.has('elv.keymap.v1.p_guest')).toBe(false);

      await store.setOverrides({ 'global.openSearch': { key: 'search', kind: 'press' } });
      await store.switchProfile('default');
      await store.deleteProfileKeymap('p_guest');
      expect(mocks.secureData.has('elv.keymap.v1.p_guest')).toBe(false);
    });

    it('returns storage/keymap-write-failed when SecureStore write or delete rejects', async () => {
      const store = createDeviceKeymapStore();
      mocks.setItemAsync.mockRejectedValueOnce(new Error('Keystore write failed'));
      const setRes = await store.setOverrides({
        'player.openInfo': { key: 'info', kind: 'press' },
      });
      expect(setRes.ok).toBe(false);
      if (!setRes.ok) {
        expect(setRes.error.category).toBe('storage');
        expect(setRes.error.code).toBe('keymap-write-failed');
      }

      mocks.deleteItemAsync.mockRejectedValueOnce(new Error('Keystore delete failed'));
      const resetRes = await store.reset();
      expect(resetRes.ok).toBe(false);
      if (!resetRes.ok) {
        expect(resetRes.error.category).toBe('storage');
        expect(resetRes.error.code).toBe('keymap-write-failed');
      }
    });
  });

  describe('fallback platform', () => {
    it('falls back to in-memory storage on unsupported platforms', async () => {
      mocks.os = 'web';
      const store = createDeviceKeymapStore();
      expect((await store.load()).overrides).toEqual({});

      const saved = await store.setOverrides({ 'global.openHome': { key: 'home', kind: 'press' } });
      expect(saved.ok).toBe(true);
      expect((await store.load()).overrides).toEqual({
        'global.openHome': { key: 'home', kind: 'press' },
      });

      await store.reset();
      expect((await store.load()).overrides).toEqual({});
      expect(mocks.settingsGet).not.toHaveBeenCalled();
      expect(mocks.settingsSet).not.toHaveBeenCalled();
      expect(mocks.getItemAsync).not.toHaveBeenCalled();
      expect(mocks.setItemAsync).not.toHaveBeenCalled();
    });
  });
});
