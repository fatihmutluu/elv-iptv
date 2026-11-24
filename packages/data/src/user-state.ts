import { elvError, err, ok, type Result, type SqlDriver } from '@elv/domain';
import { findRestrictedItemKeys, loadActiveParentalFilter } from './parental-repo';
import { resolveSafeStorageLogo, sourceOfKey } from './queries';
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
  'profile_id, source_id, item_key, kind, title, subtitle, logo, series_key, season, episode, position_ms, duration_ms, watched, updated_at, version_group_key, preferred_item_key';
const PROGRESS_SELECT = `SELECT ${PROGRESS_COLS} FROM watch_progress`;
const FAVORITE_SELECT =
  'SELECT profile_id, source_id, item_key, kind, title, logo, year, rating, added_at FROM favorites';

const UPSERT_PROGRESS = `INSERT INTO watch_progress (
  profile_id, source_id, item_key, kind, title, subtitle, logo,
  series_key, season, episode, position_ms, duration_ms, watched, updated_at,
  version_group_key, preferred_item_key
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(profile_id, item_key) DO UPDATE SET
  source_id = excluded.source_id, kind = excluded.kind, title = excluded.title,
  subtitle = excluded.subtitle, logo = excluded.logo, series_key = excluded.series_key,
  season = excluded.season, episode = excluded.episode, position_ms = excluded.position_ms,
  duration_ms = excluded.duration_ms, watched = MAX(watch_progress.watched, excluded.watched),
  updated_at = excluded.updated_at,
  version_group_key = COALESCE(excluded.version_group_key, watch_progress.version_group_key),
  preferred_item_key = COALESCE(excluded.preferred_item_key, watch_progress.preferred_item_key)`;

const INSERT_WATCHED_SEED = `INSERT INTO watch_progress (
  profile_id, source_id, item_key, kind, title, subtitle, logo,
  series_key, season, episode, position_ms, duration_ms, watched, updated_at,
  version_group_key, preferred_item_key
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?, ?)
ON CONFLICT(profile_id, item_key) DO UPDATE SET
  watched = 1, updated_at = excluded.updated_at,
  version_group_key = COALESCE(excluded.version_group_key, watch_progress.version_group_key),
  preferred_item_key = COALESCE(excluded.preferred_item_key, watch_progress.preferred_item_key)`;

async function lookupMovieVersionGroupKey(
  db: SqlDriver,
  itemKey: string,
  sourceId?: string,
): Promise<string | null> {
  const sid = sourceId ?? sourceOfKey(itemKey);
  const rows =
    sid !== undefined
      ? await db.all<{ version_group_key: string }>(
          'SELECT version_group_key FROM movies WHERE source_id = ? AND key = ? LIMIT 1',
          [sid, itemKey],
        )
      : await db.all<{ version_group_key: string }>(
          'SELECT version_group_key FROM movies WHERE key = ? LIMIT 1',
          [itemKey],
        );
  const key = rows[0]?.version_group_key;
  return key !== undefined && key !== '' ? key : null;
}

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
  const versionGroupKey =
    input.kind === 'movie'
      ? await lookupMovieVersionGroupKey(db, input.itemKey, input.sourceId)
      : null;
  const preferredItemKey = versionGroupKey !== null ? input.itemKey : null;
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
    ...(versionGroupKey !== null ? { versionGroupKey, preferredItemKey: input.itemKey } : {}),
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
    versionGroupKey,
    preferredItemKey,
  ]);
  if (versionGroupKey !== null) {
    if (!row.watched) {
      const siblingWatched = await db.all<{ watched: number }>(
        'SELECT MAX(watched) AS watched FROM watch_progress WHERE profile_id = ? AND version_group_key = ?',
        [row.profileId, versionGroupKey],
      );
      if ((siblingWatched[0]?.watched ?? 0) !== 0) {
        row.watched = true;
      }
    }
    await db.run(
      `UPDATE watch_progress
          SET position_ms = ?, duration_ms = ?, watched = MAX(watched, ?),
              updated_at = ?, preferred_item_key = ?
        WHERE profile_id = ? AND version_group_key = ?`,
      [
        row.positionMs,
        row.durationMs,
        row.watched ? 1 : 0,
        row.updatedAt,
        input.itemKey,
        row.profileId,
        versionGroupKey,
      ],
    );
  } else if (!row.watched) {
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
  const versionGroupKey = await lookupMovieVersionGroupKey(db, itemKey);
  const sql = watched
    ? 'UPDATE watch_progress SET watched = 1, updated_at = ? WHERE profile_id = ? AND item_key = ?'
    : 'UPDATE watch_progress SET watched = 0, position_ms = 0, updated_at = ? WHERE profile_id = ? AND item_key = ?';
  const result = await db.run(sql, [updatedAt, normalizedProfile, itemKey]);
  if (versionGroupKey !== null) {
    await db.run(
      watched
        ? 'UPDATE watch_progress SET watched = 1, updated_at = ?, preferred_item_key = COALESCE(preferred_item_key, ?) WHERE profile_id = ? AND version_group_key = ?'
        : 'UPDATE watch_progress SET watched = 0, position_ms = 0, updated_at = ? WHERE profile_id = ? AND version_group_key = ?',
      watched
        ? [updatedAt, itemKey, normalizedProfile, versionGroupKey]
        : [updatedAt, normalizedProfile, versionGroupKey],
    );
  }
  if (!watched) {
    await db.run(
      'UPDATE watch_progress SET watched = 0, position_ms = 0, updated_at = ? WHERE profile_id = ? AND series_key = ?',
      [updatedAt, normalizedProfile, itemKey],
    );
  } else if (result.changes === 0) {
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
        versionGroupKey,
        versionGroupKey !== null ? itemKey : null,
      ]);
    }
  }
  return ok(undefined);
}

