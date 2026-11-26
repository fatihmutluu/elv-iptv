import { secretKey } from '@elv/data';
import { ok, type SecretStore } from '@elv/domain';
import { createEmptyVaultSnapshot, type VaultSnapshot } from '@elv/sync';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogClientMessage, CatalogRpcMethodCall } from '../../shared/catalog-ipc.ts';
import {
  createDesktopCatalogSnapshotBridge,
  type DesktopCatalogPortLike,
} from './desktop-catalog-snapshot.ts';

function makeMemorySecrets(initial: Record<string, string> = {}): {
  store: SecretStore;
  data: Map<string, string>;
} {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    store: {
      async get(key) {
        return data.get(key);
      },
      async set(key, value) {
        data.set(key, value);
      },
      async delete(key) {
        data.delete(key);
      },
    },
  };
}

function makeFakeCoordinator(handler: (call: CatalogRpcMethodCall) => unknown) {
  let nextClientId = 0;
  const closedPorts: number[] = [];
  const disconnected: number[] = [];
  const calls: CatalogRpcMethodCall[] = [];

  return {
    calls,
    closedPorts,
    disconnected,
    coordinator: {
      async connectClient(): Promise<{ clientId: number; rendererPort: DesktopCatalogPortLike }> {
        const clientId = ++nextClientId;
        const listeners = new Set<(event: { readonly data: unknown }) => void>();
        const rendererPort: DesktopCatalogPortLike = {
          on(_event, listener) {
            listeners.add(listener);
          },
          off(_event, listener) {
            listeners.delete(listener);
          },
          start() {
            // no-op
          },
          close() {
            closedPorts.push(clientId);
          },
          postMessage(message: CatalogClientMessage) {
            if (message.type !== 'call') return;
            calls.push(message.call);
            const value = handler(message.call);
            queueMicrotask(() => {
              for (const l of [...listeners]) {
                l({ data: { type: 'result', reqId: message.reqId, value } });
              }
            });
          },
        };
        return { clientId, rendererPort };
      },
      disconnectClient(clientId: number) {
        disconnected.push(clientId);
      },
    },
  };
}

