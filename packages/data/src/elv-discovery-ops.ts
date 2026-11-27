import type { SqlDriver } from '@elv/domain';
import {
  computeVisibleImdbGenreCounts,
  hydrateBestPlayableMatches,
  loadActiveSourceIds,
  type RowLogoResolver,
  resolveItemsLogos,
} from './elv-discovery-helpers';
import { listMatchedTitlesByGenrePage } from './elv-enrichment-discovery-queries';
import type {
  ElvEnrichmentStore,
  ElvItemEnrichment,
  ElvMediaType,
  ElvPersonQuery,
  ElvPersonRole,
  ElvTitleRecord,
} from './elv-enrichment-types';
import { uniqueNonEmpty } from './elv-enrichment-types';
import type { ElvMetadataClient, ElvSearchCandidate } from './elv-http-client';
import {
  computeElvRecommendations,
  ELV_FEED_KEYS,
  type ElvRecommendationsQuery,
  type ElvRecommendedItem,
} from './elv-recommendations';
import type { ParentalQueryOptions } from './parental-policy';
import { loadActiveParentalFilter } from './parental-repo';
import { type ItemRow, type ItemSortOrder, resolveQueryProfileId } from './queries-shared';
import { normalizeCatalogImdbId } from './writers';

/** Prefix for synthetic IMDb genre category identifiers (`#512`). */
export const ELV_IMDB_GENRE_ID_PREFIX = 'imdb-genre:';

/** Default refresh TTL (6 hours) for cached IMDb daily feeds in `elv_feeds` (`#512`). */
export const ELV_FEEDS_TTL_MS = 6 * 60 * 60 * 1_000;

const DEFAULT_GENRE_ITEMS_LIMIT = 60;
const MAX_GENRE_ITEMS_LIMIT = 200;
const DEFAULT_PERSON_ITEMS_LIMIT = 50;
const MAX_PERSON_ITEMS_LIMIT = 200;

/** One IMDb genre bucket derived strictly from matched playable library items (`#512`). */
export interface ElvGenreBucket {
  readonly id: string;
  readonly name: string;
  readonly count: number;
}

/** Options for {@link CatalogElvDiscoveryOpsMethods.listElvImdbGenres}. */
export interface ListElvImdbGenresOptions extends ParentalQueryOptions {
  readonly excludedSourceIds?: readonly string[];
}

/** Options for {@link CatalogElvDiscoveryOpsMethods.listElvItemsByImdbGenre}. */
export interface ListElvItemsByImdbGenreOptions extends ParentalQueryOptions {
  readonly offset?: number;
  readonly limit?: number;
  readonly excludedSourceIds?: readonly string[];
  readonly sortBy?: ItemSortOrder;
}

/** Options for {@link CatalogElvDiscoveryOpsMethods.refreshElvFeeds}. */
export interface RefreshElvFeedsOptions {
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

/** Options for {@link CatalogElvDiscoveryOpsMethods.listElvFranchiseItems}. */
export interface ListElvFranchiseItemsOptions extends ParentalQueryOptions {
  readonly excludedSourceIds?: readonly string[];
}

/** One chronological playable movie or series belonging to a franchise in the user's library (`#512`). */
export interface ElvFranchiseLibraryItem {
  readonly item: ItemRow;
  readonly enrichment: ElvItemEnrichment;
  readonly franchiseKey: string;
  readonly franchiseName: string | null;
  readonly franchiseOrder: number | null;
}

/** Options for {@link CatalogElvDiscoveryOpsMethods.listElvPersonLibraryItems}. */
export interface ListElvPersonLibraryItemsOptions extends ParentalQueryOptions {
  readonly excludedSourceIds?: readonly string[];
  readonly limit?: number;
}

/** One playable movie or series in the user's library featuring a queried actor or director (`#512`). */
export interface ElvPersonLibraryItem {
  readonly item: ItemRow;
  readonly enrichment: ElvItemEnrichment;
  readonly role: ElvPersonRole;
  readonly character: string | null;
}

/** Input payload for {@link CatalogElvDiscoveryOpsMethods.applyElvFixMatch} (`#512`). */
export interface ApplyElvFixMatchInput {
  readonly itemKey: string;
  readonly sourceId: string;
  readonly mediaType: ElvMediaType;
  readonly imdbId: string;
  readonly lang?: string;
}

/** Wave E2 ELV Mode discovery, recommendations, franchise, cast filmography, feeds & Fix Match methods (`#512`). */
export interface CatalogElvDiscoveryOpsMethods {
  listElvImdbGenres(
    kind: ElvMediaType,
    opts?: ListElvImdbGenresOptions,
  ): Promise<readonly ElvGenreBucket[]>;
  listElvItemsByImdbGenre(
    kind: ElvMediaType,
    genre: string,
    opts?: ListElvItemsByImdbGenreOptions,
  ): Promise<readonly ItemRow[]>;
  getElvRecommendations(opts: ElvRecommendationsQuery): Promise<readonly ElvRecommendedItem[]>;
  refreshElvFeeds(opts?: RefreshElvFeedsOptions): Promise<boolean>;
  listElvFranchiseItems(
    imdbId: string,
    opts?: ListElvFranchiseItemsOptions,
  ): Promise<readonly ElvFranchiseLibraryItem[]>;
  listElvPersonLibraryItems(
    person: ElvPersonQuery,
    opts?: ListElvPersonLibraryItemsOptions,
  ): Promise<readonly ElvPersonLibraryItem[]>;
  searchElvMatchCandidates(
    query: string,
    mediaType: ElvMediaType,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<readonly ElvSearchCandidate[]>;
  applyElvFixMatch(input: ApplyElvFixMatchInput): Promise<ElvItemEnrichment | null>;
}

function normalizeGenreName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith(ELV_IMDB_GENRE_ID_PREFIX)) {
    return trimmed.slice(ELV_IMDB_GENRE_ID_PREFIX.length).trim();
  }
  return trimmed;
}