/** Reads a single watch progress row by `(profileId, itemKey)`, falling back to any synced version in the same `version_group_key` (`#404`). */
export async function getWatchProgress(
  db: SqlDriver,
  itemKey: string,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<WatchProgressRow | null> {
  if (itemKey === '') return null;
  const normalizedProfile = normalizeProfileId(profileId);
  const rows = await db.all<RawProgressRow>(
    `${PROGRESS_SELECT} WHERE profile_id = ? AND item_key = ? LIMIT 1`,
    [normalizedProfile, itemKey],
  );
  const direct = rows[0];
  const groupKey = direct?.version_group_key ?? (await lookupMovieVersionGroupKey(db, itemKey));
  if (groupKey !== null && groupKey !== '') {
    const groupRows = await db.all<RawProgressRow>(
      `${PROGRESS_SELECT} WHERE profile_id = ? AND version_group_key = ? ORDER BY updated_at DESC, item_key ASC LIMIT 1`,
      [normalizedProfile, groupKey],
    );
    const latest = groupRows[0];
    if (latest !== undefined && (direct === undefined || latest.updated_at >= direct.updated_at)) {
      return mapProgressRow(latest);
    }
  }
  return direct === undefined ? null : mapProgressRow(direct);
}

/**
 * Lists in-progress, unwatched items with known positive duration (`duration_ms > 0`) at or above
 * {@link MIN_RESUME_POSITION_MS}, deduplicated per series and per movie `version_group_key` (`#404`), most recent first.
 */
export async function listContinueWatching(
  db: SqlDriver,
  limit = 24,
  profileId: string = DEFAULT_PROFILE_ID,
  opts?: { readonly parentalUnlocked?: boolean },
): Promise<WatchProgressRow[]> {
  const clamped = clampLimit(limit, 24);
  if (clamped === 0) return [];
  const normalized = normalizeProfileId(profileId);
  const filter = await loadActiveParentalFilter(db, normalized, opts?.parentalUnlocked);
  const fetchLimit = filter === null ? clamped : Math.min(100, clamped * 4);
  const rows = await db.all<RawProgressRow>(
    `SELECT ${PROGRESS_COLS} FROM (
       SELECT ${PROGRESS_COLS}, ROW_NUMBER() OVER (PARTITION BY COALESCE(NULLIF(series_key, ''), NULLIF(version_group_key, ''), item_key) ORDER BY updated_at DESC, item_key ASC) AS rn
         FROM watch_progress WHERE profile_id = ? AND watched = 0 AND position_ms >= ? AND duration_ms > 0
     ) WHERE rn = 1 ORDER BY updated_at DESC, item_key ASC LIMIT ?`,
    [normalized, MIN_RESUME_POSITION_MS, fetchLimit],
  );
  const mapped = rows.map(mapProgressRow);
  if (filter === null) return mapped;
  const restricted = await findRestrictedItemKeys(
    db,
    filter,
    mapped.map((r) => ({
      itemKey: r.itemKey,
      sourceId: r.sourceId,
      kind: r.kind,
      title: r.title,
      seriesKey: r.seriesKey,
    })),
  );
  return mapped.filter((r) => !restricted.has(r.itemKey)).slice(0, clamped);
}

/** Fetches watch progress rows for up to 200 distinct item keys in one indexed lookup, including cross-version movie progress (`#404`). */
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
  const normalizedProfile = normalizeProfileId(profileId);
  const placeholders = unique.map(() => '?').join(', ');
  const directRows = await db.all<RawProgressRow>(
    `${PROGRESS_SELECT} WHERE profile_id = ? AND item_key IN (${placeholders})`,
    [normalizedProfile, ...unique],
  );
  const byKey = new Map<string, WatchProgressRow>();
  for (const r of directRows) byKey.set(r.item_key, mapProgressRow(r));

  const missing = unique.filter((k) => !byKey.has(k));
  if (missing.length > 0) {
    const mPlaceholders = missing.map(() => '?').join(', ');
    const movieGroups = await db.all<{ key: string; version_group_key: string }>(
      `SELECT key, version_group_key FROM movies WHERE key IN (${mPlaceholders}) AND version_group_key != ''`,
      missing,
    );
    const groupIds = [...new Set(movieGroups.map((m) => m.version_group_key))];
    if (groupIds.length > 0) {
      const gPlaceholders = groupIds.map(() => '?').join(', ');
      const groupRows = await db.all<RawProgressRow>(
        `${PROGRESS_SELECT} WHERE profile_id = ? AND version_group_key IN (${gPlaceholders}) ORDER BY updated_at DESC`,
        [normalizedProfile, ...groupIds],
      );
      const latestByGroup = new Map<string, WatchProgressRow>();
      for (const r of groupRows) {
        if (r.version_group_key && !latestByGroup.has(r.version_group_key)) {
          latestByGroup.set(r.version_group_key, mapProgressRow(r));
        }
      }
      for (const m of movieGroups) {
        const synced = latestByGroup.get(m.version_group_key);
        if (synced !== undefined && !byKey.has(m.key)) {
          byKey.set(m.key, { ...synced, itemKey: m.key });
        }
      }
    }
  }
  return [...byKey.values()];
}

