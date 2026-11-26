import {
  type DownloadMediaKind,
  type DownloadProgressUpdate,
  type DownloadRecord,
  type DownloadStatus,
  elvError,
  err,
  isDownloadMediaKind,
  isDownloadStatus,
  isValidManagedDownloadFileName,
  ok,
  type Result,
  type SqlDriver,
} from '@elv/domain';

const DEFAULT_PROFILE_ID = 'default';

function normalizeProfileId(profileId: string | undefined): string {
  const trimmed = profileId?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : DEFAULT_PROFILE_ID;
}

/** Input payload for {@link upsertDownload}. */
export interface UpsertDownloadInput {
  readonly id: string;
  readonly profileId?: string;
  readonly sourceId: string;
  readonly itemKey: string;
  readonly kind: DownloadMediaKind;
  readonly title: string;
  readonly seriesTitle?: string | null;
  readonly season?: number | null;
  readonly episodeNum?: number | null;
  readonly poster?: string | null;
  readonly localFileName: string;
  readonly localUri?: string | null;
  readonly bytesDownloaded?: number;
  readonly totalBytes?: number | null;
  readonly status?: DownloadStatus;
  readonly pausedForPlayback?: boolean;
  readonly errorCode?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly completedAt?: number | null;
}

/** Optional patch fields for {@link setDownloadStatus}. */
export interface SetDownloadStatusOptions {
  readonly profileId?: string;
  readonly errorCode?: string | null;
  readonly localUri?: string | null;
  readonly pausedForPlayback?: boolean;
  readonly completedAt?: number | null;
  readonly bytesDownloaded?: number;
  readonly totalBytes?: number | null;
}

/** Filter options for {@link listDownloads}. */
export interface ListDownloadsOptions {
  readonly profileId?: string;
  readonly status?: DownloadStatus | readonly DownloadStatus[];
  readonly kind?: DownloadMediaKind;
  readonly sourceId?: string;
}

