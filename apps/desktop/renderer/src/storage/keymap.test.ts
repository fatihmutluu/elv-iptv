import { KEYMAP_STORAGE_KEY, keymapStorageKey } from '@elv/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopKeymapStore } from './keymap.ts';

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

describe('createDesktopKeymapStore (#33)', () => {
  it('persists sparse overrides and resets cleanly against an injected Storage', async () => {
    const storage = createFakeStorage();
    const store = createDesktopKeymapStore(storage);

    const initial = await store.load();
    expect(initial.profileId).toBe('default');
    expect(initial.overrides).toEqual({});

    const updated = await store.setOverrides({
      'player:toggleMute': { key: 'blue', kind: 'press' },
      'live:toggleGuide': { key: 'select', kind: 'long' },
    });
    expect(updated.ok).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(KEYMAP_STORAGE_KEY, expect.any(String));

    const reloaded = createDesktopKeymapStore(storage);
    const hydrated = await reloaded.load();
    expect(hydrated.overrides).toEqual({
      'player:toggleMute': { key: 'blue', kind: 'press' },
      'live:toggleGuide': { key: 'select', kind: 'long' },
    });

    const reset = await store.reset();
    expect(reset.ok).toBe(true);
    expect(storage.removeItem).toHaveBeenCalledWith(KEYMAP_STORAGE_KEY);
    expect(storage.data.size).toBe(0);
  });

  it('uses window.localStorage by default when available', async () => {
    const storage = createFakeStorage();
    vi.stubGlobal('window', { localStorage: storage });

    const store = createDesktopKeymapStore();
    await store.setOverrides({ 'global:openSearch': { key: 'green', kind: 'press' } });
    expect(storage.setItem).toHaveBeenCalledWith(KEYMAP_STORAGE_KEY, expect.any(String));

    const reloaded = await createDesktopKeymapStore().load();
    expect(reloaded.overrides).toEqual({
      'global:openSearch': { key: 'green', kind: 'press' },
    });
  });

  it('switches per-profile keymaps and deletes custom profile keymaps cleanly', async () => {
    const storage = createFakeStorage();
    const store = createDesktopKeymapStore(storage);

    await store.setOverrides({ 'player:toggleMute': { key: 'red', kind: 'press' } });
    expect(storage.data.has(keymapStorageKey('default'))).toBe(true);

    const kidsSnap = await store.switchProfile('p_kids_1');
    expect(kidsSnap.profileId).toBe('p_kids_1');
    expect(kidsSnap.overrides).toEqual({});

    await store.setOverrides({ 'player:openInfo': { key: 'yellow', kind: 'press' } });
    expect(storage.data.has(keymapStorageKey('p_kids_1'))).toBe(true);

    const backDefault = await store.switchProfile('default');
    expect(backDefault.overrides).toEqual({
      'player:toggleMute': { key: 'red', kind: 'press' },
    });

    await store.deleteProfileKeymap('p_kids_1');
    expect(storage.removeItem).toHaveBeenCalledWith(keymapStorageKey('p_kids_1'));
    expect(storage.data.has(keymapStorageKey('p_kids_1'))).toBe(false);
    expect(storage.data.has(keymapStorageKey('default'))).toBe(true);
  });

  it('falls back cleanly to memory storage when window is undefined or localStorage throws', async () => {
    vi.stubGlobal('window', undefined);
    const memoryStore = createDesktopKeymapStore();
    const res = await memoryStore.setOverrides({
      'live:lastChannel': { key: 'back', kind: 'long' },
    });
    expect(res.ok).toBe(true);
    expect((await memoryStore.load()).overrides).toEqual({
      'live:lastChannel': { key: 'back', kind: 'long' },
    });

    const blockedWindow = {};
    Object.defineProperty(blockedWindow, 'localStorage', {
      get() {
        throw new Error('SecurityError');
      },
    });
    vi.stubGlobal('window', blockedWindow);

    const blockedStore = createDesktopKeymapStore();
    await blockedStore.setOverrides({ 'global:openHome': { key: 'menu', kind: 'press' } });
    expect((await blockedStore.load()).overrides).toEqual({
      'global:openHome': { key: 'menu', kind: 'press' },
    });
  });

  it('returns storage/keymap-write-failed when storage writes throw', async () => {
    const storage = createFakeStorage();
    storage.setItem.mockImplementationOnce(() => {
      throw new Error('QuotaExceededError');
    });
    const store = createDesktopKeymapStore(storage);
    const res = await store.setOverrides({ 'player:toggleMute': { key: 'red', kind: 'press' } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.category).toBe('storage');
      expect(res.error.code).toBe('keymap-write-failed');
    }
  });
});