/** Deletes a watch progress row for `(profileId, itemKey)` and any synced sibling versions in its `version_group_key` (`#404`). */
export async function clearWatchProgress(
  db: SqlDriver,
  itemKey: string,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<Result<void>> {
  const normalizedProfile = normalizeProfileId(profileId);
  const versionGroupKey = await lookupMovieVersionGroupKey(db, itemKey);
  await db.run('DELETE FROM watch_progress WHERE profile_id = ? AND item_key = ?', [
    normalizedProfile,
    itemKey,
  ]);
  if (versionGroupKey !== null) {
    await db.run('DELETE FROM watch_progress WHERE profile_id = ? AND version_group_key = ?', [
      normalizedProfile,
      versionGroupKey,
    ]);
  }
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
  opts?: { readonly parentalUnlocked?: boolean },
): Promise<FavoriteRow[]> {
  const clamped = clampLimit(limit, 50);
  if (clamped === 0) return [];
  const normalized = normalizeProfileId(profileId);
  const filter = await loadActiveParentalFilter(db, normalized, opts?.parentalUnlocked);
  const fetchLimit = filter === null ? clamped : Math.min(100, clamped * 4);
  const rows = await db.all<RawFavoriteRow>(
    `${FAVORITE_SELECT} WHERE profile_id = ? ORDER BY added_at DESC LIMIT ?`,
    [normalized, fetchLimit],
  );
  const mapped = rows.map(mapFavoriteRow);
  if (filter === null) return mapped;
  const restricted = await findRestrictedItemKeys(
    db,
    filter,
    mapped.map((r) => ({
      itemKey: r.itemKey,
      sourceId: r.sourceId,
      kind: r.kind,
      title: r.title,
    })),
  );
  return mapped.filter((r) => !restricted.has(r.itemKey)).slice(0, clamped);
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
