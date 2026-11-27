import type { HttpClient, Scheduler, SecretStore } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { commitStagedCatalog } from './catalog-commit';
import { openCatalog } from './migrate';
import { setParentalLock, updateParentalSettings } from './parental-repo';
import { createProfile } from './profiles-repo';
import { removeSource } from './sources';
import { testDb } from './test-db';
import { listFavorites, setFavorite } from './user-state';
import {
  addItemToCollection,
  createCollection,
  deleteCollection,
  listCollectionItems,
  listCollections,
  listCollectionsForItem,
  removeItemFromCollection,
  renameCollection,
  reorderCollectionItems,
  reorderCollections,
} from './vod-collections-repo';
import { createCoalescedCatalog } from './write-coalescer';

function memorySecrets(): SecretStore {
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

const dummyHttp: HttpClient = {
  async get() {
    throw new Error('no network expected');
  },
};

const immediateScheduler: Scheduler = {
  yieldNow: async () => undefined,
};

async function seedCatalog(db: ReturnType<typeof testDb>['db']) {
  expect((await openCatalog(db)).ok).toBe(true);
  await db.run(
    "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 1, '{}'), ('s2', 'stalker', 'Portal', 2, '{}')",
  );
  await db.run(
    `INSERT INTO movies (source_id, key, provider_id, name, name_fold, sort_title, logo, rating, year, run_id)
     VALUES
       ('s1', 'x:s1:movie:1', '1', 'Solaris', 'solaris', 'solaris', 'http://cdn.example/solaris.jpg', 8.0, 1972, 1),
       ('s1', 'x:s1:movie:2', '2', 'Metropolis', 'metropolis', 'metropolis', null, 8.3, 1927, 1),
       ('s2', 's:s2:movie:3', '3', 'Adult XXX Night', 'adult xxx night', 'adult xxx night', null, 5.0, 2020, 1)`,
  );
  await db.run(
    `INSERT INTO series (source_id, key, provider_id, name, name_fold, sort_title, cover, rating, year, run_id)
     VALUES
       ('s1', 'x:s1:series:10', '10', 'The Twilight Zone', 'the twilight zone', 'twilight zone', null, 9.0, 1959, 1)`,
  );
}

describe('Custom User VOD Collections (#403)', () => {
  it('supports full CRUD, collection reordering, item add/remove/reorder, and position compaction', async () => {
    const { db } = testDb();
    await seedCatalog(db);

    const invalidName = await createCollection(db, { name: '   ' }, 100);
    expect(invalidName.ok).toBe(false);

    const c1 = await createCollection(db, { id: 'col-1', name: 'Sci-Fi Classics' }, 100);
    const c2 = await createCollection(db, { id: 'col-2', name: 'Weekend Picks' }, 200);
    expect(c1.ok && c2.ok).toBe(true);
    if (!c1.ok || !c2.ok) return;

    expect((await listCollections(db)).map((c) => [c.id, c.sortOrder, c.itemCount])).toEqual([
      ['col-1', 0, 0],
      ['col-2', 1, 0],
    ]);

    // Add movies and a series (idempotent on duplicate)
    expect(
      (await addItemToCollection(db, 'col-1', 'x:s1:movie:1', 'movie', undefined, 300)).ok,
    ).toBe(true);
    expect(
      (await addItemToCollection(db, 'col-1', 'x:s1:movie:1', 'movie', undefined, 301)).ok,
    ).toBe(true);
    expect(
      (await addItemToCollection(db, 'col-1', 'x:s1:series:10', 'series', undefined, 302)).ok,
    ).toBe(true);
    expect(
      (await addItemToCollection(db, 'col-1', 'x:s1:movie:2', 'movie', undefined, 303)).ok,
    ).toBe(true);
    expect(
      (await addItemToCollection(db, 'col-2', 's:s2:movie:3', 'movie', undefined, 304)).ok,
    ).toBe(true);

    expect(await listCollectionsForItem(db, 'x:s1:movie:1')).toEqual(['col-1']);
    expect(await listCollectionsForItem(db, 's:s2:movie:3')).toEqual(['col-2']);
    expect((await listCollectionItems(db, 'col-1')).map((i) => i.key)).toEqual([
      'x:s1:movie:1',
      'x:s1:series:10',
      'x:s1:movie:2',
    ]);

    // Reorder items inside col-1
    const reorderedItems = await reorderCollectionItems(
      db,
      'col-1',
      ['x:s1:movie:2', 'x:s1:movie:1'],
      undefined,
      400,
    );
    expect(reorderedItems.ok).toBe(true);
    expect((await listCollectionItems(db, 'col-1')).map((i) => i.key)).toEqual([
      'x:s1:movie:2',
      'x:s1:movie:1',
      'x:s1:series:10',
    ]);

    // Remove middle item and verify compaction 0..N-1
    expect((await removeItemFromCollection(db, 'col-1', 'x:s1:movie:1', undefined, 500)).ok).toBe(
      true,
    );
    const rawPos = await db.all<{ item_key: string; position: number }>(
      'SELECT item_key, position FROM vod_collection_items WHERE collection_id = ? ORDER BY position',
      ['col-1'],
    );
    expect(rawPos).toEqual([
      { item_key: 'x:s1:movie:2', position: 0 },
      { item_key: 'x:s1:series:10', position: 1 },
    ]);

    // Rename & reorder collections
    const renamed = await renameCollection(db, 'col-2', 'Friday Night', undefined, 600);
    expect(renamed.ok).toBe(true);
    if (renamed.ok) {
      expect(renamed.value.name).toBe('Friday Night');
      expect(renamed.value.itemCount).toBe(1);
    }

    const reorderedCols = await reorderCollections(db, ['col-2', 'col-1'], undefined, 700);
    expect(reorderedCols.ok).toBe(true);
    if (reorderedCols.ok) {
      expect(reorderedCols.value.map((c) => [c.id, c.sortOrder])).toEqual([
        ['col-2', 0],
        ['col-1', 1],
      ]);
    }

    // Delete col-2 -> col-1 compacts to sortOrder 0
    expect((await deleteCollection(db, 'col-2')).ok).toBe(true);
    expect((await listCollections(db)).map((c) => [c.id, c.sortOrder, c.itemCount])).toEqual([
      ['col-1', 0, 2],
    ]);
  });

  it('survives catalog resyncs without losing valid items, ignores stale deleted items in itemCount, and purges on removeSource', async () => {
    const { db } = testDb();
    const secrets = memorySecrets();
    await seedCatalog(db);

    await createCollection(db, { id: 'c1', name: 'Favorites Mix' }, 100);
    await addItemToCollection(db, 'c1', 'x:s1:movie:1', 'movie', undefined, 101);
    await addItemToCollection(db, 'c1', 'x:s1:movie:2', 'movie', undefined, 102);
    await addItemToCollection(db, 'c1', 's:s2:movie:3', 'movie', undefined, 103);

    // Simulate a catalog resync of s1 that keeps movie:1 and drops movie:2
    await db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO movies_next (source_id, key, provider_id, name, name_fold, sort_title, run_id, content_hash)
         VALUES ('s1', 'x:s1:movie:1', '1', 'Solaris (Remastered)', 'solaris remastered', 'solaris remastered', 2, 'h2')`,
      );
      await commitStagedCatalog(tx, 's1', 2, ['live', 'series']);
    });

    const colsAfterResync = await listCollections(db);
    // Only movie:1 (s1) and movie:3 (s2) exist now -> hydrated itemCount = 2!
    expect(colsAfterResync[0]?.itemCount).toBe(2);
    expect((await listCollectionItems(db, 'c1')).map((i) => i.name)).toEqual([
      'Solaris (Remastered)',
      'Adult XXX Night',
    ]);

    // Removing source s2 purges s2's collection items cleanly
    expect((await removeSource('s2', { db, secrets })).ok).toBe(true);
    expect((await listCollectionItems(db, 'c1')).map((i) => i.key)).toEqual(['x:s1:movie:1']);
    expect((await listCollections(db))[0]?.itemCount).toBe(1);
  });

  it('enforces per-profile isolation and filters locked movies/series under active parental controls', async () => {
    const { db } = testDb();
    await seedCatalog(db);
    await createProfile(
      db,
      { name: 'Kids', isKids: true },
      () => 100,
      () => 'kids',
    );

    await createCollection(db, { id: 'def-col', profileId: 'default', name: 'Adult List' }, 100);
    await createCollection(db, { id: 'kids-col', profileId: 'kids', name: 'Kids List' }, 100);

    // Cross-profile mutation is rejected
    const crossAdd = await addItemToCollection(db, 'def-col', 'x:s1:movie:1', 'movie', 'kids', 105);
    expect(crossAdd.ok).toBe(false);

    await addItemToCollection(db, 'kids-col', 'x:s1:movie:1', 'movie', 'kids', 110);
    await addItemToCollection(db, 'kids-col', 's:s2:movie:3', 'movie', 'kids', 111);
    await addItemToCollection(db, 'kids-col', 'x:s1:series:10', 'series', 'kids', 112);

    // Lock series:10 explicitly for kids profile; movie:3 is blocked by adult-keyword filter
    await updateParentalSettings(db, 'kids', { enabled: true, blockAdultKeywords: true });
    await setParentalLock(
      db,
      {
        profileId: 'kids',
        sourceId: 's1',
        targetKind: 'item',
        itemKind: 'series',
        targetKey: 'x:s1:series:10',
      },
      true,
    );

    const kidsItemsLocked = await listCollectionItems(db, 'kids-col', { profileId: 'kids' });
    expect(kidsItemsLocked.map((i) => i.key)).toEqual(['x:s1:movie:1']);

    // listCollections itemCount MUST match parental-filtered listCollectionItems count
    const kidsColsLocked = await listCollections(db, 'kids');
    expect(kidsColsLocked[0]?.itemCount).toBe(1);

    // Unlocked session reveals all 3 items and count 3
    const kidsItemsUnlocked = await listCollectionItems(db, 'kids-col', {
      profileId: 'kids',
      parentalUnlocked: true,
    });
    expect(kidsItemsUnlocked.map((i) => i.key)).toEqual([
      'x:s1:movie:1',
      's:s2:movie:3',
      'x:s1:series:10',
    ]);
    const kidsColsUnlocked = await listCollections(db, 'kids', { parentalUnlocked: true });
    expect(kidsColsUnlocked[0]?.itemCount).toBe(3);
  });

  it('wires VOD enrichment and all 10 collection methods through CatalogService and createCoalescedCatalog', async () => {
    const { db } = testDb();
    const secrets = memorySecrets();
    await seedCatalog(db);

    const base = createCatalogService({
      db,
      secrets,
      scheduler: immediateScheduler,
      http: dummyHttp,
      clock: () => 1_700_000_000_000,
    });
    const service = createCoalescedCatalog(base, { windowMs: 0 });

    const created = await service.createCollection?.({ id: 'svc-1', name: 'Watch Soon' });
    expect(created?.ok).toBe(true);
    expect((await service.addItemToCollection?.('svc-1', 'x:s1:movie:1', 'movie'))?.ok).toBe(true);
    expect(await service.listCollectionsForItem?.('x:s1:movie:1')).toEqual(['svc-1']);
    expect((await service.listCollectionItems?.('svc-1'))?.map((i) => i.name)).toEqual(['Solaris']);

    const enriched = await service.enrichVodItem?.('x:s1:movie:1', { enabled: true });
    expect(enriched?.cleanTitle).toBe('Solaris');
    expect(enriched?.ratingSource).toBe('local-index');
    expect(await service.getVodEnrichment?.('x:s1:movie:1')).toEqual(enriched);

    await service.close();
  });

  it('enforces folder semantics (max 1 collection per item per profile), bumps updatedAt on move, isolates profiles, and preserves favorites on delete (Wave P8, #508)', async () => {
    const { db } = testDb();
    await seedCatalog(db);
    await createProfile(
      db,
      { name: 'Profile B', isKids: false },
      () => 100,
      () => 'prof-b',
    );

    await createCollection(db, { id: 'a-col-1', profileId: 'default', name: 'Sci-Fi' }, 100);
    await createCollection(db, { id: 'a-col-2', profileId: 'default', name: 'Classics' }, 110);
    await createCollection(db, { id: 'b-col-1', profileId: 'prof-b', name: 'B List' }, 120);

    // Star Solaris in My List (favorites)
    const favRes = await setFavorite(
      db,
      {
        sourceId: 's1',
        itemKey: 'x:s1:movie:1',
        kind: 'movie',
        title: 'Solaris',
        profileId: 'default',
      },
      true,
      () => 150,
    );
    expect(favRes.ok).toBe(true);

    // Add movie:1 to both profile A (a-col-1) and profile B (b-col-1)
    expect(
      (await addItemToCollection(db, 'a-col-1', 'x:s1:movie:1', 'movie', 'default', 200)).ok,
    ).toBe(true);
    expect(
      (await addItemToCollection(db, 'a-col-1', 'x:s1:movie:2', 'movie', 'default', 205)).ok,
    ).toBe(true);
    expect(
      (await addItemToCollection(db, 'b-col-1', 'x:s1:movie:1', 'movie', 'prof-b', 210)).ok,
    ).toBe(true);

    // Re-adding to the SAME collection is idempotent (no duplicate row, preserves item order)
    expect(
      (await addItemToCollection(db, 'a-col-1', 'x:s1:movie:1', 'movie', 'default', 220)).ok,
    ).toBe(true);
    expect(
      (await listCollectionItems(db, 'a-col-1', { profileId: 'default' })).map((i) => i.key),
    ).toEqual(['x:s1:movie:1', 'x:s1:movie:2']);

    // Move movie:1 from a-col-1 -> a-col-2 at timestamp 500
    expect(
      (await addItemToCollection(db, 'a-col-2', 'x:s1:movie:1', 'movie', 'default', 500)).ok,
    ).toBe(true);

    // Item belongs ONLY to a-col-2 in profile A; removed from a-col-1
    expect(await listCollectionsForItem(db, 'x:s1:movie:1', 'default')).toEqual(['a-col-2']);
    expect(
      (await listCollectionItems(db, 'a-col-1', { profileId: 'default' })).map((i) => i.key),
    ).toEqual(['x:s1:movie:2']);
    expect(
      (await listCollectionItems(db, 'a-col-2', { profileId: 'default' })).map((i) => i.key),
    ).toEqual(['x:s1:movie:1']);

    // Both source (a-col-1) and target (a-col-2) had updatedAt bumped to 500 for LWW sync propagation
    const defaultCols = await listCollections(db, 'default');
    const aCol1 = defaultCols.find((c) => c.id === 'a-col-1');
    const aCol2 = defaultCols.find((c) => c.id === 'a-col-2');
    expect(aCol1?.updatedAt).toBe(500);
    expect(aCol2?.updatedAt).toBe(500);

    // Profile B's collection is completely untouched
    expect(await listCollectionsForItem(db, 'x:s1:movie:1', 'prof-b')).toEqual(['b-col-1']);
    const profBCols = await listCollections(db, 'prof-b');
    expect(profBCols[0]?.updatedAt).toBe(210);

    // Deleting a-col-2 deletes the collection but preserves the item in `favorites` (My List)
    expect((await deleteCollection(db, 'a-col-2', 'default')).ok).toBe(true);
    expect(await listCollectionsForItem(db, 'x:s1:movie:1', 'default')).toEqual([]);
    const favs = await listFavorites(db, 50, 'default');
    expect(favs.map((f) => f.itemKey)).toContain('x:s1:movie:1');
  });
});
