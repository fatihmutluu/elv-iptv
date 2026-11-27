import { describe, expect, it, vi } from 'vitest';
import { createCatalogService } from './catalog';
import { ELV_FEEDS_TTL_MS, ELV_IMDB_GENRE_ID_PREFIX } from './elv-discovery-ops';
import { openElvEnrichmentStore } from './elv-enrichment-repo';
import type { ElvMetadataClient } from './elv-matcher';
import { recordPlaybackQuality, recordPlaybackVariantFailure } from './elv-quality-memory';
import { openCatalog } from './migrate';
import { setParentalLock, updateParentalSettings } from './parental-repo';
import { countingScheduler, memorySecrets, testDb } from './test-db';
import { createCoalescedCatalog } from './write-coalescer';

describe('Wave E2 ELV Discovery Ops (#512)', () => {
  const noopHttp = {
    get: vi.fn(async () => {
      throw new Error('unexpected http call');
    }),
  };

  async function createFixture() {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    let now = 1_700_000_000_000;
    const clock = () => now;
    const setNow = (next: number) => {
      now = next;
    };

    await db.batch(
      'INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES (?, ?, ?, ?, ?)',
      [
        ['s1', 'xtream', 'Source One', 1, '{}'],
        ['s2', 'xtream', 'Source Two', 2, '{}'],
      ],
    );
    await db.batch(
      `INSERT INTO movies (source_id, key, name, name_fold, year, logo, run_id)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [
        [
          's1',
          'x:s1:movie:m1',
          'The Matrix (1999) [4K]',
          'the matrix 1999 4k',
          1999,
          'https://p/m1.jpg',
        ],
        [
          's2',
          'x:s2:movie:m1_alt',
          'The Matrix (1999) [1080p]',
          'the matrix 1999 1080p',
          1999,
          'https://p/m1b.jpg',
        ],
        [
          's1',
          'x:s1:movie:m2',
          'The Matrix Reloaded (2003)',
          'the matrix reloaded 2003',
          2003,
          'https://p/m2.jpg',
        ],
        [
          's1',
          'x:s1:movie:m3',
          'The Matrix Revolutions (2003)',
          'the matrix revolutions 2003',
          2003,
          'https://p/m3.jpg',
        ],
        ['s1', 'x:s1:movie:john', 'John Wick (2014)', 'john wick 2014', 2014, 'https://p/jw.jpg'],
        [
          's2',
          'x:s2:movie:s2only',
          'Source Two Sci-Fi (2022)',
          'source two sci fi 2022',
          2022,
          'https://p/s2.jpg',
        ],
      ],
    );
    await db.run(
      `INSERT INTO series (source_id, key, name, name_fold, year, cover, run_id)
       VALUES ('s1', 'x:s1:series:sr1', 'Cyberpunk Series', 'cyberpunk series', 2021, 'https://p/sr1.jpg', 1)`,
    );

    const enrichment = testDb();
    const enrichmentStore = await openElvEnrichmentStore(enrichment.db, { clock });

    await enrichmentStore.upsertTitles([
      {
        imdbId: 'tt0133093',
        mediaType: 'movie',
        originalTitle: 'The Matrix',
        year: 1999,
        rating: 8.7,
        votes: 2_000_000,
        genres: ['Action', 'Sci-Fi'],
        director: 'Lana Wachowski',
        cast: [
          { personId: 'nm0000206', name: 'Keanu Reeves', character: 'Neo' },
          { personId: 'nm0000401', name: 'Laurence Fishburne', character: 'Morpheus' },
        ],
        franchiseKey: 'matrix',
        franchiseName: 'The Matrix Collection',
        franchiseOrder: 1,
        mltImdbIds: ['tt2911666'],
      },
      {
        imdbId: 'tt0234215',
        mediaType: 'movie',
        originalTitle: 'The Matrix Reloaded',
        year: 2003,
        rating: 7.2,
        votes: 600_000,
        genres: ['Action', 'Sci-Fi'],
        director: 'Lana Wachowski',
        cast: [{ personId: 'nm0000206', name: 'Keanu Reeves', character: 'Neo' }],
        franchiseKey: 'matrix',
        franchiseName: 'The Matrix Collection',
        franchiseOrder: 2,
      },
      {
        imdbId: 'tt0242653',
        mediaType: 'movie',
        originalTitle: 'The Matrix Revolutions',
        year: 2003,
        rating: 6.7,
        votes: 550_000,
        genres: ['Action', 'Sci-Fi'],
        director: 'Lana Wachowski',
        cast: [{ personId: 'nm0000206', name: 'Keanu Reeves', character: 'Neo' }],
        franchiseKey: 'matrix',
        franchiseName: 'The Matrix Collection',
        franchiseOrder: 3,
      },
      {
        imdbId: 'tt2911666',
        mediaType: 'movie',
        originalTitle: 'John Wick',
        year: 2014,
        rating: 7.4,
        votes: 750_000,
        genres: ['Action', 'Thriller'],
        director: 'Chad Stahelski',
        cast: [{ personId: 'nm0000206', name: 'Keanu Reeves', character: 'John Wick' }],
      },
      {
        imdbId: 'tt8888888',
        mediaType: 'movie',
        originalTitle: 'Source Two Sci-Fi',
        year: 2022,
        rating: 8.1,
        votes: 100_000,
        genres: ['Sci-Fi', 'Mystery'],
      },
      {
        imdbId: 'tt7777777',
        mediaType: 'series',
        originalTitle: 'Cyberpunk Series',
        year: 2021,
        rating: 8.3,
        votes: 200_000,
        genres: ['Sci-Fi', 'Animation'],
        director: 'Lana Wachowski',
        cast: [{ personId: 'nm0000206', name: 'Keanu Reeves', character: 'Johnny' }],
      },
    ]);

    await enrichmentStore.upsertMatches([
      {
        itemKey: 'x:s1:movie:m1',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt0133093',
        confidence: 0.99,
      },
      {
        itemKey: 'x:s2:movie:m1_alt',
        sourceId: 's2',
        mediaType: 'movie',
        imdbId: 'tt0133093',
        confidence: 0.96,
      },
      {
        itemKey: 'x:s1:movie:m2',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt0234215',
        confidence: 0.98,
      },
      {
        itemKey: 'x:s1:movie:m3',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt0242653',
        confidence: 0.98,
      },
      {
        itemKey: 'x:s1:movie:john',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt2911666',
        confidence: 0.97,
      },
      {
        itemKey: 'x:s2:movie:s2only',
        sourceId: 's2',
        mediaType: 'movie',
        imdbId: 'tt8888888',
        confidence: 0.95,
      },
      {
        itemKey: 'x:s1:series:sr1',
        sourceId: 's1',
        mediaType: 'series',
        imdbId: 'tt7777777',
        confidence: 0.98,
      },
    ]);

    const elvClient: ElvMetadataClient = {
      matchBatch: vi.fn(async () => ({ matches: [], unmatchedKeys: [], pendingKeys: [] })),
      fetchTitleDetail: vi.fn(async (imdbId: string, lang?: string) => ({
        imdbId,
        mediaType: 'movie' as const,
        originalTitle: imdbId === 'tt1375666' ? 'Inception' : 'Fetched Title',
        year: 2010,
        rating: 8.8,
        votes: 2_400_000,
        genres: ['Action', 'Sci-Fi'],
        director: 'Christopher Nolan',
        synopses: { [lang ?? 'en']: 'Localized rich synopsis.' },
        detailFetchedAt: clock(),
      })),
      fetchFeeds: vi.fn(async () => ({
        topPicks: [
          { imdbId: 'tt0133093', title: 'The Matrix', mediaType: 'movie' as const, rank: 1 },
        ],
        movieMeter: [
          { imdbId: 'tt2911666', title: 'John Wick', mediaType: 'movie' as const, rank: 1 },
        ],
        tvMeter: [
          { imdbId: 'tt7777777', title: 'Cyberpunk Series', mediaType: 'series' as const, rank: 1 },
        ],
        currentUpcomingTv: [
          { imdbId: 'tt7777777', title: 'Cyberpunk Series', mediaType: 'series' as const, rank: 1 },
        ],
        updatedAt: clock(),
      })),
      searchTitles: vi.fn(async (query: string, mediaType?: 'movie' | 'series') => [
        {
          imdbId: 'tt1375666',
          title: `Match for ${query}`,
          year: 2010,
          mediaType: mediaType ?? 'movie',
          posterUrl: 'https://cdn.example/tt1375666.jpg',
          stars: 'Leonardo DiCaprio',
        },
      ]),
    };

    const rawSvc = createCatalogService({
      db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: noopHttp,
      clock,
      enrichmentStore,
      elvClient,
    });
    const svc = createCoalescedCatalog(rawSvc, { windowMs: 0 });
    return { db, enrichmentStore, elvClient, svc, setNow, clock };
  }

  it('lists distinct IMDb genre buckets and paginated deduplicated items by genre honoring excludedSourceIds and quality memory', async () => {
    const { enrichmentStore, svc } = await createFixture();

    const genresAll = await svc.listElvImdbGenres?.('movie');
    expect(genresAll).toEqual([
      { id: `${ELV_IMDB_GENRE_ID_PREFIX}Action`, name: 'Action', count: 4 },
      { id: `${ELV_IMDB_GENRE_ID_PREFIX}Sci-Fi`, name: 'Sci-Fi', count: 4 },
      { id: `${ELV_IMDB_GENRE_ID_PREFIX}Mystery`, name: 'Mystery', count: 1 },
      { id: `${ELV_IMDB_GENRE_ID_PREFIX}Thriller`, name: 'Thriller', count: 1 },
    ]);

    const genresExclS2 = await svc.listElvImdbGenres?.('movie', { excludedSourceIds: ['s2'] });
    expect(genresExclS2?.map((g) => `${g.name}:${g.count}`)).toEqual([
      'Action:4',
      'Sci-Fi:3',
      'Thriller:1',
    ]);

    // Mark s1 copy of Matrix as failing twice so deduplicated genre list picks healthy s2 copy
    await recordPlaybackVariantFailure(enrichmentStore, 'x:s1:movie:m1');
    await recordPlaybackVariantFailure(enrichmentStore, 'x:s1:movie:m1');
    await recordPlaybackQuality(enrichmentStore, {
      itemKey: 'x:s2:movie:m1_alt',
      actualWidth: 1920,
      actualHeight: 1080,
      claimedLabel: '1080p',
    });

    const sciFiPage1 = await svc.listElvItemsByImdbGenre?.('movie', 'imdb-genre:Sci-Fi', {
      offset: 0,
      limit: 2,
    });
    expect(sciFiPage1).toHaveLength(2);
    // The Matrix (8.7) is #1 and resolved to healthy s2 variant (deduplicated!)
    expect(sciFiPage1?.[0]?.key).toBe('x:s2:movie:m1_alt');

    const sciFiPage2 = await svc.listElvItemsByImdbGenre?.('movie', 'Sci-Fi', {
      offset: 2,
      limit: 10,
    });
    expect(sciFiPage2).toHaveLength(2);
    // Total across pages is 4 distinct IMDb titles (no duplicate Matrix)
    expect(new Set([...(sciFiPage1 ?? []), ...(sciFiPage2 ?? [])].map((i) => i.key)).size).toBe(4);

    // Excluding s2 removes s2only and falls back to s1 copy for The Matrix
    const sciFiNoS2 = await svc.listElvItemsByImdbGenre?.('movie', 'Sci-Fi', {
      excludedSourceIds: ['s2'],
    });
    expect(sciFiNoS2).toHaveLength(3);
    expect(sciFiNoS2?.some((i) => i.sourceId === 's2')).toBe(false);

    await svc.close();
    await enrichmentStore.close();
  });

  it('returns chronological franchise items and cross-kind actor/director filmography in user library', async () => {
    const { enrichmentStore, svc } = await createFixture();

    const franchise = await svc.listElvFranchiseItems?.('tt0234215');
    expect(franchise?.map((f) => f.enrichment.imdbId)).toEqual([
      'tt0133093',
      'tt0234215',
      'tt0242653',
    ]);
    expect(franchise?.map((f) => f.franchiseOrder)).toEqual([1, 2, 3]);
    expect(franchise?.[0]?.franchiseKey).toBe('matrix');
    expect(franchise?.[0]?.franchiseName).toBe('The Matrix Collection');

    // No franchise returns empty array
    expect(await svc.listElvFranchiseItems?.('tt2911666')).toEqual([]);

    // Actor filmography spans BOTH movies and series
    const keanu = await svc.listElvPersonLibraryItems?.({
      personId: 'nm0000206',
      name: 'Keanu Reeves',
    });
    expect(keanu?.length).toBe(5);
    expect(keanu?.some((item) => item.item.kind === 'series')).toBe(true);
    expect(keanu?.some((item) => item.item.kind === 'movie')).toBe(true);
    expect(keanu?.find((item) => item.enrichment.imdbId === 'tt2911666')?.character).toBe(
      'John Wick',
    );
    expect(keanu?.every((item) => item.role === 'cast')).toBe(true);

    // Director filmography matches by name
    const lana = await svc.listElvPersonLibraryItems?.({ name: 'Lana Wachowski' }, { limit: 2 });
    expect(lana).toHaveLength(2);
    expect(lana?.every((item) => item.role === 'director')).toBe(true);

    await svc.close();
    await enrichmentStore.close();
  });

  it('handles diacritic person matching, actor+director both role, and preserves manual_lock when detail fetch throws', async () => {
    const { db, enrichmentStore, elvClient, svc } = await createFixture();
    await db.run(
      `INSERT INTO movies (source_id, key, name, name_fold, year, run_id)
       VALUES ('s1', 'x:s1:movie:volver', 'Volver (2006)', 'volver 2006', 2006, 1)`,
    );
    await enrichmentStore.upsertTitles([
      {
        imdbId: 'tt0441773',
        mediaType: 'movie',
        originalTitle: 'Volver',
        year: 2006,
        rating: 7.6,
        votes: 110_000,
        genres: ['Drama'],
        director: 'Penélope Cruz',
        cast: [{ personId: 'nm0004851', name: 'Penélope Cruz', character: 'Raimunda' }],
      },
    ]);
    await enrichmentStore.upsertMatches([
      {
        itemKey: 'x:s1:movie:volver',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt0441773',
        confidence: 0.95,
      },
    ]);

    const penelope = await svc.listElvPersonLibraryItems?.({ name: 'Penelope Cruz' });
    expect(penelope).toHaveLength(1);
    expect(penelope?.[0]?.role).toBe('both');
    expect(penelope?.[0]?.character).toBe('Raimunda');

    // Empty / invalid inputs safely return empty or null
    expect(await svc.listElvItemsByImdbGenre?.('movie', '   ')).toEqual([]);
    expect(await svc.listElvItemsByImdbGenre?.('movie', 'Action', { limit: 0 })).toEqual([]);
    expect(await svc.listElvFranchiseItems?.('invalid-id')).toEqual([]);
    expect(await svc.listElvPersonLibraryItems?.({ name: '   ' })).toEqual([]);
    expect(await svc.listElvPersonLibraryItems?.({ name: 'Keanu Reeves' }, { limit: 0 })).toEqual(
      [],
    );
    expect(await svc.searchElvMatchCandidates?.('   ', 'movie')).toEqual([]);
    expect(
      await svc.applyElvFixMatch?.({
        itemKey: 'x:s1:movie:volver',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'not-valid',
      }),
    ).toBeNull();

    // Transient detail network failure still locks manual_lock = 1 and returns updated match
    vi.mocked(elvClient.fetchTitleDetail).mockRejectedValueOnce(new Error('offline'));
    const offlineFixed = await svc.applyElvFixMatch?.({
      itemKey: 'x:s1:movie:volver',
      sourceId: 's1',
      mediaType: 'movie',
      imdbId: 'tt0133093',
      lang: 'fr',
    });
    expect(offlineFixed?.imdbId).toBe('tt0133093');
    expect(offlineFixed?.manualLock).toBe(true);

    await svc.close();
    await enrichmentStore.close();
  });

  it('refreshes ELV feeds with 6h TTL, searches Fix Match candidates, applies Fix Match with manual_lock + rich detail, and serves recommendations', async () => {
    const { enrichmentStore, elvClient, svc, setNow, clock } = await createFixture();

    // First refresh fetches and persists all 4 feeds
    expect(await svc.refreshElvFeeds?.()).toBe(true);
    expect(elvClient.fetchFeeds).toHaveBeenCalledTimes(1);
    expect((await enrichmentStore.getFeed('top_picks'))?.items).toHaveLength(1);
    expect((await enrichmentStore.getFeed('moviemeter'))?.items).toHaveLength(1);
    expect((await enrichmentStore.getFeed('tvmeter'))?.items).toHaveLength(1);
    expect((await enrichmentStore.getFeed('current_upcoming_tv'))?.items).toHaveLength(1);

    // Within 6h TTL -> skips network
    setNow(clock() + ELV_FEEDS_TTL_MS - 1_000);
    expect(await svc.refreshElvFeeds?.()).toBe(false);
    expect(elvClient.fetchFeeds).toHaveBeenCalledTimes(1);

    // Past 6h TTL -> refreshes again
    setNow(clock() + 2_000);
    expect(await svc.refreshElvFeeds?.()).toBe(true);
    expect(elvClient.fetchFeeds).toHaveBeenCalledTimes(2);

    // Recommendations via CatalogService & coalescer
    const recs = await svc.getElvRecommendations?.({ profile: 'home', limit: 5 });
    expect(recs && recs.length > 0).toBe(true);

    // Fix Match search
    const candidates = await svc.searchElvMatchCandidates?.('Inception', 'movie');
    expect(candidates).toHaveLength(1);
    expect(candidates?.[0]?.imdbId).toBe('tt1375666');
    expect(elvClient.searchTitles).toHaveBeenCalledWith('Inception', 'movie', undefined);

    // Apply Fix Match -> locks manual_lock = 1 AND fetches rich detail immediately
    const fixed = await svc.applyElvFixMatch?.({
      itemKey: 'x:s1:movie:john',
      sourceId: 's1',
      mediaType: 'movie',
      imdbId: 'tt1375666',
      lang: 'tr',
    });
    expect(fixed?.imdbId).toBe('tt1375666');
    expect(fixed?.manualLock).toBe(true);
    expect(fixed?.title?.originalTitle).toBe('Inception');
    expect(fixed?.title?.synopses['tr']).toBe('Localized rich synopsis.');

    await svc.close();
    await enrichmentStore.close();
  });

  it('degrades gracefully when enrichmentStore and elvClient are omitted', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    const svc = createCatalogService({
      db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: noopHttp,
      clock: () => 1_000,
    });

    expect(await svc.listElvImdbGenres?.('movie')).toEqual([]);
    expect(await svc.listElvItemsByImdbGenre?.('movie', 'Action')).toEqual([]);
    expect(await svc.getElvRecommendations?.({ profile: 'home' })).toEqual([]);
    expect(await svc.refreshElvFeeds?.()).toBe(false);
    expect(await svc.listElvFranchiseItems?.('tt0133093')).toEqual([]);
    expect(await svc.listElvPersonLibraryItems?.({ name: 'Keanu Reeves' })).toEqual([]);
    expect(await svc.searchElvMatchCandidates?.('Inception', 'movie')).toEqual([]);
    expect(
      await svc.applyElvFixMatch?.({
        itemKey: 'x:s1:movie:1',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt1375666',
      }),
    ).toBeNull();

    await svc.close();
  });

  it('filters hidden (is_hidden = 1) and parental/Kids Mode blocked items out of listElvImdbGenres with exact visible counts and supports parentalUnlocked bypass', async () => {
    const { db, enrichmentStore, svc } = await createFixture();

    // Add a hidden movie, an Adult/Erotica movie, a Horror movie, and a Family movie
    await db.batch(
      `INSERT INTO movies (source_id, key, name, name_fold, year, is_hidden, run_id)
       VALUES ('s1', ?, ?, ?, ?, ?, 1)`,
      [
        ['x:s1:movie:hidden1', 'Hidden Documentary (2020)', 'hidden documentary 2020', 2020, 1],
        ['x:s1:movie:adult1', 'Adult Late Night XXX (2021)', 'adult late night xxx 2021', 2021, 0],
        ['x:s1:movie:horror1', 'Scary Night (2022)', 'scary night 2022', 2022, 0],
        ['x:s1:movie:family1', 'Happy Penguins (2023)', 'happy penguins 2023', 2023, 0],
        ['x:s1:movie:locked1', 'Locked Crime Film (2023)', 'locked crime film 2023', 2023, 0],
      ],
    );
    await enrichmentStore.upsertTitles([
      {
        imdbId: 'tt9100001',
        mediaType: 'movie',
        originalTitle: 'Hidden Documentary',
        year: 2020,
        rating: 8.0,
        votes: 10_000,
        genres: ['Documentary'],
      },
      {
        imdbId: 'tt9100002',
        mediaType: 'movie',
        originalTitle: 'Adult Late Night',
        year: 2021,
        rating: 6.5,
        votes: 5_000,
        genres: ['Adult', 'Erotica'],
      },
      {
        imdbId: 'tt9100003',
        mediaType: 'movie',
        originalTitle: 'Scary Night',
        year: 2022,
        rating: 7.4,
        votes: 20_000,
        genres: ['Horror'],
      },
      {
        imdbId: 'tt9100004',
        mediaType: 'movie',
        originalTitle: 'Happy Penguins',
        year: 2023,
        rating: 7.9,
        votes: 40_000,
        genres: ['Family', 'Animation'],
      },
      {
        imdbId: 'tt9100005',
        mediaType: 'movie',
        originalTitle: 'Locked Crime Film',
        year: 2023,
        rating: 8.2,
        votes: 30_000,
        genres: ['Crime'],
      },
    ]);
    await enrichmentStore.upsertMatches([
      {
        itemKey: 'x:s1:movie:hidden1',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt9100001',
        confidence: 0.95,
      },
      {
        itemKey: 'x:s1:movie:adult1',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt9100002',
        confidence: 0.95,
      },
      {
        itemKey: 'x:s1:movie:horror1',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt9100003',
        confidence: 0.95,
      },
      {
        itemKey: 'x:s1:movie:family1',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt9100004',
        confidence: 0.95,
      },
      {
        itemKey: 'x:s1:movie:locked1',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt9100005',
        confidence: 0.95,
      },
    ]);

    // Hidden item's Documentary genre MUST NOT appear even for default profile
    const defaultGenres = await svc.listElvImdbGenres?.('movie');
    expect(defaultGenres?.some((g) => g.name === 'Documentary')).toBe(false);
    expect(defaultGenres?.some((g) => g.name === 'Adult')).toBe(true);
    expect(defaultGenres?.some((g) => g.name === 'Horror')).toBe(true);

    // Enable Kids Mode on 'kids' profile + lock Crime item + add R cert on John Wick
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
        targetKey: 'x:s1:movie:locked1',
      },
      true,
    );
    await db.run(
      `INSERT INTO vod_enrichment (item_key, source_id, clean_title, certification, fetched_at, expires_at)
       VALUES ('x:s1:movie:john', 's1', 'John Wick', 'R', 1000, 9999999999999)`,
    );

    const kidsGenres = await svc.listElvImdbGenres?.('movie', { profileId: 'kids' });
    const kidsGenreMap = new Map(kidsGenres?.map((g) => [g.name, g.count]));
    expect(kidsGenreMap.has('Documentary')).toBe(false);
    expect(kidsGenreMap.has('Adult')).toBe(false);
    expect(kidsGenreMap.has('Erotica')).toBe(false);
    expect(kidsGenreMap.has('Horror')).toBe(false);
    expect(kidsGenreMap.has('Crime')).toBe(false);
    expect(kidsGenreMap.has('Thriller')).toBe(false); // John Wick is R-rated
    expect(kidsGenreMap.get('Action')).toBe(3); // 3 Matrix films survive, John Wick excluded
    expect(kidsGenreMap.get('Family')).toBe(1);

    // Exact parity: every genre count in kidsGenres equals actual items returned by listElvItemsByImdbGenre
    for (const bucket of kidsGenres ?? []) {
      const items = await svc.listElvItemsByImdbGenre?.('movie', bucket.id, {
        profileId: 'kids',
        limit: 50,
      });
      expect(items?.length).toBe(bucket.count);
    }

    // parentalUnlocked: true restores parental-blocked genres while still hiding is_hidden = 1 items
    const unlockedGenres = await svc.listElvImdbGenres?.('movie', {
      profileId: 'kids',
      parentalUnlocked: true,
    });
    expect(unlockedGenres?.some((g) => g.name === 'Adult')).toBe(true);
    expect(unlockedGenres?.some((g) => g.name === 'Horror')).toBe(true);
    expect(unlockedGenres?.some((g) => g.name === 'Crime')).toBe(true);
    expect(unlockedGenres?.some((g) => g.name === 'Documentary')).toBe(false);

    await svc.close();
    await enrichmentStore.close();
  });

  it('does not break pagination early when post-filtering reduces a raw SQL genre batch below batchLimit, and supports sortBy: "alpha"', async () => {
    const { db, enrichmentStore, svc } = await createFixture();

    // Seed 65 movies where raw SQL LIKE '%"action"%' matches 65 titles, but 2 titles have a
    // false-positive LIKE substring (`Live "Action"`) in batch 1 (top-rated) so exact-genre
    // post-filtering shrinks batch 1 (60 raw rows -> 58 exact rows < 60), yet page 2 MUST still be reached!
    const movieParams: [string, string, string, string, number][] = [];
    const titleInputs = [];
    const matchInputs = [];
    for (let i = 1; i <= 65; i += 1) {
      const key = `x:s1:movie:pg_${i}`;
      const imdbId = `tt9200${String(i).padStart(3, '0')}`;
      const isFalseLike = i <= 2;
      movieParams.push([
        's1',
        key,
        `Batch Film ${String(i).padStart(2, '0')}`,
        `batch film ${i}`,
        2020,
      ]);
      titleInputs.push({
        imdbId,
        mediaType: 'movie' as const,
        originalTitle: `Batch Film ${String(i).padStart(2, '0')}`,
        year: 2020,
        rating: isFalseLike ? 9.9 : 8.5 - i * 0.01,
        votes: 100_000,
        genres: isFalseLike ? ['Live "Action"'] : ['Action'],
      });
      matchInputs.push({
        itemKey: key,
        sourceId: 's1',
        mediaType: 'movie' as const,
        imdbId,
        confidence: 0.95,
      });
    }
    await db.batch(
      'INSERT INTO movies (source_id, key, name, name_fold, year, run_id) VALUES (?, ?, ?, ?, ?, 1)',
      movieParams,
    );
    await enrichmentStore.upsertTitles(titleInputs);
    await enrichmentStore.upsertMatches(matchInputs);
    // Inject raw non-array JSON on the top-2 rows so SQL `LIKE '%"action"%'` matches them inside batch 1
    // (60 raw rows), while post-filtering in `listMatchedTitlesByGenrePage` drops them (58 < 60).
    await enrichmentStore.driver.run(
      `UPDATE elv_titles SET genres_json = '{"bad":"Action"}' WHERE imdb_id IN ('tt9200001', 'tt9200002')`,
    );

    // Total exact Action titles = 4 (base fixture) + 63 (seeded) = 67.
    // Requesting offset 60, limit 10 MUST reach beyond batch 1 (60 raw rows) into batch 2!
    const page2 = await svc.listElvItemsByImdbGenre?.('movie', 'imdb-genre:Action', {
      offset: 60,
      limit: 10,
    });
    expect(page2).toHaveLength(7);

    // Alpha sort orders titles alphabetically (stripping leading "The ")
    const alphaFirst = await svc.listElvItemsByImdbGenre?.('movie', 'imdb-genre:Sci-Fi', {
      offset: 0,
      limit: 10,
      sortBy: 'alpha',
    });
    expect(alphaFirst?.map((i) => i.name)).toEqual([
      'The Matrix (1999) [4K]',
      'The Matrix Reloaded (2003)',
      'The Matrix Revolutions (2003)',
      'Source Two Sci-Fi (2022)',
    ]);

    await svc.close();
    await enrichmentStore.close();
  });
});
