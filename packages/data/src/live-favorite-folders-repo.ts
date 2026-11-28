import { elvError, err, ok, type Result, type SqlDriver } from '@elv/domain';
import { foldText } from './fold';
import { findRestrictedItemKeys, loadActiveParentalFilter } from './parental-repo';
import { resolveSafeStorageLogo } from './queries';
import { isSafeRecentChannelKey } from './recent-channels-repo';
import { SOURCE_ID } from './sources';
import { normalizeProfileId } from './user-state-helpers';

/** Maximum trimmed character length of a Live TV favorite folder name (`F-11`). */
export const MAX_LIVE_FAVORITE_FOLDER_NAME_LENGTH = 80;

/** Strict safe Live TV favorite folder ID pattern compatible with SQLite and IPC serialization. */
export const LIVE_FAVORITE_FOLDER_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** One per-profile cross-source Live TV favorite folder with visible favorited `itemCount` (`F-11`). */
export interface LiveFavoriteFolderRecord {
  readonly id: string;
  readonly profileId: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly itemCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Input for {@link createLiveFavoriteFolder}. */
export interface CreateLiveFavoriteFolderInput {
  readonly id?: string;
  readonly name: string;
  readonly profileId?: string;
}

/** Input for {@link assignLiveFavoriteFolder}. Pass `folderId: null` to move the channel to Unfiled. */
export interface AssignLiveFavoriteFolderInput {
  readonly itemKey: string;
  readonly sourceId: string;
  readonly folderId: string | null;
  readonly title?: string;
  readonly logo?: string | null;
  readonly profileId?: string;
}

/** One channel-to-folder assignment row (`F-11`). */
export interface LiveFavoriteFolderAssignment {
  readonly itemKey: string;
  readonly folderId: string;
}

interface RawLiveFavoriteFolderRow {
  id: string;
  profile_id: string;
  name: string;
  sort_order: number;
  item_count: number;
  created_at: number;
  updated_at: number;
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateFolderName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_LIVE_FAVORITE_FOLDER_NAME_LENGTH ||
    hasControlChar(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function generateFolderId(nowMs: number): string {
  const ts = Math.max(0, Math.floor(nowMs)).toString(36);
  const rand = Math.random().toString(36).slice(2, 10).padEnd(6, '0');
  return `lff_${ts}_${rand}`;
}

function mapFolderRow(row: RawLiveFavoriteFolderRow): LiveFavoriteFolderRecord {
  return {
    id: row.id,
    profileId: row.profile_id,
    name: row.name,
    sortOrder: row.sort_order,
    itemCount: row.item_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const VISIBLE_FOLDER_ITEM_COUNT_SQL = `(
  SELECT COUNT(*)
    FROM live_favorite_folder_items lfi
    INNER JOIN favorites f
      ON f.profile_id = lfi.profile_id AND f.item_key = lfi.item_key AND f.kind = 'live'
    INNER JOIN live t
      ON t.source_id = lfi.source_id AND t.key = lfi.item_key
    INNER JOIN sources s
      ON s.id = t.source_id AND s.deleting = 0
    LEFT JOIN channel_overrides co
      ON co.profile_id = lfi.profile_id AND co.item_key = lfi.item_key
   WHERE lfi.folder_id = fl.id
     AND t.is_hidden = 0
     AND COALESCE(co.is_hidden, 0) = 0
)`;

async function applyParentalFolderCounts(
  db: SqlDriver,
  pid: string,
  rows: readonly RawLiveFavoriteFolderRow[],
  parentalUnlocked?: boolean,
  folderId?: string,
): Promise<LiveFavoriteFolderRecord[]> {
  if (rows.length === 0) return [];
  const filter = await loadActiveParentalFilter(db, pid, parentalUnlocked);
  if (filter === null) return rows.map(mapFolderRow);

  const visibleItems = await db.all<{
    folder_id: string;
    item_key: string;
    source_id: string;
    raw_name: string;
  }>(
    `SELECT lfi.folder_id, lfi.item_key, lfi.source_id, t.name AS raw_name
       FROM live_favorite_folder_items lfi
       INNER JOIN favorites f
         ON f.profile_id = lfi.profile_id AND f.item_key = lfi.item_key AND f.kind = 'live'
       INNER JOIN live t
         ON t.source_id = lfi.source_id AND t.key = lfi.item_key
       INNER JOIN sources s
         ON s.id = t.source_id AND s.deleting = 0
       LEFT JOIN channel_overrides co
         ON co.profile_id = lfi.profile_id AND co.item_key = lfi.item_key
      WHERE lfi.profile_id = ?${folderId !== undefined ? ' AND lfi.folder_id = ?' : ''}
        AND t.is_hidden = 0
        AND COALESCE(co.is_hidden, 0) = 0`,
    folderId !== undefined ? [pid, folderId] : [pid],
  );
  const restricted = await findRestrictedItemKeys(
    db,
    filter,
    visibleItems.map((i) => ({
      itemKey: i.item_key,
      sourceId: i.source_id,
      kind: 'live' as const,
      title: i.raw_name,
    })),
  );
  const counts = new Map<string, number>();
  for (const item of visibleItems) {
    if (restricted.has(item.item_key)) continue;
    counts.set(item.folder_id, (counts.get(item.folder_id) ?? 0) + 1);
  }
  return rows.map((row) => ({
    ...mapFolderRow(row),
    itemCount: counts.get(row.id) ?? 0,
  }));
}

/**
 * Lists all Live TV favorite folders for `profileId` ordered by `sort_order ASC, created_at ASC, id ASC`,
 * with live visible favorited `itemCount` honoring hidden flags, deleting sources, and parental controls.
 */
export async function listLiveFavoriteFolders(
  db: SqlDriver,
  profileId?: string,
  opts?: { readonly parentalUnlocked?: boolean },
): Promise<LiveFavoriteFolderRecord[]> {
  const pid = normalizeProfileId(profileId);
  const rows = await db.all<RawLiveFavoriteFolderRow>(
    `SELECT fl.id, fl.profile_id, fl.name, fl.sort_order,
            ${VISIBLE_FOLDER_ITEM_COUNT_SQL} AS item_count,
            fl.created_at, fl.updated_at
       FROM live_favorite_folders fl
      WHERE fl.profile_id = ?
      ORDER BY fl.sort_order ASC, fl.created_at ASC, fl.id ASC`,
    [pid],
  );
  return applyParentalFolderCounts(db, pid, rows, opts?.parentalUnlocked);
}

/** Creates a new per-profile Live TV favorite folder appended at `MAX(sort_order) + 1`. */
export async function createLiveFavoriteFolder(
  db: SqlDriver,
  input: CreateLiveFavoriteFolderInput,
  nowMs: number = Date.now(),
): Promise<Result<LiveFavoriteFolderRecord>> {
  const name = validateFolderName(input.name);
  if (name === null) return err(elvError('source-format', 'invalid-folder-name'));
  const pid = normalizeProfileId(input.profileId);
  const now = Math.max(0, Math.round(nowMs));
  const id = input.id !== undefined ? input.id.trim() : generateFolderId(now);
  if (!LIVE_FAVORITE_FOLDER_ID_RE.test(id)) {
    return err(elvError('storage', 'invalid-folder-id'));
  }
  const nameFold = foldText(name);

  try {
    const sortOrder = await db.transaction(async (tx) => {
      const maxRow = await tx.all<{ next_order: number }>(
        'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next_order FROM live_favorite_folders WHERE profile_id = ?',
        [pid],
      );
      const nextOrder = maxRow[0]?.next_order ?? 0;
      await tx.run(
        `INSERT INTO live_favorite_folders (id, profile_id, name, name_fold, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, pid, name, nameFold, nextOrder, now, now],
      );
      return nextOrder;
    });
    return ok({
      id,
      profileId: pid,
      name,
      sortOrder,
      itemCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    return err(elvError('storage', 'folder-already-exists'));
  }
}

/** Renames an existing Live TV favorite folder owned by `profileId`. */
export async function renameLiveFavoriteFolder(
  db: SqlDriver,
  id: string,
  name: string,
  profileId?: string,
  nowMs: number = Date.now(),
  opts?: { readonly parentalUnlocked?: boolean },
): Promise<Result<LiveFavoriteFolderRecord>> {
  const trimmedId = id.trim();
  if (!LIVE_FAVORITE_FOLDER_ID_RE.test(trimmedId)) {
    return err(elvError('storage', 'invalid-folder-id'));
  }
  const validName = validateFolderName(name);
  if (validName === null) return err(elvError('source-format', 'invalid-folder-name'));
  const pid = normalizeProfileId(profileId);
  const now = Math.max(0, Math.round(nowMs));
  const nameFold = foldText(validName);

  const res = await db.run(
    `UPDATE live_favorite_folders
        SET name = ?, name_fold = ?, updated_at = ?
      WHERE id = ? AND profile_id = ?`,
    [validName, nameFold, now, trimmedId, pid],
  );
  if (res.changes === 0) return err(elvError('storage', 'folder-not-found'));

  const rows = await db.all<RawLiveFavoriteFolderRow>(
    `SELECT fl.id, fl.profile_id, fl.name, fl.sort_order,
            ${VISIBLE_FOLDER_ITEM_COUNT_SQL} AS item_count,
            fl.created_at, fl.updated_at
       FROM live_favorite_folders fl
      WHERE fl.id = ? AND fl.profile_id = ?
      LIMIT 1`,
    [trimmedId, pid],
  );
  const filtered = await applyParentalFolderCounts(
    db,
    pid,
    rows,
    opts?.parentalUnlocked,
    trimmedId,
  );
  const record = filtered[0];
  if (record === undefined) return err(elvError('storage', 'folder-not-found'));
  return ok(record);
}

/**
 * Deletes a Live TV favorite folder owned by `profileId`.
 * Cascade-removes `live_favorite_folder_items` while preserving every channel's `favorites` row (channels become Unfiled).
 */
export async function deleteLiveFavoriteFolder(
  db: SqlDriver,
  id: string,
  profileId?: string,
): Promise<Result<void>> {
  const trimmedId = id.trim();
  if (!LIVE_FAVORITE_FOLDER_ID_RE.test(trimmedId)) {
    return err(elvError('storage', 'invalid-folder-id'));
  }
  const pid = normalizeProfileId(profileId);
  const deleted = await db.transaction(async (tx) => {
    const res = await tx.run('DELETE FROM live_favorite_folders WHERE id = ? AND profile_id = ?', [
      trimmedId,
      pid,
    ]);
    if (res.changes === 0) return false;
    const remaining = await tx.all<{ id: string }>(
      'SELECT id FROM live_favorite_folders WHERE profile_id = ? ORDER BY sort_order ASC, created_at ASC, id ASC',
      [pid],
    );
    for (let i = 0; i < remaining.length; i += 1) {
      await tx.run('UPDATE live_favorite_folders SET sort_order = ? WHERE id = ?', [
        i,
        remaining[i]?.id ?? '',
      ]);
    }
    return true;
  });
  return deleted ? ok(undefined) : err(elvError('storage', 'folder-not-found'));
}

const AUTO_STAR_FAVORITE_SQL = `INSERT OR IGNORE INTO favorites (
  profile_id, source_id, item_key, kind, title, logo, year, rating, added_at, sort_order
) VALUES (
  ?, ?, ?, 'live', ?, ?, NULL, NULL, ?,
  COALESCE((SELECT MAX(sort_order) FROM favorites WHERE profile_id = ?), 0) + 1
)`;

/**
 * Assigns a live channel to a folder (or `null` to move to Unfiled) with atomic 1-folder-per-channel semantics.
 * When `folderId !== null`, verifies folder ownership and auto-stars the channel in `favorites` if needed.
 * Stores only `source_id` + `item_key` (never stream URLs or credentials).
 */
export async function assignLiveFavoriteFolder(
  db: SqlDriver,
  input: AssignLiveFavoriteFolderInput,
  nowMs: number = Date.now(),
): Promise<Result<void>> {
  if (!isSafeRecentChannelKey(input.itemKey) || !SOURCE_ID.test(input.sourceId)) {
    return err(elvError('source-format', 'invalid-folder-item'));
  }
  const itemKey = input.itemKey.trim();
  const pid = normalizeProfileId(input.profileId);
  const now = Math.max(0, Math.round(nowMs));

  if (input.folderId === null) {
    await db.transaction(async (tx) => {
      const prev = await tx.all<{ folder_id: string }>(
        'SELECT folder_id FROM live_favorite_folder_items WHERE profile_id = ? AND item_key = ? LIMIT 1',
        [pid, itemKey],
      );
      await tx.run('DELETE FROM live_favorite_folder_items WHERE profile_id = ? AND item_key = ?', [
        pid,
        itemKey,
      ]);
      const prevFolderId = prev[0]?.folder_id;
      if (prevFolderId !== undefined) {
        await tx.run('UPDATE live_favorite_folders SET updated_at = ? WHERE id = ?', [
          now,
          prevFolderId,
        ]);
      }
    });
    return ok(undefined);
  }

  const folderId = input.folderId.trim();
  if (!LIVE_FAVORITE_FOLDER_ID_RE.test(folderId)) {
    return err(elvError('storage', 'invalid-folder-id'));
  }

  const safeLogo = await resolveSafeStorageLogo(db, {
    sourceId: input.sourceId,
    itemKey,
    kind: 'live',
    logo: input.logo ?? null,
  });

  const outcome = await db.transaction(async (tx) => {
    const owned = await tx.all<{ id: string }>(
      'SELECT id FROM live_favorite_folders WHERE id = ? AND profile_id = ? LIMIT 1',
      [folderId, pid],
    );
    if (owned.length === 0) return 'not-found' as const;

    const liveRows = await tx.all<{ name: string }>(
      'SELECT name FROM live WHERE source_id = ? AND key = ? LIMIT 1',
      [input.sourceId, itemKey],
    );
    const trimmedInputTitle = input.title?.trim() ?? '';
    const title =
      liveRows[0]?.name && liveRows[0].name.trim() !== ''
        ? liveRows[0].name
        : trimmedInputTitle !== ''
          ? trimmedInputTitle
          : itemKey;

    await tx.run(AUTO_STAR_FAVORITE_SQL, [pid, input.sourceId, itemKey, title, safeLogo, now, pid]);

    const prev = await tx.all<{ folder_id: string; position: number }>(
      'SELECT folder_id, position FROM live_favorite_folder_items WHERE profile_id = ? AND item_key = ? LIMIT 1',
      [pid, itemKey],
    );
    const prevFolderId = prev[0]?.folder_id;
    let position = prev[0]?.position ?? 0;
    if (prevFolderId !== folderId) {
      const maxPos = await tx.all<{ next_pos: number }>(
        'SELECT COALESCE(MAX(position) + 1, 0) AS next_pos FROM live_favorite_folder_items WHERE folder_id = ?',
        [folderId],
      );
      position = maxPos[0]?.next_pos ?? 0;
    }

    await tx.run(
      `INSERT INTO live_favorite_folder_items (folder_id, profile_id, source_id, item_key, position, added_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, item_key) DO UPDATE SET
         folder_id = excluded.folder_id,
         source_id = excluded.source_id,
         position = excluded.position,
         added_at = excluded.added_at`,
      [folderId, pid, input.sourceId, itemKey, position, now],
    );
    await tx.run('UPDATE live_favorite_folders SET updated_at = ? WHERE id = ?', [now, folderId]);
    if (prevFolderId !== undefined && prevFolderId !== folderId) {
      await tx.run('UPDATE live_favorite_folders SET updated_at = ? WHERE id = ?', [
        now,
        prevFolderId,
      ]);
    }
    return 'ok' as const;
  });

  return outcome === 'ok' ? ok(undefined) : err(elvError('storage', 'folder-not-found'));
}

/** Lists all channel-to-folder assignments for `profileId`. */
export async function listLiveFavoriteFolderAssignments(
  db: SqlDriver,
  profileId?: string,
): Promise<LiveFavoriteFolderAssignment[]> {
  const pid = normalizeProfileId(profileId);
  const rows = await db.all<{ item_key: string; folder_id: string }>(
    `SELECT item_key, folder_id
       FROM live_favorite_folder_items
      WHERE profile_id = ?
      ORDER BY folder_id ASC, position ASC, item_key ASC`,
    [pid],
  );
  return rows.map((r) => ({ itemKey: r.item_key, folderId: r.folder_id }));
}

/**
 * @internal Removes any `live_favorite_folder_items` assignment for `(profileId, itemKey)` inside an
 * active unfavorite transaction and bumps the vacated folder's `updated_at`.
 */
export async function removeLiveFavoriteFolderAssignmentInTx(
  tx: SqlDriver,
  profileId: string,
  itemKey: string,
  nowMs?: number,
): Promise<void> {
  const prev = await tx.all<{ folder_id: string }>(
    'SELECT folder_id FROM live_favorite_folder_items WHERE profile_id = ? AND item_key = ? LIMIT 1',
    [profileId, itemKey],
  );
  if (prev.length === 0) return;
  await tx.run('DELETE FROM live_favorite_folder_items WHERE profile_id = ? AND item_key = ?', [
    profileId,
    itemKey,
  ]);
  const prevFolderId = prev[0]?.folder_id;
  if (prevFolderId !== undefined && nowMs !== undefined) {
    await tx.run('UPDATE live_favorite_folders SET updated_at = ? WHERE id = ?', [
      Math.max(0, Math.round(nowMs)),
      prevFolderId,
    ]);
  }
}
