import { describe, expect, it } from 'vitest';
import { isCatalogClientMessage } from './catalog-ipc.ts';

const call = (c: unknown) => ({ type: 'call', reqId: 1, call: c });

describe('Wave E1 ELV Mode catalog IPC guards (#511)', () => {
  it('accepts all valid Wave E1 ELV RPC calls and extended liveVariants options', () => {
    const validCalls: unknown[] = [
      { method: 'getElvEnrichmentForKeys', itemKeys: [] },
      { method: 'getElvEnrichmentForKeys', itemKeys: ['x:s1:movie:1', 'x:s1:series:2'] },
      {
        method: 'getElvEnrichmentForKeys',
        itemKeys: ['m:src1:live:t:cnn.us@hd', 'm:src1:live:t:chan?hd=1', 'a'.repeat(256)],
      },
      { method: 'getElvTitleDetail', imdbId: 'tt1375666' },
      {
        method: 'getElvTitleDetail',
        imdbId: 'tt0133093',
        opts: { lang: 'tr', forceRefresh: true },
      },
      { method: 'getElvTitleDetail', imdbId: 'tt0133093', opts: { lang: 'en-US' } },
      { method: 'listMergedVodVersions', itemKey: 'x:s1:movie:101' },
      {
        method: 'listMergedVodVersions',
        itemKey: 'x:s1:movie:101',
        opts: { profileId: 'p_main', parentalUnlocked: false },
      },
      { method: 'enrichElvPriorityKeys', itemKeys: ['x:s1:movie:1'] },
      {
        method: 'enrichElvPriorityKeys',
        itemKeys: ['x:s1:movie:1', 'x:s1:series:2'],
        opts: { lang: 'tr' },
      },
      { method: 'runElvBackgroundMatching' },
      { method: 'runElvBackgroundMatching', opts: { lang: 'en', batchSize: 250 } },
      {
        method: 'recordPlaybackQuality',
        input: {
          itemKey: 'x:s1:movie:101',
          actualWidth: 3840,
          actualHeight: 2160,
          actualVideoCodec: 'hevc',
          actualAudioCodec: 'eac3',
          actualAudioChannels: 6,
          actualHdr: 'hdr10',
          claimedLabel: '4K UHD',
          nowMs: 1_700_000_000_000,
        },
      },
      {
        method: 'recordPlaybackQuality',
        input: {
          itemKey: 'x:s1:movie:102',
          actualWidth: null,
          actualHeight: null,
          actualVideoCodec: null,
          actualAudioCodec: null,
          actualAudioChannels: null,
          actualHdr: null,
          claimedLabel: null,
        },
      },
      { method: 'recordPlaybackVariantFailure', itemKey: 'x:s1:live:50' },
      {
        method: 'setElvManualMatch',
        itemKey: 'x:s1:movie:101',
        sourceId: 'src_1',
        mediaType: 'movie',
        imdbId: 'tt1375666',
      },
      {
        method: 'setElvManualMatch',
        itemKey: 'x:s1:series:55',
        sourceId: 'src_1',
        mediaType: 'series',
        imdbId: 'tt0903747',
      },
      { method: 'wipeElvEnrichment' },
      { method: 'searchElvItemKeysByAlias', query: 'Money Heist' },
      {
        method: 'searchElvItemKeysByAlias',
        query: 'Başlangıç',
        opts: { kind: 'movie', limit: 40, excludedSourceIds: ['src_hidden'] },
      },
      {
        method: 'recordPlaybackVariantFailure',
        itemKey: 'm:src1:live:t:cnn.us@hd',
      },
      {
        method: 'recordPlaybackQuality',
        input: { itemKey: 'm:src1:live:t:espn@us?hd', actualWidth: 1920, actualHeight: 1080 },
      },
      {
        method: 'liveVariants',
        itemKey: 'x:s1:live:10',
        categoryId: 's1|live|1',
        opts: {
          profileId: 'p_main',
          parentalUnlocked: true,
          crossCategory: true,
          crossSource: true,
        },
      },
      {
        method: 'listLiveVariants',
        itemKey: 'm:src1:live:t:cnn.us@hd',
        opts: { crossCategory: true, crossSource: false },
      },
      {
        method: 'findGuideChannelByCleanName',
        sourceId: 'src_1',
        channelName: 'TR: National News 4K HEVC',
      },
      {
        method: 'findGuideChannelByCleanName',
        sourceId: 'src_1',
        channelName: 'Sports One +1',
        opts: { crossSource: true, excludedSourceIds: ['src_2', 'src_3'] },
      },
    ];

    for (const c of validCalls) {
      expect(isCatalogClientMessage(call(c))).toBe(true);
    }
  });

  it('rejects malformed payloads, invalid IMDb IDs, non-serializable options, extra keys, and prototype pollution', () => {
    const invalidCalls: unknown[] = [
      { method: 'getElvEnrichmentForKeys', itemKeys: 'not-array' },
      { method: 'getElvEnrichmentForKeys', itemKeys: ['http://evil.invalid/1'] },
      { method: 'getElvEnrichmentForKeys', itemKeys: ['m:src1:live:t:cnn us'] },
      { method: 'getElvEnrichmentForKeys', itemKeys: ['m:src1:live:t:cnn\tus'] },
      { method: 'getElvEnrichmentForKeys', itemKeys: ['a'.repeat(257)] },
      {
        method: 'getElvEnrichmentForKeys',
        itemKeys: Array.from({ length: 501 }, (_, i) => `x:s1:movie:${i}`),
      },
      { method: 'getElvEnrichmentForKeys', itemKeys: [], extra: 1 },
      { method: 'getElvTitleDetail', imdbId: '' },
      { method: 'getElvTitleDetail', imdbId: '1375666' },
      { method: 'getElvTitleDetail', imdbId: 'tt123' },
      { method: 'getElvTitleDetail', imdbId: 'tt1375666', opts: { lang: 'en; DROP TABLE' } },
      { method: 'getElvTitleDetail', imdbId: 'tt1375666', opts: { forceRefresh: 'yes' } },
      { method: 'getElvTitleDetail', imdbId: 'tt1375666', opts: { signal: {} } },
      { method: 'listMergedVodVersions', itemKey: '' },
      { method: 'listMergedVodVersions', itemKey: 'http://bad.invalid/k' },
      { method: 'listMergedVodVersions', itemKey: 'x:s1:movie:1', opts: { extra: true } },
      {
        method: 'enrichElvPriorityKeys',
        itemKeys: Array.from({ length: 201 }, (_, i) => `x:s1:movie:${i}`),
      },
      { method: 'enrichElvPriorityKeys', itemKeys: ['x:s1:movie:1'], opts: { signal: {} } },
      { method: 'runElvBackgroundMatching', opts: { batchSize: 0 } },
      { method: 'runElvBackgroundMatching', opts: { batchSize: 501 } },
      { method: 'runElvBackgroundMatching', opts: { batchSize: 10.5 } },
      { method: 'runElvBackgroundMatching', opts: { onProgress: () => undefined } },
      { method: 'runElvBackgroundMatching', opts: { signal: {} } },
      { method: 'recordPlaybackQuality', input: null },
      { method: 'recordPlaybackQuality', input: { itemKey: '' } },
      {
        method: 'recordPlaybackQuality',
        input: { itemKey: 'x:s1:movie:1', actualWidth: -10 },
      },
      {
        method: 'recordPlaybackQuality',
        input: { itemKey: 'x:s1:movie:1', actualAudioChannels: 100 },
      },
      {
        method: 'recordPlaybackQuality',
        input: { itemKey: 'x:s1:movie:1', actualVideoCodec: 'bad\ncodec' },
      },
      {
        method: 'recordPlaybackQuality',
        input: { itemKey: 'x:s1:movie:1', claimedLabel: 'x'.repeat(129) },
      },
      {
        method: 'recordPlaybackQuality',
        input: { itemKey: 'x:s1:movie:1', extra: 1 },
      },
      { method: 'recordPlaybackVariantFailure', itemKey: '' },
      { method: 'recordPlaybackVariantFailure', itemKey: 'bad\nkey' },
      { method: 'recordPlaybackVariantFailure', itemKey: 'm:s1:live:has space' },
      { method: 'recordPlaybackVariantFailure', itemKey: 'm:s1:live:{{template}}' },
      { method: 'recordPlaybackVariantFailure', itemKey: 'k'.repeat(257) },
      {
        method: 'setElvManualMatch',
        itemKey: 'x:s1:movie:1',
        sourceId: 's1',
        mediaType: 'live',
        imdbId: 'tt1375666',
      },
      {
        method: 'setElvManualMatch',
        itemKey: 'x:s1:movie:1',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'invalid',
      },
      {
        method: 'setElvManualMatch',
        itemKey: 'x:s1:movie:1',
        sourceId: '',
        mediaType: 'movie',
        imdbId: 'tt1375666',
      },
      { method: 'wipeElvEnrichment', extra: true },
      { method: 'searchElvItemKeysByAlias', query: 'bad\nquery' },
      { method: 'searchElvItemKeysByAlias', query: 'q'.repeat(257) },
      { method: 'searchElvItemKeysByAlias', query: 'Inception', opts: { kind: 'live' } },
      { method: 'searchElvItemKeysByAlias', query: 'Inception', opts: { limit: -1 } },
      { method: 'searchElvItemKeysByAlias', query: 'Inception', opts: { limit: 101 } },
      { method: 'searchElvItemKeysByAlias', query: 'Inception', opts: { limit: 5.5 } },
      {
        method: 'searchElvItemKeysByAlias',
        query: 'Inception',
        opts: { excludedSourceIds: 'src_1' },
      },
      {
        method: 'searchElvItemKeysByAlias',
        query: 'Inception',
        opts: { excludedSourceIds: [''] },
      },
      { method: 'searchElvItemKeysByAlias', query: 'Inception', opts: { extra: 1 } },
      { method: 'searchElvItemKeysByAlias', query: 'Inception', extra: true },
      {
        method: 'liveVariants',
        itemKey: 'x:s1:live:1',
        opts: { crossCategory: 'yes' },
      },
      {
        method: 'liveVariants',
        itemKey: 'x:s1:live:1',
        opts: { enrichmentStore: {} },
      },
      {
        method: 'listLiveVariants',
        itemKey: 'x:s1:live:1',
        opts: { qualityByKey: new Map() },
      },
      { method: 'findGuideChannelByCleanName', sourceId: '', channelName: 'News' },
      { method: 'findGuideChannelByCleanName', sourceId: 's1', channelName: '' },
      { method: 'findGuideChannelByCleanName', sourceId: 's1', channelName: 'News\nHD' },
      {
        method: 'findGuideChannelByCleanName',
        sourceId: 's1',
        channelName: 'News',
        opts: { crossSource: 'yes' },
      },
      {
        method: 'findGuideChannelByCleanName',
        sourceId: 's1',
        channelName: 'News',
        opts: { excludedSourceIds: 's2' },
      },
      {
        method: 'findGuideChannelByCleanName',
        sourceId: 's1',
        channelName: 'News',
        opts: { excludedSourceIds: [''] },
      },
    ];

    for (const c of invalidCalls) {
      expect(isCatalogClientMessage(call(c))).toBe(false);
    }

    const protoInjected = JSON.parse(
      '{"type":"call","reqId":1,"call":{"method":"recordPlaybackQuality","input":{"itemKey":"x:s1:movie:1","__proto__":{"polluted":true}}}}',
    );
    expect(isCatalogClientMessage(protoInjected)).toBe(false);
  });
});
