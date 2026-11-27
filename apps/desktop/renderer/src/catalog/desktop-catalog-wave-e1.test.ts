import type {
  CleanNameGuideMatch,
  ElvItemEnrichment,
  ElvMatchingSummary,
  ElvQualityMemoryRecord,
  ElvTitleRecord,
  LiveVariantOption,
  MergedVodVariant,
} from '@elv/data';
import { ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import type { CatalogBridge } from '../../../src/shared/catalog-ipc.ts';
import { createDesktopCatalogFromBridge } from './index.ts';

function makeMinimalBridge(overrides?: Partial<CatalogBridge>): CatalogBridge {
  const base: CatalogBridge = {
    open: async () => ok(undefined),
    addSource: async () => {
      throw new Error('unused');
    },
    addSourceFromLink: async () => {
      throw new Error('unused');
    },
    removeSource: async () => ok(undefined),
    startImport: () => ({ reqId: 1, result: Promise.reject(new Error('unused')) }),
    cancelImport: () => undefined,
    importGuide: async () => {
      throw new Error('unused');
    },
    listSources: async () => [],
    categories: async () => [],
    items: async () => [],
    itemDetail: async () => null,
    search: async () => ({ live: [], epg: [], movies: [], series: [], episodes: [] }),
    nowNext: async () => [],
    epgWindow: async () => ({}),
    channelByNumber: async () => null,
    seasons: async () => ok([]),
    episodes: async () => [],
    queryNextEpisode: async () => null,
    resolveStream: async () => ok({ url: 'http://127.0.0.1/1.ts', headers: {} }),
    saveProgress: async () => {
      throw new Error('unused');
    },
    setWatched: async () => ok(undefined),
    getProgress: async () => null,
    listContinueWatching: async () => [],
    listProgressByKeys: async () => [],
    clearProgress: async () => ok(undefined),
    toggleFavorite: async () => ok(true),
    setFavorite: async (_i, active) => ok(active),
    listFavorites: async () => [],
    listFavoriteKeys: async () => [],
    onChanged: () => () => undefined,
    onDisconnected: () => () => undefined,
    close: async () => undefined,
  };
  return { ...base, ...overrides };
}

describe('desktop CatalogService Wave E1 ELV bridge adapter (#511)', () => {
  it('forwards all Wave E1 ELV methods, reconstructs Map from Record, and strips non-serializable options', async () => {
    const enrichment: ElvItemEnrichment = {
      itemKey: 'm:s1:movie:1',
      sourceId: 's1',
      mediaType: 'movie',
      imdbId: 'tt1375666',
      confidence: 0.95,
      manualLock: false,
      title: null,
    };
    const titleDetail: ElvTitleRecord = {
      imdbId: 'tt1375666',
      tmdbId: '27205',
      mediaType: 'movie',
      originalTitle: 'Inception',
      englishTitle: 'Inception',
      localizedTitles: {},
      year: 2010,
      rating: 8.8,
      votes: 2_000_000,
      runtimeMin: 148,
      genres: ['Sci-Fi'],
      posterUrl: 'https://cdn.example/tt1375666.jpg',
      backdropUrl: null,
      trailerStreamUrl: null,
      trailerYoutubeId: null,
      director: 'Christopher Nolan',
      cast: [],
      mltImdbIds: [],
      franchiseKey: null,
      franchiseName: null,
      franchiseOrder: null,
      synopses: { en: 'Dream heist.' },
      detailFetchedAt: 100,
      updatedAt: 100,
    };
    const merged: MergedVodVariant[] = [
      {
        itemKey: 'm:s1:movie:1',
        sourceId: 's1',
        sourceName: 'Main',
        rawTitle: 'Inception 4K',
        versionLabel: '4K',
        verifiedResolution: '4K',
        actualVideoCodec: 'hevc',
        actualAudioCodec: 'eac3',
        isFake4k: false,
        failCount: 0,
        qualityRank: 40,
        score: 1005,
      },
    ];
    const summary: ElvMatchingSummary = {
      scanned: 1,
      layer1Matched: 0,
      remoteMatched: 1,
      skipped: 0,
      aborted: false,
    };
    const quality: ElvQualityMemoryRecord = {
      itemKey: 'm:s1:movie:1',
      actualWidth: 3840,
      actualHeight: 2160,
      actualVideoCodec: 'hevc',
      actualAudioCodec: 'eac3',
      actualAudioChannels: 6,
      actualHdr: 'hdr10',
      claimedLabel: '4K',
      isFake4k: false,
      failCount: 0,
      lastSuccessAt: 100,
      lastFailAt: null,
      updatedAt: 100,
    };
    const liveVariant: LiveVariantOption = {
      key: 'm:s1:live:1',
      title: 'News One 4K',
      qualityLabel: '4K',
      qualityRank: 40,
    };
    const guideMatch: CleanNameGuideMatch = {
      sourceId: 's1',
      guideId: 'news.one',
      guideName: 'News One',
      matchedBy: 'clean-name',
    };

    const seen: Record<string, unknown[][]> = {};
    const record =
      <T>(name: string, value: T) =>
      async (...args: unknown[]): Promise<T> => {
        const list = seen[name] ?? [];
        list.push(args);
        seen[name] = list;
        return value;
      };

    const bridge = makeMinimalBridge({
      getElvEnrichmentForKeys: record('getElvEnrichmentForKeys', { 'm:s1:movie:1': enrichment }),
      getElvTitleDetail: record('getElvTitleDetail', titleDetail),
      listMergedVodVersions: record('listMergedVodVersions', merged),
      enrichElvPriorityKeys: record('enrichElvPriorityKeys', summary),
      runElvBackgroundMatching: record('runElvBackgroundMatching', summary),
      recordPlaybackQuality: record('recordPlaybackQuality', quality),
      recordPlaybackVariantFailure: record('recordPlaybackVariantFailure', {
        ...quality,
        failCount: 1,
      }),
      setElvManualMatch: record('setElvManualMatch', undefined),
      wipeElvEnrichment: record('wipeElvEnrichment', undefined),
      searchElvItemKeysByAlias: record('searchElvItemKeysByAlias', ['m:s1:movie:1']),
      liveVariants: record('liveVariants', [liveVariant]),
      listLiveVariants: record('listLiveVariants', [liveVariant]),
      findGuideChannelByCleanName: record('findGuideChannelByCleanName', guideMatch),
    });

    const service = createDesktopCatalogFromBridge(bridge);
    const ctl = new AbortController();

    const enrichMap = await service.getElvEnrichmentForKeys?.(['m:s1:movie:1']);
    expect(enrichMap).toBeInstanceOf(Map);
    expect(enrichMap?.get('m:s1:movie:1')).toEqual(enrichment);

    expect(
      await service.getElvTitleDetail?.('tt1375666', {
        lang: 'tr',
        forceRefresh: true,
        signal: ctl.signal,
      }),
    ).toEqual(titleDetail);
    expect(seen['getElvTitleDetail']).toEqual([['tt1375666', { lang: 'tr', forceRefresh: true }]]);

    expect(await service.listMergedVodVersions?.('m:s1:movie:1', { profileId: 'p_main' })).toEqual(
      merged,
    );

    expect(
      await service.enrichElvPriorityKeys?.(['m:s1:movie:1'], { lang: 'tr', signal: ctl.signal }),
    ).toEqual(summary);
    expect(seen['enrichElvPriorityKeys']).toEqual([[['m:s1:movie:1'], { lang: 'tr' }]]);

    expect(
      await service.runElvBackgroundMatching?.({
        lang: 'en',
        batchSize: 100,
        signal: ctl.signal,
        onProgress: () => undefined,
      }),
    ).toEqual(summary);
    expect(seen['runElvBackgroundMatching']).toEqual([[{ lang: 'en', batchSize: 100 }]]);

    expect(
      await service.recordPlaybackQuality?.({
        itemKey: 'm:s1:movie:1',
        actualWidth: 3840,
        actualHeight: 2160,
      }),
    ).toEqual(quality);
    expect(await service.recordPlaybackVariantFailure?.('m:s1:movie:1')).toMatchObject({
      failCount: 1,
    });
    await service.setElvManualMatch?.('m:s1:movie:1', 's1', 'movie', 'tt1375666');
    await service.wipeElvEnrichment?.();

    expect(
      await service.searchElvItemKeysByAlias?.('Money\tHeist\n', {
        kind: 'series',
        limit: 40,
        excludedSourceIds: ['s2'],
      }),
    ).toEqual(['m:s1:movie:1']);
    expect(seen['searchElvItemKeysByAlias']).toEqual([
      ['Money Heist', { kind: 'series', limit: 40, excludedSourceIds: ['s2'] }],
    ]);

    expect(
      await service.listLiveVariants?.('m:s1:live:1', 's1|live|1', {
        profileId: 'p_main',
        crossCategory: true,
        crossSource: true,
        qualityByKey: new Map(),
      }),
    ).toEqual([liveVariant]);
    expect(seen['listLiveVariants']).toEqual([
      ['m:s1:live:1', 's1|live|1', { profileId: 'p_main', crossCategory: true, crossSource: true }],
    ]);

    expect(
      await service.findGuideChannelByCleanName?.('s1', 'News\tOne\n4K', {
        crossSource: true,
        excludedSourceIds: ['s_blocked'],
      }),
    ).toEqual(guideMatch);
    expect(seen['findGuideChannelByCleanName']).toEqual([
      ['s1', 'News One 4K', { crossSource: true, excludedSourceIds: ['s_blocked'] }],
    ]);

    // Pre-aborted signal returns aborted summary immediately without invoking bridge
    ctl.abort();
    expect(await service.enrichElvPriorityKeys?.(['m:s1:movie:1'], { signal: ctl.signal })).toEqual(
      {
        scanned: 0,
        layer1Matched: 0,
        remoteMatched: 0,
        skipped: 0,
        aborted: true,
      },
    );
    expect(await service.runElvBackgroundMatching?.({ signal: ctl.signal })).toEqual({
      scanned: 0,
      layer1Matched: 0,
      remoteMatched: 0,
      skipped: 0,
      aborted: true,
    });
    expect(seen['enrichElvPriorityKeys']).toHaveLength(1);
    expect(seen['runElvBackgroundMatching']).toHaveLength(1);
  });

  it('chunks getElvEnrichmentForKeys batches larger than 500 keys and merges all results into one Map', async () => {
    const batchSizes: number[] = [];
    const bridge = makeMinimalBridge({
      getElvEnrichmentForKeys: async (keys) => {
        batchSizes.push(keys.length);
        const out: Record<string, ElvItemEnrichment> = {};
        for (const key of keys) {
          out[key] = {
            itemKey: key,
            sourceId: 's1',
            mediaType: 'movie',
            imdbId: 'tt1375666',
            confidence: 0.9,
            manualLock: false,
            title: null,
          };
        }
        return out;
      },
    });
    const service = createDesktopCatalogFromBridge(bridge);
    const keys = Array.from({ length: 1_120 }, (_, i) => `m:s1:movie:${i}`);
    const merged = await service.getElvEnrichmentForKeys?.(keys);

    expect(batchSizes).toEqual([500, 500, 120]);
    expect(merged?.size).toBe(1_120);
    expect(merged?.get('m:s1:movie:0')?.imdbId).toBe('tt1375666');
    expect(merged?.get('m:s1:movie:500')?.imdbId).toBe('tt1375666');
    expect(merged?.get('m:s1:movie:1119')?.imdbId).toBe('tt1375666');

    const empty = await service.getElvEnrichmentForKeys?.([]);
    expect(empty?.size).toBe(0);
    expect(batchSizes).toHaveLength(3);
  });

  it('sanitizes control characters and truncates claimedLabel to <= 128 chars before recordPlaybackQuality IPC', async () => {
    const sentInputs: unknown[] = [];
    const bridge = makeMinimalBridge({
      recordPlaybackQuality: async (input) => {
        sentInputs.push(input);
        return null;
      },
    });
    const service = createDesktopCatalogFromBridge(bridge);
    const longClaimed = `4K\tUHD\n${'A'.repeat(180)}`;
    await service.recordPlaybackQuality?.({
      itemKey: 'm:src1:live:t:cnn.us@hd',
      actualWidth: 1920,
      actualHeight: 1080,
      claimedLabel: longClaimed,
    });

    expect(sentInputs).toHaveLength(1);
    const sent = sentInputs[0] as { claimedLabel?: string };
    expect(typeof sent.claimedLabel).toBe('string');
    expect(sent.claimedLabel?.length).toBeLessThanOrEqual(128);
    expect(
      Array.from(sent.claimedLabel ?? '').some((ch) => {
        const code = ch.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      }),
    ).toBe(false);
    expect(sent.claimedLabel?.startsWith('4K UHD ')).toBe(true);
  });

  it('falls back safely when legacy bridge omits optional Wave E1 methods', async () => {
    const legacy = createDesktopCatalogFromBridge(makeMinimalBridge());
    expect(await legacy.getElvEnrichmentForKeys?.(['m:s1:movie:1'])).toEqual(new Map());
    expect(await legacy.getElvTitleDetail?.('tt1375666')).toBeNull();
    expect(await legacy.listMergedVodVersions?.('m:s1:movie:1')).toEqual([]);
    expect(await legacy.enrichElvPriorityKeys?.(['m:s1:movie:1'])).toEqual({
      scanned: 0,
      layer1Matched: 0,
      remoteMatched: 0,
      skipped: 0,
      aborted: false,
    });
    expect(await legacy.runElvBackgroundMatching?.()).toEqual({
      scanned: 0,
      layer1Matched: 0,
      remoteMatched: 0,
      skipped: 0,
      aborted: false,
    });
    expect(await legacy.recordPlaybackQuality?.({ itemKey: 'm:s1:movie:1' })).toBeNull();
    expect(await legacy.recordPlaybackVariantFailure?.('m:s1:movie:1')).toBeNull();
    await expect(
      legacy.setElvManualMatch?.('m:s1:movie:1', 's1', 'movie', 'tt1375666'),
    ).resolves.toBeUndefined();
    await expect(legacy.wipeElvEnrichment?.()).resolves.toBeUndefined();
    expect(await legacy.searchElvItemKeysByAlias?.('Inception')).toEqual([]);
    expect(await legacy.listLiveVariants?.('m:s1:live:1')).toEqual([]);
    expect(await legacy.findGuideChannelByCleanName?.('s1', 'News One')).toBeNull();
  });

  it('preserves optional ItemRow.backdrop and ElvTitleRecord.tmdbId across bridge delegation', async () => {
    const sampleItem = {
      id: 1,
      key: 'x:s1:movie:1',
      kind: 'movie' as const,
      sourceId: 's1',
      providerId: '1',
      name: 'Inception (2010)',
      logo: 'https://cdn.example/p.jpg',
      backdrop: 'https://cdn.example/b.jpg',
      rating: 8.8,
      year: 2010,
      num: null,
    };
    const bridge = makeMinimalBridge({
      items: async () => [sampleItem],
      itemDetail: async () => ({
        ...sampleItem,
        plot: 'Dream heist.',
        cast: null,
        director: null,
        genre: 'Sci-Fi',
        trailerYoutubeId: null,
        durationSec: null,
        extension: 'mp4',
      }),
    });
    const service = createDesktopCatalogFromBridge(bridge);
    const items = await service.items('s1|movie|1', 0, 10);
    expect(items[0]?.backdrop).toBe('https://cdn.example/b.jpg');
    const detail = await service.itemDetail?.('x:s1:movie:1');
    expect(detail?.backdrop).toBe('https://cdn.example/b.jpg');
  });
});
