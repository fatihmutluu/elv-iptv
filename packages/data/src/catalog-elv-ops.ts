import type { Scheduler, SqlDriver } from '@elv/domain';
import type { RowLogoResolver } from './elv-discovery-helpers';
import {
  type CatalogElvDiscoveryOpsMethods,
  createCatalogElvDiscoveryOpsMethods,
} from './elv-discovery-ops';
import type {
  ElvEnrichmentStore,
  ElvItemEnrichment,
  ElvMediaType,
  ElvQualityMemoryRecord,
  ElvTitleRecord,
} from './elv-enrichment-repo';
import {
  type CleanNameGuideMatch,
  type FindGuideChannelByCleanNameOptions,
  findGuideChannelByCleanName,
} from './elv-live-epg';
import {
  createElvCatalogMatcher,
  type ElvBackgroundMatchOptions,
  type ElvMatchingSummary,
  type ElvMetadataClient,
  type ElvPriorityMatchOptions,
} from './elv-matcher';
import { type MergedVodVariant, queryMergedVodVersions } from './elv-merge';
import {
  hasClaimedQualityTag,
  type RecordPlaybackQualityInput,
  recordPlaybackQuality,
  recordPlaybackVariantFailure,
} from './elv-quality-memory';
import type { ParentalQueryOptions } from './parental-policy';
import { sourceOfKey } from './queries-shared';
import {
  type LiveVariantOption,
  type QueryLiveVariantsOptions,
  queryLiveVariants,
} from './queries-variants';

export type { ElvEnrichmentStore, ElvMetadataClient };

/** Options for {@link CatalogElvOpsMethods.getElvTitleDetail}. */
export interface GetElvTitleDetailOptions {
  readonly lang?: string;
  readonly forceRefresh?: boolean;
  readonly signal?: AbortSignal;
}

/** Options for {@link CatalogElvOpsMethods.searchElvItemKeysByAlias}. */
export interface SearchElvItemKeysByAliasOptions {
  readonly kind?: ElvMediaType;
  readonly limit?: number;
  readonly excludedSourceIds?: readonly string[];
}

/** ELV Mode enrichment, matching, merging, quality memory, discovery, and Live TV methods exposed on `CatalogService` (`#511`, `#512`). */
export interface CatalogElvOpsMethods extends CatalogElvDiscoveryOpsMethods {
  getElvEnrichmentForKeys(itemKeys: readonly string[]): Promise<Map<string, ElvItemEnrichment>>;
  getElvTitleDetail(
    imdbId: string,
    opts?: GetElvTitleDetailOptions,
  ): Promise<ElvTitleRecord | null>;
  listMergedVodVersions(itemKey: string, opts?: ParentalQueryOptions): Promise<MergedVodVariant[]>;
  enrichElvPriorityKeys(
    itemKeys: readonly string[],
    opts?: ElvPriorityMatchOptions,
  ): Promise<ElvMatchingSummary>;
  runElvBackgroundMatching(opts?: ElvBackgroundMatchOptions): Promise<ElvMatchingSummary>;
  recordPlaybackQuality(input: RecordPlaybackQualityInput): Promise<ElvQualityMemoryRecord | null>;
  recordPlaybackVariantFailure(itemKey: string): Promise<ElvQualityMemoryRecord | null>;
  setElvManualMatch(
    itemKey: string,
    sourceId: string,
    mediaType: ElvMediaType,
    imdbId: string,
  ): Promise<void>;
  wipeElvEnrichment(): Promise<void>;
  searchElvItemKeysByAlias(
    query: string,
    opts?: SearchElvItemKeysByAliasOptions,
  ): Promise<readonly string[]>;
  listLiveVariants(
    itemKey: string,
    categoryId?: string,
    opts?: QueryLiveVariantsOptions,
  ): Promise<readonly LiveVariantOption[]>;
  findGuideChannelByCleanName(
    sourceId: string,
    channelName: string,
    opts?: FindGuideChannelByCleanNameOptions,
  ): Promise<CleanNameGuideMatch | null>;
}

interface RawClaimedLabelRow {
  readonly name: string | null;
  readonly version_label: string | null;
}

