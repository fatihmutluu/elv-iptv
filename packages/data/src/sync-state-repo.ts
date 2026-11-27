import { elvError, err, ok, type Result, type SqlDriver } from '@elv/domain';
import { isValidProfileId } from './profiles-repo';
import { SOURCE_ID, type SourceKind, type SourceRecord, type SourceSettings } from './sources';
import {
  DEFAULT_PROFILE_ID,
  mapProgressRow,
  normalizeProfileId,
  type RawProgressRow,
  type WatchProgressRow,
} from './user-state-helpers';

const MAX_SYNC_PROGRESS_LIMIT = 5_000;
const MAX_SYNC_DISMISSALS_LIMIT = 2_000;
const MAX_SYNC_COLLECTION_KEYS = 5_000;
const MAX_BITFIELD_BATCH = 500;

const ALL_PROGRESS_COLS =
  'profile_id, source_id, item_key, kind, title, subtitle, logo, series_key, season, episode, position_ms, duration_ms, watched, updated_at, version_group_key, preferred_item_key';

/** One persisted per-profile Continue Watching Next-Up series dismissal row (`#502`, `#510`). */
export interface ContinueWatchingDismissalRow {
  readonly profileId: string;
  readonly seriesKey: string;
  readonly sourceId: string;
  readonly dismissedAt: number;
}

/** Input for {@link setContinueWatchingDismissal}. */
export interface SetContinueWatchingDismissalInput {
  readonly profileId?: string;
  readonly seriesKey: string;
  readonly sourceId: string;
  readonly dismissedAt: number;
}

/** Input for {@link applyWatchedEpisodeBitfield}. */
export interface ApplyWatchedEpisodeBitfieldInput {
  readonly profileId?: string;
  readonly seriesKey: string;
  readonly season?: number;
  readonly episodeIndices: readonly number[];
  readonly updatedAt: number;
}

/** Sync-oriented user-state and source-record helpers exposed on `CatalogService` (`#510`). */
export interface CatalogSyncStateOpsMethods {
  listAllWatchProgress(profileId?: string, limit?: number): Promise<WatchProgressRow[]>;
  listContinueWatchingDismissals(profileId?: string): Promise<ContinueWatchingDismissalRow[]>;
  setContinueWatchingDismissal(
    input: SetContinueWatchingDismissalInput,
    deleted: boolean,
  ): Promise<Result<void>>;
  listCollectionRawItemKeys(collectionId: string, profileId?: string): Promise<string[]>;
  listSourceRecords(): Promise<SourceRecord[]>;
  applyWatchedEpisodeBitfield(input: ApplyWatchedEpisodeBitfieldInput): Promise<Result<number>>;
}

interface RawDismissalRow {
  profile_id: string;
  series_key: string;
  source_id: string;
  dismissed_at: number;
}

interface RawSourceRecordRow {
  id: string;
  kind: SourceKind;
  name: string;
  created_at: number;
  settings_json: string;
}

interface RawEpisodeSeedRow {
  source_id: string;
  key: string;
  series_key: string;
  season: number | null;
  episode: number | null;
  title: string | null;
  series_name: string | null;
  series_cover: string | null;
}

/**
 * Lists ALL persisted `watch_progress` rows (in-progress AND completed `watched = 1`, across movies,
 * series, episodes, and live) for `profileId`, without Next-Up synthesis (`#510`).
 */
export async function listAllWatchProgress(
  db: SqlDriver,
  profileId: string = DEFAULT_PROFILE_ID,
  limit = 2_000,
): Promise<WatchProgressRow[]> {
  const clamped = Number.isFinite(limit)
    ? Math.min(MAX_SYNC_PROGRESS_LIMIT, Math.max(0, Math.floor(limit)))
    : 2_000;
  if (clamped === 0) return [];
  const normalized = normalizeProfileId(profileId);
  const rows = await db.all<RawProgressRow>(
    `SELECT ${ALL_PROGRESS_COLS}
       FROM watch_progress
      WHERE profile_id = ?
      ORDER BY updated_at DESC, item_key ASC
      LIMIT ?`,
    [normalized, clamped],
  );
  return rows.map(mapProgressRow);
}

