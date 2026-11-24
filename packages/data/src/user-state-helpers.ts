import type { SqlDriver, SqlValue } from '@elv/domain';
import { sourceOfKey } from './queries-shared';

/** Default profile identifier used before multi-profile selection is configured. */
export const DEFAULT_PROFILE_ID = 'default';

const MAX_LIST_LIMIT = 100;

/** Content kind stored in `watch_progress` and `favorites`. */
export type UserItemKind = 'live' | 'movie' | 'series' | 'episode';

const USER_ITEM_KINDS = new Set<UserItemKind>(['live', 'movie', 'series', 'episode']);

/** One row of the `watch_progress` table. */
export interface WatchProgressRow {
  profileId: string;
  sourceId: string;
  itemKey: string;
  kind: UserItemKind;
  title: string;
  subtitle: string | null;
  logo: string | null;
  seriesKey: string | null;
  season: number | null;
  episode: number | null;
  positionMs: number;
  durationMs: number;
  watched: boolean;
  updatedAt: number;
  /** Movie version group key when synced across multi-version VOD titles (`#404`). */
  versionGroupKey?: string | null;
  /** Most recently played version item key within `versionGroupKey` (`#404`). */
  preferredItemKey?: string | null;
}

/** One row of the `favorites` table. */
export interface FavoriteRow {
  profileId: string;
  sourceId: string;
  itemKey: string;
  kind: UserItemKind;
  title: string;
  logo: string | null;
  year: number | null;
  rating: number | null;
  addedAt: number;
}

/** @internal Raw SQLite shape for `watch_progress`. */
export interface RawProgressRow {
  profile_id: string;
  source_id: string;
  item_key: string;
  kind: UserItemKind;
  title: string;
  subtitle: string | null;
  logo: string | null;
  series_key: string | null;
  season: number | null;
  episode: number | null;
  position_ms: number;
  duration_ms: number;
  watched: number;
  updated_at: number;
  version_group_key?: string | null;
  preferred_item_key?: string | null;
}

/** @internal Raw SQLite shape for `favorites`. */
export interface RawFavoriteRow {
  profile_id: string;
  source_id: string;
  item_key: string;
  kind: UserItemKind;
  title: string;
  logo: string | null;
  year: number | null;
  rating: number | null;
  added_at: number;
}

/** @internal Catalog metadata hydrated when marking an unplayed item watched via UPSERT. */
export interface CatalogWatchedSeed {
  readonly sourceId: string;
  readonly kind: UserItemKind;
  readonly title: string;
  readonly subtitle: string | null;
  readonly logo: string | null;
  readonly seriesKey: string | null;
  readonly season: number | null;
  readonly episode: number | null;
}

interface RawCatalogSeedRow {
  source_id: string;
  kind: UserItemKind;
  title: string;
  subtitle: string | null;
  logo: string | null;
  series_key: string | null;
  season: number | null;
  episode: number | null;
}

/** @internal Normalizes blank profile IDs to {@link DEFAULT_PROFILE_ID}. */
export const normalizeProfileId = (profileId?: string): string => {
  const trimmed = profileId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_PROFILE_ID;
};

/** @internal Clamps a millisecond position or duration to a non-negative integer. */
export const clampMs = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);

/** @internal Clamps list limits to `[0, 100]`. */
export const clampLimit = (limit: number | undefined, fallback: number): number => {
  const n = limit === undefined || !Number.isFinite(limit) ? fallback : Math.floor(limit);
  return Math.min(MAX_LIST_LIMIT, Math.max(0, n));
};

/** @internal Coerces finite numeric values to truncated integers or `null`. */
export const optInt = (v: number | null | undefined): number | null =>
  v !== undefined && v !== null && Number.isFinite(v) ? Math.trunc(v) : null;

/** @internal Coerces finite numeric values to floats or `null`. */
export const optFloat = (v: number | null | undefined): number | null =>
  v !== undefined && v !== null && Number.isFinite(v) ? v : null;

/** @internal Maps a raw SQLite `watch_progress` row to {@link WatchProgressRow}. */
export const mapProgressRow = (r: RawProgressRow): WatchProgressRow => ({
  profileId: r.profile_id,
  sourceId: r.source_id,
  itemKey: r.item_key,
  kind: r.kind,
  title: r.title,
  subtitle: r.subtitle,
  logo: r.logo,
  seriesKey: r.series_key,
  season: r.season,
  episode: r.episode,
  positionMs: r.position_ms,
  durationMs: r.duration_ms,
  watched: r.watched !== 0,
  updatedAt: r.updated_at,
  ...(r.version_group_key !== undefined &&
  r.version_group_key !== null &&
  r.version_group_key !== ''
    ? { versionGroupKey: r.version_group_key }
    : {}),
  ...(r.preferred_item_key !== undefined &&
  r.preferred_item_key !== null &&
  r.preferred_item_key !== ''
    ? { preferredItemKey: r.preferred_item_key }
    : {}),
});

