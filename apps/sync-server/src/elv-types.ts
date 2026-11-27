/** Minimal Cloudflare Workers AI binding interface (avoids third-party type dependencies). */
export interface WorkersAiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

/** Injectable Web Standard fetch function for upstream metadata calls and tests. */
export type ElvFetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Supported VOD media types for ELV Mode metadata enrichment. */
export type ElvMediaType = 'movie' | 'series';

/** Canonical editorial/trending feed cache keys. */
export type ElvFeedKey = 'top_picks' | 'moviemeter' | 'tvmeter' | 'current_upcoming_tv';

/** Shared atomic subrequest budget tracker keeping batch handlers within Worker limits. */
export interface ElvSubrequestBudget {
  remaining(): number;
  tryConsume(count?: number): boolean;
}

/** Cast credit entry returned in title detail responses and X-Ray views. */
export interface ElvCastMember {
  readonly personId: string;
  readonly name: string;
  readonly character: string | null;
  readonly portraitUrl: string | null;
}

/** Cached dual-ID (IMDb + TMDB) title metadata record stored in `elv_title_cache`. */
export interface ElvTitleRecord {
  readonly imdbId: string;
  readonly tmdbId: string | null;
  readonly mediaType: ElvMediaType;
  readonly originalTitle: string;
  readonly englishTitle: string | null;
  readonly year: number | null;
  readonly rating: number | null;
  readonly votes: number | null;
  readonly runtimeMin: number | null;
  readonly genres: readonly string[];
  readonly posterUrl: string | null;
  readonly backdropUrl: string | null;
  readonly trailerStreamUrl: string | null;
  readonly trailerYoutubeId: string | null;
  readonly director: string | null;
  readonly cast: readonly ElvCastMember[];
  readonly mltImdbIds: readonly string[];
  readonly franchiseKey: string | null;
  readonly franchiseName: string | null;
  readonly franchiseOrder: number | null;
  readonly originalSynopsis: string | null;
  readonly updatedAt: number;
}

/** Compact title summary included inside `/v1/elv/match-batch` responses. */
export interface ElvTitleSummary {
  readonly imdbId: string;
  readonly tmdbId: string | null;
  readonly mediaType: ElvMediaType;
  readonly originalTitle: string;
  readonly englishTitle: string | null;
  readonly localizedTitle: string | null;
  readonly year: number | null;
  readonly rating: number | null;
  readonly votes: number | null;
  readonly runtimeMin: number | null;
  readonly genres: readonly string[];
  readonly posterUrl: string | null;
  readonly backdropUrl: string | null;
  readonly franchiseKey: string | null;
  readonly franchiseName: string | null;
  readonly franchiseOrder: number | null;
}

/** Collective lookup-key -> IMDb/TMDB match row stored in `elv_title_match_index`. */
export interface ElvMatchIndexRecord {
  readonly lookupKey: string;
  readonly mediaType: ElvMediaType;
  readonly year: number | null;
  readonly imdbId: string;
  readonly tmdbId: string | null;
  readonly confidence: number;
  readonly updatedAt: number;
}

/** Permanently cached localized synopsis row stored in `elv_localized_synopses`. */
export interface ElvLocalizedSynopsisRecord {
  readonly imdbId: string;
  readonly lang: string;
  readonly localizedTitle: string | null;
  readonly synopsis: string;
  readonly source: string;
  readonly updatedAt: number;
}

/** Authoritative official IMDb rating row stored in `elv_imdb_ratings`. */
export interface ElvImdbRatingRecord {
  readonly imdbId: string;
  readonly rating: number;
  readonly votes: number;
  readonly updatedAt: number;
}

/** Single item inside a trending/top-rated editorial feed. */
export interface ElvFeedItem {
  readonly imdbId: string;
  readonly title: string;
  readonly mediaType: ElvMediaType;
  readonly year: number | null;
  readonly rating: number | null;
  readonly posterUrl: string | null;
  readonly genres: readonly string[];
  readonly rank: number;
}

/** Cached feed entry stored in `elv_feeds_cache`. */
export interface ElvFeedCacheRecord {
  readonly feedKey: ElvFeedKey;
  readonly items: readonly ElvFeedItem[];
  readonly updatedAt: number;
}

/** Upstream feed collections returned by `fetchFeeds`. */
export interface ElvFeedsPayload {
  readonly topPicks: readonly ElvFeedItem[];
  readonly movieMeter: readonly ElvFeedItem[];
  readonly tvMeter: readonly ElvFeedItem[];
  readonly currentUpcomingTv: readonly ElvFeedItem[];
}

/** Normalized candidate returned by IMDb suggestion JSON search. */
export interface ImdbSuggestionCandidate {
  readonly imdbId: string;
  readonly title: string;
  readonly year: number | null;
  readonly mediaType: ElvMediaType | 'other';
  readonly qid: string | null;
  readonly stars: string | null;
  readonly posterUrl: string | null;
}

/** Hydrated rich metadata bundle returned by TMDB v3 lookup helpers. */
export interface ElvRichTitlePayload {
  readonly record: ElvTitleRecord;
  readonly localizedTitle: string | null;
  readonly localizedSynopsis: string | null;
  readonly recommendedTmdbIds: readonly string[];
}

