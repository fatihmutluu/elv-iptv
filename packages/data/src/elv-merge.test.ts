import { describe, expect, it } from 'vitest';
import { openElvEnrichmentStore } from './elv-enrichment-repo';
import { deduplicateCatalogPageByImdb, queryMergedVodVersions } from './elv-merge';
import { recordPlaybackQuality, recordPlaybackVariantFailure } from './elv-quality-memory';
import { openCatalog } from './migrate';
import type { ItemRow } from './queries-shared';
import { testDb } from './test-db';

describe('multi-source VOD/Series merging & catalog page deduplication (#511)', () => {
  async function seedMultiSource() {
    const catalog = testDb();
    expect((await openCatalog(catalog.db)).ok).toBe(true);
    await catalog.db.batch(
      'INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES (?, ?, ?, ?, ?)',
      [
        ['s1', 'xtream', 'Provider Alpha', 1, '{}'],
        ['s2', 'xtream', 'Provider Beta', 2, '{}'],
      ],
    );
    await catalog.db.batch(
      `INSERT INTO movies (source_id, key, name, name_fold, year, version_group_key, version_label, logo, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        [
          's1',
          'x:s1:movie:1',
          'TR: Başlangıç (2010) [4K]',
          'tr baslangic 2010 4k',
          2010,
          'baslangic::2010',
          '4K',
          'http://iptv-a/1.jpg',
        ],
        [
          's2',
          'x:s2:movie:9',
          'US | Inception (2010) [1080p]',
          'us inception 2010 1080p',
          2010,
          'inception::2010',
          '1080p',
          'http://iptv-b/9.jpg',
        ],
        [
          's2',
          'x:s2:movie:10',
          'Inception (2010) [4K HDR]',
          'inception 2010 4k hdr',
          2010,
          'inception::2010',
          '4K HDR',
          'http://iptv-b/10.jpg',
        ],
        [
          's1',
          'x:s1:movie:2',
          'Unmatched Local Film [1080p]',
          'unmatched local film 1080p',
          2021,
          'unmatched local film::2021',
          '1080p',
          'http://iptv-a/2.jpg',
        ],
        [
          's1',
          'x:s1:movie:3',
          'Unmatched Local Film [4K]',
          'unmatched local film 4k',
          2021,
          'unmatched local film::2021',
          '4K',
          'http://iptv-a/3.jpg',
        ],
      ],
    );

    const enrichment = testDb();
    const store = await openElvEnrichmentStore(enrichment.db, { clock: () => 10_000 });
    await store.upsertTitles([
      {
        imdbId: 'tt1375666',
        mediaType: 'movie',
        originalTitle: 'Inception',
        englishTitle: 'Inception',
        localizedTitles: { tr: 'Başlangıç' },
        year: 2010,
        rating: 8.8,
        posterUrl: 'https://m.media-amazon.com/images/M/inception._V1_QL75_UX300_.jpg',
      },
    ]);
    await store.upsertMatches([
      {
        itemKey: 'x:s1:movie:1',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt1375666',
        confidence: 0.92,
      },
      {
        itemKey: 'x:s2:movie:9',
        sourceId: 's2',
        mediaType: 'movie',
        imdbId: 'tt1375666',
        confidence: 0.96,
      },
      {
        itemKey: 'x:s2:movie:10',
        sourceId: 's2',
        mediaType: 'movie',
        imdbId: 'tt1375666',
        confidence: 0.97,
      },
    ]);
    return { catalogDb: catalog.db, store };
  }

  it('merges all sources sharing verified imdb_id, demoting fake-4K and broken variants, and falls back to queryItemVersions when unmatched', async () => {
    const { catalogDb, store } = await seedMultiSource();

    // Mark s1's claimed 4K as fake-4K (actually 720p), s2's 1080p as verified 1080p, s2's 4K HDR as broken (2 failures)
    await recordPlaybackQuality(store, {
      itemKey: 'x:s1:movie:1',
      actualWidth: 1280,
      actualHeight: 720,
      actualVideoCodec: 'h264',
      actualAudioCodec: 'aac',
      claimedLabel: '4K',
    });
    await recordPlaybackQuality(store, {
      itemKey: 'x:s2:movie:9',
      actualWidth: 1920,
      actualHeight: 1080,
      actualVideoCodec: 'hevc',
      actualAudioCodec: 'eac3',
      claimedLabel: '1080p',
    });
    await recordPlaybackVariantFailure(store, 'x:s2:movie:10', 11_000);
    await recordPlaybackVariantFailure(store, 'x:s2:movie:10', 12_000);

    const merged = await queryMergedVodVersions(catalogDb, store, 'x:s1:movie:1');
    expect(merged).toHaveLength(3);
    // Verified 1080p wins over fake-4K, and broken 4K (failCount = 2) sinks to the bottom!
    expect(merged.map((v) => v.itemKey)).toEqual(['x:s2:movie:9', 'x:s1:movie:1', 'x:s2:movie:10']);
    expect(merged[0]).toMatchObject({
      sourceId: 's2',
      sourceName: 'Provider Beta',
      verifiedResolution: '1080p',
      actualVideoCodec: 'hevc',
      isFake4k: false,
      failCount: 0,
    });
    expect(merged[1]?.isFake4k).toBe(true);
    expect(merged[2]?.failCount).toBe(2);

    // Unmatched item falls back cleanly to single-source queryItemVersions
    const fallback = await queryMergedVodVersions(catalogDb, store, 'x:s1:movie:2');
    expect(fallback.map((v) => v.itemKey)).toEqual(['x:s1:movie:3', 'x:s1:movie:2']);
    expect(fallback[0]?.sourceName).toBe('Provider Alpha');
  });

  it('deduplicateCatalogPageByImdb collapses multi-source copies into the best healthy representative with IMDb posterUrl (zero IPTV poster)', async () => {
    const { store } = await seedMultiSource();
    await recordPlaybackQuality(store, {
      itemKey: 'x:s1:movie:1',
      actualWidth: 1280,
      actualHeight: 720,
      claimedLabel: '4K',
    });
    await recordPlaybackQuality(store, {
      itemKey: 'x:s2:movie:9',
      actualWidth: 1920,
      actualHeight: 1080,
      claimedLabel: '1080p',
    });

    const items: ItemRow[] = [
      {
        id: 1,
        key: 'x:s1:movie:1',
        kind: 'movie',
        sourceId: 's1',
        providerId: '1',
        name: 'TR: Başlangıç (2010) [4K]',
        logo: 'http://iptv-a/1.jpg',
        rating: 8,
        year: 2010,
        num: null,
      },
      {
        id: 2,
        key: 'x:s2:movie:9',
        kind: 'movie',
        sourceId: 's2',
        providerId: '9',
        name: 'US | Inception (2010) [1080p]',
        logo: 'http://iptv-b/9.jpg',
        rating: 8,
        year: 2010,
        num: null,
      },
      {
        id: 3,
        key: 'x:s1:movie:2',
        kind: 'movie',
        sourceId: 's1',
        providerId: '2',
        name: 'Unmatched Film',
        logo: 'http://iptv-a/2.jpg',
        rating: 6,
        year: 2021,
        num: null,
      },
    ];

    const enrichMap = await store.getEnrichmentForKeys(items.map((i) => i.key));
    const qualityMap = await store.getQualityMemoryForKeys(items.map((i) => i.key));
    const deduped = deduplicateCatalogPageByImdb(items, enrichMap, qualityMap);

    expect(deduped).toHaveLength(2);
    // Representative is verified 1080p (not fake-4K), mergedCount = 2, logo replaced with IMDb posterUrl
    expect(deduped[0]).toMatchObject({
      key: 'x:s2:movie:9',
      mergedCount: 2,
      imdbId: 'tt1375666',
      logo: 'https://m.media-amazon.com/images/M/inception._V1_QL75_UX300_.jpg',
    });
    // Unmatched item keeps raw IPTV poster untouched
    expect(deduped[1]).toMatchObject({
      key: 'x:s1:movie:2',
      logo: 'http://iptv-a/2.jpg',
    });
    expect(deduped[1]?.mergedCount).toBeUndefined();

    // replacePoster: false deduplicates copies by IMDb ID while preserving the original item poster
    const dedupedKeepPoster = deduplicateCatalogPageByImdb(items, enrichMap, qualityMap, {
      replacePoster: false,
    });
    expect(dedupedKeepPoster).toHaveLength(2);
    expect(dedupedKeepPoster[0]).toMatchObject({
      key: 'x:s2:movie:9',
      mergedCount: 2,
      imdbId: 'tt1375666',
      logo: 'http://iptv-b/9.jpg',
    });
  });
});
