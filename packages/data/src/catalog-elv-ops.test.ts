import { describe, expect, it, vi } from 'vitest';
import { createCatalogService } from './catalog';
import { openElvEnrichmentStore } from './elv-enrichment-repo';
import type { ElvMatchBatchRequestItem, ElvMetadataClient } from './elv-matcher';
import { openCatalog } from './migrate';
import { countingScheduler, memorySecrets, testDb } from './test-db';
import { createCoalescedCatalog } from './write-coalescer';

describe('CatalogService ELV Mode integration (#511)', () => {
  const noopHttp = {
    get: vi.fn(async () => {
      throw new Error('unexpected http call');
    }),
  };

  it('preserves 100% backward compatibility when enrichmentStore and elvClient are omitted', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    const svc = createCatalogService({
      db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: noopHttp,
      clock: () => 1_000,
    });

    expect((await svc.getElvEnrichmentForKeys?.(['x:s1:movie:1']))?.size).toBe(0);
    expect(await svc.getElvTitleDetail?.('tt1375666')).toBeNull();
    expect(await svc.listMergedVodVersions?.('x:s1:movie:1')).toEqual([]);
    expect(
      await svc.recordPlaybackQuality?.({ itemKey: 'x:s1:movie:1', actualHeight: 1080 }),
    ).toBeNull();
    expect(await svc.recordPlaybackVariantFailure?.('x:s1:movie:1')).toBeNull();
    expect(await svc.searchElvItemKeysByAlias?.('Inception')).toEqual([]);
    await expect(svc.wipeElvEnrichment?.()).resolves.toBeUndefined();
    await svc.close();
  });

  it('wires all ELV methods through CatalogService and createCoalescedCatalog and cleans up matches on removeSource', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    await db.batch(
      'INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES (?, ?, ?, ?, ?)',
      [
        ['s1', 'xtream', 'Source One', 1, '{}'],
        ['s2', 'xtream', 'Source Two', 2, '{}'],
      ],
    );
    await db.batch(
      `INSERT INTO movies (source_id, key, name, name_fold, year, provider_imdb_id, run_id)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [
        ['s1', 'x:s1:movie:1', 'Inception (2010) [4K]', 'inception 2010 4k', 2010, 'tt1375666'],
        ['s2', 'x:s2:movie:2', 'Başlangıç (2010) [1080p]', 'baslangic 2010 1080p', 2010, null],
      ],
    );
    await db.batch(
      `INSERT INTO live (source_id, key, name, name_fold, variant_base_fold, quality_rank, run_id)
       VALUES ('s1', ?, ?, ?, 'news one', ?, 1)`,
      [
        ['x:s1:live:4k', 'News One 4K', 'news one 4k', 40],
        ['x:s1:live:hd', 'News One HD', 'news one hd', 20],
      ],
    );
    await db.batch(
      `INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id)
       VALUES ('s1', 'live', ?, ?, 0, 1)`,
      [
        ['x:s1:live:4k', 'cat-4k'],
        ['x:s1:live:hd', 'cat-news'],
      ],
    );

    const enrichment = testDb();
    const enrichmentStore = await openElvEnrichmentStore(enrichment.db, { clock: () => 10_000 });
    const elvClient: ElvMetadataClient = {
      matchBatch: vi.fn(async (items: readonly ElvMatchBatchRequestItem[]) => ({
        matches: items.map((i) => ({
          key: i.key,
          imdbId: 'tt1375666',
          confidence: 0.94,
          mediaType: i.mediaType,
          title: {
            imdbId: 'tt1375666',
            mediaType: 'movie' as const,
            originalTitle: 'Inception',
            englishTitle: 'Inception',
            localizedTitles: { tr: 'Başlangıç' },
            year: 2010,
            rating: 8.8,
            posterUrl: 'https://m.media-amazon.com/images/M/p._V1_QL75_UX300_.jpg',
          },
        })),
        unmatchedKeys: [],
        pendingKeys: [],
      })),
      fetchTitleDetail: vi.fn(async (imdbId: string, lang?: string) => ({
        imdbId,
        mediaType: 'movie' as const,
        originalTitle: 'Inception',
        englishTitle: 'Inception',
        localizedTitles: lang === 'tr' ? { tr: 'Başlangıç' } : {},
        director: 'Christopher Nolan',
        synopses: { [lang ?? 'en']: 'Dream heist.' },
        detailFetchedAt: 10_000,
      })),
      fetchFeeds: vi.fn(async () => null),
      searchTitles: vi.fn(async () => []),
    };

    const rawSvc = createCatalogService({
      db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: noopHttp,
      clock: () => 10_000,
      enrichmentStore,
      elvClient,
    });
    const svc = createCoalescedCatalog(rawSvc, { windowMs: 0 });

    const prio = await svc.enrichElvPriorityKeys?.(['x:s1:movie:1', 'x:s2:movie:2'], {
      lang: 'tr',
    });
    expect(prio?.layer1Matched).toBe(1);
    expect(prio?.remoteMatched).toBe(1);

    const enrichMap = await svc.getElvEnrichmentForKeys?.(['x:s1:movie:1', 'x:s2:movie:2']);
    expect(enrichMap?.size).toBe(2);

    // First detail call fetches remotely & caches; second hits local elv-enrichment.db with 0 remote calls
    const detail1 = await svc.getElvTitleDetail?.('tt1375666', { lang: 'tr' });
    expect(detail1?.director).toBe('Christopher Nolan');
    expect(detail1?.synopses.tr).toBe('Dream heist.');
    const detail2 = await svc.getElvTitleDetail?.('tt1375666', { lang: 'tr' });
    expect(detail2?.director).toBe('Christopher Nolan');
    expect(elvClient.fetchTitleDetail).toHaveBeenCalledTimes(1);

    // Record fake-4K on s1 and real 1080p on s2 -> merged versions rank s2 above s1!
    await svc.recordPlaybackQuality?.({
      itemKey: 'x:s1:movie:1',
      actualWidth: 1280,
      actualHeight: 720,
      claimedLabel: '4K',
    });
    await svc.recordPlaybackQuality?.({
      itemKey: 'x:s2:movie:2',
      actualWidth: 1920,
      actualHeight: 1080,
      claimedLabel: '1080p',
    });
    const merged = await svc.listMergedVodVersions?.('x:s1:movie:1');
    expect(merged?.map((v) => v.itemKey)).toEqual(['x:s2:movie:2', 'x:s1:movie:1']);

    // Live TV cross-category variants with failure demotion
    await svc.recordPlaybackVariantFailure?.('x:s1:live:4k');
    await svc.recordPlaybackVariantFailure?.('x:s1:live:4k');
    const liveVars = await svc.listLiveVariants?.('x:s1:live:hd', 's1|live|cat-news', {
      crossCategory: true,
    });
    expect(liveVars?.map((v) => v.key)).toEqual(['x:s1:live:hd', 'x:s1:live:4k']);
    expect(liveVars?.[1]?.isUnreliable).toBe(true);

    // Manual Fix Match locks row
    await svc.setElvManualMatch?.('x:s2:movie:2', 's2', 'movie', 'tt0816692');
    expect((await enrichmentStore.getMatchForKey('x:s2:movie:2'))?.manualLock).toBe(true);

    // IMDb alias search is exposed via CatalogService & createCoalescedCatalog
    expect(await svc.searchElvItemKeysByAlias?.('Inception', { kind: 'movie' })).toEqual([
      'x:s1:movie:1',
    ]);
    expect(
      await svc.searchElvItemKeysByAlias?.('Inception', {
        kind: 'movie',
        excludedSourceIds: ['s1'],
      }),
    ).toEqual([]);

    // recordPlaybackQuality resolves raw catalog.db label even when PlayTarget.title was cleaned by ELV Mode!
    const fakeViaCleanedTitle = await svc.recordPlaybackQuality?.({
      itemKey: 'x:s1:movie:1',
      actualWidth: 1280,
      actualHeight: 720,
      claimedLabel: 'Inception',
    });
    expect(fakeViaCleanedTitle?.claimedLabel).toBe('Inception (2010) [4K]');
    expect(fakeViaCleanedTitle?.isFake4k).toBe(true);

    // Same raw 4K label with genuine cinema-scope 3840x1600 is NOT fake 4K!
    const realCinema4k = await svc.recordPlaybackQuality?.({
      itemKey: 'x:s1:movie:1',
      actualWidth: 3840,
      actualHeight: 1600,
      claimedLabel: 'Inception',
    });
    expect(realCinema4k?.isFake4k).toBe(false);

    // Live channel with omitted claimedLabel resolves raw `live.name` ("News One 4K") and detects fake 4K!
    const fakeLive4k = await svc.recordPlaybackQuality?.({
      itemKey: 'x:s1:live:4k',
      actualWidth: 1280,
      actualHeight: 720,
    });
    expect(fakeLive4k?.claimedLabel).toBe('News One 4K');
    expect(fakeLive4k?.isFake4k).toBe(true);

    // Series and movie version_label resolution when claimedLabel lacks a resolution tag
    await db.run(
      `INSERT INTO series (source_id, key, name, name_fold, year, run_id)
       VALUES ('s2', 'x:s2:series:uhd', 'Dark [UHD]', 'dark uhd', 2017, 1)`,
    );
    const fakeSeries4k = await svc.recordPlaybackQuality?.({
      itemKey: 'x:s2:series:uhd',
      actualWidth: 1280,
      actualHeight: 720,
      claimedLabel: 'Dark',
    });
    expect(fakeSeries4k?.claimedLabel).toBe('Dark [UHD]');
    expect(fakeSeries4k?.isFake4k).toBe(true);

    await db.run(
      `INSERT INTO movies (source_id, key, name, name_fold, year, version_label, run_id)
       VALUES ('s2', 'x:s2:movie:vlabel', 'Interstellar (2014)', 'interstellar 2014', 2014, '4K', 1)`,
    );
    const fakeViaVersionLabel = await svc.recordPlaybackQuality?.({
      itemKey: 'x:s2:movie:vlabel',
      actualWidth: 1920,
      actualHeight: 1080,
      claimedLabel: 'Interstellar',
    });
    expect(fakeViaVersionLabel?.claimedLabel).toBe('Interstellar (2014) [4K]');
    expect(fakeViaVersionLabel?.isFake4k).toBe(true);

    // findGuideChannelByCleanName forwards excludedSourceIds through CatalogService & createCoalescedCatalog
    await db.batch(
      `INSERT INTO guide_channels (source_id, guide_id, name, name_fold, run_id)
       VALUES (?, ?, ?, ?, 1)`,
      [['s2', 'news1.s2', 'News One HD', 'news one hd']],
    );
    expect(
      await svc.findGuideChannelByCleanName?.('s1', 'TR: News One FHD', {
        crossSource: true,
        excludedSourceIds: ['s2'],
      }),
    ).toBeNull();
    expect(
      await svc.findGuideChannelByCleanName?.('s1', 'TR: News One FHD', {
        crossSource: true,
      }),
    ).toMatchObject({ sourceId: 's2', guideId: 'news1.s2' });

    // Background matcher runs cleanly
    const bg = await svc.runElvBackgroundMatching?.({ lang: 'tr' });
    expect(bg?.aborted).toBe(false);

    // removeSource cleans up s1 matches AND s1 quality memory (both matched movie and unmatched live) automatically
    const removed = await svc.removeSource('s1');
    expect(removed.ok).toBe(true);
    expect(await enrichmentStore.getMatchForKey('x:s1:movie:1')).toBeNull();
    expect(await enrichmentStore.getQualityMemory('x:s1:movie:1')).toBeNull();
    expect(await enrichmentStore.getQualityMemory('x:s1:live:4k')).toBeNull();
    expect(await enrichmentStore.getMatchForKey('x:s2:movie:2')).not.toBeNull();
    expect(await enrichmentStore.getQualityMemory('x:s2:movie:2')).not.toBeNull();

    // wipeElvEnrichment clears all ELV data cleanly
    await svc.wipeElvEnrichment?.();
    expect(await enrichmentStore.getMatchForKey('x:s2:movie:2')).toBeNull();

    await svc.close();
    await enrichmentStore.close();
  });

  it('runs offline Layer 1 matching when elvClient is initially undefined and dynamically activates remote ELV calls via setElvClient', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    await db.batch(
      'INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES (?, ?, ?, ?, ?)',
      [
        ['s1', 'xtream', 'Alpha', 1, '{}'],
        ['s2', 'xtream', 'Beta', 2, '{}'],
      ],
    );
    await db.batch(
      `INSERT INTO movies (source_id, key, name, name_fold, year, provider_imdb_id, run_id)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [
        ['s1', 'x:s1:movie:1', 'Inception (2010) [4K]', 'inception 2010 4k', 2010, 'tt1375666'],
        ['s2', 'x:s2:movie:2', 'TR: Inception (2010) [FHD]', 'tr inception 2010 fhd', 2010, null],
      ],
    );

    const enrichment = testDb();
    const enrichmentStore = await openElvEnrichmentStore(enrichment.db, { clock: () => 20_000 });
    const rawSvc = createCatalogService({
      db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: noopHttp,
      clock: () => 20_000,
      enrichmentStore,
    });
    const svc = createCoalescedCatalog(rawSvc, { windowMs: 0 });

    // Offline Layer 1 still matches x:s1:movie:1 via provider_imdb_id even without elvClient
    const prioOffline = await svc.enrichElvPriorityKeys?.(['x:s1:movie:1', 'x:s2:movie:2']);
    expect(prioOffline?.layer1Matched).toBe(1);
    expect(prioOffline?.remoteMatched).toBe(0);
    expect((await enrichmentStore.getMatchForKey('x:s1:movie:1'))?.imdbId).toBe('tt1375666');

    // Offline multi-source version merge combines s1 + s2 without needing remote matches!
    const offlineMerged = await svc.listMergedVodVersions?.('x:s1:movie:1');
    expect(offlineMerged?.map((v) => v.itemKey)).toEqual(['x:s1:movie:1', 'x:s2:movie:2']);

    // Remote detail/feeds fail closed offline
    expect(await svc.refreshElvFeeds?.()).toBe(false);

    // Dynamically configure elvClient via setElvClient -> immediately enables remote matching & discovery
    const elvClient: ElvMetadataClient = {
      matchBatch: vi.fn(async (items: readonly ElvMatchBatchRequestItem[]) => ({
        matches: items.map((item) => ({
          key: item.key,
          imdbId: 'tt1375666',
          confidence: 0.95,
          mediaType: item.mediaType,
          title: {
            imdbId: 'tt1375666',
            tmdbId: '27205',
            mediaType: 'movie' as const,
            originalTitle: 'Inception',
            year: 2010,
          },
        })),
        unmatchedKeys: [],
        pendingKeys: [],
      })),
      fetchTitleDetail: vi.fn(async () => ({
        imdbId: 'tt1375666',
        tmdbId: '27205',
        mediaType: 'movie' as const,
        originalTitle: 'Inception',
        director: 'Christopher Nolan',
        detailFetchedAt: 20_000,
      })),
      fetchFeeds: vi.fn(async () => ({
        topPicks: [
          { imdbId: 'tt1375666', title: 'Inception', mediaType: 'movie' as const, rank: 1 },
        ],
        movieMeter: [],
        tvMeter: [],
        currentUpcomingTv: [],
        updatedAt: 20_000,
      })),
      searchTitles: vi.fn(async () => []),
    };

    svc.setElvClient?.(elvClient);
    const bgOnline = await svc.runElvBackgroundMatching?.();
    expect(bgOnline?.remoteMatched).toBe(1);
    expect(await svc.refreshElvFeeds?.()).toBe(true);
    const detail = await svc.getElvTitleDetail?.('tt1375666');
    expect(detail?.tmdbId).toBe('27205');
    expect(detail?.director).toBe('Christopher Nolan');

    await svc.close();
    await enrichmentStore.close();
  });
});
