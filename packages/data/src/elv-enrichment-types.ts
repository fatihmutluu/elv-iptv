import type { SqlDriver, SqlValue } from '@elv/domain';
import { normalizeCatalogImdbId } from './writers';

/** Media type supported by ELV Mode enrichment tables. */
export type ElvMediaType = 'movie' | 'series';

/** Cast credit entry stored in `elv_titles.cast_json`. */
export interface ElvCastMember {
  readonly personId?: string | null;
  readonly name: string;
  readonly character?: string | null;
  readonly portraitUrl?: string | null;
}

/** One item-to-IMDb match persisted in `elv_item_matches`. */
export interface ElvMatchRecord {
  readonly itemKey: string;
  readonly sourceId: string;
  readonly mediaType: ElvMediaType;
  readonly imdbId: string;
  readonly confidence: number;
  readonly manualLock: boolean;
  readonly updatedAt: number;
}

/** Input row for {@link ElvEnrichmentStore.upsertMatches}. */
export interface UpsertElvMatchInput {
  readonly itemKey: string;
  readonly sourceId: string;
  readonly mediaType: ElvMediaType;
  readonly imdbId: string;
  readonly confidence: number;
  readonly forceManual?: boolean;
  readonly updatedAt?: number;
}

/** Enriched IMDb title record persisted in `elv_titles`. */
export interface ElvTitleRecord {
  readonly imdbId: string;
  readonly mediaType: ElvMediaType;
  readonly originalTitle: string;
  readonly englishTitle: string | null;
  readonly localizedTitles: Readonly<Record<string, string>>;
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
  readonly synopses: Readonly<Record<string, string>>;
  readonly detailFetchedAt: number | null;
  readonly updatedAt: number;
}

/** Input row for {@link ElvEnrichmentStore.upsertTitles}; maps merge non-destructively. */
export interface UpsertElvTitleInput {
  readonly imdbId: string;
  readonly mediaType: ElvMediaType;
  readonly originalTitle: string;
  readonly englishTitle?: string | null;
  readonly localizedTitles?: Readonly<Record<string, string>>;
  readonly year?: number | null;
  readonly rating?: number | null;
  readonly votes?: number | null;
  readonly runtimeMin?: number | null;
  readonly genres?: readonly string[];
  readonly posterUrl?: string | null;
  readonly backdropUrl?: string | null;
  readonly trailerStreamUrl?: string | null;
  readonly trailerYoutubeId?: string | null;
  readonly director?: string | null;
  readonly cast?: readonly ElvCastMember[];
  readonly mltImdbIds?: readonly string[];
  readonly franchiseKey?: string | null;
  readonly franchiseName?: string | null;
  readonly franchiseOrder?: number | null;
  readonly synopses?: Readonly<Record<string, string>>;
  readonly detailFetchedAt?: number | null;
  readonly updatedAt?: number;
}

/** Combined match + IMDb title enrichment returned for visible catalog items. */
export interface ElvItemEnrichment {
  readonly itemKey: string;
  readonly sourceId: string;
  readonly mediaType: ElvMediaType;
  readonly imdbId: string;
  readonly confidence: number;
  readonly manualLock: boolean;
  readonly title: ElvTitleRecord | null;
}

/** One entry in an editorial/trending feed stored in `elv_feeds`. */
export interface ElvFeedItem {
  readonly imdbId: string;
  readonly title: string;
  readonly mediaType: ElvMediaType;
  readonly year?: number | null;
  readonly rating?: number | null;
  readonly posterUrl?: string | null;
  readonly genres?: readonly string[];
  readonly rank?: number;
}

/** Cached editorial/trending feed row in `elv_feeds`. */
export interface ElvFeedRecord {
  readonly feedKey: string;
  readonly items: readonly ElvFeedItem[];
  readonly updatedAt: number;
}

