import { createCatalogService, createSyncSqlDriver, openCatalog } from '@elv/data';
import type { HttpClient, Scheduler, SecretStore } from '@elv/domain';
import { mergeVaultSnapshots } from '@elv/sync';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { CatalogClientMessage, CatalogRpcMethodCall } from '../../shared/catalog-ipc.ts';
import {
  executeWaveQ7OpsRpcCall,
  isWaveQ7RpcCall,
} from '../../utility/catalog-worker-wave-q7-ops.ts';
import {
  createDesktopCatalogSnapshotBridge,
  type DesktopCatalogPortLike,
} from './desktop-catalog-snapshot.ts';
import { reconcileLocalSnapshotWithBaseline } from './snapshot-tombstones.ts';

function makeMemorySecrets(): SecretStore {
  const data = new Map<string, string>();
  return {
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

async function makeDevice(clockRef: { now: number }) {
  const rawDb = new Database(':memory:');
  const driver = createSyncSqlDriver(rawDb);
  const secrets = makeMemorySecrets();
  const scheduler: Scheduler = { yieldNow: async () => undefined };
  const http = {
    get: async () => {
      throw new Error('offline');
    },
  } as unknown as HttpClient;
  await openCatalog(driver);
  const catalog = createCatalogService({
    db: driver,
    secrets,
    scheduler,
    http,
    clock: () => clockRef.now,
  });

  await driver.run(
    "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 100, '{}')",
  );
  await driver.run(
    `INSERT INTO live (source_id, key, provider_id, name, name_fold, sort_title, num, is_hidden, run_id)
     VALUES ('s1', 'x:s1:live:1', '1', 'Sports HD', 'sports hd', 'sports hd', 1, 0, 1),
            ('s1', 'x:s1:live:2', '2', 'News HD', 'news hd', 'news hd', 2, 0, 1)`,
  );

  let nextClientId = 0;
  const coordinator = {
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
        start() {},
        close() {},
        postMessage(message: CatalogClientMessage) {
          if (message.type !== 'call') return;
          const call: CatalogRpcMethodCall = message.call;
          const dispatch = async (): Promise<unknown> => {
            if (isWaveQ7RpcCall(call)) return executeWaveQ7OpsRpcCall(catalog, call);
            switch (call.method) {
              case 'listSources':
                return catalog.listSources();
              case 'listProfiles':
                return catalog.listProfiles?.() ?? [];
              case 'listFavorites':
                return catalog.listFavorites?.(call.limit, call.profileId, call.opts) ?? [];
              case 'listFavoriteKeys':
                return catalog.listFavoriteKeys?.(call.profileId) ?? [];
              case 'setFavorite':
                return catalog.setFavorite?.(call.input, call.active);
              case 'listChannelOverrides':
                return catalog.listChannelOverrides?.(call.profileId) ?? [];
              case 'listCustomGroups':
                return catalog.listCustomGroups?.(call.profileId, call.opts) ?? [];
              case 'listCollections':
                return catalog.listCollections?.(call.profileId, call.opts) ?? [];
              case 'listRatings':
                return catalog.listRatings?.(call.opts) ?? [];
              case 'listContinueWatching':
                return catalog.listContinueWatching?.(call.limit, call.profileId, call.opts) ?? [];
              case 'listAllWatchProgress':
                return catalog.listAllWatchProgress?.(call.profileId, call.limit) ?? [];
              case 'listContinueWatchingDismissals':
                return catalog.listContinueWatchingDismissals?.(call.profileId) ?? [];
              case 'getParentalSettings':
                return catalog.getParentalSettings?.(call.profileId);
              case 'flushPendingWrites':
                return catalog.flushPendingWrites?.();
              default:
                return [];
            }
          };
          void dispatch().then((value) => {
            for (const l of [...listeners]) {
              l({ data: { type: 'result', reqId: message.reqId, value } });
            }
          });
        },
      };
      return { clientId, rendererPort };
    },
    disconnectClient() {},
  };

  const bridge = createDesktopCatalogSnapshotBridge({
    getCoordinator: () => coordinator as never,
    secretStore: secrets,
    clock: () => clockRef.now,
  });

  return { catalog, bridge, rawDb };
}

