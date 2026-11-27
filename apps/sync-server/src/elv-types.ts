/** Minimal Cloudflare Workers AI binding interface (avoids third-party type dependencies). */
export interface WorkersAiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

/** Injectable Web Standard fetch function for IMDb-first upstream calls and tests. */
export type ElvFetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Supported VOD media types for ELV Mode metadata enrichment. */
export type ElvMediaType = 'movie' | 'series';

/** Canonical IMDb chart / editorial feed cache keys. */
export type ElvFeedKey = 'top_picks' | 'moviemeter' | 'tvmeter' | 'current_upcoming_tv';

/** Cast credit entry returned in title detail responses and X-Ray views. */
export interface ElvCastMember {
  readonly personId: string;
  readonly name: string;
  readonly character: string | null;
  readonly portraitUrl: string | null;
}

/** Cached IMDb-first title metadata record stored in `elv_title_cache`. */
export interface ElvTitleRecord {
  readonly imdbId: string;
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

/** Collective lookup-key -> IMDb match row stored in `elv_title_match_index`. */
export interface ElvMatchIndexRecord {
  readonly lookupKey: string;
  readonly mediaType: ElvMediaType;
  readonly year: number | null;
  readonly imdbId: string;
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

/** Single item inside an IMDb chart / trending editorial feed. */
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

/** Raw upstream feed collections fetched from IMDb chart pages. */
export interface ElvFeedsPayload {
  readonly topPicks: readonly ElvFeedItem[];
  readonly movieMeter: readonly ElvFeedItem[];
  readonly tvMeter: readonly ElvFeedItem[];
  readonly currentUpcomingTv: readonly ElvFeedItem[];
}

/** Normalized candidate returned by IMDb suggestion search. */
export interface ImdbSuggestionCandidate {
  readonly imdbId: string;
  readonly title: string;
  readonly year: number | null;
  readonly mediaType: ElvMediaType | 'other';
  readonly qid: string | null;
  readonly stars: string | null;
  readonly posterUrl: string | null;
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

/** Persistence methods for Wave E1 collective ELV metadata tables (`0003_wave_e1_elv_metadata.sql`). */
export interface ElvMetadataStorage {
  getElvTitle(imdbId: string): Promise<ElvTitleRecord | null>;
  getElvTitlesByIds(imdbIds: readonly string[]): Promise<Map<string, ElvTitleRecord>>;
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

  getElvFeed(feedKey: ElvFeedKey): Promise<ElvFeedCacheRecord | null>;
  upsertElvFeed(
    feedKey: ElvFeedKey,
    items: readonly ElvFeedItem[],
    updatedAt: number,
  ): Promise<void>;
}

/** Injectable IMDb-first upstream metadata client seam used by `/v1/elv/*` routes. */
export interface ElvUpstreamClient {
  searchSuggestions(query: string): Promise<readonly ImdbSuggestionCandidate[]>;
  fetchTitleDetail(imdbId: string): Promise<ElvTitleRecord | null>;
  fetchFeeds(): Promise<ElvFeedsPayload>;
  resolveTmdbToImdb(tmdbId: string, mediaType: ElvMediaType): Promise<string | null>;
}
