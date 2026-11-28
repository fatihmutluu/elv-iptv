import { elvError, err, ok, type Result, type SqlDriver } from '@elv/domain';
import {
  lookupSeriesRefForDismissal,
  queryContinueWatchingWithNextUp,
  recordContinueWatchingDismissal,
} from './continue-watching-next-up';
import { captureMyListSeriesBaseline, clearMyListSeriesTracking } from './my-list-new-episodes';
import { findRestrictedItemKeys, loadActiveParentalFilter } from './parental-repo';
import { resolveSafeStorageLogo, sourceOfKey } from './queries';
import {
  clampLimit,
  clampMs,
  DEFAULT_PROFILE_ID,
  type FavoriteRow,
  hasValidMeta,
  lookupCatalogItemForWatched,
  MAX_USER_LIST_LIMIT,
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
import { lookupParentSeriesKeyForUnwatch } from './user-state-series';

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
  if (!watched) {
    await db.transaction(async (tx) => {
      const parentSeriesKey = await lookupParentSeriesKeyForUnwatch(tx, normalizedProfile, itemKey);
      await tx.run(
        'UPDATE watch_progress SET watched = 0, position_ms = 0, updated_at = ? WHERE profile_id = ? AND item_key = ?',
        [updatedAt, normalizedProfile, itemKey],
      );
      if (versionGroupKey !== null) {
        await tx.run(
          'UPDATE watch_progress SET watched = 0, position_ms = 0, updated_at = ? WHERE profile_id = ? AND version_group_key = ?',
          [updatedAt, normalizedProfile, versionGroupKey],
        );
      }
      await tx.run(
        'UPDATE watch_progress SET watched = 0, position_ms = 0, updated_at = ? WHERE profile_id = ? AND series_key = ?',
        [updatedAt, normalizedProfile, itemKey],
      );
      if (parentSeriesKey !== null && parentSeriesKey !== itemKey) {
        await tx.run(
          'UPDATE watch_progress SET watched = 0, position_ms = 0, updated_at = ? WHERE profile_id = ? AND item_key = ?',
          [updatedAt, normalizedProfile, parentSeriesKey],
        );
      }
    });
    return ok(undefined);
  }
  const result = await db.run(
    'UPDATE watch_progress SET watched = 1, updated_at = ? WHERE profile_id = ? AND item_key = ?',
    [updatedAt, normalizedProfile, itemKey],
  );
  if (versionGroupKey !== null) {
    await db.run(
      'UPDATE watch_progress SET watched = 1, updated_at = ?, preferred_item_key = COALESCE(preferred_item_key, ?) WHERE profile_id = ? AND version_group_key = ?',
      [updatedAt, itemKey, normalizedProfile, versionGroupKey],
    );
  }
  if (result.changes === 0) {
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
 * {@link MIN_RESUME_POSITION_MS} plus synthesized Next-Up episodes for completed series,
 * deduplicated per series and per movie `version_group_key` (`#404`), most recent first.
 */
export async function listContinueWatching(
  db: SqlDriver,
  limit = 24,
  profileId: string = DEFAULT_PROFILE_ID,
  opts?: { readonly parentalUnlocked?: boolean },
): Promise<WatchProgressRow[]> {
  return queryContinueWatchingWithNextUp(
    db,
    PROGRESS_COLS,
    MIN_RESUME_POSITION_MS,
    limit,
    profileId,
    opts,
  );
}

/** Options for {@link listWatched}. */
export interface ListWatchedOptions {
  readonly kind?: 'movie' | 'series';
  readonly parentalUnlocked?: boolean;
}

/**
 * Lists completed (`watched = 1`) movies and/or series for a profile, ordered by
 * `updated_at DESC, item_key ASC` and clamped to `MAX_USER_LIST_LIMIT` (250).
 * Deduplicates multi-version movies by `version_group_key` (`#404`) and includes series
 * whose imported episodes are all watched even when the series parent key was not explicitly marked.
 */
export async function listWatched(
  db: SqlDriver,
  limit = 100,
  profileId: string = DEFAULT_PROFILE_ID,
  opts?: ListWatchedOptions,
): Promise<WatchProgressRow[]> {
  const clamped = clampLimit(limit, 100);
  if (clamped === 0) return [];
  const normalized = normalizeProfileId(profileId);
  const filter = await loadActiveParentalFilter(db, normalized, opts?.parentalUnlocked);
  const fetchLimit = filter === null ? clamped : Math.min(MAX_USER_LIST_LIMIT * 4, clamped * 4);

  let rows: RawProgressRow[];
  if (opts?.kind === 'movie') {
    rows = await db.all<RawProgressRow>(
      `SELECT ${PROGRESS_COLS} FROM (
         SELECT ${PROGRESS_COLS},
                ROW_NUMBER() OVER (
                  PARTITION BY COALESCE(NULLIF(version_group_key, ''), item_key)
                  ORDER BY updated_at DESC, item_key ASC
                ) AS rn
           FROM watch_progress
          WHERE profile_id = ? AND watched = 1 AND kind = 'movie'
       ) WHERE rn = 1
       ORDER BY updated_at DESC, item_key ASC
       LIMIT ?`,
      [normalized, fetchLimit],
    );
  } else {
    const directKindClause =
      opts?.kind === 'series' ? "kind = 'series'" : "kind IN ('movie', 'series')";
    rows = await db.all<RawProgressRow>(
      `WITH direct_watched AS (
         SELECT ${PROGRESS_COLS} FROM (
           SELECT ${PROGRESS_COLS},
                  ROW_NUMBER() OVER (
                    PARTITION BY COALESCE(NULLIF(version_group_key, ''), item_key)
                    ORDER BY updated_at DESC, item_key ASC
                  ) AS rn
             FROM watch_progress
            WHERE profile_id = ? AND watched = 1 AND ${directKindClause}
         ) WHERE rn = 1
       ),
       watched_ep_series AS (
         SELECT wp.source_id, wp.series_key, MAX(wp.updated_at) AS updated_at
           FROM watch_progress wp
          WHERE wp.profile_id = ?
            AND wp.watched = 1
            AND wp.kind = 'episode'
            AND wp.series_key IS NOT NULL
            AND wp.series_key != ''
          GROUP BY wp.source_id, wp.series_key
       ),
       completed_series AS (
         SELECT ? AS profile_id,
                wes.source_id,
                wes.series_key AS item_key,
                'series' AS kind,
                s.name AS title,
                NULL AS subtitle,
                s.cover AS logo,
                NULL AS series_key,
                NULL AS season,
                NULL AS episode,
                0 AS position_ms,
                0 AS duration_ms,
                1 AS watched,
                wes.updated_at,
                NULL AS version_group_key,
                NULL AS preferred_item_key
           FROM watched_ep_series wes
           JOIN series s
             ON s.source_id = wes.source_id AND s.key = wes.series_key
          WHERE NOT EXISTS (
                  SELECT 1 FROM watch_progress wp_s
                   WHERE wp_s.profile_id = ?
                     AND wp_s.item_key = wes.series_key
                     AND wp_s.kind = 'series'
                     AND wp_s.watched = 1
                )
            AND EXISTS (
                  SELECT 1 FROM episodes e
                   WHERE e.source_id = wes.source_id AND e.series_key = wes.series_key
                )
            AND NOT EXISTS (
                  SELECT 1 FROM episodes e
                   LEFT JOIN watch_progress wp_e
                     ON wp_e.profile_id = ? AND wp_e.item_key = e.key
                   WHERE e.source_id = wes.source_id
                     AND e.series_key = wes.series_key
                     AND COALESCE(wp_e.watched, 0) = 0
                )
       )
       SELECT ${PROGRESS_COLS}
         FROM (
           SELECT ${PROGRESS_COLS} FROM direct_watched
           UNION ALL
           SELECT ${PROGRESS_COLS} FROM completed_series
         )
        ORDER BY updated_at DESC, item_key ASC
        LIMIT ?`,
      [normalized, normalized, normalized, normalized, normalized, fetchLimit],
    );
  }

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

/**
 * Deletes a watch progress row for `(profileId, itemKey)` and any synced sibling versions in its
 * `version_group_key` (`#404`), and records a Continue Watching dismissal when `itemKey` belongs
 * to a series episode so Next-Up stays hidden until another episode is watched.
 */
export async function clearWatchProgress(
  db: SqlDriver,
  itemKey: string,
  profileId: string = DEFAULT_PROFILE_ID,
  clock: () => number = Date.now,
): Promise<Result<void>> {
  const normalizedProfile = normalizeProfileId(profileId);
  const [versionGroupKey, seriesRef] = await Promise.all([
    lookupMovieVersionGroupKey(db, itemKey),
    lookupSeriesRefForDismissal(db, normalizedProfile, itemKey),
  ]);
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
  if (seriesRef !== null) {
    await recordContinueWatchingDismissal(db, normalizedProfile, seriesRef, clock);
  }
  return ok(undefined);
}

const FAVORITES_ORDER_BY =
  'CASE WHEN f.sort_order > 0 THEN 0 ELSE 1 END, f.sort_order ASC, f.added_at DESC, f.item_key ASC';

const UPSERT_FAVORITE = `INSERT INTO favorites (
  profile_id, source_id, item_key, kind, title, logo, year, rating, added_at, sort_order
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?,
  COALESCE((SELECT MAX(sort_order) FROM favorites WHERE profile_id = ?), 0) + 1
)
ON CONFLICT(profile_id, item_key) DO UPDATE SET
  source_id = excluded.source_id, kind = excluded.kind, title = excluded.title,
  logo = excluded.logo, year = excluded.year, rating = excluded.rating,
  added_at = excluded.added_at,
  sort_order = CASE WHEN favorites.sort_order > 0 THEN favorites.sort_order ELSE excluded.sort_order END`;

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
    await clearMyListSeriesTracking(db, profileId, input.itemKey);
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
    profileId,
  ]);
  if (input.kind === 'series') {
    await captureMyListSeriesBaseline(db, profileId, input.itemKey, input.sourceId, clock);
  }
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
      await clearMyListSeriesTracking(tx, profileId, input.itemKey);
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
      profileId,
    ]);
    if (input.kind === 'series') {
      await captureMyListSeriesBaseline(tx, profileId, input.itemKey, input.sourceId, clock);
    }
    return true;
  });
  return ok(added);
}