interface DownloadRowRaw {
  id: string;
  profile_id: string;
  source_id: string;
  item_key: string;
  kind: string;
  title: string;
  series_title: string | null;
  season: number | null;
  episode_num: number | null;
  poster: string | null;
  local_file_name: string;
  local_uri: string | null;
  bytes_downloaded: number;
  total_bytes: number | null;
  status: string;
  paused_for_playback: number;
  error_code: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

const SELECT_COLUMNS = `id, profile_id, source_id, item_key, kind, title, series_title, season,
  episode_num, poster, local_file_name, local_uri, bytes_downloaded, total_bytes, status,
  paused_for_playback, error_code, created_at, updated_at, completed_at`;

function mapRow(row: DownloadRowRaw): DownloadRecord {
  return {
    id: row.id,
    profileId: row.profile_id,
    sourceId: row.source_id,
    itemKey: row.item_key,
    kind: isDownloadMediaKind(row.kind) ? row.kind : 'movie',
    title: row.title,
    seriesTitle: row.series_title,
    season: row.season,
    episodeNum: row.episode_num,
    poster: row.poster,
    localFileName: row.local_file_name,
    localUri: row.local_uri,
    bytesDownloaded: row.bytes_downloaded,
    totalBytes: row.total_bytes,
    status: isDownloadStatus(row.status) ? row.status : 'queued',
    pausedForPlayback: row.paused_for_playback === 1,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function clampBytes(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function normalizeNullableBytes(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/**
 * Inserts or updates a managed offline VOD download record keyed by `(profileId, itemKey)`.
 * Strictly rejects non-`'movie'`/`'episode'` kinds and unsafe `localFileName` values.
 */
export async function upsertDownload(
  db: SqlDriver,
  input: UpsertDownloadInput,
  clock: () => number = Date.now,
): Promise<Result<DownloadRecord>> {
  if (!isDownloadMediaKind(input.kind)) {
    return err(elvError('source-format', 'invalid-download-kind'));
  }
  if (!isValidManagedDownloadFileName(input.localFileName)) {
    return err(elvError('source-format', 'invalid-download-filename'));
  }
  const id = input.id.trim();
  const sourceId = input.sourceId.trim();
  const itemKey = input.itemKey.trim();
  const title = input.title.trim();
  if (id === '' || sourceId === '' || itemKey === '' || title === '') {
    return err(elvError('source-format', 'invalid-download-input'));
  }
  const status = input.status ?? 'queued';
  if (!isDownloadStatus(status)) {
    return err(elvError('source-format', 'invalid-download-status'));
  }

  const profileId = normalizeProfileId(input.profileId ?? DEFAULT_PROFILE_ID);
  const now = clock();
  const createdAt = input.createdAt ?? now;
  const updatedAt = input.updatedAt ?? now;
  const bytesDownloaded = clampBytes(input.bytesDownloaded);
  const totalBytes = normalizeNullableBytes(input.totalBytes);
  const pausedForPlayback = input.pausedForPlayback === true ? 1 : 0;

  await db.run(
    `INSERT INTO downloads (
       id, profile_id, source_id, item_key, kind, title, series_title, season, episode_num,
       poster, local_file_name, local_uri, bytes_downloaded, total_bytes, status,
       paused_for_playback, error_code, created_at, updated_at, completed_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (profile_id, item_key) DO UPDATE SET
       id = excluded.id,
       source_id = excluded.source_id,
       kind = excluded.kind,
       title = excluded.title,
       series_title = excluded.series_title,
       season = excluded.season,
       episode_num = excluded.episode_num,
       poster = excluded.poster,
       local_file_name = excluded.local_file_name,
       local_uri = excluded.local_uri,
       bytes_downloaded = excluded.bytes_downloaded,
       total_bytes = excluded.total_bytes,
       status = excluded.status,
       paused_for_playback = excluded.paused_for_playback,
       error_code = excluded.error_code,
       updated_at = excluded.updated_at,
       completed_at = excluded.completed_at`,
    [
      id,
      profileId,
      sourceId,
      itemKey,
      input.kind,
      title,
      input.seriesTitle ?? null,
      input.season ?? null,
      input.episodeNum ?? null,
      input.poster ?? null,
      input.localFileName,
      input.localUri ?? null,
      bytesDownloaded,
      totalBytes,
      status,
      pausedForPlayback,
      input.errorCode ?? null,
      createdAt,
      updatedAt,
      input.completedAt ?? null,
    ],
  );

  const saved = await getDownload(db, itemKey, profileId);
  if (saved === null) return err(elvError('storage', 'item-not-found'));
  return ok(saved);
}

/** Updates byte progress (and optional status/URI/error fields) for an existing download. */
export async function updateDownloadProgress(
  db: SqlDriver,
  itemKey: string,
  update: DownloadProgressUpdate,
  profileId?: string,
  clock: () => number = Date.now,
): Promise<Result<DownloadRecord>> {
  const pid = normalizeProfileId(profileId);
  const existing = await getDownload(db, itemKey, pid);
  if (existing === null) return err(elvError('storage', 'item-not-found'));
  if (update.status !== undefined && !isDownloadStatus(update.status)) {
    return err(elvError('source-format', 'invalid-download-status'));
  }

  const nextStatus = update.status ?? existing.status;
  const nextBytes = clampBytes(update.bytesDownloaded);
  const nextTotal =
    update.totalBytes !== undefined
      ? normalizeNullableBytes(update.totalBytes)
      : existing.totalBytes;
  const nextLocalUri = update.localUri !== undefined ? update.localUri : existing.localUri;
  const nextPaused =
    update.pausedForPlayback !== undefined
      ? update.pausedForPlayback
        ? 1
        : 0
      : existing.pausedForPlayback === true
        ? 1
        : 0;
  const nextError =
    update.errorCode !== undefined ? update.errorCode : (existing.errorCode ?? null);
  const nextCompletedAt =
    update.completedAt !== undefined ? update.completedAt : (existing.completedAt ?? null);
  const now = clock();

  await db.run(
    `UPDATE downloads
     SET bytes_downloaded = ?,
         total_bytes = ?,
         status = ?,
         local_uri = ?,
         paused_for_playback = ?,
         error_code = ?,
         completed_at = ?,
         updated_at = ?
     WHERE profile_id = ? AND item_key = ?`,
    [
      nextBytes,
      nextTotal,
      nextStatus,
      nextLocalUri,
      nextPaused,
      nextError,
      nextCompletedAt,
      now,
      pid,
      itemKey,
    ],
  );

  const updated = await getDownload(db, itemKey, pid);
  if (updated === null) return err(elvError('storage', 'item-not-found'));
  return ok(updated);
}

/** Updates the lifecycle status (and optional metadata) of an existing download record. */
export async function setDownloadStatus(
  db: SqlDriver,
  itemKey: string,
  status: DownloadStatus,
  opts: SetDownloadStatusOptions = {},
  clock: () => number = Date.now,
): Promise<Result<DownloadRecord>> {
  if (!isDownloadStatus(status)) {
    return err(elvError('source-format', 'invalid-download-status'));
  }
  const pid = normalizeProfileId(opts.profileId);
  const existing = await getDownload(db, itemKey, pid);
  if (existing === null) return err(elvError('storage', 'item-not-found'));

  const now = clock();
  const nextError = opts.errorCode !== undefined ? opts.errorCode : (existing.errorCode ?? null);
  const nextLocalUri = opts.localUri !== undefined ? opts.localUri : existing.localUri;
  const nextPaused =
    opts.pausedForPlayback !== undefined
      ? opts.pausedForPlayback
        ? 1
        : 0
      : existing.pausedForPlayback === true
        ? 1
        : 0;
  const nextCompletedAt =
    opts.completedAt !== undefined
      ? opts.completedAt
      : status === 'completed'
        ? (existing.completedAt ?? now)
        : (existing.completedAt ?? null);
  const nextBytes =
    opts.bytesDownloaded !== undefined
      ? clampBytes(opts.bytesDownloaded)
      : existing.bytesDownloaded;
  const nextTotal =
    opts.totalBytes !== undefined ? normalizeNullableBytes(opts.totalBytes) : existing.totalBytes;

  await db.run(
    `UPDATE downloads
     SET status = ?,
         error_code = ?,
         local_uri = ?,
         paused_for_playback = ?,
         completed_at = ?,
         bytes_downloaded = ?,
         total_bytes = ?,
         updated_at = ?
     WHERE profile_id = ? AND item_key = ?`,
    [
      status,
      nextError,
      nextLocalUri,
      nextPaused,
      nextCompletedAt,
      nextBytes,
      nextTotal,
      now,
      pid,
      itemKey,
    ],
  );

  const updated = await getDownload(db, itemKey, pid);
  if (updated === null) return err(elvError('storage', 'item-not-found'));
  return ok(updated);
}

/** Reads a single download record by `(profileId, itemKey)`, or `null` when absent. */
export async function getDownload(
  db: SqlDriver,
  itemKey: string,
  profileId?: string,
): Promise<DownloadRecord | null> {
  const pid = normalizeProfileId(profileId);
  const rows = await db.all<DownloadRowRaw>(
    `SELECT ${SELECT_COLUMNS}
     FROM downloads
     WHERE profile_id = ? AND item_key = ?
     LIMIT 1`,
    [pid, itemKey],
  );
  const row = rows[0];
  return row === undefined ? null : mapRow(row);
}

/** Lists downloads for a profile with optional status, media kind, and source filters. */
export async function listDownloads(
  db: SqlDriver,
  opts: ListDownloadsOptions = {},
): Promise<DownloadRecord[]> {
  const pid = normalizeProfileId(opts.profileId);
  const clauses: string[] = ['profile_id = ?'];
  const params: (string | number)[] = [pid];

  if (opts.status !== undefined) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    clauses.push(`status IN (${placeholders})`);
    for (const s of statuses) params.push(s);
  }
  if (opts.kind !== undefined) {
    clauses.push('kind = ?');
    params.push(opts.kind);
  }
  if (opts.sourceId !== undefined) {
    clauses.push('source_id = ?');
    params.push(opts.sourceId);
  }

  const rows = await db.all<DownloadRowRaw>(
    `SELECT ${SELECT_COLUMNS}
     FROM downloads
     WHERE ${clauses.join(' AND ')}
     ORDER BY updated_at DESC, item_key ASC`,
    params,
  );
  return rows.map(mapRow);
}

/** Deletes a single download record for `(profileId, itemKey)`. */
export async function deleteDownload(
  db: SqlDriver,
  itemKey: string,
  profileId?: string,
): Promise<Result<void>> {
  const pid = normalizeProfileId(profileId);
  await db.run('DELETE FROM downloads WHERE profile_id = ? AND item_key = ?', [pid, itemKey]);
  return ok(undefined);
}

/** Deletes all download records associated with `sourceId` across all profiles. */
export async function deleteDownloadsBySource(db: SqlDriver, sourceId: string): Promise<number> {
  const res = await db.run('DELETE FROM downloads WHERE source_id = ?', [sourceId]);
  return res.changes;
}
