import type { HttpClient, Scheduler } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { createCatalogService } from './catalog';
import { openCatalog, SCHEMA_VERSION } from './migrate';
import { setParentalLock, updateParentalSettings } from './parental-repo';
import { createProfile, deleteProfile } from './profiles-repo';
import {
  getItemRating,
  listRatingMap,
  listRatings,
  type RatingKind,
  type RatingValue,
  setItemRating,
} from './ratings-repo';
import { MIGRATIONS } from './schema';
import { addM3uSource, removeSource, TABLES_BY_SOURCE } from './sources';
import { memorySecrets, testDb } from './test-db';

const immediateScheduler: Scheduler = {
  yieldNow: async () => undefined,
};

describe('MIGRATION_V23 & ratings-repo', () => {
  it('upgrades from v22 to v23 and creates the ratings table with indexes', async () => {
    const { db, close } = testDb();
    for (let i = 0; i < 22; i += 1) {
      await db.exec(MIGRATIONS[i] ?? '');
    }
    await db.exec('PRAGMA user_version = 22');

    expect((await openCatalog(db)).ok).toBe(true);

    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);
    expect(TABLES_BY_SOURCE).toContain('ratings');

    const tables = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ratings'",
    );
    expect(tables).toEqual([{ name: 'ratings' }]);

    const indexes = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ratings' ORDER BY name",
    );
    expect(indexes.map((r) => r.name)).toEqual(['idx_ratings_profile_value', 'idx_ratings_source']);
    close();
  });

  it('sets, updates, reads, lists, maps, and clears movie & series ratings while rejecting Live TV', async () => {
    const { db, close } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    let now = 1_000;
    const clock = () => {
      now += 100;
      return now;
    };

    // Rejects non-movie/series kinds (e.g. Live TV or episode)
    const liveAttempt = await setItemRating(
      db,
      {
        sourceId: 's1',
        itemKey: 's1:live:1',
        kind: 'live' as unknown as RatingKind,
        title: 'News HD',
      },
      'like',
      clock,
    );
    expect(liveAttempt.ok).toBe(false);

    // Rejects invalid rating values & blank metadata
    const badVal = await setItemRating(
      db,
      { sourceId: 's1', itemKey: 's1:movie:1', kind: 'movie', title: 'Dune' },
      'love' as unknown as RatingValue,
      clock,
    );
    expect(badVal.ok).toBe(false);

    const blankKey = await setItemRating(
      db,
      { sourceId: 's1', itemKey: '   ', kind: 'movie', title: 'Dune' },
      'like',
      clock,
    );
    expect(blankKey.ok).toBe(false);

    const blankTitle = await setItemRating(
      db,
      { sourceId: 's1', itemKey: 's1:movie:1', kind: 'movie', title: '   ' },
      'like',
      clock,
    );
    expect(blankTitle.ok).toBe(false);

    // Like a movie and dislike a series
    const r1 = await setItemRating(
      db,
      {
        sourceId: 's1',
        itemKey: 's1:movie:1',
        kind: 'movie',
        title: 'Dune',
        logo: 'https://cdn.example/dune.jpg',
        year: 2021,
        rating: 8.3,
      },
      'like',
      clock,
    );
    expect(r1).toEqual({ ok: true, value: 'like' });

    const r2 = await setItemRating(
      db,
      {
        sourceId: 's1',
        itemKey: 's1:series:1',
        kind: 'series',
        title: 'Dark',
        year: 2017,
        rating: 8.7,
      },
      'dislike',
      clock,
    );
    expect(r2).toEqual({ ok: true, value: 'dislike' });

    expect(await getItemRating(db, 's1:movie:1')).toBe('like');
    expect(await getItemRating(db, 's1:series:1')).toBe('dislike');
    expect(await getItemRating(db, 's1:movie:999')).toBeNull();
    expect(await getItemRating(db, '   ')).toBeNull();

    expect(await listRatingMap(db)).toEqual({
      's1:movie:1': 'like',
      's1:series:1': 'dislike',
    });

    const all = await listRatings(db);
    expect(all.map((r) => [r.itemKey, r.value, r.title, r.year, r.rating])).toEqual([
      ['s1:series:1', 'dislike', 'Dark', 2017, 8.7],
      ['s1:movie:1', 'like', 'Dune', 2021, 8.3],
    ]);

    const likesOnly = await listRatings(db, { value: 'like' });
    expect(likesOnly.map((r) => r.itemKey)).toEqual(['s1:movie:1']);

    const dislikesOnly = await listRatings(db, { value: 'dislike' });
    expect(dislikesOnly.map((r) => r.itemKey)).toEqual(['s1:series:1']);

    expect(await listRatings(db, { limit: 0 })).toEqual([]);
    expect(await listRatings(db, { value: 'bogus' as RatingValue })).toEqual([]);

    // Switch movie from like -> dislike
    const r3 = await setItemRating(
      db,
      { sourceId: 's1', itemKey: 's1:movie:1', kind: 'movie', title: 'Dune' },
      'dislike',
      clock,
    );
    expect(r3).toEqual({ ok: true, value: 'dislike' });
    expect(await getItemRating(db, 's1:movie:1')).toBe('dislike');

    // Clear rating with null
    const cleared = await setItemRating(
      db,
      { sourceId: 's1', itemKey: 's1:movie:1', kind: 'movie', title: 'Dune' },
      null,
      clock,
    );
    expect(cleared).toEqual({ ok: true, value: null });
    expect(await getItemRating(db, 's1:movie:1')).toBeNull();
    expect(await listRatingMap(db)).toEqual({ 's1:series:1': 'dislike' });

    close();
  });

  it('respects parental locks in listRatings and cascades on removeSource & deleteProfile', async () => {
    const { db, close } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    const secrets = memorySecrets();

    const added = await addM3uSource(
      { name: 'Test Source', playlistUrl: 'https://example.test/list.m3u' },
      { db, secrets, clock: () => 1_000, newId: () => 'src1' },
    );
    expect(added.ok).toBe(true);

    const profileRes = await createProfile(
      db,
      { name: 'Kids', isKids: false },
      () => 2_000,
      () => 'p_kids',
    );
    expect(profileRes.ok).toBe(true);

    await setItemRating(
      db,
      { sourceId: 'src1', itemKey: 'src1:movie:1', kind: 'movie', title: 'Family Movie' },
      'like',
      () => 3_000,
    );
    await setItemRating(
      db,
      { sourceId: 'src1', itemKey: 'src1:movie:2', kind: 'movie', title: 'Locked Thriller' },
      'like',
      () => 4_000,
    );
    await setItemRating(
      db,
      {
        profileId: 'p_kids',
        sourceId: 'src1',
        itemKey: 'src1:movie:1',
        kind: 'movie',
        title: 'Family Movie',
      },
      'like',
      () => 5_000,
    );

    await updateParentalSettings(db, 'default', { enabled: true }, () => 6_000);
    await setParentalLock(
      db,
      {
        profileId: 'default',
        sourceId: 'src1',
        targetKind: 'item',
        itemKind: 'movie',
        targetKey: 'src1:movie:2',
      },
      true,
      () => 6_000,
    );

    const filtered = await listRatings(db, { profileId: 'default' });
    expect(filtered.map((r) => r.itemKey)).toEqual(['src1:movie:1']);

    const unlocked = await listRatings(db, { profileId: 'default', parentalUnlocked: true });
    expect(unlocked.map((r) => r.itemKey)).toEqual(['src1:movie:2', 'src1:movie:1']);

    // Delete profile cascades ratings for that profile only
    const delProfile = await deleteProfile(db, secrets, 'p_kids');
    expect(delProfile.ok).toBe(true);
    expect(await getItemRating(db, 'src1:movie:1', 'p_kids')).toBeNull();
    expect(await getItemRating(db, 'src1:movie:1', 'default')).toBe('like');

    // Remove source cascades ratings for that source
    const remSource = await removeSource('src1', { db, secrets, scheduler: immediateScheduler });
    expect(remSource.ok).toBe(true);
    expect(await listRatings(db, { profileId: 'default', parentalUnlocked: true })).toEqual([]);

    close();
  });

  it('wires ratings methods on CatalogService and refreshes extraSeriesKeys without polluting My List new episodes', async () => {
    const { db, close } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    const secrets = memorySecrets();
    let now = 10_000;
    const clock = () => {
      now += 100;
      return now;
    };

    let fetchCount = 0;
    const http: HttpClient = {
      get: vi.fn(async () => {
        fetchCount += 1;
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            episodes: {
              '1': [
                {
                  id: '101',
                  episode_num: 1,
                  title: 'Pilot',
                  container_extension: 'mp4',
                },
                {
                  id: '102',
                  episode_num: 2,
                  title: 'Second',
                  container_extension: 'mp4',
                },
              ],
            },
          }),
        );
        return {
          ok: true as const,
          value: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: (async function* () {
              yield bytes;
            })(),
          },
        };
      }),
    };

    const userDataSave = vi.fn();
    const catalog = createCatalogService({
      db,
      secrets,
      scheduler: immediateScheduler,
      http,
      clock,
      newId: () => 'xt1',
      userData: {
        read: () => undefined,
        write: userDataSave,
      },
    });

    const added = await catalog.addSource({
      kind: 'xtream',
      name: 'Xtream',
      server: 'https://xt.example',
      username: 'u',
      password: 'p',
    });
    expect(added.ok).toBe(true);

    // Seed a non-favorited series row (simulating a downloaded series)
    await db.run(
      `INSERT INTO series (source_id, key, provider_id, name, name_fold, run_id)
       VALUES ('xt1', 'xt1:series:42', '42', 'Downloaded Show', 'downloaded show', 1)`,
    );

    // Test CatalogService ratings methods + syncUserData hook
    const setRes = await catalog.setRating?.(
      { sourceId: 'xt1', itemKey: 'xt1:series:42', kind: 'series', title: 'Downloaded Show' },
      'like',
    );
    expect(setRes).toEqual({ ok: true, value: 'like' });
    expect(userDataSave).toHaveBeenCalledTimes(1);
    expect(await catalog.getRating?.('xt1:series:42')).toBe('like');
    expect(await catalog.listRatingMap?.()).toEqual({ 'xt1:series:42': 'like' });
    const rated = await catalog.listRatings?.({ value: 'like' });
    expect(rated?.map((r) => r.itemKey)).toEqual(['xt1:series:42']);

    // Refresh extraSeriesKeys: should fetch episodes for non-favorited downloaded series
    const refresh1 = await catalog.refreshMyListNewEpisodes?.('default', {
      extraSeriesKeys: ['xt1:series:42'],
      cooldownMs: 30 * 60_000,
    });
    expect(refresh1).toEqual({
      ok: true,
      value: { checkedSeriesCount: 1, newlyDetectedCount: 0 },
    });
    expect(fetchCount).toBe(1);

    // Episodes table is now populated, and My List new episodes rail stays empty
    const eps = await db.all<{ key: string }>(
      "SELECT key FROM episodes WHERE source_id = 'xt1' AND series_key = 'xt1:series:42'",
    );
    expect(eps.length).toBe(2);
    expect(await catalog.listMyListNewEpisodes?.()).toEqual([]);

    // Second call within cooldown should NOT re-fetch
    const refresh2 = await catalog.refreshMyListNewEpisodes?.('default', {
      extraSeriesKeys: ['xt1:series:42'],
      cooldownMs: 30 * 60_000,
    });
    expect(refresh2).toEqual({
      ok: true,
      value: { checkedSeriesCount: 0, newlyDetectedCount: 0 },
    });
    expect(fetchCount).toBe(1);

    // With force: true it re-fetches
    const refresh3 = await catalog.refreshMyListNewEpisodes?.('default', {
      extraSeriesKeys: ['xt1:series:42'],
      force: true,
    });
    expect(refresh3).toEqual({
      ok: true,
      value: { checkedSeriesCount: 1, newlyDetectedCount: 0 },
    });
    expect(fetchCount).toBe(2);

    await catalog.close();
    close();
  });
});
