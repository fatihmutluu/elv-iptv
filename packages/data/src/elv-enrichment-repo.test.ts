import { describe, expect, it } from 'vitest';
import { openElvEnrichmentStore } from './elv-enrichment-repo';
import { ELV_ENRICHMENT_SCHEMA_VERSION } from './elv-enrichment-schema';
import { openCatalog } from './migrate';
import { testDb } from './test-db';

describe('isolated local elv-enrichment.db store (#511)', () => {
  it('opens idempotently on its own SqlDriver with all tables, indexes, and current schema_version without touching catalog.db', async () => {
    const catalog = testDb();
    expect((await openCatalog(catalog.db)).ok).toBe(true);

    const enrichment = testDb();
    const store = await openElvEnrichmentStore(enrichment.db, { clock: () => 1_700_000_000_000 });
    // Second open on same DB is completely idempotent
    await openElvEnrichmentStore(enrichment.db, { clock: () => 1_700_000_000_000 });

    const tables = (
      await enrichment.db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
    ).map((r) => r.name);
    expect(tables).toEqual([
      'elv_feeds',
      'elv_item_matches',
      'elv_meta',
      'elv_quality_memory',
      'elv_titles',
    ]);

    const indexes = (
      await enrichment.db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
    ).map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_elv_matches_imdb_type',
        'idx_elv_matches_source',
        'idx_elv_titles_franchise',
      ]),
    );

    const meta = await enrichment.db.all<{ key: string; value: string }>(
      "SELECT key, value FROM elv_meta WHERE key = 'schema_version'",
    );
    expect(meta).toEqual([{ key: 'schema_version', value: ELV_ENRICHMENT_SCHEMA_VERSION }]);

    // Zero ELV tables exist in catalog.db
    const catalogTables = (
      await catalog.db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'elv_%'",
      )
    ).map((r) => r.name);
    expect(catalogTables).toEqual([]);

    await store.close();
  });

  it('respects manual_lock = 1 during upsertMatches unless forceManual is true, and clears per-source matches', async () => {
    const { db } = testDb();
    let now = 10_000;
    const store = await openElvEnrichmentStore(db, { clock: () => now });

    const inserted = await store.upsertMatches([
      {
        itemKey: 'x:s1:movie:1',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'TT1375666',
        confidence: 0.92,
      },
      {
        itemKey: 'x:s2:movie:2',
        sourceId: 's2',
        mediaType: 'movie',
        imdbId: 'tt0816692',
        confidence: 0.95,
      },
    ]);
    expect(inserted).toBe(2);

    // Lock x:s1:movie:1 via Fix Match
    now = 20_000;
    await store.setManualMatch('x:s1:movie:1', 's1', 'movie', 'tt0133093');
    const locked = await store.getMatchForKey('x:s1:movie:1');
    expect(locked).toEqual({
      itemKey: 'x:s1:movie:1',
      sourceId: 's1',
      mediaType: 'movie',
      imdbId: 'tt0133093',
      confidence: 1,
      manualLock: true,
      updatedAt: 20_000,
    });

    // Automated re-match MUST NOT overwrite manual_lock = 1
    now = 30_000;
    await store.upsertMatches([
      {
        itemKey: 'x:s1:movie:1',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt1375666',
        confidence: 0.99,
      },
    ]);
    expect((await store.getMatchForKey('x:s1:movie:1'))?.imdbId).toBe('tt0133093');
    expect((await store.getMatchForKey('x:s1:movie:1'))?.manualLock).toBe(true);

    // forceManual = true explicitly overrides the lock
    now = 40_000;
    await store.upsertMatches([
      {
        itemKey: 'x:s1:movie:1',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt0468569',
        confidence: 1,
        forceManual: true,
      },
    ]);
    expect((await store.getMatchForKey('x:s1:movie:1'))?.imdbId).toBe('tt0468569');
    expect((await store.getMatchForKey('x:s1:movie:1'))?.manualLock).toBe(true);

    // Invalid IMDb ID is rejected cleanly on setManualMatch
    await expect(store.setManualMatch('x:s1:movie:1', 's1', 'movie', 'not-imdb')).rejects.toThrow();

    // clearSourceMatches deletes only s1, keeping s2 untouched
    const cleared = await store.clearSourceMatches('s1');
    expect(cleared).toBe(1);
    expect(await store.getMatchForKey('x:s1:movie:1')).toBeNull();
    expect((await store.getMatchForKey('x:s2:movie:2'))?.imdbId).toBe('tt0816692');
  });

  it('merges localizedTitles and synopses maps without clobbering prior languages and preserves richer detail fields', async () => {
    const { db } = testDb();
    let now = 50_000;
    const store = await openElvEnrichmentStore(db, { clock: () => now });

    await store.upsertTitles([
      {
        imdbId: 'tt1375666',
        mediaType: 'movie',
        originalTitle: 'Inception',
        englishTitle: 'Inception',
        localizedTitles: { tr: 'Başlangıç' },
        year: 2010,
        rating: 8.8,
        votes: 2_500_000,
        runtimeMin: 148,
        genres: ['Action', 'Sci-Fi'],
        posterUrl: 'https://m.media-amazon.com/images/M/p._V1_QL75_UX300_.jpg',
        backdropUrl: 'https://m.media-amazon.com/images/M/b._V1_QL75_UX1280_.jpg',
        trailerStreamUrl: 'https://imdb-video.media-imdb.com/trailer.mp4',
        director: 'Christopher Nolan',
        cast: [{ personId: 'nm0000138', name: 'Leonardo DiCaprio', character: 'Cobb' }],
        mltImdbIds: ['tt0816692'],
        synopses: { tr: 'Rüyaların derinliklerine giren bir hırsızın hikayesi.' },
        detailFetchedAt: 50_000,
      },
    ]);

    // Second upsert adds English synopsis & German localized title without clobbering Turkish or full detail fields
    now = 60_000;
    await store.upsertTitles([
      {
        imdbId: 'tt1375666',
        mediaType: 'movie',
        originalTitle: 'Inception',
        localizedTitles: { de: 'Inception' },
        synopses: { en: 'A thief who steals corporate secrets through dream-sharing technology.' },
      },
    ]);

    const title = await store.getTitleByImdbId('tt1375666');
    expect(title).not.toBeNull();
    expect(title?.localizedTitles).toEqual({ tr: 'Başlangıç', de: 'Inception' });
    expect(title?.synopses).toEqual({
      tr: 'Rüyaların derinliklerine giren bir hırsızın hikayesi.',
      en: 'A thief who steals corporate secrets through dream-sharing technology.',
    });
    expect(title?.director).toBe('Christopher Nolan');
    expect(title?.backdropUrl).toBe('https://m.media-amazon.com/images/M/b._V1_QL75_UX1280_.jpg');
    expect(title?.cast).toHaveLength(1);
    expect(title?.detailFetchedAt).toBe(50_000);
  });

  it('supports batched getEnrichmentForKeys, listImdbGenres, listMatchedItemKeysForImdbIds, feeds, and wipeAll', async () => {
    const { db } = testDb();
    const store = await openElvEnrichmentStore(db, { clock: () => 100_000 });

    await store.upsertTitles([
      {
        imdbId: 'tt1375666',
        mediaType: 'movie',
        originalTitle: 'Inception',
        genres: ['Action', 'Sci-Fi'],
        rating: 8.8,
        posterUrl: 'https://m.media-amazon.com/images/M/1._V1_QL75_UX300_.jpg',
      },
      {
        imdbId: 'tt0816692',
        mediaType: 'movie',
        originalTitle: 'Interstellar',
        genres: ['Adventure', 'Sci-Fi'],
        rating: 8.7,
        posterUrl: 'https://m.media-amazon.com/images/M/2._V1_QL75_UX300_.jpg',
      },
      {
        imdbId: 'tt5753856',
        mediaType: 'series',
        originalTitle: 'Dark',
        genres: ['Mystery', 'Sci-Fi'],
        rating: 8.7,
      },
    ]);

    await store.upsertMatches([
      {
        itemKey: 'x:s1:movie:1',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt1375666',
        confidence: 0.95,
      },
      {
        itemKey: 'x:s2:movie:9',
        sourceId: 's2',
        mediaType: 'movie',
        imdbId: 'tt1375666',
        confidence: 0.91,
      },
      {
        itemKey: 'x:s1:movie:2',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt0816692',
        confidence: 0.93,
      },
      {
        itemKey: 'x:s1:series:1',
        sourceId: 's1',
        mediaType: 'series',
        imdbId: 'tt5753856',
        confidence: 0.96,
      },
    ]);

    expect((await store.getEnrichmentForKeys([])).size).toBe(0);

    const page = await store.getEnrichmentForKeys([
      'x:s1:movie:1',
      'x:s1:movie:2',
      'x:s1:movie:missing',
    ]);
    expect(page.size).toBe(2);
    expect(page.get('x:s1:movie:1')?.title?.originalTitle).toBe('Inception');
    expect(page.get('x:s1:movie:2')?.title?.originalTitle).toBe('Interstellar');

    const genresAll = await store.listImdbGenres('movie');
    expect(genresAll).toEqual([
      { genre: 'Sci-Fi', itemCount: 3 },
      { genre: 'Action', itemCount: 2 },
      { genre: 'Adventure', itemCount: 1 },
    ]);

    const genresFiltered = await store.listImdbGenres('movie', ['x:s1:movie:1']);
    expect(genresFiltered).toEqual([
      { genre: 'Action', itemCount: 1 },
      { genre: 'Sci-Fi', itemCount: 1 },
    ]);

    const matchedByImdb = await store.listMatchedItemKeysForImdbIds(
      ['tt1375666', 'tt0816692'],
      'movie',
    );
    expect(matchedByImdb.get('tt1375666')).toEqual(['x:s1:movie:1', 'x:s2:movie:9']);
    expect(matchedByImdb.get('tt0816692')).toEqual(['x:s1:movie:2']);

    await store.upsertFeed(
      'moviemeter',
      [{ imdbId: 'tt1375666', title: 'Inception', mediaType: 'movie', rank: 1 }],
      200_000,
    );
    const feed = await store.getFeed('moviemeter');
    expect(feed).toEqual({
      feedKey: 'moviemeter',
      items: [{ imdbId: 'tt1375666', title: 'Inception', mediaType: 'movie', rank: 1 }],
      updatedAt: 200_000,
    });
    expect(await store.getFeed('missing')).toBeNull();

    // wipeAll clears all ELV tables cleanly while retaining elv_meta schema_version
    await store.wipeAll();
    expect((await store.getEnrichmentForKeys(['x:s1:movie:1'])).size).toBe(0);
    expect(await store.getTitleByImdbId('tt1375666')).toBeNull();
    expect(await store.getFeed('moviemeter')).toBeNull();
    expect(await db.all("SELECT key, value FROM elv_meta WHERE key = 'schema_version'")).toEqual([
      { key: 'schema_version', value: ELV_ENRICHMENT_SCHEMA_VERSION },
    ]);
  });

  it('searchMatchedItemKeysByAlias resolves original, English, and localized titles with Turkish folding, mediaType, source exclusion, and limit cap', async () => {
    const { db } = testDb();
    const store = await openElvEnrichmentStore(db, { clock: () => 10_000 });

    await store.upsertTitles([
      {
        imdbId: 'tt6468322',
        mediaType: 'series',
        originalTitle: 'La Casa de Papel',
        englishTitle: 'Money Heist',
        localizedTitles: { tr: 'La Casa de Papel', de: 'Haus des Geldes', ja: 'ペーパー・ハウス' },
      },
      {
        imdbId: 'tt1375666',
        mediaType: 'movie',
        originalTitle: 'Inception',
        englishTitle: 'Inception',
        localizedTitles: { tr: 'Başlangıç' },
      },
      {
        imdbId: 'tt0211915',
        mediaType: 'movie',
        originalTitle: "Le Fabuleux Destin d'Amélie Poulain",
        englishTitle: 'Amélie',
      },
    ]);
    await store.upsertMatches([
      {
        itemKey: 'x:s1:series:casa',
        sourceId: 's1',
        mediaType: 'series',
        imdbId: 'tt6468322',
        confidence: 0.96,
      },
      {
        itemKey: 'x:s1:movie:baslangic',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt1375666',
        confidence: 0.95,
      },
      {
        itemKey: 'x:s2:movie:baslangic-alt',
        sourceId: 's2',
        mediaType: 'movie',
        imdbId: 'tt1375666',
        confidence: 0.9,
      },
      {
        itemKey: 'x:s1:movie:amelie',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt0211915',
        confidence: 0.92,
      },
    ]);

    // English alias finds Spanish original series
    expect(await store.searchMatchedItemKeysByAlias('Money Heist')).toEqual(['x:s1:series:casa']);
    expect(await store.searchMatchedItemKeysByAlias('Haus des Geldes')).toEqual([
      'x:s1:series:casa',
    ]);
    // Original/English title finds Turkish-titled catalog item
    expect(await store.searchMatchedItemKeysByAlias('Inception')).toEqual([
      'x:s1:movie:baslangic',
      'x:s2:movie:baslangic-alt',
    ]);
    // ASCII-folded and uppercase Turkish localized title queries find Başlangıç
    expect(await store.searchMatchedItemKeysByAlias('Baslangic')).toEqual([
      'x:s1:movie:baslangic',
      'x:s2:movie:baslangic-alt',
    ]);
    expect(await store.searchMatchedItemKeysByAlias('BAŞLANGIÇ')).toEqual([
      'x:s1:movie:baslangic',
      'x:s2:movie:baslangic-alt',
    ]);
    expect(await store.searchMatchedItemKeysByAlias('Amelie')).toEqual(['x:s1:movie:amelie']);
    // Language JSON keys ("tr", "ja") must never cause false matches
    expect(await store.searchMatchedItemKeysByAlias('tr')).toEqual([]);
    expect(await store.searchMatchedItemKeysByAlias('ja')).toEqual([]);
    // Word-prefix match ("de" matches "de" in "La Casa de Papel" and "Destin" in Amélie's original title)
    expect(await store.searchMatchedItemKeysByAlias('de')).toEqual([
      'x:s1:series:casa',
      'x:s1:movie:amelie',
    ]);

    // mediaType and excludedSourceIds filters
    expect(await store.searchMatchedItemKeysByAlias('Money Heist', { mediaType: 'movie' })).toEqual(
      [],
    );
    expect(
      await store.searchMatchedItemKeysByAlias('Inception', { excludedSourceIds: ['s1'] }),
    ).toEqual(['x:s2:movie:baslangic-alt']);
    expect(await store.searchMatchedItemKeysByAlias('Inception', { limit: 1 })).toEqual([
      'x:s1:movie:baslangic',
    ]);
    expect(await store.searchMatchedItemKeysByAlias('Inception', { limit: 0 })).toEqual([]);
    expect(await store.searchMatchedItemKeysByAlias('   ')).toEqual([]);
    expect(await store.searchMatchedItemKeysByAlias('%_\\')).toEqual([]);
  });

  it('clearSourceMatches purges matched and unmatched elv_quality_memory rows for that source without touching sibling sources', async () => {
    const { db } = testDb();
    const store = await openElvEnrichmentStore(db, { clock: () => 1_000 });

    await store.upsertMatches([
      {
        itemKey: 'custom-key-for-s_1',
        sourceId: 's_1',
        mediaType: 'movie',
        imdbId: 'tt1375666',
        confidence: 0.95,
      },
      {
        itemKey: 'x:s21:movie:1',
        sourceId: 's21',
        mediaType: 'movie',
        imdbId: 'tt0816692',
        confidence: 0.95,
      },
    ]);

    const baseQuality = {
      actualWidth: 1920,
      actualHeight: 1080,
      actualVideoCodec: 'hevc',
      actualAudioCodec: 'aac',
      actualAudioChannels: 2,
      actualHdr: null,
      claimedLabel: '1080p',
      isFake4k: false,
      failCount: 0,
      lastSuccessAt: 1_000,
      lastFailAt: null,
      updatedAt: 1_000,
    };
    await store.upsertQualityMemory({ ...baseQuality, itemKey: 'custom-key-for-s_1' });
    await store.upsertQualityMemory({ ...baseQuality, itemKey: 'x:s_1:live:4k' });
    await store.upsertQualityMemory({ ...baseQuality, itemKey: 'm:s_1:movie:2' });
    await store.upsertQualityMemory({ ...baseQuality, itemKey: 's:s_1:movie:3' });
    await store.upsertQualityMemory({ ...baseQuality, itemKey: 'x:s21:movie:1' });
    await store.upsertQualityMemory({ ...baseQuality, itemKey: 'x:s21:live:hd' });

    const deletedMatches = await store.clearSourceMatches('s_1');
    expect(deletedMatches).toBe(1);
    expect(await store.getQualityMemory('custom-key-for-s_1')).toBeNull();
    expect(await store.getQualityMemory('x:s_1:live:4k')).toBeNull();
    expect(await store.getQualityMemory('m:s_1:movie:2')).toBeNull();
    expect(await store.getQualityMemory('s:s_1:movie:3')).toBeNull();
    // Wildcard-adjacent source `s21` MUST NOT be touched when deleting `s_1`!
    expect(await store.getQualityMemory('x:s21:movie:1')).not.toBeNull();
    expect(await store.getQualityMemory('x:s21:live:hd')).not.toBeNull();
  });

  it('guards against prototype pollution keys (__proto__, constructor, prototype) in parseStringMap and mergeStringMap', async () => {
    const { db } = testDb();
    const store = await openElvEnrichmentStore(db, { clock: () => 1_000 });

    const maliciousMap = JSON.parse(
      '{"__proto__":"evil","constructor":"evil2","prototype":"evil3","tr":"Başlangıç"}',
    ) as Record<string, string>;

    await store.upsertTitles([
      {
        imdbId: 'tt1375666',
        mediaType: 'movie',
        originalTitle: 'Inception',
        localizedTitles: maliciousMap,
        synopses: maliciousMap,
      },
    ]);

    // Also inject raw malicious JSON directly into SQLite to exercise parseStringMap
    await db.run(
      `UPDATE elv_titles
          SET localized_titles_json = ?, synopses_json = ?
        WHERE imdb_id = 'tt1375666'`,
      [
        '{"__proto__":"rawEvil","constructor":"rawCtor","prototype":"rawProto","en":"Inception"}',
        '{"__proto__":"rawEvil","constructor":"rawCtor","prototype":"rawProto","en":"Dream heist."}',
      ],
    );

    const loaded = await store.getTitleByImdbId('tt1375666');
    expect(loaded).not.toBeNull();
    expect(Object.keys(loaded?.localizedTitles ?? {})).toEqual(['en']);
    expect(Object.keys(loaded?.synopses ?? {})).toEqual(['en']);
    expect(Object.hasOwn(loaded?.localizedTitles ?? {}, '__proto__')).toBe(false);
    expect(Object.hasOwn(loaded?.localizedTitles ?? {}, 'constructor')).toBe(false);
    expect(Object.hasOwn(loaded?.localizedTitles ?? {}, 'prototype')).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

    // Upsert merge must also strip dangerous keys while keeping valid ones
    await store.upsertTitles([
      {
        imdbId: 'tt1375666',
        mediaType: 'movie',
        originalTitle: 'Inception',
        localizedTitles: maliciousMap,
        synopses: maliciousMap,
      },
    ]);
    const merged = await store.getTitleByImdbId('tt1375666');
    expect(merged?.localizedTitles).toEqual({ en: 'Inception', tr: 'Başlangıç' });
    expect(merged?.synopses).toEqual({ en: 'Dream heist.', tr: 'Başlangıç' });
    expect(Object.hasOwn(merged?.localizedTitles ?? {}, 'constructor')).toBe(false);
    expect(Object.hasOwn(merged?.synopses ?? {}, 'prototype')).toBe(false);
  });

  it('safely migrates a v1 elv-enrichment.db lacking tmdb_id, creates idx_elv_titles_tmdb_id, and merges tmdbId non-destructively', async () => {
    const { db } = testDb();
    // Simulate a legacy v1 elv-enrichment.db before tmdb_id existed
    await db.exec(`
      CREATE TABLE elv_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO elv_meta (key, value) VALUES ('schema_version', '1');
      CREATE TABLE elv_item_matches (
        item_key TEXT PRIMARY KEY, source_id TEXT NOT NULL, media_type TEXT NOT NULL,
        imdb_id TEXT NOT NULL, confidence REAL NOT NULL, manual_lock INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE elv_titles (
        imdb_id TEXT PRIMARY KEY, media_type TEXT NOT NULL, original_title TEXT NOT NULL,
        english_title TEXT, localized_titles_json TEXT NOT NULL DEFAULT '{}', year INTEGER,
        rating REAL, votes INTEGER, runtime_min INTEGER, genres_json TEXT NOT NULL DEFAULT '[]',
        poster_url TEXT, backdrop_url TEXT, trailer_stream_url TEXT, trailer_youtube_id TEXT,
        director TEXT, cast_json TEXT NOT NULL DEFAULT '[]', mlt_imdb_ids_json TEXT NOT NULL DEFAULT '[]',
        franchise_key TEXT, franchise_name TEXT, franchise_order INTEGER,
        synopses_json TEXT NOT NULL DEFAULT '{}', detail_fetched_at INTEGER, updated_at INTEGER NOT NULL
      );
      INSERT INTO elv_titles (imdb_id, media_type, original_title, updated_at)
        VALUES ('tt1375666', 'movie', 'Inception', 1000);
      INSERT INTO elv_item_matches (item_key, source_id, media_type, imdb_id, confidence, manual_lock, updated_at)
        VALUES ('x:s1:movie:1', 's1', 'movie', 'tt1375666', 1, 0, 1000);
    `);

    const store = await openElvEnrichmentStore(db, { clock: () => 20_000 });
    const cols = await db.all<{ name: string }>('PRAGMA table_info(elv_titles)');
    expect(cols.some((c) => c.name === 'tmdb_id')).toBe(true);

    const indexes = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'elv_titles'",
    );
    expect(indexes.some((i) => i.name === 'idx_elv_titles_tmdb_id')).toBe(true);

    const meta = await db.all<{ value: string }>(
      "SELECT value FROM elv_meta WHERE key = 'schema_version'",
    );
    expect(meta).toEqual([{ value: ELV_ENRICHMENT_SCHEMA_VERSION }]);

    // Existing row survived cleanly with tmdbId = null
    expect((await store.getTitleByImdbId('tt1375666'))?.tmdbId).toBeNull();

    // Upsert attaches tmdbId and preserves it when later upsert omits tmdbId
    await store.upsertTitles([
      {
        imdbId: 'tt1375666',
        mediaType: 'movie',
        originalTitle: 'Inception',
        tmdbId: '27205',
      },
    ]);
    await store.upsertTitles([
      {
        imdbId: 'tt1375666',
        mediaType: 'movie',
        originalTitle: 'Inception',
        year: 2010,
      },
    ]);

    const updated = await store.getTitleByImdbId('tt1375666');
    expect(updated?.tmdbId).toBe('27205');
    expect(updated?.year).toBe(2010);

    const enrich = await store.getEnrichmentForKeys(['x:s1:movie:1']);
    expect(enrich.get('x:s1:movie:1')?.title?.tmdbId).toBe('27205');

    const byTmdb = await store.getTitlesByTmdbIds?.(['27205', 'invalid', '0', '999999']);
    expect(byTmdb?.get('27205')?.imdbId).toBe('tt1375666');
    expect(byTmdb?.size).toBe(1);

    await store.close();
  });

  it('listTopRatedMatchedTitles rewards audience consensus (votes >= 500, m = 5000), keeps classics eligible, and falls back gracefully on low-vote fixtures', async () => {
    const { db } = testDb();
    const store = await openElvEnrichmentStore(db, { clock: () => 10_000 });

    await store.upsertTitles([
      {
        imdbId: 'tt0068646',
        mediaType: 'movie',
        originalTitle: 'Classic Masterpiece',
        year: 1972,
        rating: 9.2,
        votes: 2_000_000,
      },
      {
        imdbId: 'tt8880001',
        mediaType: 'movie',
        originalTitle: 'Obscure Spike',
        year: 2021,
        rating: 9.9,
        votes: 250,
      },
      {
        imdbId: 'tt8880002',
        mediaType: 'movie',
        originalTitle: 'Niche Cult',
        year: 2020,
        rating: 9.2,
        votes: 1_500,
      },
      {
        imdbId: 'tt8880003',
        mediaType: 'movie',
        originalTitle: 'Widely Acclaimed Hit',
        year: 2019,
        rating: 8.0,
        votes: 500_000,
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
        imdbId: 'tt8880001',
        confidence: 0.99,
      },
      {
        itemKey: 'x:s1:movie:lowcult',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt8880002',
        confidence: 0.99,
      },
      {
        itemKey: 'x:s1:movie:popular',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt8880003',
        confidence: 0.99,
      },
    ]);

    const ranked = await store.listTopRatedMatchedTitles({ mediaType: 'movie', limit: 10 });
    expect(ranked.map((t) => t.imdbId)).toEqual([
      'tt0068646', // 1972 classic with 2M votes stays #1 (no year cutoff!)
      'tt8880003', // 8.0 w/ 500k votes beats 9.2 w/ 1500 votes under m=5000!
      'tt8880002', // 1500 votes (>= 500) still beats < 500 obscure spike
      'tt8880001', // < 500 votes still returned gracefully when limit > 3
    ]);

    await store.close();
  });
});
