import { describe, expect, it } from 'vitest';
import {
  openElvEnrichmentStore,
  type UpsertElvMatchInput,
  type UpsertElvTitleInput,
} from './elv-enrichment-repo';
import { recordPlaybackQuality, recordPlaybackVariantFailure } from './elv-quality-memory';
import { computeBayesianRating, computeElvRecommendations } from './elv-recommendations';
import { openCatalog } from './migrate';
import { setParentalLock, updateParentalSettings } from './parental-repo';
import { setItemRating } from './ratings-repo';
import { testDb } from './test-db';
import { setFavorite, setItemWatched } from './user-state';

async function setupDbs() {
  const catalog = testDb();
  expect((await openCatalog(catalog.db)).ok).toBe(true);
  const enrichment = testDb();
  const store = await openElvEnrichmentStore(enrichment.db, { clock: () => 1_700_000_000_000 });
  return { db: catalog.db, store };
}

describe('3-Pool On-Device ELV Recommendation Engine (#512)', () => {
  it('computes Bayesian IMDb rating using ((v / (v + 1000)) * r + (1000 / (v + 1000)) * 6.8)', () => {
    expect(computeBayesianRating(9.0, 1000)).toBeCloseTo(7.9, 5);
    expect(computeBayesianRating(9.0, 0)).toBeCloseTo(6.8, 5);
    expect(computeBayesianRating(8.8, 1_000_000)).toBeCloseTo(8.798, 3);
    expect(computeBayesianRating(null, 5000)).toBeCloseTo(6.8, 5);
    expect(computeBayesianRating(8.5, null)).toBeCloseTo(6.8, 5);
  });

  it('cold-start safe: intersects Pool C IMDb daily feeds with playable IPTV library when user has 0 signals', async () => {
    const { db, store } = await setupDbs();
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 1, '{}')",
    );
    await db.batch(
      `INSERT INTO movies (source_id, key, name, name_fold, year, logo, run_id)
       VALUES ('s1', ?, ?, ?, ?, ?, 1)`,
      [
        ['x:s1:movie:1', 'Dune Part Two (2024)', 'dune part two 2024', 2024, 'https://p/1.jpg'],
        [
          'x:s1:movie:2',
          'Top Pick Classic (1999)',
          'top pick classic 1999',
          1999,
          'https://p/2.jpg',
        ],
      ],
    );
    await db.run(
      `INSERT INTO series (source_id, key, name, name_fold, year, cover, run_id)
       VALUES ('s1', 'x:s1:series:1', 'Upcoming Sci-Fi Show', 'upcoming sci fi show', 2025, 'https://p/s1.jpg', 1)`,
    );

    await store.upsertTitles([
      {
        imdbId: 'tt15239678',
        mediaType: 'movie',
        originalTitle: 'Dune: Part Two',
        year: 2024,
        rating: 8.5,
        votes: 500_000,
        genres: ['Action', 'Sci-Fi'],
      },
      {
        imdbId: 'tt0133093',
        mediaType: 'movie',
        originalTitle: 'The Matrix',
        year: 1999,
        rating: 8.7,
        votes: 2_000_000,
        genres: ['Action', 'Sci-Fi'],
      },
      {
        imdbId: 'tt9000001',
        mediaType: 'series',
        originalTitle: 'Upcoming Sci-Fi Show',
        year: 2025,
        rating: 8.1,
        votes: 25_000,
        genres: ['Sci-Fi'],
      },
    ]);
    await store.upsertMatches([
      {
        itemKey: 'x:s1:movie:1',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt15239678',
        confidence: 0.96,
      },
      {
        itemKey: 'x:s1:movie:2',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt0133093',
        confidence: 0.96,
      },
      {
        itemKey: 'x:s1:series:1',
        sourceId: 's1',
        mediaType: 'series',
        imdbId: 'tt9000001',
        confidence: 0.95,
      },
    ]);

    // Include an unmatched feed item tt9999999 that MUST NOT appear (Golden Rule: playable intersection only)
    await store.upsertFeed('top_picks', [
      { imdbId: 'tt9999999', title: 'Not In Library', mediaType: 'movie', rank: 1 },
      { imdbId: 'tt0133093', title: 'The Matrix', mediaType: 'movie', rank: 2 },
    ]);
    await store.upsertFeed('moviemeter', [
      { imdbId: 'tt15239678', title: 'Dune: Part Two', mediaType: 'movie', rank: 1 },
    ]);
    await store.upsertFeed('current_upcoming_tv', [
      { imdbId: 'tt9000001', title: 'Upcoming Sci-Fi Show', mediaType: 'series', rank: 1 },
    ]);

    const homeRecs = await computeElvRecommendations({
      catalogDb: db,
      enrichmentStore: store,
      profile: 'home',
      limit: 10,
    });
    expect(homeRecs.map((r) => r.enrichment.imdbId)).toHaveLength(3);
    expect(homeRecs.some((r) => r.enrichment.imdbId === 'tt9999999')).toBe(false);
    expect(homeRecs.find((r) => r.enrichment.imdbId === 'tt0133093')?.reason).toBe('top_picks');
    expect(homeRecs.find((r) => r.enrichment.imdbId === 'tt15239678')?.reason).toBe('trending');
    expect(homeRecs.find((r) => r.enrichment.imdbId === 'tt9000001')?.reason).toBe('upcoming_tv');

    // Kind filtering works cleanly
    const movieOnly = await computeElvRecommendations({
      catalogDb: db,
      enrichmentStore: store,
      profile: 'elv_picks',
      kind: 'movie',
      limit: 10,
    });
    expect(movieOnly.every((r) => r.item.kind === 'movie')).toBe(true);
    expect(movieOnly).toHaveLength(2);
  });

  it('applies Pool A MLT cumulative scoring, Pool B genre/cast affinity, and 2 distinct weight profiles (home vs elv_picks)', async () => {
    const { db, store } = await setupDbs();
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 1, '{}')",
    );
    await db.batch(
      `INSERT INTO movies (source_id, key, name, name_fold, year, run_id)
       VALUES ('s1', ?, ?, ?, ?, 1)`,
      [
        ['x:s1:movie:seed1', 'Inception (2010)', 'inception 2010', 2010],
        ['x:s1:movie:seed2', 'Interstellar (2014)', 'interstellar 2014', 2014],
        ['x:s1:movie:mlt_shared', 'Tenet (2020)', 'tenet 2020', 2020],
        ['x:s1:movie:cast_only', 'Oppenheimer (2023)', 'oppenheimer 2023', 2023],
        ['x:s1:movie:trending', 'Trending RomCom (2025)', 'trending romcom 2025', 2025],
      ],
    );

    await store.upsertTitles([
      {
        imdbId: 'tt1375666',
        mediaType: 'movie',
        originalTitle: 'Inception',
        year: 2010,
        rating: 8.8,
        votes: 2_500_000,
        genres: ['Action', 'Sci-Fi'],
        director: 'Christopher Nolan',
        cast: [{ personId: 'nm0000138', name: 'Leonardo DiCaprio' }],
        mltImdbIds: ['tt6723592'],
      },
      {
        imdbId: 'tt0816692',
        mediaType: 'movie',
        originalTitle: 'Interstellar',
        year: 2014,
        rating: 8.7,
        votes: 2_100_000,
        genres: ['Adventure', 'Sci-Fi'],
        director: 'Christopher Nolan',
        cast: [{ personId: 'nm0000190', name: 'Matthew McConaughey' }],
        mltImdbIds: ['tt6723592'],
      },
      {
        imdbId: 'tt6723592',
        mediaType: 'movie',
        originalTitle: 'Tenet',
        year: 2020,
        rating: 7.4,
        votes: 600_000,
        genres: ['Action', 'Sci-Fi'],
        director: 'Christopher Nolan',
      },
      {
        imdbId: 'tt15398776',
        mediaType: 'movie',
        originalTitle: 'Oppenheimer',
        year: 2023,
        rating: 8.3,
        votes: 800_000,
        genres: ['Biography', 'Drama'],
        director: 'Christopher Nolan',
      },
      {
        imdbId: 'tt5555555',
        mediaType: 'movie',
        originalTitle: 'Trending RomCom',
        year: 2025,
        rating: 7.1,
        votes: 50_000,
        genres: ['Romance', 'Comedy'],
        director: 'Other Director',
      },
    ]);
    await store.upsertMatches([
      {
        itemKey: 'x:s1:movie:seed1',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt1375666',
        confidence: 0.99,
      },
      {
        itemKey: 'x:s1:movie:seed2',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt0816692',
        confidence: 0.99,
      },
      {
        itemKey: 'x:s1:movie:mlt_shared',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt6723592',
        confidence: 0.98,
      },
      {
        itemKey: 'x:s1:movie:cast_only',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt15398776',
        confidence: 0.98,
      },
      {
        itemKey: 'x:s1:movie:trending',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt5555555',
        confidence: 0.98,
      },
    ]);
    await store.upsertFeed('moviemeter', [
      { imdbId: 'tt5555555', title: 'Trending RomCom', mediaType: 'movie', rank: 1 },
    ]);

    // User liked Inception (+6 MLT) and favorited Interstellar (+4 MLT) -> Tenet gets +10 cumulative MLT!
    await setItemRating(
      db,
      { sourceId: 's1', itemKey: 'x:s1:movie:seed1', kind: 'movie', title: 'Inception' },
      'like',
    );
    await setFavorite(
      db,
      { sourceId: 's1', itemKey: 'x:s1:movie:seed2', kind: 'movie', title: 'Interstellar' },
      true,
    );

    // ELV Picks (~70% Personal / ~30% Feed): Tenet (shared MLT) ranks #1 above unrelated Trending RomCom
    const picks = await computeElvRecommendations({
      catalogDb: db,
      enrichmentStore: store,
      profile: 'elv_picks',
      kind: 'movie',
      limit: 10,
    });
    expect(picks[0]?.enrichment.imdbId).toBe('tt6723592');
    expect(picks[0]?.reason).toBe('more_like_this');
    const oppPick = picks.find((r) => r.enrichment.imdbId === 'tt15398776');
    expect(oppPick?.reason).toBe('cast_match');

    // Home (~65% Feed / ~35% Personal): Trending #1 RomCom ranks #1 above non-trending personal picks
    const home = await computeElvRecommendations({
      catalogDb: db,
      enrichmentStore: store,
      profile: 'home',
      limit: 10,
    });
    expect(home[0]?.enrichment.imdbId).toBe('tt5555555');
    expect(home[0]?.reason).toBe('trending');
    // Already-favorited seed2 is automatically excluded
    expect(home.some((r) => r.enrichment.imdbId === 'tt0816692')).toBe(false);
  });

  it('automatically excludes watched, disliked, favorited, excludedSourceIds, and parental/maxRatingAge blocked items, and deduplicates by imdbId picking best healthy variant', async () => {
    const { db, store } = await setupDbs();
    await db.batch(
      'INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES (?, ?, ?, ?, ?)',
      [
        ['s1', 'xtream', 'Source One', 1, '{}'],
        ['s2', 'xtream', 'Source Two', 2, '{}'],
      ],
    );
    await db.batch(
      `INSERT INTO movies (source_id, key, name, name_fold, year, run_id)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [
        ['s1', 'x:s1:movie:watched', 'Already Watched', 'already watched', 2020],
        ['s2', 'x:s2:movie:watched_dup', 'Already Watched [4K]', 'already watched 4k', 2020],
        ['s1', 'x:s1:movie:disliked', 'Disliked Movie', 'disliked movie', 2020],
        ['s1', 'x:s1:movie:fav', 'My List Movie', 'my list movie', 2020],
        ['s2', 'x:s2:movie:excluded_src', 'Excluded Source Movie', 'excluded source movie', 2021],
        ['s1', 'x:s1:movie:adult', 'Adult Movie XXX', 'adult movie xxx', 2021],
        ['s1', 'x:s1:movie:horror', 'Scary Horror', 'scary horror', 2022],
        ['s1', 'x:s1:movie:locked', 'Locked Thriller', 'locked thriller', 2022],
        ['s1', 'x:s1:movie:good_bad_copy', 'Good Movie [4K]', 'good movie 4k', 2023],
        ['s2', 'x:s2:movie:good_healthy', 'Good Movie [1080p]', 'good movie 1080p', 2023],
        ['s1', 'x:s1:movie:good_s1_ok', 'Good Movie [720p]', 'good movie 720p', 2023],
      ],
    );

    await store.upsertTitles([
      {
        imdbId: 'tt1000001',
        mediaType: 'movie',
        originalTitle: 'Already Watched',
        rating: 9.0,
        votes: 100_000,
        genres: ['Drama'],
      },
      {
        imdbId: 'tt1000002',
        mediaType: 'movie',
        originalTitle: 'Disliked Movie',
        rating: 9.0,
        votes: 100_000,
        genres: ['Drama'],
      },
      {
        imdbId: 'tt1000003',
        mediaType: 'movie',
        originalTitle: 'My List Movie',
        rating: 9.0,
        votes: 100_000,
        genres: ['Drama'],
      },
      {
        imdbId: 'tt1000004',
        mediaType: 'movie',
        originalTitle: 'Excluded Source Movie',
        rating: 9.0,
        votes: 100_000,
        genres: ['Drama'],
      },
      {
        imdbId: 'tt1000005',
        mediaType: 'movie',
        originalTitle: 'Adult Movie XXX',
        rating: 8.5,
        votes: 50_000,
        genres: ['Adult'],
      },
      {
        imdbId: 'tt1000006',
        mediaType: 'movie',
        originalTitle: 'Scary Horror',
        rating: 8.4,
        votes: 80_000,
        genres: ['Horror'],
      },
      {
        imdbId: 'tt1000007',
        mediaType: 'movie',
        originalTitle: 'Locked Thriller',
        rating: 8.6,
        votes: 90_000,
        genres: ['Thriller'],
      },
      {
        imdbId: 'tt1000008',
        mediaType: 'movie',
        originalTitle: 'Good Movie',
        rating: 8.2,
        votes: 150_000,
        genres: ['Family', 'Adventure'],
      },
    ]);
    await store.upsertMatches([
      {
        itemKey: 'x:s1:movie:watched',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt1000001',
        confidence: 0.95,
      },
      {
        itemKey: 'x:s2:movie:watched_dup',
        sourceId: 's2',
        mediaType: 'movie',
        imdbId: 'tt1000001',
        confidence: 0.95,
      },
      {
        itemKey: 'x:s1:movie:disliked',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt1000002',
        confidence: 0.95,
      },
      {
        itemKey: 'x:s1:movie:fav',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt1000003',
        confidence: 0.95,
      },
      {
        itemKey: 'x:s2:movie:excluded_src',
        sourceId: 's2',
        mediaType: 'movie',
        imdbId: 'tt1000004',
        confidence: 0.95,
      },
      {
        itemKey: 'x:s1:movie:adult',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt1000005',
        confidence: 0.95,
      },
      {
        itemKey: 'x:s1:movie:horror',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt1000006',
        confidence: 0.95,
      },
      {
        itemKey: 'x:s1:movie:locked',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt1000007',
        confidence: 0.95,
      },
      {
        itemKey: 'x:s1:movie:good_bad_copy',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt1000008',
        confidence: 0.95,
      },
      {
        itemKey: 'x:s2:movie:good_healthy',
        sourceId: 's2',
        mediaType: 'movie',
        imdbId: 'tt1000008',
        confidence: 0.95,
      },
      {
        itemKey: 'x:s1:movie:good_s1_ok',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt1000008',
        confidence: 0.95,
      },
    ]);

    // Mark watched, disliked, favorited, locked
    await setItemWatched(db, 'x:s1:movie:watched', true, () => 1_000, 'kids');
    await setItemRating(
      db,
      {
        profileId: 'kids',
        sourceId: 's1',
        itemKey: 'x:s1:movie:disliked',
        kind: 'movie',
        title: 'Disliked Movie',
      },
      'dislike',
    );
    await setFavorite(
      db,
      {
        profileId: 'kids',
        sourceId: 's1',
        itemKey: 'x:s1:movie:fav',
        kind: 'movie',
        title: 'My List Movie',
      },
      true,
    );
    await updateParentalSettings(db, 'kids', {
      enabled: true,
      blockAdultKeywords: true,
      maxRatingAge: 12,
    });
    await setParentalLock(
      db,
      {
        profileId: 'kids',
        sourceId: 's1',
        targetKind: 'item',
        itemKind: 'movie',
        targetKey: 'x:s1:movie:locked',
      },
      true,
    );

    // Mark good_bad_copy as failing twice (unreliable) and good_s1_ok as verified 720p
    await recordPlaybackVariantFailure(store, 'x:s1:movie:good_bad_copy');
    await recordPlaybackVariantFailure(store, 'x:s1:movie:good_bad_copy');
    await recordPlaybackQuality(store, {
      itemKey: 'x:s1:movie:good_s1_ok',
      actualWidth: 1280,
      actualHeight: 720,
      claimedLabel: '720p',
    });

    const recs = await computeElvRecommendations({
      catalogDb: db,
      enrichmentStore: store,
      profileId: 'kids',
      profile: 'home',
      excludedSourceIds: ['s2'],
      maxRatingAge: 12,
      limit: 20,
    });

    // Only tt1000008 survives, deduplicated to healthy s1 720p copy (s2 is excluded, s1 4K failed twice!)
    expect(recs).toHaveLength(1);
    expect(recs[0]?.enrichment.imdbId).toBe('tt1000008');
    expect(recs[0]?.item.key).toBe('x:s1:movie:good_s1_ok');

    // vod_enrichment certification ('R' -> 18) also blocks under maxRatingAge: 12
    await db.run(
      `INSERT INTO vod_enrichment (item_key, source_id, clean_title, certification, fetched_at, expires_at)
       VALUES ('x:s1:movie:good_s1_ok', 's1', 'Good Movie', 'R', 1000, 9999999999999)`,
    );
    const certBlocked = await computeElvRecommendations({
      catalogDb: db,
      enrichmentStore: store,
      profileId: 'kids',
      profile: 'home',
      excludedSourceIds: ['s2'],
      maxRatingAge: 12,
      limit: 20,
    });
    expect(certBlocked).toEqual([]);
    expect(
      await computeElvRecommendations({
        catalogDb: db,
        enrichmentStore: store,
        profile: 'home',
        limit: 0,
      }),
    ).toEqual([]);
  });

  it('benchmark: executes in < 25 ms over 550 synthetic enriched items', async () => {
    const { db, store } = await setupDbs();
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Bench', 1, '{}')",
    );

    const movieRows: [string, string, string, string, number][] = [];
    const titles: UpsertElvTitleInput[] = [];
    const matches: UpsertElvMatchInput[] = [];
    const genresList = [
      'Action',
      'Sci-Fi',
      'Drama',
      'Thriller',
      'Comedy',
      'Adventure',
      'Animation',
    ];

    for (let i = 1; i <= 550; i += 1) {
      const imdbId = `tt${String(2000000 + i)}`;
      const key = `x:s1:movie:${i}`;
      movieRows.push([
        's1',
        key,
        `Synth Movie ${i} (2020)`,
        `synth movie ${i} 2020`,
        2000 + (i % 25),
      ]);
      titles.push({
        imdbId,
        mediaType: 'movie',
        originalTitle: `Synth Movie ${i}`,
        year: 2000 + (i % 25),
        rating: 5.5 + (i % 40) * 0.1,
        votes: 500 + i * 200,
        genres: [
          genresList[i % genresList.length] as string,
          genresList[(i + 2) % genresList.length] as string,
        ],
        director: `Director ${i % 25}`,
        cast: [{ personId: `nm${10000 + (i % 40)}`, name: `Actor ${i % 40}` }],
        mltImdbIds: [
          `tt${String(2000000 + ((i + 7) % 550) + 1)}`,
          `tt${String(2000000 + ((i + 19) % 550) + 1)}`,
        ],
      });
      matches.push({
        itemKey: key,
        sourceId: 's1',
        mediaType: 'movie',
        imdbId,
        confidence: 0.95,
      });
    }

    await db.batch(
      'INSERT INTO movies (source_id, key, name, name_fold, year, run_id) VALUES (?, ?, ?, ?, ?, 1)',
      movieRows,
    );
    await store.upsertTitles(titles);
    await store.upsertMatches(matches);
    await store.upsertFeed(
      'moviemeter',
      Array.from({ length: 40 }, (_, idx) => ({
        imdbId: `tt${String(2000000 + idx * 10 + 1)}`,
        title: `Synth Movie ${idx * 10 + 1}`,
        mediaType: 'movie' as const,
        rank: idx + 1,
      })),
    );

    // Seed 10 likes, 5 favorites, 10 watched
    for (let i = 1; i <= 10; i += 1) {
      await setItemRating(
        db,
        { sourceId: 's1', itemKey: `x:s1:movie:${i}`, kind: 'movie', title: `Synth Movie ${i}` },
        'like',
      );
    }
    for (let i = 11; i <= 15; i += 1) {
      await setFavorite(
        db,
        { sourceId: 's1', itemKey: `x:s1:movie:${i}`, kind: 'movie', title: `Synth Movie ${i}` },
        true,
      );
    }
    for (let i = 16; i <= 25; i += 1) {
      await setItemWatched(db, `x:s1:movie:${i}`, true);
    }

    // Warm up JIT once, then measure
    const warm = await computeElvRecommendations({
      catalogDb: db,
      enrichmentStore: store,
      profile: 'elv_picks',
      kind: 'movie',
      limit: 24,
    });
    expect(warm).toHaveLength(24);

    const t0 = performance.now();
    const recs = await computeElvRecommendations({
      catalogDb: db,
      enrichmentStore: store,
      profile: 'elv_picks',
      kind: 'movie',
      limit: 24,
    });
    const elapsedMs = performance.now() - t0;

    expect(recs).toHaveLength(24);
    expect(elapsedMs).toBeLessThan(25);
  });
});