describe('createDesktopCatalogSnapshotBridge (HIGH #9)', () => {
  it('returns an empty snapshot when catalog coordinator is not yet initialized', async () => {
    const secrets = makeMemorySecrets();
    const bridge = createDesktopCatalogSnapshotBridge({
      getCoordinator: () => undefined,
      secretStore: secrets.store,
      clock: () => 1234,
    });
    expect(await bridge.getLocalSnapshot()).toEqual(createEmptyVaultSnapshot(1234));
  });

  it('exports real catalog sources (reading credentials strictly from SecretStore), favorites, hidden channels, custom groups, collections, and progress, and disconnects its port cleanly', async () => {
    const secrets = makeMemorySecrets({
      [secretKey('d-x', 'xtream')]: JSON.stringify({
        server: 'https://desk-xtream.example.test',
        username: 'desk_user',
        password: 'desk_password',
      }),
      [secretKey('d-m', 'playlist')]: 'https://desk-m3u.example.test/list.m3u',
    });

    const fake = makeFakeCoordinator((rpc) => {
      switch (rpc.method) {
        case 'listSources':
          return [
            { id: 'd-x', kind: 'xtream', name: 'Desk Xtream', createdAt: 100, needsImport: false },
            { id: 'd-m', kind: 'm3u', name: 'Desk M3U', createdAt: 200, needsImport: false },
          ];
        case 'listFavorites':
          return [{ itemKey: 'x:d-x:live:1', addedAt: 300 }];
        case 'listContinueWatching':
          return [
            {
              itemKey: 'x:d-x:movie:2',
              positionMs: 60_000,
              durationMs: 1_800_000,
              watched: false,
              updatedAt: 400,
            },
          ];
        case 'listChannelOverrides':
          return [{ itemKey: 'x:d-x:live:9', sourceId: 'd-x', isHidden: true, updatedAt: 500 }];
        case 'listCustomGroups':
          return [{ id: 'dg-1', name: 'News', sortOrder: 0, updatedAt: 600 }];
        case 'items':
          return [{ key: 'x:d-x:live:1' }];
        case 'listCollections':
          return [{ id: 'dc-1', name: 'Favorites VOD', updatedAt: 700 }];
        case 'listCollectionItems':
          return [{ key: 'x:d-x:movie:2' }];
        default:
          return [];
      }
    });

    const bridge = createDesktopCatalogSnapshotBridge({
      getCoordinator: () => fake.coordinator,
      secretStore: secrets.store,
      clock: () => 5000,
    });

    const snap = await bridge.getLocalSnapshot();
    expect(snap.updatedAt).toBe(5000);
    expect(snap.sources).toEqual([
      {
        id: 'd-x',
        kind: 'xtream',
        name: 'Desk Xtream',
        url: 'https://desk-xtream.example.test',
        username: 'desk_user',
        password: 'desk_password',
        updatedAt: 100,
      },
      {
        id: 'd-m',
        kind: 'm3u',
        name: 'Desk M3U',
        url: 'https://desk-m3u.example.test/list.m3u',
        updatedAt: 200,
      },
    ]);
    expect(snap.favorites).toEqual([{ key: 'x:d-x:live:1', updatedAt: 300 }]);
    expect(snap.hiddenChannels).toEqual([{ key: 'x:d-x:live:9', updatedAt: 500 }]);
    expect(snap.customGroups).toEqual([
      { id: 'dg-1', name: 'News', channelKeys: ['x:d-x:live:1'], sortOrder: 0, updatedAt: 600 },
    ]);
    expect(snap.collections).toEqual([
      { id: 'dc-1', name: 'Favorites VOD', itemKeys: ['x:d-x:movie:2'], updatedAt: 700 },
    ]);
    expect(snap.watchProgress).toEqual([
      {
        key: 'x:d-x:movie:2',
        positionMs: 60_000,
        durationMs: 1_800_000,
        completed: false,
        updatedAt: 400,
      },
    ]);
    expect(fake.closedPorts).toEqual([1]);
    expect(fake.disconnected).toEqual([1]);
  });

  it('applies merged remote snapshot via CatalogCoordinator RPCs and notifies onApplied', async () => {
    const secrets = makeMemorySecrets();
    const onApplied = vi.fn();
    const fake = makeFakeCoordinator((rpc) => {
      switch (rpc.method) {
        case 'listSources':
        case 'listFavoriteKeys':
        case 'listChannelOverrides':
        case 'listCustomGroups':
        case 'listCollections':
          return [];
        case 'itemDetail':
        case 'getProgress':
          return null;
        case 'addSource':
          return ok({ id: 'created-1', kind: 'm3u', name: 'Remote M3U', createdAt: 10 });
        case 'setFavorite':
          return ok(true);
        case 'setChannelOverride':
          return ok({});
        case 'saveProgress':
          return ok({});
        case 'flushPendingWrites':
          return undefined;
        default:
          return ok(undefined);
      }
    });

    const bridge = createDesktopCatalogSnapshotBridge({
      getCoordinator: () => fake.coordinator,
      secretStore: secrets.store,
      onApplied,
    });

    const merged: VaultSnapshot = {
      ...createEmptyVaultSnapshot(8000),
      sources: [
        {
          id: 'r-m3u',
          kind: 'm3u',
          name: 'Remote M3U',
          url: 'https://remote.example.test/list.m3u',
          epgUrl: 'https://remote.example.test/epg.xml',
          updatedAt: 1000,
        },
      ],
      favorites: [{ key: 'm:r-m3u:live:ch1', updatedAt: 1100 }],
      hiddenChannels: [{ key: 'm:r-m3u:live:ch2', updatedAt: 1200 }],
      watchProgress: [
        {
          key: 'm:r-m3u:movie:mov1',
          positionMs: 90_000,
          durationMs: 5_400_000,
          completed: false,
          updatedAt: 1300,
        },
      ],
    };

    await bridge.applyMergedSnapshot(merged);

    expect(fake.calls).toContainEqual({
      method: 'addSource',
      input: {
        kind: 'm3u',
        name: 'Remote M3U',
        playlistUrl: 'https://remote.example.test/list.m3u',
        guideUrl: 'https://remote.example.test/epg.xml',
      },
    });
    expect(fake.calls).toContainEqual(
      expect.objectContaining({
        method: 'setFavorite',
        active: true,
      }),
    );
    expect(fake.calls).toContainEqual({
      method: 'setChannelOverride',
      input: { itemKey: 'm:r-m3u:live:ch2', sourceId: 'r-m3u', isHidden: true },
    });
    expect(fake.calls).toContainEqual(
      expect.objectContaining({
        method: 'saveProgress',
        input: expect.objectContaining({
          sourceId: 'r-m3u',
          itemKey: 'm:r-m3u:movie:mov1',
          kind: 'movie',
          positionMs: 90_000,
          durationMs: 5_400_000,
          watched: false,
        }),
      }),
    );
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(fake.closedPorts).toEqual([1]);
    expect(fake.disconnected).toEqual([1]);
  });

  it('excludes synthetic Next-Up rows (positionMs <= 0 && !watched) from exported watchProgress (#502)', async () => {
    const secrets = makeMemorySecrets();
    const fake = makeFakeCoordinator((rpc) => {
      if (rpc.method === 'listContinueWatching') {
        return [
          {
            itemKey: 'x:d-x:ep:102',
            positionMs: 0,
            durationMs: 2_820_000,
            watched: false,
            updatedAt: 500,
          },
          {
            itemKey: 'x:d-x:movie:2',
            positionMs: 60_000,
            durationMs: 1_800_000,
            watched: false,
            updatedAt: 400,
          },
          {
            itemKey: 'x:d-x:ep:101',
            positionMs: 0,
            durationMs: 2_700_000,
            watched: true,
            updatedAt: 300,
          },
        ];
      }
      return [];
    });

    const bridge = createDesktopCatalogSnapshotBridge({
      getCoordinator: () => fake.coordinator,
      secretStore: secrets.store,
      clock: () => 5000,
    });

    const snap = await bridge.getLocalSnapshot();
    expect(snap.watchProgress).toEqual([
      {
        key: 'x:d-x:movie:2',
        positionMs: 60_000,
        durationMs: 1_800_000,
        completed: false,
        updatedAt: 400,
      },
      {
        key: 'x:d-x:ep:101',
        positionMs: 0,
        durationMs: 2_700_000,
        completed: true,
        updatedAt: 300,
      },
    ]);
  });

  it('exports ratings and applies LWW updates and tombstone deletions cleanly', async () => {
    const secrets = makeMemorySecrets();
    const setRatingCalls: unknown[] = [];
    const fake = makeFakeCoordinator((rpc) => {
      if (rpc.method === 'listRatings') {
        return [
          {
            profileId: 'default',
            sourceId: 'd-x',
            itemKey: 'x:d-x:movie:1',
            kind: 'movie',
            value: 'like',
            title: 'Dune',
            logo: 'https://cdn.example/dune.jpg',
            year: 2021,
            rating: 8.3,
            updatedAt: 500,
          },
          {
            profileId: 'default',
            sourceId: 'd-x',
            itemKey: 'x:d-x:series:2',
            kind: 'series',
            value: 'dislike',
            title: 'Dark',
            logo: null,
            year: 2017,
            rating: 8.7,
            updatedAt: 600,
          },
        ];
      }
      if (rpc.method === 'setRating') {
        setRatingCalls.push(rpc);
        return ok(rpc.value);
      }
      return [];
    });

    const onApplied = vi.fn();
    const bridge = createDesktopCatalogSnapshotBridge({
      getCoordinator: () => fake.coordinator,
      secretStore: secrets.store,
      clock: () => 5000,
      onApplied,
    });

    const exported = await bridge.getLocalSnapshot();
    expect(exported.ratings).toEqual([
      {
        key: 'x:d-x:movie:1',
        sourceId: 'd-x',
        kind: 'movie',
        value: 'like',
        title: 'Dune',
        logo: 'https://cdn.example/dune.jpg',
        year: 2021,
        rating: 8.3,
        updatedAt: 500,
      },
      {
        key: 'x:d-x:series:2',
        sourceId: 'd-x',
        kind: 'series',
        value: 'dislike',
        title: 'Dark',
        year: 2017,
        rating: 8.7,
        updatedAt: 600,
      },
    ]);

    const merged: VaultSnapshot = {
      ...createEmptyVaultSnapshot(7000),
      ratings: [
        // Stale update ignored (400 <= 500)
        {
          key: 'x:d-x:movie:1',
          sourceId: 'd-x',
          kind: 'movie',
          value: 'dislike',
          title: 'Dune',
          updatedAt: 400,
        },
        // Newer tombstone deletes existing series rating (700 >= 600)
        {
          key: 'x:d-x:series:2',
          sourceId: 'd-x',
          kind: 'series',
          value: 'dislike',
          title: 'Dark',
          updatedAt: 700,
          deleted: true,
        },
        // New rating inserted
        {
          key: 'x:d-x:movie:3',
          sourceId: 'd-x',
          kind: 'movie',
          value: 'like',
          title: 'Arrival',
          year: 2016,
          rating: 7.9,
          updatedAt: 800,
        },
      ],
    };
    await bridge.applyMergedSnapshot(merged);

    expect(setRatingCalls).toEqual([
      {
        method: 'setRating',
        input: {
          sourceId: 'd-x',
          itemKey: 'x:d-x:series:2',
          kind: 'series',
          title: 'Dark',
        },
        value: null,
      },
      {
        method: 'setRating',
        input: {
          sourceId: 'd-x',
          itemKey: 'x:d-x:movie:3',
          kind: 'movie',
          title: 'Arrival',
          logo: null,
          year: 2016,
          rating: 7.9,
        },
        value: 'like',
      },
    ]);
    expect(onApplied).toHaveBeenCalledTimes(1);
  });
});
