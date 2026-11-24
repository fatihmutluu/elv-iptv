import type { SqlDriver, SqlValue } from '@elv/domain';
import { isAdultKeywordMatch } from './parental-policy';
import {
  type ActiveParentalFilter,
  buildSqlItemRestrictionClause,
  isProgrammeRestricted,
} from './parental-repo';
import { backfillProgrammesFtsIfEmpty } from './schema-v12';
import { escapeLikePattern, MAX_SEARCH_LIMIT } from './search-channel-overrides';

/** An EPG programme search hit joined to a visible live channel (`#397`). */
export interface SearchProgrammeHit {
  readonly sourceId: string;
  readonly guideId: string;
  readonly channelKey: string;
  readonly channelName: string;
  readonly channelLogoUrl: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly start: number;
  readonly stop: number;
  readonly category: string | null;
  readonly isLiveNow: boolean;
}

/** A series episode search hit joined to a visible parent series (`#397`). */
export interface SearchEpisodeHit {
  readonly sourceId: string;
  readonly itemKey: string;
  readonly seriesKey: string;
  readonly seriesName: string;
  readonly season: number;
  readonly episode: number;
  readonly title: string;
  readonly posterUrl: string | null;
}

interface RawProgrammeSearchRow {
  source_id: string;
  guide_id: string;
  channel_key: string;
  channel_name: string;
  raw_channel_name?: string;
  channel_logo: string | null;
  title: string;
  description: string | null;
  start: number;
  stop: number;
  categories_json: string | null;
  genre: string | null;
  rating_value: string | null;
}

interface RawEpisodeSearchRow {
  source_id: string;
  item_key: string;
  series_key: string;
  series_name: string;
  season: number;
  episode: number;
  title: string;
  poster_url: string | null;
}

function searchFetchLimit(limit: number, filter: ActiveParentalFilter | null): number {
  return filter === null ? limit : Math.min(MAX_SEARCH_LIMIT * 4, Math.max(limit * 4, 60));
}

function parseProgrammeCategory(
  categoriesJson: string | null,
  genre: string | null,
): string | null {
  if (categoriesJson !== null && categoriesJson !== '') {
    try {
      const parsed = JSON.parse(categoriesJson) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry === 'string' && entry.trim() !== '') return entry.trim();
        }
      }
    } catch {
      // Fall through to genre
    }
  }
  return genre !== null && genre !== '' ? genre : null;
}

function mapProgrammeSearchRow(r: RawProgrammeSearchRow, nowMs: number): SearchProgrammeHit {
  return {
    sourceId: r.source_id,
    guideId: r.guide_id,
    channelKey: r.channel_key,
    channelName: r.channel_name,
    channelLogoUrl: r.channel_logo,
    title: r.title,
    description: r.description,
    start: r.start,
    stop: r.stop,
    category: parseProgrammeCategory(r.categories_json, r.genre),
    isLiveNow: r.start <= nowMs && r.stop > nowMs,
  };
}

function mapEpisodeSearchRow(r: RawEpisodeSearchRow): SearchEpisodeHit {
  return {
    sourceId: r.source_id,
    itemKey: r.item_key,
    seriesKey: r.series_key,
    seriesName: r.series_name,
    season: r.season,
    episode: r.episode,
    title: r.title,
    posterUrl: r.poster_url,
  };
}

const EPG_LIVE_JOIN = `JOIN live l
  ON l.source_id = p.source_id
 AND l.is_hidden = 0
 AND (
   l.key IN (
     SELECT cg.channel_key FROM channel_guide cg
      WHERE cg.source_id = p.source_id AND cg.guide_id = p.guide_id
   )
   OR (
     l.guide_id = p.guide_id
     AND NOT EXISTS (
       SELECT 1 FROM channel_guide cg2
        WHERE cg2.source_id = p.source_id AND cg2.guide_id = p.guide_id
     )
   )
 )`;