/** Lists all persisted Continue Watching Next-Up series dismissals for `profileId` (`#510`). */
export async function listContinueWatchingDismissals(
  db: SqlDriver,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<ContinueWatchingDismissalRow[]> {
  const normalized = normalizeProfileId(profileId);
  const rows = await db.all<RawDismissalRow>(
    `SELECT profile_id, series_key, source_id, dismissed_at
       FROM continue_watching_dismissals
      WHERE profile_id = ?
      ORDER BY dismissed_at DESC, series_key ASC
      LIMIT ?`,
    [normalized, MAX_SYNC_DISMISSALS_LIMIT],
  );
  return rows.map((r) => ({
    profileId: r.profile_id,
    seriesKey: r.series_key,
    sourceId: r.source_id,
    dismissedAt: r.dismissed_at,
  }));
}

/**
 * Applies a synced Continue Watching series dismissal for `(profileId, seriesKey)`:
 * upserts LWW by `dismissedAt` when `deleted === false`, or removes the row when `deleted === true`.
 */
export async function setContinueWatchingDismissal(
  db: SqlDriver,
  input: SetContinueWatchingDismissalInput,
  deleted: boolean,
): Promise<Result<void>> {
  const profileId = normalizeProfileId(input.profileId);
  const seriesKey = input.seriesKey.trim();
  const sourceId = input.sourceId.trim();
  if (!isValidProfileId(profileId) || seriesKey === '') {
    return err(elvError('source-format', 'invalid-dismissal'));
  }
  if (deleted) {
    await db.run(
      'DELETE FROM continue_watching_dismissals WHERE profile_id = ? AND series_key = ?',
      [profileId, seriesKey],
    );
    return ok(undefined);
  }
  if (!SOURCE_ID.test(sourceId)) {
    return err(elvError('source-format', 'invalid-dismissal'));
  }
  const dismissedAt = Number.isFinite(input.dismissedAt)
    ? Math.max(0, Math.round(input.dismissedAt))
    : 0;
  await db.run(
    `INSERT INTO continue_watching_dismissals (profile_id, series_key, source_id, dismissed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(profile_id, series_key) DO UPDATE SET
       source_id = CASE WHEN excluded.dismissed_at >= continue_watching_dismissals.dismissed_at THEN excluded.source_id ELSE continue_watching_dismissals.source_id END,
       dismissed_at = MAX(continue_watching_dismissals.dismissed_at, excluded.dismissed_at)`,
    [profileId, seriesKey, sourceId, dismissedAt],
  );
  return ok(undefined);
}

/**
 * Lists raw ordered `item_key` entries stored in `vod_collection_items` for `(collectionId, profileId)`
 * without filtering out items whose catalog source has not yet imported (`#510`).
 */
export async function listCollectionRawItemKeys(
  db: SqlDriver,
  collectionId: string,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<string[]> {
  const pid = normalizeProfileId(profileId);
  const owns = await db.all<{ id: string }>(
    'SELECT id FROM vod_collections WHERE id = ? AND profile_id = ? LIMIT 1',
    [collectionId, pid],
  );
  if (owns.length === 0) return [];
  const rows = await db.all<{ item_key: string }>(
    `SELECT item_key
       FROM vod_collection_items
      WHERE collection_id = ?
      ORDER BY position ASC, added_at ASC
      LIMIT ?`,
    [collectionId, MAX_SYNC_COLLECTION_KEYS],
  );
  return rows.map((r) => r.item_key);
}

/** Lists active (`deleting = 0`) `sources` rows with full parsed `SourceSettings` JSON (`#510`). */
export async function listSourceRecords(db: SqlDriver): Promise<SourceRecord[]> {
  const rows = await db.all<RawSourceRecordRow>(
    'SELECT id, kind, name, created_at, settings_json FROM sources WHERE deleting = 0 ORDER BY created_at, id',
  );
  return rows.map((row) => {
    let settings: SourceSettings = {};
    try {
      const parsed: unknown = JSON.parse(row.settings_json);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        settings = parsed as SourceSettings;
      }
    } catch {
      settings = {};
    }
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      createdAt: row.created_at,
      settings,
    };
  });
}

/**
 * Marks imported episodes matching `(seriesKey, season?, episodeIndices)` as `watched = 1` in
 * `watch_progress` for `profileId`, returning how many episodes were marked (`#510`).
 */