/** Rich TMDB search match including match confidence. */
export interface ElvRichSearchMatchPayload extends ElvRichTitlePayload {
  readonly confidence: number;
}

/** Validated input item inside `POST /v1/elv/match-batch`. */
export interface ElvMatchBatchItemInput {
  readonly key: string;
  readonly cleanTitle: string;
  readonly year: number | null;
  readonly mediaType: ElvMediaType;
  readonly providerImdbId: string | null;
  readonly providerTmdbId: string | null;
}

/** Validated `POST /v1/elv/match-batch` request payload. */
export interface ElvMatchBatchInput {
  readonly items: readonly ElvMatchBatchItemInput[];
  readonly lang: string;
}

/** Matched entry returned per input key in `POST /v1/elv/match-batch`. */
export interface ElvBatchMatchEntry {
  readonly key: string;
  readonly imdbId: string;
  readonly confidence: number;
  readonly mediaType: ElvMediaType;
  readonly title: ElvTitleSummary;
}

/** Callback resolving already-cached `tmdbId -> imdbId` pairs without external calls. */
export type ElvCachedTmdbResolver = (
  tmdbIds: readonly string[],
  mediaType: ElvMediaType,
) => Promise<ReadonlyMap<string, string>>;

/** Persistence methods for collective ELV metadata tables (`0003` + `0004`). */
export interface ElvMetadataStorage {
  getElvTitle(imdbId: string): Promise<ElvTitleRecord | null>;
  getElvTitleByTmdbId(tmdbId: string, mediaType?: ElvMediaType): Promise<ElvTitleRecord | null>;
  getElvTitlesByIds(imdbIds: readonly string[]): Promise<Map<string, ElvTitleRecord>>;
  getElvTitlesByTmdbIds(
    tmdbIds: readonly string[],
    mediaType?: ElvMediaType,
  ): Promise<Map<string, ElvTitleRecord>>;
  upsertElvTitle(title: ElvTitleRecord): Promise<void>;
  upsertElvTitlesBatch(titles: readonly ElvTitleRecord[]): Promise<void>;

  getElvMatchesByKeys(lookupKeys: readonly string[]): Promise<Map<string, ElvMatchIndexRecord>>;
  upsertElvMatches(matches: readonly ElvMatchIndexRecord[]): Promise<void>;

  getElvLocalizedSynopsis(imdbId: string, lang: string): Promise<ElvLocalizedSynopsisRecord | null>;
  getElvLocalizedSynopsesByIds(
    imdbIds: readonly string[],
    lang: string,
  ): Promise<Map<string, ElvLocalizedSynopsisRecord>>;
  upsertElvLocalizedSynopsis(record: ElvLocalizedSynopsisRecord): Promise<void>;
  upsertElvLocalizedSynopsesBatch(records: readonly ElvLocalizedSynopsisRecord[]): Promise<void>;

  getImdbRatingsByIds(imdbIds: readonly string[]): Promise<Map<string, ElvImdbRatingRecord>>;
  upsertImdbRatingsBatch(ratings: readonly ElvImdbRatingRecord[]): Promise<void>;

  getElvFeed(feedKey: ElvFeedKey): Promise<ElvFeedCacheRecord | null>;
  upsertElvFeed(
    feedKey: ElvFeedKey,
    items: readonly ElvFeedItem[],
    updatedAt: number,
  ): Promise<void>;
}

/** Injectable hybrid upstream metadata client seam used by `/v1/elv/*` routes. */
export interface ElvUpstreamClient {
  readonly isTmdbEnabled?: boolean;
  searchSuggestions(query: string): Promise<readonly ImdbSuggestionCandidate[]>;
  fetchTitleDetail(imdbId: string, lang?: string): Promise<ElvTitleRecord | null>;
  fetchFeeds(resolveCachedImdbIds?: ElvCachedTmdbResolver): Promise<ElvFeedsPayload>;
  resolveTmdbToImdb(tmdbId: string, mediaType: ElvMediaType): Promise<string | null>;

  searchRichMatch?(
    query: string,
    mediaType: ElvMediaType,
    year: number | null,
    lang: string,
    budget?: ElvSubrequestBudget,
  ): Promise<{
    readonly match: ElvRichSearchMatchPayload | null;
    readonly subrequestsUsed: number;
    readonly budgetExhausted?: boolean;
  }>;
  fetchRichTitleByTmdbId?(
    tmdbId: string,
    mediaType: ElvMediaType,
    lang: string,
    budget?: ElvSubrequestBudget,
  ): Promise<{
    readonly payload: ElvRichTitlePayload | null;
    readonly subrequestsUsed: number;
    readonly budgetExhausted?: boolean;
  }>;
  fetchRichTitleByImdbId?(
    imdbId: string,
    lang: string,
    knownTmdbId?: string | null,
    knownMediaType?: ElvMediaType | null,
    budget?: ElvSubrequestBudget,
  ): Promise<{
    readonly payload: ElvRichTitlePayload | null;
    readonly subrequestsUsed: number;
    readonly budgetExhausted?: boolean;
  }>;
}
