import { elvError, err, ok, type Result, type SqlDriver } from '@elv/domain';
import { resolveSafeStorageLogo } from './queries';

/** Default profile identifier used before multi-profile selection is configured. */
export const DEFAULT_PROFILE_ID = 'default';

/** Fraction of duration watched at or above which an item is considered completed. */
export const WATCHED_THRESHOLD_RATIO = 0.9;

/** Minimum playback position (ms) required before an item appears in Continue Watching. */
export const MIN_RESUME_POSITION_MS = 10_000;

/** Smart rewind offset (ms) applied when resuming an in-progress item. */
export const SMART_RESUME_REWIND_MS = 5_000;

const MAX_LIST_LIMIT = 100;
const MAX_PROGRESS_KEYS = 200;
const MAX_FAVORITE_KEYS = 2_000;
const USER_ITEM_KINDS = new Set<UserItemKind>(['live', 'movie', 'series', 'episode']);

/** Content kind stored in `watch_progress` and `favorites`. */
export type UserItemKind = 'live' | 'movie' | 'series' | 'episode';

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
}

/** Input for {@link saveWatchProgress}. */
export interface SaveProgressInput {
  profileId?: string;
  sourceId: string;
  itemKey: string;
  kind: UserItemKind;
  title: string;
  subtitle?: string | null;
  logo?: string | null;
  seriesKey?: string | null;
  season?: number | null;
  episode?: number | null;
  positionMs: number;
  durationMs: number;
  watched?: boolean;
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

/** Input for {@link toggleFavorite}. */
export interface ToggleFavoriteInput {
  profileId?: string;
  sourceId: string;
  itemKey: string;
  kind: UserItemKind;
  title: string;
  logo?: string | null;
  year?: number | null;
  rating?: number | null;
}

interface RawProgressRow {
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
}

interface RawFavoriteRow {
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

const PROGRESS_COLS =
  'profile_id, source_id, item_key, kind, title, subtitle, logo, series_key, season, episode, position_ms, duration_ms, watched, updated_at';
const PROGRESS_SELECT = `SELECT ${PROGRESS_COLS} FROM watch_progress`;
const FAVORITE_SELECT =
  'SELECT profile_id, source_id, item_key, kind, title, logo, year, rating, added_at FROM favorites';

const UPSERT_PROGRESS = `INSERT INTO watch_progress (
  profile_id, source_id, item_key, kind, title, subtitle, logo,
  series_key, season, episode, position_ms, duration_ms, watched, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(profile_id, item_key) DO UPDATE SET
  source_id = excluded.source_id, kind = excluded.kind, title = excluded.title,
  subtitle = excluded.subtitle, logo = excluded.logo, series_key = excluded.series_key,
  season = excluded.season, episode = excluded.episode, position_ms = excluded.position_ms,
  duration_ms = excluded.duration_ms, watched = excluded.watched, updated_at = excluded.updated_at`;

const normalizeProfileId = (profileId?: string): string => {
  const trimmed = profileId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_PROFILE_ID;
};
const clampMs = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const clampLimit = (limit: number | undefined, fallback: number): number => {
  const n = limit === undefined || !Number.isFinite(limit) ? fallback : Math.floor(limit);
  return Math.min(MAX_LIST_LIMIT, Math.max(0, n));
};
const optInt = (v: number | null | undefined): number | null =>
  v !== undefined && v !== null && Number.isFinite(v) ? Math.trunc(v) : null;
const optFloat = (v: number | null | undefined): number | null =>
  v !== undefined && v !== null && Number.isFinite(v) ? v : null;

const mapProgressRow = (r: RawProgressRow): WatchProgressRow => ({
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
});

const mapFavoriteRow = (r: RawFavoriteRow): FavoriteRow => ({
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

const hasValidMeta = (input: {
  sourceId: string;
  itemKey: string;
  title: string;
  kind: UserItemKind;
}): boolean =>
  input.sourceId.trim() !== '' &&
  input.itemKey.trim() !== '' &&
  input.title.trim() !== '' &&
  USER_ITEM_KINDS.has(input.kind);

/** Returns `true` when playback has reached or passed {@link WATCHED_THRESHOLD_RATIO}. */
export function isCompletedProgress(positionMs: number, durationMs: number): boolean {
  if (!Number.isFinite(positionMs) || !Number.isFinite(durationMs)) return false;
  return durationMs > 0 && positionMs >= 0 && positionMs / durationMs >= WATCHED_THRESHOLD_RATIO;
}

/**
 * Computes the smart resume position (ms) for an item: `0` when watched or below
 * {@link MIN_RESUME_POSITION_MS}, otherwise rewound by {@link SMART_RESUME_REWIND_MS}.
 */
export function computeResumePositionMs(
  row: Pick<WatchProgressRow, 'positionMs' | 'watched'>,
): number {
  if (row.watched || !Number.isFinite(row.positionMs) || row.positionMs < MIN_RESUME_POSITION_MS) {
    return 0;
  }
  return Math.max(0, Math.round(row.positionMs) - SMART_RESUME_REWIND_MS);
}

/** Upserts a playback progress snapshot for `(profileId, itemKey)`. */
export async function saveWatchProgress(
  db: SqlDriver,
  input: SaveProgressInput,
  clock: () => number = Date.now,
): Promise<Result<WatchProgressRow>> {
  if (!hasValidMeta(input)) return err(elvError('source-format', 'invalid-progress'));
  const positionMs = clampMs(input.positionMs);
  const durationMs = clampMs(input.durationMs);
  const row: WatchProgressRow = {
    profileId: normalizeProfileId(input.profileId),
    sourceId: input.sourceId,
    itemKey: input.itemKey,
    kind: input.kind,
    title: input.title,
    subtitle: input.subtitle ?? null,
    logo: await resolveSafeStorageLogo(db, input),
    seriesKey: input.seriesKey?.trim() || null,
    season: optInt(input.season),
    episode: optInt(input.episode),
    positionMs,
    durationMs,
    watched: input.watched ?? isCompletedProgress(positionMs, durationMs),
    updatedAt: Math.round(clock()),
  };
  await db.run(UPSERT_PROGRESS, [
    row.profileId,
    row.sourceId,
    row.itemKey,
    row.kind,
    row.title,
    row.subtitle,
    row.logo,
    row.seriesKey,
    row.season,
    row.episode,
    row.positionMs,
    row.durationMs,
    row.watched ? 1 : 0,
    row.updatedAt,
  ]);
  return ok(row);
}

/**
 * Explicitly marks an existing watch progress row watched or unwatched. Marking unwatched resets
 * `position_ms` to `0`. Safe no-op if no row exists for `(profileId, itemKey)`.
 */
export async function setItemWatched(
  db: SqlDriver,
  itemKey: string,
  watched: boolean,
  clock: () => number = Date.now,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<Result<void>> {
  const sql = watched
    ? 'UPDATE watch_progress SET watched = 1, updated_at = ? WHERE profile_id = ? AND item_key = ?'
    : 'UPDATE watch_progress SET watched = 0, position_ms = 0, updated_at = ? WHERE profile_id = ? AND item_key = ?';
  await db.run(sql, [Math.round(clock()), normalizeProfileId(profileId), itemKey]);
  return ok(undefined);
}

/** Reads a single watch progress row by `(profileId, itemKey)`, or `null` when absent. */
export async function getWatchProgress(
  db: SqlDriver,
  itemKey: string,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<WatchProgressRow | null> {
  if (itemKey === '') return null;
  const rows = await db.all<RawProgressRow>(
    `${PROGRESS_SELECT} WHERE profile_id = ? AND item_key = ? LIMIT 1`,
    [normalizeProfileId(profileId), itemKey],
  );
  return rows[0] === undefined ? null : mapProgressRow(rows[0]);
}

/** Lists in-progress, unwatched items at or above {@link MIN_RESUME_POSITION_MS}, deduplicated per series, most recent first. */
export async function listContinueWatching(
  db: SqlDriver,
  limit = 24,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<WatchProgressRow[]> {
  const clamped = clampLimit(limit, 24);
  if (clamped === 0) return [];
  const rows = await db.all<RawProgressRow>(
    `SELECT ${PROGRESS_COLS} FROM (
       SELECT ${PROGRESS_COLS}, ROW_NUMBER() OVER (PARTITION BY COALESCE(NULLIF(series_key, ''), item_key) ORDER BY updated_at DESC, item_key ASC) AS rn
         FROM watch_progress WHERE profile_id = ? AND watched = 0 AND position_ms >= ?
     ) WHERE rn = 1 ORDER BY updated_at DESC, item_key ASC LIMIT ?`,
    [normalizeProfileId(profileId), MIN_RESUME_POSITION_MS, clamped],
  );
  return rows.map(mapProgressRow);
}

/** Fetches watch progress rows for up to 200 distinct item keys in one indexed lookup. */
export async function listProgressByKeys(
  db: SqlDriver,
  itemKeys: readonly string[],
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<WatchProgressRow[]> {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const key of itemKeys) {
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
    if (unique.length >= MAX_PROGRESS_KEYS) break;
  }
  if (unique.length === 0) return [];
  const placeholders = unique.map(() => '?').join(', ');
  const rows = await db.all<RawProgressRow>(
    `${PROGRESS_SELECT} WHERE profile_id = ? AND item_key IN (${placeholders})`,
    [normalizeProfileId(profileId), ...unique],
  );
  return rows.map(mapProgressRow);
}

/** Deletes a watch progress row for `(profileId, itemKey)`. */
export async function clearWatchProgress(
  db: SqlDriver,
  itemKey: string,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<Result<void>> {
  await db.run('DELETE FROM watch_progress WHERE profile_id = ? AND item_key = ?', [
    normalizeProfileId(profileId),
    itemKey,
  ]);
  return ok(undefined);
}

const UPSERT_FAVORITE = `INSERT INTO favorites (
  profile_id, source_id, item_key, kind, title, logo, year, rating, added_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(profile_id, item_key) DO UPDATE SET
  source_id = excluded.source_id, kind = excluded.kind, title = excluded.title,
  logo = excluded.logo, year = excluded.year, rating = excluded.rating, added_at = excluded.added_at`;

/**
 * Idempotently sets My List favorite state for `(profileId, itemKey)`:
 * upserts when `active` is `true`, deletes when `active` is `false`.
 */
export async function setFavorite(
  db: SqlDriver,
  input: ToggleFavoriteInput,
  active: boolean,
  clock: () => number = Date.now,
): Promise<Result<boolean>> {
  const profileId = normalizeProfileId(input.profileId);
  if (!active) {
    await db.run('DELETE FROM favorites WHERE profile_id = ? AND item_key = ?', [
      profileId,
      input.itemKey,
    ]);
    return ok(false);
  }
  if (!hasValidMeta(input)) return err(elvError('source-format', 'invalid-favorite'));
  const safeLogo = await resolveSafeStorageLogo(db, input);
  await db.run(UPSERT_FAVORITE, [
    profileId,
    input.sourceId,
    input.itemKey,
    input.kind,
    input.title,
    safeLogo,
    optInt(input.year),
    optFloat(input.rating),
    Math.round(clock()),
  ]);
  return ok(true);
}

/** Atomically adds or removes a My List favorite; returns `true` if added and `false` if removed. */
export async function toggleFavorite(
  db: SqlDriver,
  input: ToggleFavoriteInput,
  clock: () => number = Date.now,
): Promise<Result<boolean>> {
  if (!hasValidMeta(input)) return err(elvError('source-format', 'invalid-favorite'));
  const profileId = normalizeProfileId(input.profileId);
  const addedAt = Math.round(clock());
  const safeLogo = await resolveSafeStorageLogo(db, input);
  const added = await db.transaction(async (tx) => {
    const existing = await tx.all<{ found: number }>(
      'SELECT 1 AS found FROM favorites WHERE profile_id = ? AND item_key = ? LIMIT 1',
      [profileId, input.itemKey],
    );
    if (existing.length > 0) {
      await tx.run('DELETE FROM favorites WHERE profile_id = ? AND item_key = ?', [
        profileId,
        input.itemKey,
      ]);
      return false;
    }
    await tx.run(UPSERT_FAVORITE, [
      profileId,
      input.sourceId,
      input.itemKey,
      input.kind,
      input.title,
      safeLogo,
      optInt(input.year),
      optFloat(input.rating),
      addedAt,
    ]);
    return true;
  });
  return ok(added);
}

/** Lists My List favorites for a profile, most recently added first. */
export async function listFavorites(
  db: SqlDriver,
  limit = 50,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<FavoriteRow[]> {
  const clamped = clampLimit(limit, 50);
  if (clamped === 0) return [];
  const rows = await db.all<RawFavoriteRow>(
    `${FAVORITE_SELECT} WHERE profile_id = ? ORDER BY added_at DESC LIMIT ?`,
    [normalizeProfileId(profileId), clamped],
  );
  return rows.map(mapFavoriteRow);
}

/** Lists favorited item keys for a profile (capped at 2,000), most recently added first. */
export async function listFavoriteKeys(
  db: SqlDriver,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<string[]> {
  const rows = await db.all<{ item_key: string }>(
    'SELECT item_key FROM favorites WHERE profile_id = ? ORDER BY added_at DESC LIMIT ?',
    [normalizeProfileId(profileId), MAX_FAVORITE_KEYS],
  );
  return rows.map((r) => r.item_key);
}