/** @internal Creates Wave E2 ELV Mode discovery methods wired into `CatalogElvOpsMethods`. */
export function createCatalogElvDiscoveryOpsMethods(deps: {
  readonly db: SqlDriver;
  readonly clock: () => number;
  readonly enrichmentStore?: ElvEnrichmentStore | undefined;
  readonly elvClient?: ElvMetadataClient | undefined;
  readonly resolveRowLogos?: RowLogoResolver | undefined;
  readonly getElvTitleDetail: (
    imdbId: string,
    opts?: {
      readonly lang?: string;
      readonly forceRefresh?: boolean;
      readonly signal?: AbortSignal;
    },
  ) => Promise<ElvTitleRecord | null>;
}): CatalogElvDiscoveryOpsMethods {
  const { db, clock, enrichmentStore, elvClient, resolveRowLogos, getElvTitleDetail } = deps;

  return {
    async listElvImdbGenres(kind, opts) {
      if (enrichmentStore === undefined) return [];
      const activeSourceIds = await loadActiveSourceIds(db, opts?.excludedSourceIds);
      if (activeSourceIds.length === 0) return [];
      const profileId = resolveQueryProfileId(opts?.profileId);
      const parentalFilter = await loadActiveParentalFilter(db, profileId, opts?.parentalUnlocked);
      const counts = await computeVisibleImdbGenreCounts({
        catalogDb: db,
        enrichmentStore,
        kind,
        activeSourceIds,
        parentalFilter,
      });
      return counts.map((entry) => ({
        id: `${ELV_IMDB_GENRE_ID_PREFIX}${entry.genre}`,
        name: entry.genre,
        count: entry.itemCount,
      }));
    },

    async listElvItemsByImdbGenre(kind, genre, opts) {
      if (enrichmentStore === undefined) return [];
      const cleanGenre = normalizeGenreName(genre);
      if (cleanGenre === '') return [];
      if (opts?.limit !== undefined && (!Number.isFinite(opts.limit) || opts.limit <= 0)) {
        return [];
      }
      const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
      const limit = Math.max(
        1,
        Math.min(MAX_GENRE_ITEMS_LIMIT, Math.floor(opts?.limit ?? DEFAULT_GENRE_ITEMS_LIMIT)),
      );
      const activeSourceIds = await loadActiveSourceIds(db, opts?.excludedSourceIds);
      if (activeSourceIds.length === 0) return [];

      const profileId = resolveQueryProfileId(opts?.profileId);
      const parentalFilter = await loadActiveParentalFilter(db, profileId, opts?.parentalUnlocked);
      const excludedSourceSet = new Set(uniqueNonEmpty(opts?.excludedSourceIds ?? []));

      const targetCount = offset + limit;
      const batchLimit = Math.min(MAX_GENRE_ITEMS_LIMIT, Math.max(limit * 2, 60));
      const collected: ItemRow[] = [];
      const seenImdb = new Set<string>();
      let dbOffset = 0;

      while (collected.length < targetCount) {
        const batch = await listMatchedTitlesByGenrePage(enrichmentStore.driver, kind, cleanGenre, {
          offset: dbOffset,
          limit: batchLimit,
          allowedSourceIds: activeSourceIds,
          ...(opts?.sortBy !== undefined ? { sortBy: opts.sortBy } : {}),
        });
        if (batch.rawCount === 0) break;
        dbOffset += batch.rawCount;
        const { titles } = batch;

        const titleByImdb = new Map<string, ElvTitleRecord>();
        const orderedImdbIds: string[] = [];
        for (const t of titles) {
          if (seenImdb.has(t.imdbId)) continue;
          seenImdb.add(t.imdbId);
          titleByImdb.set(t.imdbId, t);
          orderedImdbIds.push(t.imdbId);
        }
        if (orderedImdbIds.length > 0) {
          const matchesByImdb = await enrichmentStore.listMatchedMatchesForImdbIds(
            orderedImdbIds,
            kind,
            { allowedSourceIds: activeSourceIds },
          );
          const hydrated = await hydrateBestPlayableMatches({
            catalogDb: db,
            enrichmentStore,
            orderedImdbIds,
            matchesByImdb,
            titleByImdb,
            kind,
            excludedSourceIds: excludedSourceSet,
            parentalFilter,
            maxRatingAge: parentalFilter?.maxRatingAge ?? null,
          });
          for (const imdbId of orderedImdbIds) {
            const match = hydrated.get(imdbId);
            if (match !== undefined) {
              collected.push(match.item);
              if (collected.length >= targetCount) break;
            }
          }
        }
        if (batch.rawCount < batchLimit) break;
      }

      const page = collected.slice(offset, offset + limit);
      return resolveItemsLogos(page, resolveRowLogos);
    },

    async getElvRecommendations(opts) {
      if (enrichmentStore === undefined) return [];
      return computeElvRecommendations({
        ...opts,
        catalogDb: db,
        enrichmentStore,
        now: clock,
        ...(resolveRowLogos !== undefined ? { resolveRowLogos } : {}),
      });
    },

    async refreshElvFeeds(opts) {
      if (enrichmentStore === undefined || elvClient === undefined) return false;
      const nowMs = clock();
      if (opts?.force !== true) {
        const existing = await enrichmentStore.listFeeds(ELV_FEED_KEYS);
        if (existing.length === ELV_FEED_KEYS.length) {
          let oldestUpdatedAt = Number.POSITIVE_INFINITY;
          for (const feed of existing) {
            if (feed.updatedAt < oldestUpdatedAt) oldestUpdatedAt = feed.updatedAt;
          }
          if (nowMs - oldestUpdatedAt < ELV_FEEDS_TTL_MS) {
            return false;
          }
        }
      }
      const payload = await elvClient.fetchFeeds(opts?.signal);
      if (payload === null) return false;
      const persistedAt = clock();
      await Promise.all([
        enrichmentStore.upsertFeed('top_picks', payload.topPicks, persistedAt),
        enrichmentStore.upsertFeed('moviemeter', payload.movieMeter, persistedAt),
        enrichmentStore.upsertFeed('tvmeter', payload.tvMeter, persistedAt),
        enrichmentStore.upsertFeed('current_upcoming_tv', payload.currentUpcomingTv, persistedAt),
      ]);
      return true;
    },

    async listElvFranchiseItems(imdbId, opts) {
      if (enrichmentStore === undefined) return [];
      const normalized = normalizeCatalogImdbId(imdbId);
      if (normalized === null) return [];
      const seedTitle = await enrichmentStore.getTitleByImdbId(normalized);
      if (seedTitle === null || seedTitle.franchiseKey === null || seedTitle.franchiseKey === '') {
        return [];
      }
      const activeSourceIds = await loadActiveSourceIds(db, opts?.excludedSourceIds);
      if (activeSourceIds.length === 0) return [];

      const titles = await enrichmentStore.listTitlesByFranchise(seedTitle.franchiseKey, {
        allowedSourceIds: activeSourceIds,
      });
      if (titles.length === 0) return [];

      const orderedImdbIds = titles.map((t) => t.imdbId);
      const titleByImdb = new Map<string, ElvTitleRecord>(titles.map((t) => [t.imdbId, t]));
      const matchesByImdb = await enrichmentStore.listMatchedMatchesForImdbIds(
        orderedImdbIds,
        undefined,
        { allowedSourceIds: activeSourceIds },
      );
      const profileId = resolveQueryProfileId(opts?.profileId);
      const parentalFilter = await loadActiveParentalFilter(db, profileId, opts?.parentalUnlocked);
      const hydrated = await hydrateBestPlayableMatches({
        catalogDb: db,
        enrichmentStore,
        orderedImdbIds,
        matchesByImdb,
        titleByImdb,
        excludedSourceIds: new Set(uniqueNonEmpty(opts?.excludedSourceIds ?? [])),
        parentalFilter,
        maxRatingAge: parentalFilter?.maxRatingAge ?? null,
      });

      const entries: ElvFranchiseLibraryItem[] = [];
      for (const title of titles) {
        const match = hydrated.get(title.imdbId);
        if (match === undefined) continue;
        entries.push({
          item: match.item,
          enrichment: match.enrichment,
          franchiseKey: title.franchiseKey ?? seedTitle.franchiseKey,
          franchiseName: title.franchiseName ?? seedTitle.franchiseName,
          franchiseOrder: title.franchiseOrder,
        });
      }
      if (entries.length === 0) return [];
      const resolvedItems = await resolveItemsLogos(
        entries.map((e) => e.item),
        resolveRowLogos,
      );
      return entries.map((entry, idx) => ({
        ...entry,
        item: resolvedItems[idx] ?? entry.item,
      }));
    },

    async listElvPersonLibraryItems(person, opts) {
      if (enrichmentStore === undefined) return [];
      if (opts?.limit !== undefined && (!Number.isFinite(opts.limit) || opts.limit <= 0)) {
        return [];
      }
      const limit = Math.max(
        1,
        Math.min(MAX_PERSON_ITEMS_LIMIT, Math.floor(opts?.limit ?? DEFAULT_PERSON_ITEMS_LIMIT)),
      );
      const activeSourceIds = await loadActiveSourceIds(db, opts?.excludedSourceIds);
      if (activeSourceIds.length === 0) return [];

      const personMatches = await enrichmentStore.listMatchedTitlesByPerson(person, {
        allowedSourceIds: activeSourceIds,
        limit: Math.min(MAX_PERSON_ITEMS_LIMIT, limit * 2),
      });
      if (personMatches.length === 0) return [];

      const orderedImdbIds = personMatches.map((m) => m.title.imdbId);
      const titleByImdb = new Map<string, ElvTitleRecord>(
        personMatches.map((m) => [m.title.imdbId, m.title]),
      );
      const matchesByImdb = await enrichmentStore.listMatchedMatchesForImdbIds(
        orderedImdbIds,
        undefined,
        { allowedSourceIds: activeSourceIds },
      );
      const profileId = resolveQueryProfileId(opts?.profileId);
      const parentalFilter = await loadActiveParentalFilter(db, profileId, opts?.parentalUnlocked);
      const hydrated = await hydrateBestPlayableMatches({
        catalogDb: db,
        enrichmentStore,
        orderedImdbIds,
        matchesByImdb,
        titleByImdb,
        excludedSourceIds: new Set(uniqueNonEmpty(opts?.excludedSourceIds ?? [])),
        parentalFilter,
        maxRatingAge: parentalFilter?.maxRatingAge ?? null,
      });

      const entries: ElvPersonLibraryItem[] = [];
      for (const hit of personMatches) {
        const match = hydrated.get(hit.title.imdbId);
        if (match === undefined) continue;
        entries.push({
          item: match.item,
          enrichment: match.enrichment,
          role: hit.role,
          character: hit.character,
        });
        if (entries.length >= limit) break;
      }
      if (entries.length === 0) return [];
      const resolvedItems = await resolveItemsLogos(
        entries.map((e) => e.item),
        resolveRowLogos,
      );
      return entries.map((entry, idx) => ({
        ...entry,
        item: resolvedItems[idx] ?? entry.item,
      }));
    },

    async searchElvMatchCandidates(query, mediaType, opts) {
      if (elvClient === undefined) return [];
      const cleaned = query.trim();
      if (cleaned === '') return [];
      return elvClient.searchTitles(cleaned, mediaType, opts?.signal);
    },

    async applyElvFixMatch(input) {
      if (enrichmentStore === undefined) return null;
      const itemKey = input.itemKey.trim();
      const sourceId = input.sourceId.trim();
      const normalizedImdbId = normalizeCatalogImdbId(input.imdbId);
      if (itemKey === '' || sourceId === '' || normalizedImdbId === null) return null;

      await enrichmentStore.setManualMatch(
        itemKey,
        sourceId,
        input.mediaType,
        normalizedImdbId,
        clock(),
      );
      try {
        await getElvTitleDetail(
          normalizedImdbId,
          input.lang !== undefined ? { lang: input.lang } : undefined,
        );
      } catch {
        // Keep manual_lock persisted even if remote rich-detail fetch fails transiently.
      }
      const updated = await enrichmentStore.getEnrichmentForKeys([itemKey]);
      return updated.get(itemKey) ?? null;
    },
  };
}
