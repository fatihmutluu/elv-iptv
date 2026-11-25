import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { openCatalog } from './migrate';
import { countingScheduler, memorySecrets, testDb } from './test-db';
import { listFavoriteKeys, listFavorites, setFavorite } from './user-state';

async function setupDb() {
  const handle = testDb();
  await openCatalog(handle.db);
  return handle;
}

describe('setFavorite idempotent favorite mutations', () => {
  it('upserts when active=true, deletes when active=false, validates meta, isolates profiles, and wires through CatalogService', async () => {
    const { db } = await setupDb();
    let now = 1_000;
    const clock = () => now;

    const bad = await setFavorite(
      db,
      { sourceId: ' ', itemKey: 'm:s1:1', kind: 'movie', title: 'X' },
      true,
      clock,
    );
    expect(bad).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'invalid-favorite' },
    });

    const first = await setFavorite(
      db,
      {
        sourceId: 's1',
        itemKey: 'm:s1:1',
        kind: 'movie',
        title: 'First Title',
        logo: 'https://img.example/a.png',
        year: 2024,
        rating: 7.5,
      },
      true,
      clock,
    );
    expect(first).toEqual({ ok: true, value: true });

    now = 2_000;
    const second = await setFavorite(
      db,
      {
        sourceId: 's1',
        itemKey: 'm:s1:1',
        kind: 'movie',
        title: 'Updated Title',
        logo: 'https://img.example/b.png',
        year: 2025,
        rating: 8.8,
      },
      true,
      clock,
    );
    expect(second).toEqual({ ok: true, value: true });

    const rows = await listFavorites(db, 10);
    expect(rows).toEqual([
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'm:s1:1',
        kind: 'movie',
        title: 'Updated Title',
        logo: 'https://img.example/b.png',
        year: 2025,
        rating: 8.8,
        addedAt: 2_000,
      },
    ]);

    const kidsAdd = await setFavorite(
      db,
      {
        profileId: 'kids',
        sourceId: 's1',
        itemKey: 'm:s1:1',
        kind: 'movie',
        title: 'Kids Copy',
      },
      true,
      clock,
    );
    expect(kidsAdd).toEqual({ ok: true, value: true });

    const del1 = await setFavorite(
      db,
      { sourceId: 's1', itemKey: 'm:s1:1', kind: 'movie', title: 'Updated Title' },
      false,
      clock,
    );
    expect(del1).toEqual({ ok: true, value: false });
    const del2 = await setFavorite(
      db,
      { sourceId: 's1', itemKey: 'm:s1:1', kind: 'movie', title: 'Updated Title' },
      false,
      clock,
    );
    expect(del2).toEqual({ ok: true, value: false });
    expect(await listFavoriteKeys(db)).toEqual([]);
    expect(await listFavoriteKeys(db, 'kids')).toEqual(['m:s1:1']);

    const service = createCatalogService({
      db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: {
        get: async () => ({
          ok: false,
          error: { category: 'network', code: 'offline' },
        }),
      },
      clock,
    });
    const svcOn = await service.setFavorite?.(
      { sourceId: 's1', itemKey: 'm:s1:2', kind: 'movie', title: 'Service Fav' },
      true,
    );
    expect(svcOn).toEqual({ ok: true, value: true });
    expect(await service.listFavoriteKeys?.()).toEqual(['m:s1:2']);
    const svcOff = await service.setFavorite?.(
      { sourceId: 's1', itemKey: 'm:s1:2', kind: 'movie', title: 'Service Fav' },
      false,
    );
    expect(svcOff).toEqual({ ok: true, value: false });
    expect(await service.listFavoriteKeys?.()).toEqual([]);
    await service.close();
  });

  it('supports listing up to 250 favorites without truncating at 100', async () => {
    const { db } = await setupDb();
    let now = 1_000;
    const clock = () => (now += 10);

    for (let i = 1; i <= 125; i += 1) {
      const res = await setFavorite(
        db,
        {
          sourceId: 's1',
          itemKey: `x:s1:live:${i}`,
          kind: 'live',
          title: `Channel ${i}`,
        },
        true,
        clock,
      );
      expect(res).toEqual({ ok: true, value: true });
    }

    const rows200 = await listFavorites(db, 200);
    expect(rows200).toHaveLength(125);
    const rowsCapped = await listFavorites(db, 500);
    expect(rowsCapped).toHaveLength(125);
  });
});
