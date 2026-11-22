import { elvError, err, ok, type Result, type SqlDriver } from '@elv/domain';
import { resolveSafeStorageLogo } from './queries';
import {
  clampLimit,
  clampMs,
  DEFAULT_PROFILE_ID,
  type FavoriteRow,
  hasValidMeta,
  lookupCatalogItemForWatched,
  mapFavoriteRow,
  mapProgressRow,
  normalizeProfileId,
  optFloat,
  optInt,
  type RawFavoriteRow,
  type RawProgressRow,
  type UserItemKind,
  type WatchProgressRow,
} from './user-state-helpers';

export { listSeriesUnplayedCounts, type SeriesUnplayedSummary } from './user-state-unplayed';
export { DEFAULT_PROFILE_ID, type FavoriteRow, type UserItemKind, type WatchProgressRow };

/** Fraction of duration watched at or above which an item is considered completed. */
export const WATCHED_THRESHOLD_RATIO = 0.9;

/** Minimum playback position (ms) required before an item appears in Continue Watching. */
export const MIN_RESUME_POSITION_MS = 10_000;

/** Smart rewind offset (ms) applied when resuming an in-progress item. */
export const SMART_RESUME_REWIND_MS = 5_000;

const MAX_PROGRESS_KEYS = 200;
const MAX_FAVORITE_KEYS = 2_000;

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
  duration_ms = excluded.duration_ms, watched = MAX(watch_progress.watched, excluded.watched),
  updated_at = excluded.updated_at`;

const INSERT_WATCHED_SEED = `INSERT INTO watch_progress (
  profile_id, source_id, item_key, kind, title, subtitle, logo,
  series_key, season, episode, position_ms, duration_ms, watched, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?)
ON CONFLICT(profile_id, item_key) DO UPDATE SET
  watched = 1, updated_at = excluded.updated_at`;

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

/**
 * Upserts a playback progress snapshot for `(profileId, itemKey)`. Keeps `watched` monotonic
 * (`MAX(watch_progress.watched, excluded.watched)`) so rewatching an already-watched item never
 * silently clears `watched`; returns the actual persisted `watched` state.
 */
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
  if (!row.watched) {
    const persisted = await db.all<{ watched: number }>(
      'SELECT watched FROM watch_progress WHERE profile_id = ? AND item_key = ? LIMIT 1',
      [row.profileId, row.itemKey],
    );
    if (persisted[0]?.watched !== 0 && persisted[0] !== undefined) {
      row.watched = true;
    }
  }
  return ok(row);
}

/**
 * Explicitly marks a catalog item watched or unwatched. Updates an existing progress row first;
 * when none exists and `watched` is `true`, hydrates catalog metadata (`movies`, `series`,
 * `episodes`, `live`) and inserts a watched row with `position_ms = 0, duration_ms = 0`.
 * Marking unwatched resets `position_ms` to `0` and is a safe no-op when absent.
 */
export async function setItemWatched(
  db: SqlDriver,
  itemKey: string,
  watched: boolean,
  clock: () => number = Date.now,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<Result<void>> {
  const normalizedProfile = normalizeProfileId(profileId);
  const updatedAt = Math.round(clock());
  const sql = watched
    ? 'UPDATE watch_progress SET watched = 1, updated_at = ? WHERE profile_id = ? AND item_key = ?'
    : 'UPDATE watch_progress SET watched = 0, position_ms = 0, updated_at = ? WHERE profile_id = ? AND item_key = ?';
  const result = await db.run(sql, [updatedAt, normalizedProfile, itemKey]);
  if (result.changes === 0 && watched) {
    const seed = await lookupCatalogItemForWatched(db, itemKey);
    if (seed !== null) {
      await db.run(INSERT_WATCHED_SEED, [
        normalizedProfile,
        seed.sourceId,
        itemKey,
        seed.kind,
        seed.title,
        seed.subtitle,
        seed.logo,
        seed.seriesKey,
        seed.season,
        seed.episode,
        updatedAt,
      ]);
    }
  }
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

/**
 * Lists in-progress, unwatched items with known positive duration (`duration_ms > 0`) at or above
 * {@link MIN_RESUME_POSITION_MS}, deduplicated per series, most recent first.
 */
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
         FROM watch_progress WHERE profile_id = ? AND watched = 0 AND position_ms >= ? AND duration_ms > 0
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
