import { describe, expect, it } from 'vitest';
import { openElvEnrichmentStore } from './elv-enrichment-repo';
import { computeElvRecommendations } from './elv-recommendations';
import { openCatalog } from './migrate';
import { testDb } from './test-db';
import { saveWatchProgress, setItemWatched } from './user-state';

describe('ELV Recommendations — Episode-by-episode watch signals (#512)', () => {
  it('folds watched series episodes (kind = "episode", watched = 1, series_key) into Pool A MLT and Pool B genre/cast taste signals without falsely hiding ongoing series', async () => {
    const catalog = testDb();
    expect((await openCatalog(catalog.db)).ok).toBe(true);
    const enrichment = testDb();
    const store = await openElvEnrichmentStore(enrichment.db, { clock: () => 1_700_000_000_000 });
    const db = catalog.db;

    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 1, '{}')",
    );
    await db.batch(
      `INSERT INTO series (source_id, key, name, name_fold, year, run_id)
       VALUES ('s1', ?, ?, ?, ?, 1)`,
      [
        ['x:s1:series:dark', 'Dark', 'dark', 2017],
        ['x:s1:series:1899', '1899', '1899', 2022],
        ['x:s1:series:cast_sib', 'German Mystery', 'german mystery', 2023],
        ['x:s1:series:other', 'Unrelated Sitcom', 'unrelated sitcom', 2024],
      ],
    );

    await store.upsertTitles([
      {
        imdbId: 'tt5753856',
        mediaType: 'series',
        originalTitle: 'Dark',
        year: 2017,
        rating: 8.7,
        votes: 450_000,
        genres: ['Sci-Fi', 'Mystery'],
        director: 'Baran bo Odar',
        cast: [{ personId: 'nm1111111', name: 'Louis Hofmann' }],
        mltImdbIds: ['tt9319668'],
      },
      {
        imdbId: 'tt9319668',
        mediaType: 'series',
        originalTitle: '1899',
        year: 2022,
        rating: 7.3,
        votes: 120_000,
        genres: ['Mystery', 'Drama'],
        director: 'Baran bo Odar',
      },
      {
        imdbId: 'tt9319669',
        mediaType: 'series',
        originalTitle: 'German Mystery',
        year: 2023,
        rating: 7.1,
        votes: 40_000,
        genres: ['Sci-Fi', 'Mystery'],
        cast: [{ personId: 'nm1111111', name: 'Louis Hofmann' }],
      },
      {
        imdbId: 'tt9319670',
        mediaType: 'series',
        originalTitle: 'Unrelated Sitcom',
        year: 2024,
        rating: 7.0,
        votes: 50_000,
        genres: ['Comedy'],
      },
    ]);
    await store.upsertMatches([
      {
        itemKey: 'x:s1:series:dark',
        sourceId: 's1',
        mediaType: 'series',
        imdbId: 'tt5753856',
        confidence: 0.99,
      },
      {
        itemKey: 'x:s1:series:1899',
        sourceId: 's1',
        mediaType: 'series',
        imdbId: 'tt9319668',
        confidence: 0.98,
      },
      {
        itemKey: 'x:s1:series:cast_sib',
        sourceId: 's1',
        mediaType: 'series',
        imdbId: 'tt9319669',
        confidence: 0.98,
      },
      {
        itemKey: 'x:s1:series:other',
        sourceId: 's1',
        mediaType: 'series',
        imdbId: 'tt9319670',
        confidence: 0.98,
      },
    ]);

    // User watched episode 1 of Dark (kind = 'episode', watched = 1, series_key = 'x:s1:series:dark')
    await saveWatchProgress(db, {
      profileId: 'default',
      sourceId: 's1',
      itemKey: 'x:s1:ep:dark_s1e1',
      kind: 'episode',
      title: 'Dark',
      seriesKey: 'x:s1:series:dark',
      season: 1,
      episode: 1,
      positionMs: 3_000_000,
      durationMs: 3_000_000,
      watched: true,
    });

    const recs = await computeElvRecommendations({
      catalogDb: db,
      enrichmentStore: store,
      profileId: 'default',
      profile: 'elv_picks',
      kind: 'series',
      limit: 10,
    });

    // Pool A MLT neighbor '1899' gets boosted with reason 'more_like_this'
    const mltRec = recs.find((r) => r.enrichment.imdbId === 'tt9319668');
    expect(mltRec).toBeDefined();
    expect(mltRec?.reason).toBe('more_like_this');
    // Pool B genre/cast match 'German Mystery' outranks unrelated comedy
    const sibIdx = recs.findIndex((r) => r.enrichment.imdbId === 'tt9319669');
    const otherIdx = recs.findIndex((r) => r.enrichment.imdbId === 'tt9319670');
    expect(sibIdx).toBeGreaterThanOrEqual(0);
    expect(otherIdx).toBeGreaterThan(sibIdx);
    // Ongoing series 'Dark' is NOT falsely excluded until the series itself is marked watched
    expect(recs.some((r) => r.enrichment.imdbId === 'tt5753856')).toBe(true);

    // Explicitly marking series itself as watched excludes 'Dark' while preserving taste signals
    await setItemWatched(db, 'x:s1:series:dark', true, () => 2_000, 'default');
    const afterFullWatch = await computeElvRecommendations({
      catalogDb: db,
      enrichmentStore: store,
      profileId: 'default',
      profile: 'elv_picks',
      kind: 'series',
      limit: 10,
    });
    expect(afterFullWatch.some((r) => r.enrichment.imdbId === 'tt5753856')).toBe(false);
    expect(afterFullWatch.find((r) => r.enrichment.imdbId === 'tt9319668')?.reason).toBe(
      'more_like_this',
    );
    const afterOtherIdx = afterFullWatch.findIndex((r) => r.enrichment.imdbId === 'tt9319670');
    const afterMltIdx = afterFullWatch.findIndex((r) => r.enrichment.imdbId === 'tt9319668');
    expect(afterMltIdx).toBeGreaterThanOrEqual(0);
    expect(afterOtherIdx).toBeGreaterThan(afterMltIdx);

    await store.close();
  });
});