/** @internal Maps a raw SQLite `favorites` row to {@link FavoriteRow}. */
export const mapFavoriteRow = (r: RawFavoriteRow): FavoriteRow => ({
  profileId: r.profile_id,
  sourceId: r.source_id,
  itemKey: r.item_key,
  kind: r.kind,
  title: r.title,
  logo: r.logo,
  year: r.year,
  rating: r.rating,
  addedAt: r.added_at,
});

/** @internal Validates required non-empty item metadata for user-state writes. */
export const hasValidMeta = (input: {
  sourceId: string;
  itemKey: string;
  title: string;
  kind: UserItemKind;
}): boolean =>
  input.sourceId.trim() !== '' &&
  input.itemKey.trim() !== '' &&
  input.title.trim() !== '' &&
  USER_ITEM_KINDS.has(input.kind);

const LOOKUP_BY_SOURCE_AND_KEY = `
SELECT source_id, 'movie' AS kind, name AS title, NULL AS subtitle, logo,
       NULL AS series_key, NULL AS season, NULL AS episode
  FROM movies WHERE source_id = ? AND key = ?
UNION ALL
SELECT source_id, 'series', name, NULL, cover, NULL, NULL, NULL
  FROM series WHERE source_id = ? AND key = ?
UNION ALL
SELECT e.source_id, 'episode',
       COALESCE(NULLIF(TRIM(e.title), ''), NULLIF(TRIM(s.name), ''), e.key),
       NULL, s.cover, e.series_key, e.season, e.episode
  FROM episodes e
  LEFT JOIN series s ON s.source_id = e.source_id AND s.key = e.series_key
 WHERE e.source_id = ? AND e.key = ?
UNION ALL
SELECT source_id, 'live', name, NULL, logo, NULL, NULL, NULL
  FROM live WHERE source_id = ? AND key = ?
LIMIT 1`;

const LOOKUP_BY_KEY_ONLY = `
SELECT source_id, 'movie' AS kind, name AS title, NULL AS subtitle, logo,
       NULL AS series_key, NULL AS season, NULL AS episode
  FROM movies WHERE key = ?
UNION ALL
SELECT source_id, 'series', name, NULL, cover, NULL, NULL, NULL
  FROM series WHERE key = ?
UNION ALL
SELECT e.source_id, 'episode',
       COALESCE(NULLIF(TRIM(e.title), ''), NULLIF(TRIM(s.name), ''), e.key),
       NULL, s.cover, e.series_key, e.season, e.episode
  FROM episodes e
  LEFT JOIN series s ON s.source_id = e.source_id AND s.key = e.series_key
 WHERE e.key = ?
UNION ALL
SELECT source_id, 'live', name, NULL, logo, NULL, NULL, NULL
  FROM live WHERE key = ?
LIMIT 1`;

/**
 * @internal Looks up raw catalog metadata (`movies`, `series`, `episodes`, `live`) for an item key
 * so `setItemWatched(..., true)` can UPSERT a `watch_progress` row for unplayed items without
 * ever persisting resolved M3U credentials.
 */
export async function lookupCatalogItemForWatched(
  db: SqlDriver,
  itemKey: string,
): Promise<CatalogWatchedSeed | null> {
  if (itemKey.trim() === '') return null;
  const sourceId = sourceOfKey(itemKey);
  const sql = sourceId === undefined ? LOOKUP_BY_KEY_ONLY : LOOKUP_BY_SOURCE_AND_KEY;
  const params: SqlValue[] =
    sourceId === undefined
      ? [itemKey, itemKey, itemKey, itemKey]
      : [sourceId, itemKey, sourceId, itemKey, sourceId, itemKey, sourceId, itemKey];
  const rows = await db.all<RawCatalogSeedRow>(sql, params);
  const r = rows[0];
  if (r === undefined) return null;
  return {
    sourceId: r.source_id,
    kind: r.kind,
    title: r.title,
    subtitle: r.subtitle,
    logo: r.logo,
    seriesKey: r.series_key,
    season: r.season,
    episode: r.episode,
  };
}