/** Observed stream quality & failure record stored in `elv_quality_memory`. */
export interface ElvQualityMemoryRecord {
  readonly itemKey: string;
  readonly actualWidth: number | null;
  readonly actualHeight: number | null;
  readonly actualVideoCodec: string | null;
  readonly actualAudioCodec: string | null;
  readonly actualAudioChannels: number | null;
  readonly actualHdr: string | null;
  readonly claimedLabel: string | null;
  readonly isFake4k: boolean;
  readonly failCount: number;
  readonly lastSuccessAt: number | null;
  readonly lastFailAt: number | null;
  readonly updatedAt: number;
}

/** Aggregated IMDb genre count across matched library items. */
export interface ElvGenreSummary {
  readonly genre: string;
  readonly itemCount: number;
}

/** Options for {@link openElvEnrichmentStore}. */
export interface OpenElvEnrichmentStoreOptions {
  readonly clock?: () => number;
}

/** Options for {@link ElvEnrichmentStore.searchMatchedItemKeysByAlias}. */
export interface SearchMatchedItemKeysByAliasOptions {
  readonly mediaType?: ElvMediaType;
  readonly limit?: number;
  readonly excludedSourceIds?: readonly string[];
}

/** Repository API over the isolated local `elv-enrichment.db` SQLite database (`#511`). */
export interface ElvEnrichmentStore {
  readonly driver: SqlDriver;
  upsertMatches(matches: readonly UpsertElvMatchInput[]): Promise<number>;
  setManualMatch(
    itemKey: string,
    sourceId: string,
    mediaType: ElvMediaType,
    imdbId: string,
    updatedAt?: number,
  ): Promise<void>;
  clearSourceMatches(sourceId: string): Promise<number>;
  getMatchForKey(itemKey: string): Promise<ElvMatchRecord | null>;
  listMatchedKeysForSet(itemKeys: readonly string[]): Promise<Set<string>>;
  listMatchesByImdbId(
    imdbId: string,
    mediaType: ElvMediaType,
    minConfidence?: number,
  ): Promise<ElvMatchRecord[]>;
  upsertTitles(titles: readonly UpsertElvTitleInput[]): Promise<void>;
  getEnrichmentForKeys(itemKeys: readonly string[]): Promise<Map<string, ElvItemEnrichment>>;
  getTitleByImdbId(imdbId: string): Promise<ElvTitleRecord | null>;
  listImdbGenres(
    mediaType: ElvMediaType,
    allowedItemKeys?: readonly string[] | ReadonlySet<string>,
  ): Promise<ElvGenreSummary[]>;
  listMatchedItemKeysForImdbIds(
    imdbIds: readonly string[],
    mediaType?: ElvMediaType,
  ): Promise<Map<string, readonly string[]>>;
  searchMatchedItemKeysByAlias(
    query: string,
    opts?: SearchMatchedItemKeysByAliasOptions,
  ): Promise<readonly string[]>;
  upsertFeed(feedKey: string, items: readonly ElvFeedItem[], updatedAt?: number): Promise<void>;
  getFeed(feedKey: string): Promise<ElvFeedRecord | null>;
  getQualityMemory(itemKey: string): Promise<ElvQualityMemoryRecord | null>;
  getQualityMemoryForKeys(
    itemKeys: readonly string[],
  ): Promise<Map<string, ElvQualityMemoryRecord>>;
  upsertQualityMemory(record: ElvQualityMemoryRecord): Promise<void>;
  wipeAll(): Promise<void>;
  close(): Promise<void>;
}

/** @internal Raw SQL row from `elv_item_matches`. */
export interface RawMatchRow {
  item_key: string;
  source_id: string;
  media_type: string;
  imdb_id: string;
  confidence: number;
  manual_lock: number;
  updated_at: number;
}

/** @internal Raw SQL row from `elv_titles`. */
export interface RawTitleRow {
  imdb_id: string;
  media_type: string;
  original_title: string;
  english_title: string | null;
  localized_titles_json: string;
  year: number | null;
  rating: number | null;
  votes: number | null;
  runtime_min: number | null;
  genres_json: string;
  poster_url: string | null;
  backdrop_url: string | null;
  trailer_stream_url: string | null;
  trailer_youtube_id: string | null;
  director: string | null;
  cast_json: string;
  mlt_imdb_ids_json: string;
  franchise_key: string | null;
  franchise_name: string | null;
  franchise_order: number | null;
  synopses_json: string;
  detail_fetched_at: number | null;
  updated_at: number;
}