function filterProgrammeRows(
  rows: readonly RawProgrammeSearchRow[],
  limit: number,
  filter: ActiveParentalFilter | null,
): RawProgrammeSearchRow[] {
  if (filter === null) return rows.slice(0, limit);
  const out: RawProgrammeSearchRow[] = [];
  for (const r of rows) {
    if (
      filter.blockAdultKeywords &&
      (isAdultKeywordMatch(r.raw_channel_name ?? r.channel_name) ||
        isAdultKeywordMatch(r.channel_name))
    ) {
      continue;
    }
    if (isProgrammeRestricted(filter, r.title, r.description, r.rating_value)) continue;
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

async function queryEpgFts(
  db: SqlDriver,
  ftsQuery: string,
  foldedQuery: string,
  limit: number,
  sourceId: string | undefined,
  nowMs: number,
  profileId: string,
  filter: ActiveParentalFilter | null,
): Promise<RawProgrammeSearchRow[]> {
  const sourceClause = sourceId === undefined ? '' : ' AND p.source_id = ?';
  const restrict =
    filter === null
      ? { clause: '', params: [] as readonly SqlValue[] }
      : buildSqlItemRestrictionClause(filter, 'live', 'l.source_id', 'l.key', sourceId);
  const params: SqlValue[] = [
    profileId,
    ftsQuery,
    ...(sourceId === undefined ? [] : [sourceId]),
    ...restrict.params,
    nowMs,
    nowMs,
    nowMs,
    foldedQuery,
    foldedQuery,
    foldedQuery,
    searchFetchLimit(limit, filter),
  ];
  return db.all<RawProgrammeSearchRow>(
    `SELECT p.source_id,
            p.guide_id,
            l.key AS channel_key,
            COALESCE(NULLIF(co.custom_name, ''), l.name) AS channel_name,
            l.name AS raw_channel_name,
            l.logo AS channel_logo,
            p.title,
            p.description,
            p.start,
            p.stop,
            p.categories_json,
            p.genre,
            p.rating_value
       FROM programmes_fts
       JOIN programmes p
         ON p.source_id = programmes_fts.source_id
        AND p.guide_id = programmes_fts.guide_id
        AND p.start = programmes_fts.start
       JOIN sources s ON s.id = p.source_id AND s.deleting = 0
       ${EPG_LIVE_JOIN}
       LEFT JOIN channel_overrides co ON co.profile_id = ? AND co.item_key = l.key
      WHERE programmes_fts MATCH ? AND COALESCE(co.is_hidden, 0) = 0${sourceClause}${restrict.clause}
      ORDER BY CASE WHEN p.stop >= ? THEN 0 ELSE 1 END ASC,
               CASE WHEN p.start <= ? AND p.stop > ? THEN 0 ELSE 1 END ASC,
               CASE
                 WHEN programmes_fts.title_fold = ? THEN 0
                 WHEN substr(programmes_fts.title_fold, 1, length(?)) = ? THEN 1
                 ELSE 2
               END ASC,
               bm25(programmes_fts, 0.0, 0.0, 0.0, 0.0, 4.0, 1.0) ASC,
               p.start ASC,
               channel_name ASC
      LIMIT ?`,
    params,
  );
}

/** @internal Searches EPG programmes joined to visible live channels with per-profile `channel_overrides`. */
export async function searchEpg(
  db: SqlDriver,
  ftsQuery: string,
  foldedQuery: string,
  tokens: readonly string[],
  limit: number,
  sourceId: string | undefined,
  nowMs: number,
  profileId: string,
  filter: ActiveParentalFilter | null,
): Promise<SearchProgrammeHit[]> {
  let rows = await queryEpgFts(
    db,
    ftsQuery,
    foldedQuery,
    limit,
    sourceId,
    nowMs,
    profileId,
    filter,
  );
  if (rows.length === 0) {
    const backfilled = await backfillProgrammesFtsIfEmpty(db);
    if (backfilled) {
      rows = await queryEpgFts(
        db,
        ftsQuery,
        foldedQuery,
        limit,
        sourceId,
        nowMs,
        profileId,
        filter,
      );
    }
  }
  const filteredFts = filterProgrammeRows(rows, limit, filter);
  if (filteredFts.length > 0) {
    return filteredFts.map((r) => mapProgrammeSearchRow(r, nowMs));
  }
  if (rows.length > 0) return [];

  const sourceClause = sourceId === undefined ? '' : ' AND p.source_id = ?';
  const restrict =
    filter === null
      ? { clause: '', params: [] as readonly SqlValue[] }
      : buildSqlItemRestrictionClause(filter, 'live', 'l.source_id', 'l.key', sourceId);
  const likeClauses = tokens
    .map(
      () =>
        "(programmes_fts.title_fold LIKE ? ESCAPE '\\' OR programmes_fts.description_fold LIKE ? ESCAPE '\\')",
    )
    .join(' AND ');
  const tokenParams: SqlValue[] = [];
  for (const tok of tokens) {
    const pat = `%${escapeLikePattern(tok)}%`;
    tokenParams.push(pat, pat);
  }
  const params: SqlValue[] = [
    profileId,
    ...(sourceId === undefined ? [] : [sourceId]),
    ...restrict.params,
    ...tokenParams,
    nowMs,
    nowMs,
    nowMs,
    searchFetchLimit(limit, filter),
  ];
  const fallbackRows = await db.all<RawProgrammeSearchRow>(
    `SELECT p.source_id,
            p.guide_id,
            l.key AS channel_key,
            COALESCE(NULLIF(co.custom_name, ''), l.name) AS channel_name,
            l.name AS raw_channel_name,
            l.logo AS channel_logo,
            p.title,
            p.description,
            p.start,
            p.stop,
            p.categories_json,
            p.genre,
            p.rating_value
       FROM programmes_fts
       JOIN programmes p
         ON p.source_id = programmes_fts.source_id
        AND p.guide_id = programmes_fts.guide_id
        AND p.start = programmes_fts.start
       JOIN sources s ON s.id = p.source_id AND s.deleting = 0
       ${EPG_LIVE_JOIN}
       LEFT JOIN channel_overrides co ON co.profile_id = ? AND co.item_key = l.key
      WHERE COALESCE(co.is_hidden, 0) = 0${sourceClause}${restrict.clause} AND ${likeClauses}
      ORDER BY CASE WHEN p.stop >= ? THEN 0 ELSE 1 END ASC,
               CASE WHEN p.start <= ? AND p.stop > ? THEN 0 ELSE 1 END ASC,
               p.start ASC,
               channel_name ASC
      LIMIT ?`,
    params,
  );
  return filterProgrammeRows(fallbackRows, limit, filter).map((r) =>
    mapProgrammeSearchRow(r, nowMs),
  );
}

function filterEpisodeRows(
  rows: readonly RawEpisodeSearchRow[],
  limit: number,
  filter: ActiveParentalFilter | null,
): RawEpisodeSearchRow[] {
  if (filter === null) return rows.slice(0, limit);
  const out: RawEpisodeSearchRow[] = [];
  for (const r of rows) {
    if (filter.lockedItemKeys.has(r.item_key) || filter.lockedItemKeys.has(r.series_key)) continue;
    if (
      filter.blockAdultKeywords &&
      (isAdultKeywordMatch(r.series_name) || isAdultKeywordMatch(r.title))
    ) {
      continue;
    }
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/** @internal Searches series episodes via `episodes_fts` with bounded `LIKE` fallback. */
export async function searchEpisodes(
  db: SqlDriver,
  ftsQuery: string,
  foldedQuery: string,
  tokens: readonly string[],
  limit: number,
  sourceId: string | undefined,
  filter: ActiveParentalFilter | null,
): Promise<SearchEpisodeHit[]> {
  const sourceClause = sourceId === undefined ? '' : ' AND e.source_id = ?';
  const restrict =
    filter === null
      ? { clause: '', params: [] as readonly SqlValue[] }
      : buildSqlItemRestrictionClause(filter, 'series', 'ser.source_id', 'ser.key', sourceId);
  const fetchLimit = searchFetchLimit(limit, filter);
  const params: SqlValue[] = [
    ftsQuery,
    ...(sourceId === undefined ? [] : [sourceId]),
    ...restrict.params,
    foldedQuery,
    foldedQuery,
    foldedQuery,
    fetchLimit,
  ];
  const rows = await db.all<RawEpisodeSearchRow>(
    `SELECT e.source_id,
            e.key AS item_key,
            e.series_key,
            ser.name AS series_name,
            COALESCE(e.season, 0) AS season,
            COALESCE(e.episode, 0) AS episode,
            COALESCE(e.title, '') AS title,
            ser.cover AS poster_url
       FROM episodes_fts
       JOIN episodes e ON e.id = episodes_fts.rowid
       JOIN series ser ON ser.source_id = e.source_id AND ser.key = e.series_key AND ser.is_hidden = 0
       JOIN sources s ON s.id = e.source_id AND s.deleting = 0
      WHERE episodes_fts MATCH ?${sourceClause}${restrict.clause}
      ORDER BY CASE
                 WHEN e.title_fold = ? THEN 0
                 WHEN substr(e.title_fold, 1, length(?)) = ? THEN 1
                 ELSE 2
               END,
               bm25(episodes_fts),
               ser.name ASC,
               COALESCE(e.season, 0) ASC,
               COALESCE(e.episode, 0) ASC
      LIMIT ?`,
    params,
  );
  const filteredFts = filterEpisodeRows(rows, limit, filter);
  if (filteredFts.length > 0) return filteredFts.map(mapEpisodeSearchRow);
  if (rows.length > 0) return [];

  const likeClauses = tokens.map(() => "e.title_fold LIKE ? ESCAPE '\\'").join(' AND ');
  const fallbackParams: SqlValue[] = [
    ...(sourceId === undefined ? [] : [sourceId]),
    ...restrict.params,
    ...tokens.map((tok) => `%${escapeLikePattern(tok)}%`),
    fetchLimit,
  ];
  const fallbackRows = await db.all<RawEpisodeSearchRow>(
    `SELECT e.source_id,
            e.key AS item_key,
            e.series_key,
            ser.name AS series_name,
            COALESCE(e.season, 0) AS season,
            COALESCE(e.episode, 0) AS episode,
            COALESCE(e.title, '') AS title,
            ser.cover AS poster_url
       FROM episodes e
       JOIN series ser ON ser.source_id = e.source_id AND ser.key = e.series_key AND ser.is_hidden = 0
       JOIN sources s ON s.id = e.source_id AND s.deleting = 0
      WHERE 1 = 1${sourceClause}${restrict.clause} AND ${likeClauses}
      ORDER BY ser.name COLLATE NOCASE ASC,
               COALESCE(e.season, 0) ASC,
               COALESCE(e.episode, 0) ASC,
               e.id ASC
      LIMIT ?`,
    fallbackParams,
  );
  return filterEpisodeRows(fallbackRows, limit, filter).map(mapEpisodeSearchRow);
}
