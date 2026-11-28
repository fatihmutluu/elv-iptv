import type { HttpClient, Scheduler } from '@elv/domain';
import { ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { createCatalogService } from './catalog';
import { openElvEnrichmentStore } from './elv-enrichment-repo';
import { computeElvRecommendations } from './elv-recommendations';
import { openCatalog, SCHEMA_VERSION } from './migrate';
import { createProfile, deleteProfile } from './profiles-repo';
import {
  dismissRecommendation,
  listDismissedRecommendationKeys,
  type RecommendationDismissalKind,
  restoreRecommendation,
} from './recommendation-dismissals-repo';
import { MIGRATIONS } from './schema';
import { TABLES_BY_SOURCE } from './sources';
import { memorySecrets, testDb } from './test-db';
import { createCoalescedCatalog } from './write-coalescer';

const immediateScheduler: Scheduler = {
  yieldNow: async () => undefined,
};

const emptyHttp: HttpClient = {
  get: async () =>
    ok({
      status: 200,
      headers: {},
      body: (async function* () {})(),
    }),
};

describe('MIGRATION_V27 & recommendation-dismissals-repo', () => {
  it('upgrades from v26 to v27 creating recommendation_dismissals table & index without source_id coupling', async () => {
    const { db, close } = testDb();
    for (let i = 0; i < 26; i += 1) {
      await db.exec(MIGRATIONS[i] ?? '');
    }
    await db.exec('PRAGMA user_version = 26');

    expect((await openCatalog(db)).ok).toBe(true);
    expect(SCHEMA_VERSION).toBe(27);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: 27 }]);
    expect(TABLES_BY_SOURCE).not.toContain('recommendation_dismissals');

    const cols = await db.all<{ name: string }>('PRAGMA table_info(recommendation_dismissals)');
    expect(cols.map((c) => c.name)).toEqual(['profile_id', 'item_key', 'kind', 'dismissed_at']);

    const indexes = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'recommendation_dismissals' ORDER BY name",
    );
    expect(indexes.map((r) => r.name)).toEqual(['idx_recommendation_dismissals_profile']);
    close();
  });

  it('validates itemKey and kind on dismissRecommendation, upserts idempotently, lists newest first, and restores', async () => {
    const { db, close } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);

    for (const badKey of ['', '   ', '\u0000bad', 'line\nbreak', 'x'.repeat(1025)]) {
      await expect(dismissRecommendation(db, badKey, 'movie')).rejects.toThrow();
    }
    for (const badKind of ['live', 'episode', '', 'unknown'] as const) {
      await expect(
        dismissRecommendation(db, 'm:s1:1', badKind as unknown as RecommendationDismissalKind),
      ).rejects.toThrow();
    }

    await dismissRecommendation(db, '  m:s1:1  ', 'movie', 'default', 1_000);
    await dismissRecommendation(db, 's:s1:2', 'series', 'default', 2_000);
    expect(await listDismissedRecommendationKeys(db, 'default')).toEqual(['s:s1:2', 'm:s1:1']);

    // Idempotent upsert updates dismissed_at and moves key to the front without duplicates
    await dismissRecommendation(db, 'm:s1:1', 'series', 'default', 3_500);
    expect(await listDismissedRecommendationKeys(db, 'default')).toEqual(['m:s1:1', 's:s1:2']);
    const rawRows = await db.all<{ item_key: string; kind: string; dismissed_at: number }>(
      'SELECT item_key, kind, dismissed_at FROM recommendation_dismissals ORDER BY item_key ASC',
    );
    expect(rawRows).toEqual([
      { item_key: 'm:s1:1', kind: 'series', dismissed_at: 3_500 },
      { item_key: 's:s1:2', kind: 'series', dismissed_at: 2_000 },
    ]);

    // Tie-break ordering when timestamps match
    await dismissRecommendation(db, 'a:s1:3', 'movie', 'default', 3_500);
    expect(await listDismissedRecommendationKeys(db, 'default')).toEqual([
      'a:s1:3',
      'm:s1:1',
      's:s1:2',
    ]);

    // Restore deletes only the requested key and treats missing/blank keys as no-op
    await restoreRecommendation(db, 'm:s1:1', 'default');
    await restoreRecommendation(db, 'missing-key', 'default');
    await restoreRecommendation(db, '   ', 'default');
    expect(await listDismissedRecommendationKeys(db, 'default')).toEqual(['a:s1:3', 's:s1:2']);

    close();
  });

  it('isolates dismissals per profile and cascades deletion cleanly in deleteProfile', async () => {
    const { db, close } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    const secrets = memorySecrets();

    const pKids = await createProfile(
      db,
      { name: 'Kids', isKids: true },
      () => 1_000,
      () => 'p_kids',
    );
    expect(pKids.ok).toBe(true);

    await dismissRecommendation(db, 'm:s1:adult', 'movie', 'default', 2_000);
    await dismissRecommendation(db, 'm:s1:kids-1', 'movie', 'p_kids', 3_000);
    await dismissRecommendation(db, 's:s1:kids-2', 'series', 'p_kids', 4_000);

    expect(await listDismissedRecommendationKeys(db, 'default')).toEqual(['m:s1:adult']);
    expect(await listDismissedRecommendationKeys(db, 'p_kids')).toEqual([
      's:s1:kids-2',
      'm:s1:kids-1',
    ]);

    // Restoring in default does not affect p_kids
    await restoreRecommendation(db, 'm:s1:kids-1', 'default');
    expect(await listDismissedRecommendationKeys(db, 'p_kids')).toEqual([
      's:s1:kids-2',
      'm:s1:kids-1',
    ]);

    const deleted = await deleteProfile(db, secrets, 'p_kids');
    expect(deleted.ok).toBe(true);
    expect(
      await db.all("SELECT * FROM recommendation_dismissals WHERE profile_id = 'p_kids'"),
    ).toEqual([]);
    expect(await listDismissedRecommendationKeys(db, 'default')).toEqual(['m:s1:adult']);

    close();
  });

  it('wires CatalogService + createCoalescedCatalog + syncUserData and filters ELV recommendations until restored', async () => {
    const { db, close } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    const enrichmentDb = testDb();
    const enrichmentStore = await openElvEnrichmentStore(enrichmentDb.db, {
      clock: () => 50_000,
    });
    const secrets = memorySecrets();
    let now = 10_000;
    const clock = () => {
      now += 100;
      return now;
    };
    const userDataWrite = vi.fn();

    const base = createCatalogService({
      db,
      secrets,
      scheduler: immediateScheduler,
      http: emptyHttp,
      clock,
      enrichmentStore,
      userData: { read: () => undefined, write: userDataWrite },
    });
    const catalog = createCoalescedCatalog(base);

    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 1, '{}')",
    );
    await db.batch(
      "INSERT INTO movies (source_id, key, name, name_fold, year, run_id) VALUES ('s1', ?, ?, ?, ?, 1)",
      [
        ['x:s1:movie:1', 'Solaris One', 'solaris one', 2023],
        ['x:s1:movie:2', 'Solaris Two', 'solaris two', 2024],
      ],
    );
    await enrichmentStore.upsertTitles([
      {
        imdbId: 'tt1000001',
        mediaType: 'movie',
        originalTitle: 'Solaris One',
        year: 2023,
        rating: 8.6,
        votes: 120_000,
        genres: ['Sci-Fi'],
      },
      {
        imdbId: 'tt1000002',
        mediaType: 'movie',
        originalTitle: 'Solaris Two',
        year: 2024,
        rating: 8.1,
        votes: 90_000,
        genres: ['Sci-Fi'],
      },
    ]);
    await enrichmentStore.upsertMatches([
      {
        itemKey: 'x:s1:movie:1',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt1000001',
        confidence: 0.99,
      },
      {
        itemKey: 'x:s1:movie:2',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt1000002',
        confidence: 0.99,
      },
    ]);

    const initialRecs = await computeElvRecommendations({
      catalogDb: db,
      enrichmentStore,
      profileId: 'default',
      profile: 'home',
      kind: 'movie',
      limit: 10,
    });
    expect(initialRecs.map((r) => r.item.key)).toEqual(['x:s1:movie:1', 'x:s1:movie:2']);

    await catalog.dismissRecommendation?.('x:s1:movie:1', 'movie');
    expect(userDataWrite).toHaveBeenCalledTimes(1);
    expect(await catalog.listDismissedRecommendationKeys?.()).toEqual(['x:s1:movie:1']);

    const afterDismiss = await catalog.getElvRecommendations?.({
      profileId: 'default',
      profile: 'home',
      kind: 'movie',
      limit: 10,
    });
    expect(afterDismiss?.map((r) => r.item.key)).toEqual(['x:s1:movie:2']);

    await catalog.restoreRecommendation?.('x:s1:movie:1');
    expect(userDataWrite).toHaveBeenCalledTimes(2);
    expect(await catalog.listDismissedRecommendationKeys?.()).toEqual([]);

    const afterRestore = await catalog.getElvRecommendations?.({
      profileId: 'default',
      profile: 'home',
      kind: 'movie',
      limit: 10,
    });
    expect(afterRestore?.map((r) => r.item.key)).toEqual(['x:s1:movie:1', 'x:s1:movie:2']);

    await catalog.close();
    await enrichmentStore.close();
    enrichmentDb.close();
    close();
  });
});
