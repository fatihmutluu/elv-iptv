import {
  createCatalogService,
  createSyncSqlDriver,
  openCatalog,
  pinSecretKey,
  type SourceSettings,
} from '@elv/data';
import type { HttpClient, Scheduler, SecretStore } from '@elv/domain';
import { decodeEpisodeBitfield, mergeVaultSnapshots, type VaultSnapshot } from '@elv/sync';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogClientMessage, CatalogRpcMethodCall } from '../../shared/catalog-ipc.ts';
import { isChannelOpsRpcCall } from '../../shared/catalog-ipc-channel-guards.ts';
import { isAddSourceInput } from '../../shared/catalog-ipc-guards.ts';
import {
  createDesktopCatalogSnapshotBridge,
  type DesktopCatalogPortLike,
} from './desktop-catalog-snapshot.ts';
import { reconcileLocalSnapshotWithBaseline } from './snapshot-tombstones.ts';

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
  return {
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
            // no-op
          },
          postMessage(message: CatalogClientMessage) {
            if (message.type !== 'call') return;
            Promise.resolve(handler(message.call)).then((value) => {
              for (const l of [...listeners]) {
                l({ data: { type: 'result', reqId: message.reqId, value } });
              }
            });
          },
        };
        return { clientId, rendererPort };
      },
      disconnectClient() {
        // no-op
      },
    },
  };
}

async function makeSqliteDevice(clockRef: { now: number }) {
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
  let seq = 0;
  const catalog = createCatalogService({
    db: driver,
    secrets: secrets.store,
    scheduler,
    http,
    clock: () => clockRef.now,
    newId: () => `src_${++seq}`,
  });

  const fake = makeFakeCoordinator((rpc) => {
    switch (rpc.method) {
      case 'listSources':
        return catalog.listSources();
      case 'listSourceRecords':
        return catalog.listSourceRecords?.();
      case 'addSource':
        return catalog.addSource(rpc.input);
      case 'removeSource':
        return catalog.removeSource(rpc.id);
      case 'renameSource':
        return catalog.renameSource?.(rpc.sourceId, rpc.name);
      case 'setSourceExcludedProfiles':
        return catalog.setSourceExcludedProfiles?.(rpc.sourceId, rpc.excludedProfileIds);
      case 'updateSourceSettings':
        return catalog.updateSourceSettings?.(rpc.sourceId, rpc.patch);
      case 'listProfiles':
        return catalog.listProfiles?.();
      case 'createProfile':
        return catalog.createProfile?.(rpc.input);
      case 'updateProfile':
        return catalog.updateProfile?.(rpc.id, rpc.patch);
      case 'deleteProfile':
        return catalog.deleteProfile?.(rpc.id);
      case 'getParentalSettings':
        return catalog.getParentalSettings?.(rpc.profileId);
      case 'updateParentalSettings':
        return catalog.updateParentalSettings?.(rpc.patch, rpc.profileId);
      case 'listFavorites':
        return catalog.listFavorites?.(rpc.limit, rpc.profileId, rpc.opts);
      case 'listFavoriteKeys':
        return catalog.listFavoriteKeys?.(rpc.profileId);
      case 'setFavorite':
        return catalog.setFavorite?.(rpc.input, rpc.active);
      case 'reorderFavorites':
        return catalog.reorderFavorites?.(rpc.orderedItemKeys, rpc.profileId);
      case 'listAllWatchProgress':
        return catalog.listAllWatchProgress?.(rpc.profileId, rpc.limit);
      case 'listContinueWatching':
        return catalog.listContinueWatching?.(rpc.limit, rpc.profileId, rpc.opts);
      case 'getProgress':
        return catalog.getProgress?.(rpc.itemKey, rpc.profileId);
      case 'saveProgress':
        return catalog.saveProgress?.(rpc.input);
      case 'clearProgress':
        return catalog.clearProgress?.(rpc.itemKey, rpc.profileId);
      case 'applyWatchedEpisodeBitfield':
        return catalog.applyWatchedEpisodeBitfield?.(rpc.input);
      case 'listContinueWatchingDismissals':
        return catalog.listContinueWatchingDismissals?.(rpc.profileId);
      case 'setContinueWatchingDismissal':
        return catalog.setContinueWatchingDismissal?.(rpc.input, rpc.deleted);
      case 'listChannelOverrides':
        return catalog.listChannelOverrides?.(rpc.profileId);
      case 'setChannelOverride':
        return catalog.setChannelOverride?.(rpc.input);
      case 'listCustomGroups':
        return catalog.listCustomGroups?.(rpc.profileId, rpc.opts);
      case 'createCustomGroup':
        return catalog.createCustomGroup?.(rpc.input);
      case 'updateCustomGroup':
        return catalog.updateCustomGroup?.(rpc.groupId, rpc.patch);
      case 'deleteCustomGroup':
        return catalog.deleteCustomGroup?.(rpc.groupId);
      case 'setCustomGroupItems':
        return catalog.setCustomGroupItems?.(rpc.groupId, rpc.items);
      case 'items':
        return catalog.items(rpc.categoryId, rpc.offset, rpc.limit, rpc.opts);
      case 'listCollections':
        return catalog.listCollections?.(rpc.profileId, rpc.opts);
      case 'createCollection':
        return catalog.createCollection?.(rpc.input);
      case 'renameCollection':
        return catalog.renameCollection?.(rpc.id, rpc.name, rpc.profileId);
      case 'reorderCollections':
        return catalog.reorderCollections?.(rpc.orderedIds, rpc.profileId);
      case 'deleteCollection':
        return catalog.deleteCollection?.(rpc.id, rpc.profileId);
      case 'listCollectionRawItemKeys':
        return catalog.listCollectionRawItemKeys?.(rpc.collectionId, rpc.profileId);
      case 'listCollectionItems':
        return catalog.listCollectionItems?.(rpc.collectionId, rpc.opts);
      case 'addItemToCollection':
        return catalog.addItemToCollection?.(
          rpc.collectionId,
          rpc.itemKey,
          rpc.kind,
          rpc.profileId,
        );
      case 'removeItemFromCollection':
        return catalog.removeItemFromCollection?.(rpc.collectionId, rpc.itemKey, rpc.profileId);
      case 'reorderCollectionItems':
        return catalog.reorderCollectionItems?.(
          rpc.collectionId,
          rpc.orderedItemKeys,
          rpc.profileId,
        );
      case 'listRatings':
        return catalog.listRatings?.(rpc.opts);
      case 'setRating':
        return catalog.setRating?.(rpc.input, rpc.value);
      case 'itemDetail':
        return catalog.itemDetail?.(rpc.itemKey, rpc.opts);
      case 'flushPendingWrites':
        return catalog.flushPendingWrites?.();
      default:
        return [];
    }
  });
  const onApplied = vi.fn();
  const bridge = createDesktopCatalogSnapshotBridge({
    getCoordinator: () => fake.coordinator,
    secretStore: secrets.store,
    clock: () => clockRef.now,
    onApplied,
  });
  return { driver, catalog, secrets, bridge, onApplied };
}