function combineCatalogClaimedLabel(row: RawClaimedLabelRow): string | null {
  const name = row.name?.trim() ?? '';
  const version = row.version_label?.trim() ?? '';
  if (name !== '' && version !== '') {
    if (name.toLowerCase().includes(version.toLowerCase())) return name;
    return `${name} [${version}]`;
  }
  if (version !== '') return version;
  return name !== '' ? name : null;
}

async function resolveCatalogClaimedLabel(db: SqlDriver, itemKey: string): Promise<string | null> {
  const sourceId = sourceOfKey(itemKey);
  const rows =
    sourceId !== undefined
      ? await db.all<RawClaimedLabelRow>(
          `SELECT name, version_label FROM movies WHERE source_id = ? AND key = ?
           UNION ALL
           SELECT name, NULL AS version_label FROM series WHERE source_id = ? AND key = ?
           UNION ALL
           SELECT name, NULL AS version_label FROM live WHERE source_id = ? AND key = ?
           LIMIT 1`,
          [sourceId, itemKey, sourceId, itemKey, sourceId, itemKey],
        )
      : await db.all<RawClaimedLabelRow>(
          `SELECT name, version_label FROM movies WHERE key = ?
           UNION ALL
           SELECT name, NULL AS version_label FROM series WHERE key = ?
           UNION ALL
           SELECT name, NULL AS version_label FROM live WHERE key = ?
           LIMIT 1`,
          [itemKey, itemKey, itemKey],
        );
  const row = rows[0];
  return row === undefined ? null : combineCatalogClaimedLabel(row);
}

const EMPTY_SUMMARY: ElvMatchingSummary = {
  scanned: 0,
  layer1Matched: 0,
  remoteMatched: 0,
  skipped: 0,
  aborted: false,
};

