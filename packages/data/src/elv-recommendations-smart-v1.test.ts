import { describe, expect, it } from 'vitest';
import { openElvEnrichmentStore } from './elv-enrichment-repo';
import { computeElvRecommendations } from './elv-recommendations';
import { openCatalog } from './migrate';
import { testDb } from './test-db';

async function setupDbs() {
  const catalog = testDb();
  expect((await openCatalog(catalog.db)).ok).toBe(true);
  const enrichment = testDb();
  const store = await openElvEnrichmentStore(enrichment.db, { clock: () => 1_700_000_000_000 });
  return { db: catalog.db, store };
}

describe('Smart Recommendations v1 (#512)', () => {
  it('labels cold-start Pool B as top_picks, keeps classics, penalizes low-vote obscure junk, caps franchises at 2, and prioritizes trending hits on home', async () => {
    const { db, store } = await setupDbs();
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 1, '{}')",
    );
    await db.batch(
      `INSERT INTO movies (source_id, key, name, name_fold, year, run_id)
       VALUES ('s1', ?, ?, ?, ?, 1)`,
      [
        ['x:s1:movie:classic', 'The Godfather (1972)', 'the godfather 1972', 1972],
        [
          'x:s1:movie:obscure',
          'Obscure Festival Short (2022)',
          'obscure festival short 2022',
          2022,
        ],
        ['x:s1:movie:saga1', 'Saga Entry 1 (2015)', 'saga entry 1 2015', 2015],
        ['x:s1:movie:saga2', 'Saga Entry 2 (2016)', 'saga entry 2 2016', 2016],
        ['x:s1:movie:saga3', 'Saga Entry 3 (2017)', 'saga entry 3 2017', 2017],
        ['x:s1:movie:saga4', 'Saga Entry 4 (2018)', 'saga entry 4 2018', 2018],
        ['x:s1:movie:other', 'Standalone Hit (2023)', 'standalone hit 2023', 2023],
      ],
    );

    await store.upsertTitles([
      {
        imdbId: 'tt0068646',
        mediaType: 'movie',
        originalTitle: 'The Godfather',
        year: 1972,
        rating: 9.2,
        votes: 2_000_000,
        genres: ['Crime', 'Drama'],
      },
      {
        imdbId: 'tt9900100',
        mediaType: 'movie',
        originalTitle: 'Obscure Festival Short',
        year: 2022,
        rating: 9.8,
        votes: 120,
        genres: ['Drama'],
      },
      {
        imdbId: 'tt9900201',
        mediaType: 'movie',
        originalTitle: 'Saga Entry 1',
        year: 2015,
        rating: 8.6,
        votes: 800_000,
        genres: ['Action'],
        franchiseKey: 'fast_saga',
        franchiseName: 'Fast Saga',
        franchiseOrder: 1,
      },
      {
        imdbId: 'tt9900202',
        mediaType: 'movie',
        originalTitle: 'Saga Entry 2',
        year: 2016,
        rating: 8.5,
        votes: 750_000,
        genres: ['Action'],
        franchiseKey: 'fast_saga',
        franchiseName: 'Fast Saga',
        franchiseOrder: 2,
      },
      {
        imdbId: 'tt9900203',
        mediaType: 'movie',
        originalTitle: 'Saga Entry 3',
        year: 2017,
        rating: 8.4,
        votes: 700_000,
        genres: ['Action'],
        franchiseKey: 'fast_saga',
        franchiseName: 'Fast Saga',
        franchiseOrder: 3,
      },
      {
        imdbId: 'tt9900204',
        mediaType: 'movie',
        originalTitle: 'Saga Entry 4',
        year: 2018,
        rating: 8.3,
        votes: 650_000,
        genres: ['Action'],
        franchiseKey: 'fast_saga',
        franchiseName: 'Fast Saga',
        franchiseOrder: 4,
      },
      {
        imdbId: 'tt9900300',
        mediaType: 'movie',
        originalTitle: 'Standalone Hit',
        year: 2023,
        rating: 7.5,
        votes: 220_000,
        genres: ['Thriller'],
      },
    ]);
    await store.upsertMatches([
      {
        itemKey: 'x:s1:movie:classic',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt0068646',
        confidence: 0.99,
      },
      {
        itemKey: 'x:s1:movie:obscure',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt9900100',
        confidence: 0.99,
      },
      {
        itemKey: 'x:s1:movie:saga1',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt9900201',
        confidence: 0.99,
      },
      {
        itemKey: 'x:s1:movie:saga2',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt9900202',
        confidence: 0.99,
      },
      {
        itemKey: 'x:s1:movie:saga3',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt9900203',
        confidence: 0.99,
      },
      {
        itemKey: 'x:s1:movie:saga4',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt9900204',
        confidence: 0.99,
      },
      {
        itemKey: 'x:s1:movie:other',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt9900300',
        confidence: 0.99,
      },
    ]);

    // 1. Zero feeds + zero signals: Pool B items NEVER claim 'genre_match', classics stay #1, franchise capped at 2
    const coldPoolBOnly = await computeElvRecommendations({
      catalogDb: db,
      enrichmentStore: store,
      profile: 'elv_picks',
      kind: 'movie',
      limit: 5,
    });
    expect(coldPoolBOnly[0]?.enrichment.imdbId).toBe('tt0068646');
    expect(coldPoolBOnly.every((r) => r.reason === 'top_picks')).toBe(true);
    expect(coldPoolBOnly.some((r) => r.reason === 'genre_match')).toBe(false);
    const sagaCount = coldPoolBOnly.filter(
      (r) => r.enrichment.title?.franchiseKey === 'fast_saga',
    ).length;
    expect(sagaCount).toBe(2);
    expect(coldPoolBOnly.some((r) => r.enrichment.imdbId === 'tt9900300')).toBe(true);
    // Low-vote obscure item ranks behind 220k-vote Standalone Hit
    const hitIdx = coldPoolBOnly.findIndex((r) => r.enrichment.imdbId === 'tt9900300');
    const obscureIdx = coldPoolBOnly.findIndex((r) => r.enrichment.imdbId === 'tt9900100');
    expect(hitIdx).toBeGreaterThanOrEqual(0);
    if (obscureIdx >= 0) expect(hitIdx).toBeLessThan(obscureIdx);

    // 2. With live TMDB feeds present, home profile boosts feed hits above non-feed items even at moderate rank
    await store.upsertFeed('moviemeter', [
      { imdbId: 'tt9900300', title: 'Standalone Hit', mediaType: 'movie', rank: 25 },
    ]);
    const homeWithFeed = await computeElvRecommendations({
      catalogDb: db,
      enrichmentStore: store,
      profile: 'home',
      kind: 'movie',
      limit: 5,
    });
    expect(homeWithFeed[0]?.enrichment.imdbId).toBe('tt9900300');
    expect(homeWithFeed[0]?.reason).toBe('trending');
    // Non-feed cold-start items on home still get 'top_picks', never 'genre_match'
    const homeClassic = homeWithFeed.find((r) => r.enrichment.imdbId === 'tt0068646');
    expect(homeClassic?.reason).toBe('top_picks');
  });
});