/** @internal Raw SQL row from `elv_quality_memory`. */
export interface RawQualityRow {
  item_key: string;
  actual_width: number | null;
  actual_height: number | null;
  actual_video_codec: string | null;
  actual_audio_codec: string | null;
  actual_audio_channels: number | null;
  actual_hdr: string | null;
  claimed_label: string | null;
  is_fake_4k: number;
  fail_count: number;
  last_success_at: number | null;
  last_fail_at: number | null;
  updated_at: number;
}

/** @internal */
export function uniqueNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (t !== '' && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** @internal */
export function toMediaType(raw: string): ElvMediaType {
  return raw === 'series' ? 'series' : 'movie';
}

/** @internal */
export function clampConfidence(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(1, raw));
}

/** @internal */
export function parseStringMap(raw: string | null | undefined): Record<string, string> {
  if (raw === null || raw === undefined || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/** @internal */
export function parseStringArray(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  } catch {
    return [];
  }
}

function parseCastArray(raw: string | null | undefined): ElvCastMember[] {
  if (raw === null || raw === undefined || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ElvCastMember[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.name !== 'string' || e.name.trim() === '') continue;
      out.push({
        ...(typeof e.personId === 'string' && e.personId !== '' ? { personId: e.personId } : {}),
        name: e.name.trim(),
        ...(typeof e.character === 'string' && e.character !== ''
          ? { character: e.character }
          : {}),
        ...(typeof e.portraitUrl === 'string' && e.portraitUrl !== ''
          ? { portraitUrl: e.portraitUrl }
          : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function mergeStringMap(
  base: Readonly<Record<string, string>>,
  incoming: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = { ...base };
  if (incoming === undefined) return out;
  for (const [k, v] of Object.entries(incoming)) {
    const key = k.trim().toLowerCase();
    const val = typeof v === 'string' ? v.trim() : '';
    if (key !== '' && val !== '') out[key] = val;
  }
  return out;
}

function nonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** @internal */
export function mapMatchRow(r: RawMatchRow): ElvMatchRecord {
  return {
    itemKey: r.item_key,
    sourceId: r.source_id,
    mediaType: toMediaType(r.media_type),
    imdbId: r.imdb_id,
    confidence: r.confidence,
    manualLock: r.manual_lock !== 0,
    updatedAt: r.updated_at,
  };
}

/** @internal */
export function mapTitleRow(r: RawTitleRow): ElvTitleRecord {
  return {
    imdbId: r.imdb_id,
    mediaType: toMediaType(r.media_type),
    originalTitle: r.original_title,
    englishTitle: r.english_title,
    localizedTitles: parseStringMap(r.localized_titles_json),
    year: r.year,
    rating: r.rating,
    votes: r.votes,
    runtimeMin: r.runtime_min,
    genres: parseStringArray(r.genres_json),
    posterUrl: r.poster_url,
    backdropUrl: r.backdrop_url,
    trailerStreamUrl: r.trailer_stream_url,
    trailerYoutubeId: r.trailer_youtube_id,
    director: r.director,
    cast: parseCastArray(r.cast_json),
    mltImdbIds: parseStringArray(r.mlt_imdb_ids_json),
    franchiseKey: r.franchise_key,
    franchiseName: r.franchise_name,
    franchiseOrder: r.franchise_order,
    synopses: parseStringMap(r.synopses_json),
    detailFetchedAt: r.detail_fetched_at,
    updatedAt: r.updated_at,
  };
}

/** @internal */
export function mapQualityRow(r: RawQualityRow): ElvQualityMemoryRecord {
  return {
    itemKey: r.item_key,
    actualWidth: r.actual_width,
    actualHeight: r.actual_height,
    actualVideoCodec: r.actual_video_codec,
    actualAudioCodec: r.actual_audio_codec,
    actualAudioChannels: r.actual_audio_channels,
    actualHdr: r.actual_hdr,
    claimedLabel: r.claimed_label,
    isFake4k: r.is_fake_4k !== 0,
    failCount: r.fail_count,
    lastSuccessAt: r.last_success_at,
    lastFailAt: r.last_fail_at,
    updatedAt: r.updated_at,
  };
}

/** @internal */
export function mergeElvTitle(
  existing: ElvTitleRecord | undefined,
  incoming: UpsertElvTitleInput,
  imdbId: string,
  nowMs: number,
): ElvTitleRecord {
  const originalTitle = nonEmptyString(incoming.originalTitle) ?? existing?.originalTitle ?? imdbId;
  const genres =
    incoming.genres !== undefined && incoming.genres.length > 0
      ? uniqueNonEmpty(incoming.genres)
      : (existing?.genres ?? []);
  const cast =
    incoming.cast !== undefined && incoming.cast.length > 0
      ? incoming.cast
      : (existing?.cast ?? []);
  const mltImdbIds =
    incoming.mltImdbIds !== undefined && incoming.mltImdbIds.length > 0
      ? uniqueNonEmpty(
          incoming.mltImdbIds
            .map((id) => normalizeCatalogImdbId(id))
            .filter((id): id is string => id !== null),
        )
      : (existing?.mltImdbIds ?? []);

  return {
    imdbId,
    mediaType: incoming.mediaType,
    originalTitle,
    englishTitle: nonEmptyString(incoming.englishTitle) ?? existing?.englishTitle ?? null,
    localizedTitles: mergeStringMap(existing?.localizedTitles ?? {}, incoming.localizedTitles),
    year: incoming.year ?? existing?.year ?? null,
    rating: incoming.rating ?? existing?.rating ?? null,
    votes: incoming.votes ?? existing?.votes ?? null,
    runtimeMin: incoming.runtimeMin ?? existing?.runtimeMin ?? null,
    genres,
    posterUrl: nonEmptyString(incoming.posterUrl) ?? existing?.posterUrl ?? null,
    backdropUrl: nonEmptyString(incoming.backdropUrl) ?? existing?.backdropUrl ?? null,
    trailerStreamUrl:
      nonEmptyString(incoming.trailerStreamUrl) ?? existing?.trailerStreamUrl ?? null,
    trailerYoutubeId:
      nonEmptyString(incoming.trailerYoutubeId) ?? existing?.trailerYoutubeId ?? null,
    director: nonEmptyString(incoming.director) ?? existing?.director ?? null,
    cast,
    mltImdbIds,
    franchiseKey: nonEmptyString(incoming.franchiseKey) ?? existing?.franchiseKey ?? null,
    franchiseName: nonEmptyString(incoming.franchiseName) ?? existing?.franchiseName ?? null,
    franchiseOrder: incoming.franchiseOrder ?? existing?.franchiseOrder ?? null,
    synopses: mergeStringMap(existing?.synopses ?? {}, incoming.synopses),
    detailFetchedAt: incoming.detailFetchedAt ?? existing?.detailFetchedAt ?? null,
    updatedAt: incoming.updatedAt ?? nowMs,
  };
}

/** @internal */
export function titleToParams(t: ElvTitleRecord): SqlValue[] {
  return [
    t.imdbId,
    t.mediaType,
    t.originalTitle,
    t.englishTitle,
    JSON.stringify(t.localizedTitles),
    t.year,
    t.rating,
    t.votes,
    t.runtimeMin,
    JSON.stringify(t.genres),
    t.posterUrl,
    t.backdropUrl,
    t.trailerStreamUrl,
    t.trailerYoutubeId,
    t.director,
    JSON.stringify(t.cast),
    JSON.stringify(t.mltImdbIds),
    t.franchiseKey,
    t.franchiseName,
    t.franchiseOrder,
    JSON.stringify(t.synopses),
    t.detailFetchedAt,
    t.updatedAt,
  ];
}