describe('Desktop E2EE Vault snapshot liveFavoriteFolders round-trip (Wave Q7-B)', () => {
  it('exports, merges, applies, and tombstone-deletes liveFavoriteFolders across two desktop devices', async () => {
    const clock = { now: 1_000 };
    const devA = await makeDevice(clock);
    const devB = await makeDevice(clock);

    // Device A creates Sports folder and assigns channel 1
    const created = await devA.catalog.createLiveFavoriteFolder?.({ name: 'Sports' });
    expect(created?.ok).toBe(true);
    if (!created?.ok) return;
    await devA.catalog.assignLiveFavoriteFolder?.({
      itemKey: 'x:s1:live:1',
      sourceId: 's1',
      folderId: created.value.id,
      title: 'Sports HD',
    });

    const snapA1 = await devA.bridge.getLocalSnapshot();
    expect(snapA1.liveFavoriteFolders).toEqual([
      {
        id: created.value.id,
        name: 'Sports',
        channelKeys: ['x:s1:live:1'],
        sortOrder: 0,
        updatedAt: 1_000,
      },
    ]);

    // Device B receives merged snapshot and applies it
    const snapB0 = await devB.bridge.getLocalSnapshot();
    const merged1 = mergeVaultSnapshots(snapB0, snapA1);
    await devB.bridge.applyMergedSnapshot(merged1);

    const foldersB = await devB.catalog.listLiveFavoriteFolders?.();
    expect(foldersB?.map((f) => [f.id, f.name, f.itemCount])).toEqual([
      [created.value.id, 'Sports', 1],
    ]);
    expect(await devB.catalog.listLiveFavoriteFolderAssignments?.()).toEqual([
      { itemKey: 'x:s1:live:1', folderId: created.value.id },
    ]);

    // Device A deletes folder -> tombstone reconciliation propagates delete to Device B while keeping favorite
    clock.now = 2_000;
    await devA.catalog.deleteLiveFavoriteFolder?.(created.value.id);
    const freshA2 = await devA.bridge.getLocalSnapshot();
    const reconciledA2 = reconcileLocalSnapshotWithBaseline(freshA2, snapA1, clock.now);
    expect(reconciledA2.liveFavoriteFolders?.[0]?.deleted).toBe(true);

    const snapB1 = await devB.bridge.getLocalSnapshot();
    const merged2 = mergeVaultSnapshots(snapB1, reconciledA2);
    await devB.bridge.applyMergedSnapshot(merged2);

    expect(await devB.catalog.listLiveFavoriteFolders?.()).toEqual([]);
    expect(await devB.catalog.listFavoriteKeys?.()).toContain('x:s1:live:1');

    await devA.catalog.close();
    await devB.catalog.close();
  });

  it('BLOCKER-4: tombstone delete matches strictly by id (never deletes newer same-name folder), preserves sortOrder, updates loop maps, and never resurrects deleted favorites', async () => {
    const clock = { now: 1_000 };
    const dev = await makeDevice(clock);

    // Local device already has newer folder lff_new named "Sports"
    const createdLocal = await dev.catalog.createLiveFavoriteFolder?.({
      id: 'lff_new',
      name: 'Sports',
    });
    expect(createdLocal?.ok).toBe(true);
    await dev.catalog.assignLiveFavoriteFolder?.({
      itemKey: 'x:s1:live:1',
      sourceId: 's1',
      folderId: 'lff_new',
      title: 'Sports HD',
    });

    // Apply snapshot containing:
    // 1. Tombstone for OLD id lff_old also named "Sports" (newer updatedAt 5_000) -> MUST NOT delete lff_new!
    // 2. Two new folders out-of-order in array: lff_z (sortOrder: 2), lff_a (sortOrder: 1) -> must be created in sortOrder ASC order!
    // 3. Channel x:s1:live:2 listed in lff_a.channelKeys, BUT simultaneously deleted in snapshot.favorites -> MUST NOT be resurrected!
    // 4. Delete of lff_old2 followed by create of same-name folder lff_reborn in same snapshot -> loop maps stay consistent!
    const snap = await dev.bridge.getLocalSnapshot();
    const incoming = {
      ...snap,
      favorites: [
        ...snap.favorites,
        {
          key: 'x:s1:live:2',
          updatedAt: 6_000,
          deleted: true,
        },
      ],
      liveFavoriteFolders: [
        {
          id: 'lff_old',
          name: 'Sports',
          channelKeys: [],
          sortOrder: 0,
          updatedAt: 5_000,
          deleted: true,
        },
        {
          id: 'lff_z',
          name: 'Zebra',
          channelKeys: [],
          sortOrder: 2,
          updatedAt: 4_000,
        },
        {
          id: 'lff_a',
          name: 'Alpha',
          channelKeys: ['x:s1:live:2'],
          sortOrder: 1,
          updatedAt: 4_000,
        },
      ],
    };

    await dev.bridge.applyMergedSnapshot(incoming);

    const folders = (await dev.catalog.listLiveFavoriteFolders?.()) ?? [];
    // lff_new ("Sports") must survive tombstone for lff_old ("Sports")
    expect(folders.map((f) => f.id)).toEqual(['lff_new', 'lff_a', 'lff_z']);
    // Deleted favorite x:s1:live:2 must NOT be resurrected by lff_a.channelKeys
    const favKeys = (await dev.catalog.listFavoriteKeys?.()) ?? [];
    expect(favKeys).not.toContain('x:s1:live:2');
    const assignments = (await dev.catalog.listLiveFavoriteFolderAssignments?.()) ?? [];
    expect(assignments.some((a) => a.itemKey === 'x:s1:live:2')).toBe(false);

    // Now test same-snapshot delete of existing lff_z ("Zebra") + create of lff_z2 ("Zebra") -> maps update across loop iterations
    const snap2 = await dev.bridge.getLocalSnapshot();
    await dev.bridge.applyMergedSnapshot({
      ...snap2,
      liveFavoriteFolders: [
        {
          id: 'lff_z',
          name: 'Zebra',
          channelKeys: [],
          sortOrder: 2,
          updatedAt: 8_000,
          deleted: true,
        },
        {
          id: 'lff_z2',
          name: 'Zebra',
          channelKeys: ['x:s1:live:1'],
          sortOrder: 3,
          updatedAt: 8_500,
        },
      ],
    });
    const foldersAfter = (await dev.catalog.listLiveFavoriteFolders?.()) ?? [];
    expect(foldersAfter.map((f) => f.id)).toContain('lff_z2');
    expect(foldersAfter.map((f) => f.id)).not.toContain('lff_z');
    expect(
      ((await dev.catalog.listLiveFavoriteFolderAssignments?.()) ?? []).find(
        (a) => a.itemKey === 'x:s1:live:1',
      )?.folderId,
    ).toBe('lff_z2');

    await dev.catalog.close();
  });
});