export async function applyWatchedEpisodeBitfield(
  db: SqlDriver,
  input: ApplyWatchedEpisodeBitfieldInput,
): Promise<Result<number>> {
  const profileId = normalizeProfileId(input.profileId);
  const seriesKey = input.seriesKey.trim();
  if (!isValidProfileId(profileId) || seriesKey === '') {
    return err(elvError('source-format', 'invalid-bitfield'));
  }
  const indices: number[] = [];
  const seen = new Set<number>();
  for (const idx of input.episodeIndices) {
    if (!Number.isSafeInteger(idx) || idx < 0 || seen.has(idx)) continue;
    seen.add(idx);
    indices.push(idx);
    if (indices.length >= MAX_BITFIELD_BATCH) break;
  }
  if (indices.length === 0) return ok(0);

  const placeholders = indices.map(() => '?').join(', ');
  const seasonFilter =
    input.season !== undefined && Number.isSafeInteger(input.season) && input.season >= 0;
  const params = seasonFilter
    ? [seriesKey, input.season as number, ...indices]
    : [seriesKey, ...indices];
  const epRows = await db.all<RawEpisodeSeedRow>(
    `SELECT e.source_id, e.key, e.series_key, e.season, e.episode, e.title,
            s.name AS series_name, s.cover AS series_cover
       FROM episodes e
       LEFT JOIN series s ON s.source_id = e.source_id AND s.key = e.series_key
      WHERE e.series_key = ?${seasonFilter ? ' AND COALESCE(e.season, 0) = ?' : ''}
        AND e.episode IN (${placeholders})`,
    params,
  );
  if (epRows.length === 0) return ok(0);

  const updatedAt = Number.isFinite(input.updatedAt) ? Math.max(0, Math.round(input.updatedAt)) : 0;
  await db.transaction(async (tx) => {
    for (const ep of epRows) {
      const title =
        (ep.title?.trim() ?? '') !== ''
          ? (ep.title as string).trim()
          : (ep.series_name?.trim() ?? '') !== ''
            ? (ep.series_name as string).trim()
            : ep.key;
      await tx.run(
        `INSERT INTO watch_progress (
           profile_id, source_id, item_key, kind, title, subtitle, logo,
           series_key, season, episode, position_ms, duration_ms, watched, updated_at,
           version_group_key, preferred_item_key
         ) VALUES (?, ?, ?, 'episode', ?, NULL, ?, ?, ?, ?, 0, 0, 1, ?, NULL, NULL)
         ON CONFLICT(profile_id, item_key) DO UPDATE SET
           watched = 1,
           updated_at = MAX(watch_progress.updated_at, excluded.updated_at)`,
        [
          profileId,
          ep.source_id,
          ep.key,
          title,
          ep.series_cover,
          ep.series_key,
          ep.season,
          ep.episode,
          updatedAt,
        ],
      );
    }
  });
  return ok(epRows.length);
}

interface SyncStatePlaytimeLike {
  resolveRowLogos<T extends { sourceId: string; logo: string | null }>(rows: T[]): Promise<T[]>;
}

/** @internal Builds Wave P9 sync-state helper methods for `CatalogService`. */
export function createCatalogSyncStateOpsMethods(deps: {
  db: SqlDriver;
  playtime: SyncStatePlaytimeLike;
  syncUserData: () => Promise<void> | undefined;
}): CatalogSyncStateOpsMethods {
  const { db, playtime, syncUserData } = deps;
  return {
    listAllWatchProgress: async (profileId, limit) =>
      playtime.resolveRowLogos(await listAllWatchProgress(db, profileId, limit)),
    listContinueWatchingDismissals: (profileId) => listContinueWatchingDismissals(db, profileId),
    async setContinueWatchingDismissal(input, deleted) {
      const res = await setContinueWatchingDismissal(db, input, deleted);
      if (res.ok) await syncUserData();
      return res;
    },
    listCollectionRawItemKeys: (collectionId, profileId) =>
      listCollectionRawItemKeys(db, collectionId, profileId),
    listSourceRecords: () => listSourceRecords(db),
    async applyWatchedEpisodeBitfield(input) {
      const res = await applyWatchedEpisodeBitfield(db, input);
      if (res.ok && res.value > 0) await syncUserData();
      return res;
    },
  };
}