/**
 * Reorders My List favorites for `profileId` into a dense `1..N` sequence.
 * Specified keys belonging to `profileId` receive `1..k` in order; any remaining favorites
 * in `profileId` are re-numbered starting at `k + 1` in their existing display order.
 */
export async function reorderFavorites(
  db: SqlDriver,
  orderedItemKeys: readonly string[],
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<Result<void>> {
  const normalized = normalizeProfileId(profileId);
  const requested: string[] = [];
  const seen = new Set<string>();
  for (const rawKey of orderedItemKeys) {
    const trimmed = rawKey.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    requested.push(trimmed);
    if (requested.length >= MAX_USER_LIST_LIMIT) break;
  }
  await db.transaction(async (tx) => {
    const existingRows = await tx.all<{ item_key: string }>(
      `SELECT f.item_key
         FROM favorites f
        WHERE f.profile_id = ?
        ORDER BY ${FAVORITES_ORDER_BY}`,
      [normalized],
    );
    if (existingRows.length === 0) return;
    const existingSet = new Set(existingRows.map((r) => r.item_key));
    const matched: string[] = [];
    const matchedSet = new Set<string>();
    for (const key of requested) {
      if (existingSet.has(key)) {
        matched.push(key);
        matchedSet.add(key);
      }
    }
    const remaining: string[] = [];
    for (const row of existingRows) {
      if (!matchedSet.has(row.item_key)) remaining.push(row.item_key);
    }
    const finalOrder = [...matched, ...remaining];
    for (let i = 0; i < finalOrder.length; i += 1) {
      await tx.run('UPDATE favorites SET sort_order = ? WHERE profile_id = ? AND item_key = ?', [
        i + 1,
        normalized,
        finalOrder[i] ?? '',
      ]);
    }
  });
  return ok(undefined);
}

/** Lists My List favorites for a profile in custom `sort_order` order, falling back to `added_at DESC` (applying live `channel_overrides` `#60`). */
export async function listFavorites(
  db: SqlDriver,
  limit = 50,
  profileId: string = DEFAULT_PROFILE_ID,
  opts?: { readonly parentalUnlocked?: boolean; readonly includeHidden?: boolean },
): Promise<FavoriteRow[]> {
  const clamped = clampLimit(limit, 50);
  if (clamped === 0) return [];
  const normalized = normalizeProfileId(profileId);
  const filter = await loadActiveParentalFilter(db, normalized, opts?.parentalUnlocked);
  const fetchLimit = filter === null ? clamped : Math.min(100, clamped * 4);
  const hiddenClause =
    opts?.includeHidden === true ? '' : " AND (f.kind != 'live' OR COALESCE(co.is_hidden, 0) = 0)";
  const rows = await db.all<RawFavoriteRow & { raw_title: string }>(
    `SELECT f.profile_id, f.source_id, f.item_key, f.kind,
            CASE WHEN f.kind = 'live' THEN COALESCE(NULLIF(co.custom_name, ''), f.title) ELSE f.title END AS title,
            f.title AS raw_title,
            f.logo, f.year, f.rating, f.added_at, f.sort_order
       FROM favorites f
       LEFT JOIN channel_overrides co
         ON co.profile_id = f.profile_id AND co.item_key = f.item_key
      WHERE f.profile_id = ?${hiddenClause}
      ORDER BY ${FAVORITES_ORDER_BY}
      LIMIT ?`,
    [normalized, fetchLimit],
  );
  const mapped = rows.map(mapFavoriteRow);
  if (filter === null) return mapped;
  const restricted = await findRestrictedItemKeys(
    db,
    filter,
    rows.map((r) => ({
      itemKey: r.item_key,
      sourceId: r.source_id,
      kind: r.kind,
      title: r.raw_title,
    })),
  );
  return mapped.filter((r) => !restricted.has(r.itemKey)).slice(0, clamped);
}

/** Lists favorited item keys for a profile (capped at 2,000) in custom `sort_order` order, falling back to `added_at DESC`. */
export async function listFavoriteKeys(
  db: SqlDriver,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<string[]> {
  const rows = await db.all<{ item_key: string }>(
    `SELECT f.item_key
       FROM favorites f
      WHERE f.profile_id = ?
      ORDER BY ${FAVORITES_ORDER_BY}
      LIMIT ?`,
    [normalizeProfileId(profileId), MAX_FAVORITE_KEYS],
  );
  return rows.map((r) => r.item_key);
}