/** @internal Creates ELV Mode methods for `CatalogService` over optional isolated enrichment store & client. */
export function createCatalogElvOpsMethods(deps: {
  readonly db: SqlDriver;
  readonly clock: () => number;
  readonly scheduler: Scheduler;
  readonly enrichmentStore?: ElvEnrichmentStore | undefined;
  readonly elvClient?: ElvMetadataClient | undefined;
  readonly resolveRowLogos?: RowLogoResolver | undefined;
}): CatalogElvOpsMethods {
  const { db, clock, scheduler, enrichmentStore, elvClient, resolveRowLogos } = deps;
  const matcher =
    enrichmentStore !== undefined && elvClient !== undefined
      ? createElvCatalogMatcher({
          catalogDb: db,
          enrichmentStore,
          client: elvClient,
          now: clock,
          scheduler,
        })
      : undefined;

  const getElvTitleDetail: CatalogElvOpsMethods['getElvTitleDetail'] = async (imdbId, opts) => {
    const cached =
      enrichmentStore === undefined ? null : await enrichmentStore.getTitleByImdbId(imdbId);
    const langKey = opts?.lang?.trim().toLowerCase();
    const hasRequestedLang =
      langKey === undefined || langKey === '' || cached?.synopses[langKey] !== undefined;
    if (
      cached !== null &&
      cached.detailFetchedAt !== null &&
      opts?.forceRefresh !== true &&
      (hasRequestedLang || elvClient === undefined)
    ) {
      return cached;
    }
    if (elvClient === undefined) return cached;
    const fetched = await elvClient.fetchTitleDetail(imdbId, opts?.lang, opts?.signal);
    if (fetched === null) return cached;
    if (enrichmentStore !== undefined) {
      await enrichmentStore.upsertTitles([fetched]);
      return enrichmentStore.getTitleByImdbId(imdbId);
    }
    const nowMs = clock();
    return {
      imdbId: fetched.imdbId,
      mediaType: fetched.mediaType,
      originalTitle: fetched.originalTitle,
      englishTitle: fetched.englishTitle ?? null,
      localizedTitles: fetched.localizedTitles ?? {},
      year: fetched.year ?? null,
      rating: fetched.rating ?? null,
      votes: fetched.votes ?? null,
      runtimeMin: fetched.runtimeMin ?? null,
      genres: fetched.genres ?? [],
      posterUrl: fetched.posterUrl ?? null,
      backdropUrl: fetched.backdropUrl ?? null,
      trailerStreamUrl: fetched.trailerStreamUrl ?? null,
      trailerYoutubeId: fetched.trailerYoutubeId ?? null,
      director: fetched.director ?? null,
      cast: fetched.cast ?? [],
      mltImdbIds: fetched.mltImdbIds ?? [],
      franchiseKey: fetched.franchiseKey ?? null,
      franchiseName: fetched.franchiseName ?? null,
      franchiseOrder: fetched.franchiseOrder ?? null,
      synopses: fetched.synopses ?? {},
      detailFetchedAt: fetched.detailFetchedAt ?? nowMs,
      updatedAt: fetched.updatedAt ?? nowMs,
    };
  };

  const discoveryOps = createCatalogElvDiscoveryOpsMethods({
    db,
    clock,
    enrichmentStore,
    elvClient,
    resolveRowLogos,
    getElvTitleDetail,
  });

  return {
    getElvEnrichmentForKeys: async (itemKeys) =>
      enrichmentStore === undefined ? new Map() : enrichmentStore.getEnrichmentForKeys(itemKeys),

    getElvTitleDetail,

    listMergedVodVersions: (itemKey, opts) =>
      queryMergedVodVersions(db, enrichmentStore, itemKey, opts),

    enrichElvPriorityKeys: async (itemKeys, opts) =>
      matcher === undefined ? EMPTY_SUMMARY : matcher.enrichPriorityKeys(itemKeys, opts),

    runElvBackgroundMatching: async (opts) =>
      matcher === undefined ? EMPTY_SUMMARY : matcher.runBackgroundMatching(opts),

    recordPlaybackQuality: async (input) => {
      if (enrichmentStore === undefined) return null;
      const trimmedLabel = typeof input.claimedLabel === 'string' ? input.claimedLabel.trim() : '';
      let effectiveClaimedLabel = input.claimedLabel;
      if (trimmedLabel === '' || !hasClaimedQualityTag(trimmedLabel)) {
        const rawCatalogLabel = await resolveCatalogClaimedLabel(db, input.itemKey);
        if (rawCatalogLabel !== null) {
          effectiveClaimedLabel = rawCatalogLabel;
        }
      }
      return recordPlaybackQuality(enrichmentStore, {
        ...input,
        ...(effectiveClaimedLabel !== undefined ? { claimedLabel: effectiveClaimedLabel } : {}),
        ...(input.nowMs === undefined ? { nowMs: clock() } : {}),
      });
    },

    recordPlaybackVariantFailure: async (itemKey) =>
      enrichmentStore === undefined
        ? null
        : recordPlaybackVariantFailure(enrichmentStore, itemKey, clock()),

    setElvManualMatch: async (itemKey, sourceId, mediaType, imdbId) => {
      if (enrichmentStore === undefined) return;
      await enrichmentStore.setManualMatch(itemKey, sourceId, mediaType, imdbId, clock());
    },

    wipeElvEnrichment: async () => {
      if (enrichmentStore === undefined) return;
      await enrichmentStore.wipeAll();
    },

    searchElvItemKeysByAlias: async (query, opts) =>
      enrichmentStore === undefined
        ? []
        : enrichmentStore.searchMatchedItemKeysByAlias(query, {
            ...(opts?.kind !== undefined ? { mediaType: opts.kind } : {}),
            ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
            ...(opts?.excludedSourceIds !== undefined
              ? { excludedSourceIds: opts.excludedSourceIds }
              : {}),
          }),

    listLiveVariants: (itemKey, categoryId, opts) =>
      queryLiveVariants(
        db,
        itemKey,
        categoryId,
        opts?.crossCategory === true &&
          opts.enrichmentStore === undefined &&
          enrichmentStore !== undefined
          ? { ...opts, enrichmentStore }
          : opts,
      ),

    findGuideChannelByCleanName: (sourceId, channelName, opts) =>
      findGuideChannelByCleanName(db, {
        sourceId,
        channelName,
        ...(opts?.crossSource !== undefined ? { crossSource: opts.crossSource } : {}),
        ...(opts?.excludedSourceIds !== undefined
          ? { excludedSourceIds: opts.excludedSourceIds }
          : {}),
      }),

    ...discoveryOps,
  };
}