describe('createDesktopCatalogSnapshotBridge VaultSnapshot v2 round-trip (#510)', () => {
  it('round-trips profiles+PIN, Stalker+Xtream settings+LWW edits, favorites sortOrder+tombstones, completed progress+bitfields+dismissals, collections+removals, and ratings across two SQLite devices', async () => {
    const clockA = { now: 10_000 };
    const clockB = { now: 10_000 };
    const devA = await makeSqliteDevice(clockA);
    const devB = await makeSqliteDevice(clockB);
    try {
      await devA.catalog.createProfile?.({
        id: 'kids_1',
        name: 'Kids Room',
        avatarToken: 'emerald',
        isKids: true,
      });
      await devA.catalog.updateParentalSettings?.({ enabled: true, maxRatingAge: 12 }, 'kids_1');
      await devA.secrets.store.set(pinSecretKey('kids_1'), 'pbkdf2$100000$saltA$hashA');

      const xtRes = await devA.catalog.addSource({
        kind: 'xtream',
        name: 'Provider Alpha',
        server: 'https://alpha.example.test',
        username: 'u_alpha',
        password: 'p_alpha',
        backupServers: ['https://mirror1.example.test'],
        xmltvTimezone: 'Europe/Istanbul',
        transport: { userAgent: 'ELV-Test/1.0', xtreamFormat: 'ts' },
      });
      expect(xtRes.ok).toBe(true);
      const xtId = xtRes.ok ? xtRes.value.id : '';
      await devA.catalog.setSourceExcludedProfiles?.(xtId, ['kids_1']);
      const patchSettings: Partial<SourceSettings> = {
        epgShiftMs: 3_600_000,
        categorySelection: { live: ['Sports', 'News'] },
      };
      await devA.catalog.updateSourceSettings?.(xtId, patchSettings);

      const stRes = await devA.catalog.addSource({
        kind: 'stalker',
        name: 'Portal Beta',
        portalUrl: 'https://portal.example.test/c/',
        mac: '00:1A:79:AA:BB:CC',
        serialNumber: 'SN-999',
      });
      expect(stRes.ok).toBe(true);

      const seedEpSql = `INSERT INTO episodes (source_id, series_key, key, provider_id, season, episode, title, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`;
      await devB.driver.run(seedEpSql, [
        xtId,
        `x:${xtId}:series:9`,
        `x:${xtId}:ep:901`,
        '901',
        1,
        1,
        'E1',
      ]);
      await devB.driver.run(seedEpSql, [
        xtId,
        `x:${xtId}:series:9`,
        `x:${xtId}:ep:903`,
        '903',
        1,
        3,
        'E3',
      ]);

      await devA.catalog.setFavorite?.(
        { sourceId: xtId, itemKey: `x:${xtId}:live:2`, kind: 'live', title: 'Ch 2' },
        true,
      );
      await devA.catalog.setFavorite?.(
        { sourceId: xtId, itemKey: `x:${xtId}:live:1`, kind: 'live', title: 'Ch 1' },
        true,
      );
      await devA.catalog.reorderFavorites?.([`x:${xtId}:live:1`, `x:${xtId}:live:2`], 'default');
      await devA.catalog.setFavorite?.(
        {
          profileId: 'kids_1',
          sourceId: xtId,
          itemKey: `x:${xtId}:live:7`,
          kind: 'live',
          title: 'Cartoons',
        },
        true,
      );

      await devA.catalog.saveProgress?.({
        sourceId: xtId,
        itemKey: `x:${xtId}:movie:10`,
        kind: 'movie',
        title: 'Done Movie',
        positionMs: 7_200_000,
        durationMs: 7_200_000,
        watched: true,
      });
      await devA.catalog.saveProgress?.({
        profileId: 'kids_1',
        sourceId: xtId,
        itemKey: `x:${xtId}:ep:901`,
        kind: 'episode',
        title: 'E1',
        seriesKey: `x:${xtId}:series:9`,
        season: 1,
        episode: 1,
        positionMs: 1_800_000,
        durationMs: 1_800_000,
        watched: true,
      });
      await devA.catalog.saveProgress?.({
        profileId: 'kids_1',
        sourceId: xtId,
        itemKey: `x:${xtId}:ep:903`,
        kind: 'episode',
        title: 'E3',
        seriesKey: `x:${xtId}:series:9`,
        season: 1,
        episode: 3,
        positionMs: 1_800_000,
        durationMs: 1_800_000,
        watched: true,
      });
      await devA.catalog.setContinueWatchingDismissal?.(
        {
          profileId: 'default',
          seriesKey: `x:${xtId}:series:55`,
          sourceId: xtId,
          dismissedAt: 10_000,
        },
        false,
      );

      await devA.catalog.createCollection?.({ id: 'col_empty', name: 'Watch Later' });
      await devA.catalog.createCollection?.({
        id: 'col_kids',
        profileId: 'kids_1',
        name: 'Animated',
      });
      await devA.catalog.addItemToCollection?.('col_kids', `x:${xtId}:movie:20`, 'movie', 'kids_1');
      await devA.catalog.addItemToCollection?.('col_kids', `x:${xtId}:movie:21`, 'movie', 'kids_1');
      await devA.catalog.setRating?.(
        {
          profileId: 'kids_1',
          sourceId: xtId,
          itemKey: `x:${xtId}:movie:20`,
          kind: 'movie',
          title: 'Toy World',
        },
        'like',
      );

      const snapA1 = await devA.bridge.getLocalSnapshot();
      expect(snapA1.profiles?.map((p) => p.id)).toContain('kids_1');
      const kidsProf = snapA1.profiles?.find((p) => p.id === 'kids_1');
      expect(kidsProf?.pinHash).toBe('pbkdf2$100000$saltA$hashA');
      expect(kidsProf?.parentalEnabled).toBe(true);
      expect(kidsProf?.parentalMaxRating).toBe('12');
      expect(snapA1.sources.find((s) => s.kind === 'stalker')?.mac).toBe('00:1A:79:AA:BB:CC');
      expect(snapA1.sources.find((s) => s.kind === 'xtream')?.settings).toMatchObject({
        excludedProfileIds: ['kids_1'],
        epgShiftMs: 3_600_000,
        xmltvTimezone: 'Europe/Istanbul',
        backupServers: ['https://mirror1.example.test'],
      });
      expect(snapA1.watchedEpisodesBitfields).toHaveLength(1);
      expect(decodeEpisodeBitfield(snapA1.watchedEpisodesBitfields[0]?.bitsB64 ?? '')).toEqual([
        1, 3,
      ]);
      expect(snapA1.continueWatchingDismissals).toHaveLength(1);
      expect(snapA1.collections.find((c) => c.id === 'col_empty')?.itemKeys).toEqual([]);

      await devB.bridge.applyMergedSnapshot(snapA1);

      const profilesB = (await devB.catalog.listProfiles?.()) ?? [];
      expect(profilesB.find((p) => p.id === 'kids_1')?.isKids).toBe(true);
      expect(await devB.secrets.store.get(pinSecretKey('kids_1'))).toBe(
        'pbkdf2$100000$saltA$hashA',
      );
      expect((await devB.catalog.getParentalSettings?.('kids_1'))?.maxRatingAge).toBe(12);
      const favsB =
        (await devB.catalog.listFavorites?.(50, 'default', { parentalUnlocked: true })) ?? [];
      expect(favsB.map((f) => f.itemKey)).toEqual([`x:${xtId}:live:1`, `x:${xtId}:live:2`]);
      const progressB = await devB.catalog.listAllWatchProgress?.('default');
      expect(progressB?.find((p) => p.itemKey === `x:${xtId}:movie:10`)?.watched).toBe(true);
      const dismissalsB = await devB.catalog.listContinueWatchingDismissals?.('default');
      expect(dismissalsB?.map((d) => d.seriesKey)).toEqual([`x:${xtId}:series:55`]);
      const colKidsKeysB = await devB.catalog.listCollectionRawItemKeys?.('col_kids', 'kids_1');
      expect(colKidsKeysB).toEqual([`x:${xtId}:movie:20`, `x:${xtId}:movie:21`]);
      const ratingsB = await devB.catalog.listRatings?.({
        profileId: 'kids_1',
        parentalUnlocked: true,
      });
      expect(ratingsB?.map((r) => r.itemKey)).toEqual([`x:${xtId}:movie:20`]);

      clockA.now = 20_000;
      await devA.catalog.renameSource?.(xtId, 'Provider Alpha Renamed');
      await devA.catalog.setSourceExcludedProfiles?.(xtId, []);
      await devA.catalog.updateSourceSettings?.(xtId, { epgShiftMs: -1_800_000 });
      await devA.catalog.setFavorite?.(
        { sourceId: xtId, itemKey: `x:${xtId}:live:2`, kind: 'live', title: 'Ch 2' },
        false,
      );
      await devA.catalog.removeItemFromCollection?.('col_kids', `x:${xtId}:movie:21`, 'kids_1');

      const freshA2 = await devA.bridge.getLocalSnapshot();
      const snapA2 = reconcileLocalSnapshotWithBaseline(freshA2, snapA1, clockA.now);
      const merged2 = mergeVaultSnapshots(snapA2, await devB.bridge.getLocalSnapshot());
      await devB.bridge.applyMergedSnapshot(merged2);

      const sourcesB2 = await devB.catalog.listSourceRecords?.();
      const xtB = sourcesB2?.find((s) => s.kind === 'xtream');
      expect(xtB?.name).toBe('Provider Alpha Renamed');
      expect(xtB?.settings.excludedProfileIds ?? []).toEqual([]);
      expect(xtB?.settings.epgShiftMs).toBe(-1_800_000);
      expect(await devB.catalog.listFavoriteKeys?.('default')).toEqual([`x:${xtId}:live:1`]);
      expect(await devB.catalog.listCollectionRawItemKeys?.('col_kids', 'kids_1')).toEqual([
        `x:${xtId}:movie:20`,
      ]);
    } finally {
      await devA.catalog.close();
      await devB.catalog.close();
    }
  });

  it('preserves explicit source and custom group IDs across devices, applies LWW updates when local createdAt is newer, and suppresses no-op onApplied (P1-1, P1-9)', async () => {
    // Desktop IPC guards accept valid explicit source/group IDs and reject invalid ones
    expect(
      isAddSourceInput({
        id: 'src_explicit_99',
        kind: 'm3u',
        name: 'Feed',
        playlistUrl: 'https://feed.example.test/list.m3u',
      }),
    ).toBe(true);
    expect(
      isAddSourceInput({
        id: '../bad/id',
        kind: 'm3u',
        name: 'Feed',
        playlistUrl: 'https://feed.example.test/list.m3u',
      }),
    ).toBe(false);
    expect(
      isChannelOpsRpcCall({
        method: 'createCustomGroup',
        input: { id: 'grp_exact_42', name: 'Sports' },
      }),
    ).toBe(true);
    expect(
      isChannelOpsRpcCall({
        method: 'createCustomGroup',
        input: { id: 'bad group id!', name: 'Sports' },
      }),
    ).toBe(false);

    const clockA = { now: 10_000 };
    // Device B clock is intentionally much newer than Device A's source updatedAt!
    const clockB = { now: 50_000 };
    const devA = await makeSqliteDevice(clockA);
    const devB = await makeSqliteDevice(clockB);
    try {
      const xtRes = await devA.catalog.addSource({
        id: 'src_explicit_alpha',
        kind: 'xtream',
        name: 'Alpha Original',
        server: 'https://alpha-id.example.test',
        username: 'u1',
        password: 'p1',
      });
      expect(xtRes.ok).toBe(true);
      const xtId = xtRes.ok ? xtRes.value.id : '';
      expect(xtId).toBe('src_explicit_alpha');

      const grpRes = await devA.catalog.createCustomGroup?.({
        id: 'grp_explicit_sports',
        name: 'Sports',
      });
      expect(grpRes?.ok).toBe(true);
      await devA.catalog.setCustomGroupItems?.('grp_explicit_sports', [
        { itemKey: `x:${xtId}:live:10`, sourceId: xtId },
      ]);
      await devA.catalog.setFavorite?.(
        { sourceId: xtId, itemKey: `x:${xtId}:live:10`, kind: 'live', title: 'Sport 1' },
        true,
      );
      await devA.catalog.saveProgress?.({
        sourceId: xtId,
        itemKey: `x:${xtId}:movie:5`,
        kind: 'movie',
        title: 'Match Replay',
        positionMs: 30_000,
        durationMs: 90_000,
        watched: false,
      });
      await devA.catalog.setContinueWatchingDismissal?.(
        {
          profileId: 'default',
          seriesKey: `x:${xtId}:series:7`,
          sourceId: xtId,
          dismissedAt: 10_000,
        },
        false,
      );

      const snapA1 = await devA.bridge.getLocalSnapshot();
      await devB.bridge.applyMergedSnapshot(snapA1);

      // Device B created the exact same source ID and custom group ID so all item keys bind seamlessly
      const sourcesB1 = await devB.catalog.listSourceRecords?.();
      expect(sourcesB1?.map((s) => s.id)).toEqual(['src_explicit_alpha']);
      expect(sourcesB1?.[0]?.createdAt).toBe(50_000);
      const groupsB1 = await devB.catalog.listCustomGroups?.('default');
      expect(groupsB1?.map((g) => g.id)).toEqual(['grp_explicit_sports']);
      expect(await devB.catalog.listFavoriteKeys?.('default')).toEqual([`x:${xtId}:live:10`]);
      expect((await devB.catalog.getProgress?.(`x:${xtId}:movie:5`, 'default'))?.positionMs).toBe(
        30_000,
      );

      // P1-9: Re-applying an identical snapshot (plus a tombstone for an absent progress key) is a strict no-op
      devB.onApplied.mockClear();
      const identicalPlusAbsentTombstone: VaultSnapshot = {
        ...snapA1,
        watchProgress: [
          ...snapA1.watchProgress,
          {
            key: `x:${xtId}:movie:absent`,
            positionMs: 0,
            durationMs: 0,
            completed: false,
            updatedAt: 25_000,
            deleted: true,
          },
        ],
      };
      await devB.bridge.applyMergedSnapshot(identicalPlusAbsentTombstone);
      expect(devB.onApplied).not.toHaveBeenCalled();

      // P1-1: Remote rename/settings update at t=20_000 (< Device B's createdAt=50_000) MUST still apply!
      clockA.now = 20_000;
      await devA.catalog.renameSource?.(xtId, 'Alpha Remote Rename');
      await devA.catalog.updateSourceSettings?.(xtId, { epgShiftMs: 1_800_000 });
      const snapA2 = await devA.bridge.getLocalSnapshot();
      await devB.bridge.applyMergedSnapshot(snapA2);

      const sourcesB2 = await devB.catalog.listSourceRecords?.();
      expect(sourcesB2?.[0]?.name).toBe('Alpha Remote Rename');
      expect(sourcesB2?.[0]?.settings.epgShiftMs).toBe(1_800_000);
      expect(devB.onApplied).toHaveBeenCalledTimes(1);
    } finally {
      await devA.catalog.close();
      await devB.catalog.close();
    }
  });
});
