import type { CatalogRpcMethodCall } from '../shared/catalog-ipc.ts';
import type { CatalogBridgeWaveE1Ops } from '../shared/catalog-ipc-wave-e1-guards.ts';
import type { CatalogBridgeWaveE2Ops } from '../shared/catalog-ipc-wave-e2-guards.ts';

/** Builds the preload bridge delegates for all Wave E1 & Wave E2 ELV Mode RPC methods (`#511`, `#512`). */
export function createCatalogBridgeWaveE1Ops(
  callValue: <T>(call: CatalogRpcMethodCall) => Promise<T>,
): Required<CatalogBridgeWaveE1Ops & CatalogBridgeWaveE2Ops> {
  return {
    getElvEnrichmentForKeys: (itemKeys) =>
      callValue({ method: 'getElvEnrichmentForKeys', itemKeys }),
    getElvTitleDetail: (imdbId, opts) =>
      callValue({
        method: 'getElvTitleDetail',
        imdbId,
        ...(opts === undefined ? {} : { opts }),
      }),
    listMergedVodVersions: (itemKey, opts) =>
      callValue({
        method: 'listMergedVodVersions',
        itemKey,
        ...(opts === undefined ? {} : { opts }),
      }),
    enrichElvPriorityKeys: (itemKeys, opts) =>
      callValue({
        method: 'enrichElvPriorityKeys',
        itemKeys,
        ...(opts === undefined ? {} : { opts }),
      }),
    runElvBackgroundMatching: (opts) =>
      callValue({
        method: 'runElvBackgroundMatching',
        ...(opts === undefined ? {} : { opts }),
      }),
    recordPlaybackQuality: (input) => callValue({ method: 'recordPlaybackQuality', input }),
    recordPlaybackVariantFailure: (itemKey) =>
      callValue({ method: 'recordPlaybackVariantFailure', itemKey }),
    setElvManualMatch: (itemKey, sourceId, mediaType, imdbId) =>
      callValue({ method: 'setElvManualMatch', itemKey, sourceId, mediaType, imdbId }),
    wipeElvEnrichment: () => callValue({ method: 'wipeElvEnrichment' }),
    searchElvItemKeysByAlias: (query, opts) =>
      callValue({
        method: 'searchElvItemKeysByAlias',
        query,
        ...(opts === undefined ? {} : { opts }),
      }),
    listLiveVariants: (itemKey, categoryId, opts) =>
      callValue({
        method: 'listLiveVariants',
        itemKey,
        ...(categoryId === undefined ? {} : { categoryId }),
        ...(opts === undefined ? {} : { opts }),
      }),
    findGuideChannelByCleanName: (sourceId, channelName, opts) =>
      callValue({
        method: 'findGuideChannelByCleanName',
        sourceId,
        channelName,
        ...(opts === undefined ? {} : { opts }),
      }),
    listElvImdbGenres: (kind, opts) =>
      callValue({
        method: 'listElvImdbGenres',
        kind,
        ...(opts === undefined ? {} : { opts }),
      }),
    listElvItemsByImdbGenre: (kind, genre, opts) =>
      callValue({
        method: 'listElvItemsByImdbGenre',
        kind,
        genre,
        ...(opts === undefined ? {} : { opts }),
      }),
    getElvRecommendations: (opts) => callValue({ method: 'getElvRecommendations', opts }),
    refreshElvFeeds: (opts) =>
      callValue({
        method: 'refreshElvFeeds',
        ...(opts === undefined ? {} : { opts }),
      }),
    listElvFranchiseItems: (imdbId, opts) =>
      callValue({
        method: 'listElvFranchiseItems',
        imdbId,
        ...(opts === undefined ? {} : { opts }),
      }),
    listElvPersonLibraryItems: (person, opts) =>
      callValue({
        method: 'listElvPersonLibraryItems',
        person,
        ...(opts === undefined ? {} : { opts }),
      }),
    searchElvMatchCandidates: (query, mediaType) =>
      callValue({ method: 'searchElvMatchCandidates', query, mediaType }),
    applyElvFixMatch: (input) => callValue({ method: 'applyElvFixMatch', input }),
  };
}
