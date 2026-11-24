import { describe, expect, it, vi } from 'vitest';
import {
  createKeymapStore,
  KEYMAP_SCHEMA_VERSION,
  KEYMAP_STORAGE_KEY,
  keymapStorageKey,
  MAX_KEYMAP_BYTES,
  type RawKeymapOverrides,
} from './keymap-store';
import type { PreferencesKvBackend } from './preferences';

function createMemoryBackend(initial?: Record<string, string>): {
  backend: PreferencesKvBackend;
  map: Map<string, string>;
} {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  const backend: PreferencesKvBackend = {
    get: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value);
    },
    delete: (key) => {
      map.delete(key);
    },
  };
  return { backend, map };
}

describe('@elv/domain keymap-store', () => {
  it('computes storage keys safely for default, custom, and invalid profile IDs', () => {
    expect(KEYMAP_STORAGE_KEY).toBe('elv.keymap.v1');
    expect(keymapStorageKey()).toBe('elv.keymap.v1');
    expect(keymapStorageKey('default')).toBe('elv.keymap.v1');
    expect(keymapStorageKey('')).toBe('elv.keymap.v1');
    expect(keymapStorageKey('bad/id?')).toBe('elv.keymap.v1');
    expect(keymapStorageKey('kids-1')).toBe('elv.keymap.v1.kids-1');
    expect(keymapStorageKey('  living_room.tv  ')).toBe('elv.keymap.v1.living_room.tv');
  });

  it('loads empty defaults, persists sparse overrides, notifies subscribers, and resets cleanly', async () => {
    const { backend, map } = createMemoryBackend();
    const store = createKeymapStore(backend);

    expect(store.getSnapshot()).toEqual({
      version: KEYMAP_SCHEMA_VERSION,
      profileId: 'default',
      overrides: {},
    });

    const loaded = await store.load();
    expect(loaded.overrides).toEqual({});

    const snapshots: RawKeymapOverrides[] = [];
    const unsubscribe = store.subscribe((snap) => snapshots.push(snap.overrides));

    const saved = await store.setOverrides({
      'player.openSettings': { key: 'colorRed', kind: 'long' },
      'player.toggleMute': null,
    });
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.value.overrides).toEqual({
        'player.openSettings': { key: 'colorRed', kind: 'long' },
        'player.toggleMute': null,
      });
    }
    expect(map.has(KEYMAP_STORAGE_KEY)).toBe(true);
    expect(JSON.parse(map.get(KEYMAP_STORAGE_KEY) as string)).toEqual({
      v: 1,
      overrides: {
        'player.openSettings': { key: 'colorRed', kind: 'long' },
        'player.toggleMute': null,
      },
    });
    expect(snapshots).toHaveLength(1);

    // Reload from a fresh store instance backed by the same KV map.
    const reloaded = await createKeymapStore(backend).load();
    expect(reloaded.overrides).toEqual({
      'player.openSettings': { key: 'colorRed', kind: 'long' },
      'player.toggleMute': null,
    });

    // Reset clears KV entry and restores empty overrides.
    const resetResult = await store.reset();
    expect(resetResult.ok).toBe(true);
    expect(store.getSnapshot().overrides).toEqual({});
    expect(map.has(KEYMAP_STORAGE_KEY)).toBe(false);
    expect(snapshots).toHaveLength(2);

    unsubscribe();
  });

  it('enforces the 2048-byte serialized payload budget without corrupting stored state', async () => {
    const { backend } = createMemoryBackend();
    const store = createKeymapStore(backend);

    const oversized: Record<string, { key: string; kind: 'press' }> = {};
    for (let i = 0; i < 80; i += 1) {
      oversized[`action.custom.very_long_identifier_${i}`] = {
        key: 'colorRed',
        kind: 'press',
      };
    }

    const result = await store.setOverrides(oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe('storage');
      expect(result.error.code).toBe('keymap-too-large');
    }
    expect(MAX_KEYMAP_BYTES).toBe(2048);
    expect(store.getSnapshot().overrides).toEqual({});
  });

  it('recovers gracefully from corrupt or invalid JSON payloads in storage', async () => {
    const { backend: badJsonBackend } = createMemoryBackend({
      [KEYMAP_STORAGE_KEY]: '{not-valid-json',
    });
    const s1 = await createKeymapStore(badJsonBackend).load();
    expect(s1.overrides).toEqual({});

    const { backend: partialBackend } = createMemoryBackend({
      [KEYMAP_STORAGE_KEY]: JSON.stringify({
        v: 1,
        overrides: {
          'player.openInfo': { key: 'info', kind: 'press' },
          'player.toggleMute': null,
          'bad.kind': { key: 'menu', kind: 'repeat' },
          'bad.key': { key: '', kind: 'press' },
          'bad.val': 42,
        },
      }),
    });
    const s2 = await createKeymapStore(partialBackend).load();
    expect(s2.overrides).toEqual({
      'player.openInfo': { key: 'info', kind: 'press' },
      'player.toggleMute': null,
    });
  });

  it('isolates profiles on switchProfile and deletes non-default profile keymaps', async () => {
    const { backend, map } = createMemoryBackend();
    const store = createKeymapStore(backend);

    await store.setOverrides({ 'player.openSettings': { key: 'colorRed', kind: 'press' } });

    const kidsSnap = await store.switchProfile('kids');
    expect(kidsSnap.profileId).toBe('kids');
    expect(kidsSnap.overrides).toEqual({});

    await store.setOverrides({ 'live.toggleFavorite': { key: 'colorBlue', kind: 'press' } });
    expect(map.has('elv.keymap.v1.kids')).toBe(true);

    // Switch back to default -> gets default overrides from cache.
    const backDefault = await store.switchProfile('default');
    expect(backDefault.profileId).toBe('default');
    expect(backDefault.overrides).toEqual({
      'player.openSettings': { key: 'colorRed', kind: 'press' },
    });

    // Deleting default is a no-op.
    await store.deleteProfileKeymap('default');
    expect(map.has(KEYMAP_STORAGE_KEY)).toBe(true);

    // Deleting kids removes its keymap from backend and cache.
    await store.deleteProfileKeymap('kids');
    expect(map.has('elv.keymap.v1.kids')).toBe(false);
    const reloadedKids = await store.switchProfile('kids');
    expect(reloadedKids.overrides).toEqual({});
  });

  it('returns storage errors when backend write fails and isolates throwing listeners', async () => {
    const failingBackend: PreferencesKvBackend = {
      get: () => undefined,
      set: () => {
        throw new Error('disk full');
      },
    };
    const store = createKeymapStore(failingBackend);
    const res = await store.setOverrides({ 'player.openInfo': { key: 'colorRed', kind: 'press' } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('keymap-write-failed');
    }

    // Throwing listener does not break subsequent listeners.
    const { backend } = createMemoryBackend();
    const okStore = createKeymapStore(backend);
    const second = vi.fn();
    okStore.subscribe(() => {
      throw new Error('boom');
    });
    okStore.subscribe(second);
    await okStore.setOverrides({ 'player.openInfo': { key: 'colorRed', kind: 'press' } });
    expect(second).toHaveBeenCalledTimes(1);
    await okStore.flush();
  });
});
