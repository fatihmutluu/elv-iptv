import type { CatalogService } from '@elv/data';
import { ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { createLazyCatalog } from './lazy-catalog';

describe('createLazyCatalog Wave E1 ELV Mode forwarding (#511)', () => {
  it('forwards all 11 Wave E1 ELV Mode methods when implemented and falls back cleanly when omitted', async () => {
    const getElvEnrichmentForKeys = vi.fn(async () => new Map());
    const getElvTitleDetail = vi.fn(async () => null);
    const listMergedVodVersions = vi.fn(async () => []);
    const enrichElvPriorityKeys = vi.fn(async () => ({
      scanned: 1,
      layer1Matched: 1,
      remoteMatched: 0,
      skipped: 0,
      aborted: false,
    }));
    const runElvBackgroundMatching = vi.fn(async () => ({
      scanned: 2,
      layer1Matched: 1,
      remoteMatched: 1,
      skipped: 0,
      aborted: false,
    }));
    const recordPlaybackQuality = vi.fn(async () => null);
    const recordPlaybackVariantFailure = vi.fn(async () => null);
    const setElvManualMatch = vi.fn(async () => undefined);
    const wipeElvEnrichment = vi.fn(async () => undefined);
    const searchElvItemKeysByAlias = vi.fn(async () => ['k:1']);
    const listLiveVariants = vi.fn(async () => []);
    const findGuideChannelByCleanName = vi.fn(async () => null);

    const full = {
      addSource: vi.fn(),
      addSourceFromLink: vi.fn(),
      removeSource: vi.fn(),
      importSource: vi.fn(),
      listSources: vi.fn(async () => []),
      categories: vi.fn(async () => []),
      items: vi.fn(async () => []),
      seasons: vi.fn(async () => ok([])),
      episodes: vi.fn(async () => []),
      resolveStream: vi.fn(),
      close: vi.fn(async () => undefined),
      getElvEnrichmentForKeys,
      getElvTitleDetail,
      listMergedVodVersions,
      enrichElvPriorityKeys,
      runElvBackgroundMatching,
      recordPlaybackQuality,
      recordPlaybackVariantFailure,
      setElvManualMatch,
      wipeElvEnrichment,
      searchElvItemKeysByAlias,
      listLiveVariants,
      findGuideChannelByCleanName,
    } as unknown as CatalogService;

    const lazyFull = createLazyCatalog(async () => full);
    await lazyFull.getElvEnrichmentForKeys?.(['k:1']);
    await lazyFull.getElvTitleDetail?.('tt1375666', { lang: 'tr' });
    await lazyFull.listMergedVodVersions?.('k:1');
    await lazyFull.enrichElvPriorityKeys?.(['k:1'], { lang: 'tr' });
    await lazyFull.runElvBackgroundMatching?.({ lang: 'tr' });
    await lazyFull.recordPlaybackQuality?.({
      itemKey: 'k:1',
      actualWidth: 1920,
      actualHeight: 1080,
    });
    await lazyFull.recordPlaybackVariantFailure?.('k:1');
    await lazyFull.setElvManualMatch?.('k:1', 's1', 'movie', 'tt1375666');
    await lazyFull.wipeElvEnrichment?.();
    await lazyFull.searchElvItemKeysByAlias?.('Money Heist', { kind: 'series', limit: 40 });
    await lazyFull.listLiveVariants?.('k:live', undefined, { crossCategory: true });
    await lazyFull.findGuideChannelByCleanName?.('s1', 'CNN');

    expect(getElvEnrichmentForKeys).toHaveBeenCalledWith(['k:1']);
    expect(getElvTitleDetail).toHaveBeenCalledWith('tt1375666', { lang: 'tr' });
    expect(listMergedVodVersions).toHaveBeenCalledWith('k:1', undefined);
    expect(enrichElvPriorityKeys).toHaveBeenCalledWith(['k:1'], { lang: 'tr' });
    expect(runElvBackgroundMatching).toHaveBeenCalledWith({ lang: 'tr' });
    expect(recordPlaybackQuality).toHaveBeenCalled();
    expect(recordPlaybackVariantFailure).toHaveBeenCalledWith('k:1');
    expect(setElvManualMatch).toHaveBeenCalledWith('k:1', 's1', 'movie', 'tt1375666');
    expect(wipeElvEnrichment).toHaveBeenCalled();
    expect(searchElvItemKeysByAlias).toHaveBeenCalledWith('Money Heist', {
      kind: 'series',
      limit: 40,
    });
    expect(listLiveVariants).toHaveBeenCalledWith('k:live', undefined, { crossCategory: true });
    expect(findGuideChannelByCleanName).toHaveBeenCalledWith('s1', 'CNN', undefined);

    const minimal = {
      addSource: vi.fn(),
      addSourceFromLink: vi.fn(),
      removeSource: vi.fn(),
      importSource: vi.fn(),
      listSources: vi.fn(async () => []),
      categories: vi.fn(async () => []),
      items: vi.fn(async () => []),
      seasons: vi.fn(async () => ok([])),
      episodes: vi.fn(async () => []),
      resolveStream: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as CatalogService;

    const lazyMin = createLazyCatalog(async () => minimal);
    expect((await lazyMin.getElvEnrichmentForKeys?.(['k:1']))?.size).toBe(0);
    expect(await lazyMin.getElvTitleDetail?.('tt1375666')).toBeNull();
    expect(await lazyMin.listMergedVodVersions?.('k:1')).toEqual([]);
    expect(await lazyMin.enrichElvPriorityKeys?.(['k:1'])).toEqual({
      scanned: 0,
      layer1Matched: 0,
      remoteMatched: 0,
      skipped: 0,
      aborted: false,
    });
    expect(await lazyMin.runElvBackgroundMatching?.()).toEqual({
      scanned: 0,
      layer1Matched: 0,
      remoteMatched: 0,
      skipped: 0,
      aborted: false,
    });
    expect(await lazyMin.recordPlaybackQuality?.({ itemKey: 'k:1' })).toBeNull();
    expect(await lazyMin.recordPlaybackVariantFailure?.('k:1')).toBeNull();
    await expect(
      lazyMin.setElvManualMatch?.('k:1', 's1', 'movie', 'tt1375666'),
    ).resolves.toBeUndefined();
    await expect(lazyMin.wipeElvEnrichment?.()).resolves.toBeUndefined();
    expect(await lazyMin.searchElvItemKeysByAlias?.('Money Heist')).toEqual([]);
    expect(await lazyMin.listLiveVariants?.('k:live')).toEqual([]);
    expect(await lazyMin.findGuideChannelByCleanName?.('s1', 'CNN')).toBeNull();
  });
});
