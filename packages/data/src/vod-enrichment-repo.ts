import type { SqlDriver } from '@elv/domain';
import { sourceOfKey } from './queries-shared';
import {
  lookupLocalVodIndex,
  type VodEnrichmentFetcher,
  type VodEnrichmentPayload,
} from './vod-rating-index';
import { cleanVodTitle } from './vod-title-cleaner';

/** Default SQLite cache lifetime for VOD enrichment rows (7 days). */
export const DEFAULT_VOD_ENRICHMENT_TTL_MS = 7 * 86_400_000;

/** Persisted VOD/series metadata enrichment row (`#215`). */
export interface VodEnrichmentRecord {
  readonly itemKey: string;
  readonly sourceId: string;
  readonly cleanTitle: string;
  readonly releaseYear: number | null;
  readonly rating: number | null;
  readonly ratingSource: string | null;
  readonly genres: readonly string[];
  readonly synopsis: string | null;
  readonly certification: string | null;
  readonly fetchedAt: number;
  readonly expiresAt: number;
}

/** Options for {@link enrichVodItem}. */
export interface EnrichVodItemOptions {
  /** Explicit user opt-in gate; when `false`, returns `null` with zero DB writes and zero network calls. */
  readonly enabled?: boolean;
  /** Current epoch milliseconds (defaults to `Date.now()`). */
  readonly nowMs?: number;
  /** Cache TTL in milliseconds (defaults to {@link DEFAULT_VOD_ENRICHMENT_TTL_MS}). */
  readonly ttlMs?: number;
  /** Optional pluggable key-free metadata adapter called only on local-index miss when enabled. */
  readonly remoteFetcher?: VodEnrichmentFetcher;
}

interface RawEnrichmentRow {
  item_key: string;
  source_id: string;
  clean_title: string;
  release_year: number | null;
  rating: number | null;
  rating_source: string | null;
  genres_json: string | null;
  synopsis: string | null;
  certification: string | null;
  fetched_at: number;
  expires_at: number;
}

function parseGenres(raw: string | null): readonly string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((g): g is string => typeof g === 'string' && g.trim() !== '');
  } catch {
    return [];
  }
}

function mapRow(r: RawEnrichmentRow): VodEnrichmentRecord {
  return {
    itemKey: r.item_key,
    sourceId: r.source_id,
    cleanTitle: r.clean_title,
    releaseYear: r.release_year,
    rating: r.rating,
    ratingSource: r.rating_source,
    genres: parseGenres(r.genres_json),
    synopsis: r.synopsis,
    certification: r.certification,
    fetchedAt: r.fetched_at,
    expiresAt: r.expires_at,
  };
}

function sanitizeRating(raw: number | null | undefined): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 10) return null;
  return Math.round(raw * 10) / 10;
}

/** Reads a non-expired cached VOD enrichment record from SQLite, or `null` when missing/expired. */
export async function getVodEnrichment(
  db: SqlDriver,
  itemKey: string,
  nowMs: number = Date.now(),
): Promise<VodEnrichmentRecord | null> {
  const rows = await db.all<RawEnrichmentRow>(
    `SELECT item_key, source_id, clean_title, release_year, rating, rating_source,
            genres_json, synopsis, certification, fetched_at, expires_at
       FROM vod_enrichment
      WHERE item_key = ? AND expires_at > ?
      LIMIT 1`,
    [itemKey, nowMs],
  );
  const row = rows[0];
  return row === undefined ? null : mapRow(row);
}

/**
 * Resolves and caches key-free VOD/series metadata enrichment (`#215`):
 * - When `opts?.enabled === false`, returns `null` immediately with zero DB writes and zero network calls.
 * - Returns valid cached rows from `vod_enrichment` until `expires_at`.
 * - Otherwise cleans the catalog title/year, checks the bundled offline rating index, optionally calls
 *   `remoteFetcher` on a local miss, and persists the result with a 7-day TTL.
 */
export async function enrichVodItem(
  db: SqlDriver,
  itemKey: string,
  opts?: EnrichVodItemOptions,
): Promise<VodEnrichmentRecord | null> {
  if (opts?.enabled === false) return null;

  const nowMs = opts?.nowMs ?? Date.now();
  const cached = await getVodEnrichment(db, itemKey, nowMs);
  if (cached !== null) return cached;

  const sourceId = sourceOfKey(itemKey);
  if (sourceId === undefined) return null;

  const items = await db.all<{
    kind: 'movie' | 'series';
    name: string;
    year: number | null;
  }>(
    `SELECT 'movie' AS kind, name, year FROM movies WHERE source_id = ? AND key = ?
     UNION ALL
     SELECT 'series' AS kind, name, year FROM series WHERE source_id = ? AND key = ?
     LIMIT 1`,
    [sourceId, itemKey, sourceId, itemKey],
  );
  const item = items[0];
  if (item === undefined) return null;

  const cleaned = cleanVodTitle(item.name, item.year);
  const query = {
    cleanTitle: cleaned.cleanTitle,
    foldedTitle: cleaned.foldedTitle,
    releaseYear: cleaned.releaseYear,
    kind: item.kind,
  } as const;

  let payload: VodEnrichmentPayload | null = lookupLocalVodIndex(query);
  if (payload === null && opts?.remoteFetcher !== undefined) {
    try {
      payload = await opts.remoteFetcher(query);
    } catch {
      payload = null;
    }
  }

  const ttlMs =
    opts?.ttlMs !== undefined && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
      ? Math.floor(opts.ttlMs)
      : DEFAULT_VOD_ENRICHMENT_TTL_MS;
  const expiresAt = nowMs + ttlMs;
  const releaseYear = payload?.releaseYear ?? cleaned.releaseYear;
  const rating = sanitizeRating(payload?.rating);
  const ratingSource = payload?.ratingSource?.trim() || null;
  const genres = (payload?.genres ?? []).map((g) => g.trim()).filter((g) => g.length > 0);
  const genresJson = genres.length > 0 ? JSON.stringify(genres) : null;
  const synopsis = payload?.synopsis?.trim() || null;
  const certification = payload?.certification?.trim() || null;

  await db.run(
    `INSERT INTO vod_enrichment (
       item_key, source_id, clean_title, release_year, rating, rating_source,
       genres_json, synopsis, certification, fetched_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_key) DO UPDATE SET
       source_id = excluded.source_id,
       clean_title = excluded.clean_title,
       release_year = excluded.release_year,
       rating = excluded.rating,
       rating_source = excluded.rating_source,
       genres_json = excluded.genres_json,
       synopsis = excluded.synopsis,
       certification = excluded.certification,
       fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at`,
    [
      itemKey,
      sourceId,
      cleaned.cleanTitle,
      releaseYear,
      rating,
      ratingSource,
      genresJson,
      synopsis,
      certification,
      nowMs,
      expiresAt,
    ],
  );

  return {
    itemKey,
    sourceId,
    cleanTitle: cleaned.cleanTitle,
    releaseYear,
    rating,
    ratingSource,
    genres,
    synopsis,
    certification,
    fetchedAt: nowMs,
    expiresAt,
  };
}
