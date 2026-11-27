import { elvError, err, ok, type Result, type SqlDriver } from '@elv/domain';
import { foldText } from './fold';
import type { ParentalQueryOptions } from './parental-policy';
import { isItemRestricted, loadActiveParentalFilter } from './parental-repo';
import {
  type ItemRow,
  mapItemRow,
  type RawItemRow,
  resolveQueryProfileId,
  sourceOfKey,
} from './queries-shared';

/** Maximum trimmed character length of a custom VOD collection name (`#403`). */
export const MAX_VOD_COLLECTION_NAME_LENGTH = 80;

/** Strict safe collection ID regex compatible with SQLite and IPC serialization. */
export const VOD_COLLECTION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** One custom per-profile VOD collection row with live hydrated item count (`#403`). */
export interface VodCollectionRecord {
  readonly id: string;
  readonly profileId: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly itemCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Input for {@link createCollection}. */
export interface CreateVodCollectionInput {
  readonly id?: string;
  readonly profileId?: string;
  readonly name: string;
}

interface RawCollectionRow {
  id: string;
  profile_id: string;
  name: string;
  sort_order: number;
  item_count: number;
  created_at: number;
  updated_at: number;
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateCollectionName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_VOD_COLLECTION_NAME_LENGTH ||
    hasControlChar(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function generateCollectionId(nowMs: number): string {
  const ts = Math.max(0, Math.floor(nowMs)).toString(36);
  const rand = Math.random().toString(36).slice(2, 10).padEnd(6, '0');
  return `vc_${ts}_${rand}`;
}

function mapCollectionRow(row: RawCollectionRow): VodCollectionRecord {
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

const LIVE_ITEM_COUNT_SUBQUERY = `(
  SELECT COUNT(*)
    FROM vod_collection_items ci
   WHERE ci.collection_id = c.id
     AND (
       (ci.kind = 'movie' AND EXISTS (
          SELECT 1 FROM movies m
            JOIN sources s ON s.id = m.source_id
           WHERE m.source_id = ci.source_id AND m.key = ci.item_key
             AND m.is_hidden = 0 AND s.deleting = 0
       ))
       OR
       (ci.kind = 'series' AND EXISTS (
          SELECT 1 FROM series sr
            JOIN sources s ON s.id = sr.source_id
           WHERE sr.source_id = ci.source_id AND sr.key = ci.item_key
             AND sr.is_hidden = 0 AND s.deleting = 0
       ))
     )
)`;

/**
 * Lists all custom VOD collections for `profileId` ordered by `sort_order ASC, created_at ASC`,
 * with live hydrated `itemCount` counting only currently present visible movies/series permitted
 * by the profile's active parental-control filter.
 */
export async function listCollections(
  db: SqlDriver,
  profileId?: string,
  opts?: { readonly parentalUnlocked?: boolean },
): Promise<VodCollectionRecord[]> {
  const pid = resolveQueryProfileId(profileId);
  const rows = await db.all<RawCollectionRow>(
    `SELECT c.id, c.profile_id, c.name, c.sort_order,
            ${LIVE_ITEM_COUNT_SUBQUERY} AS item_count,
            c.created_at, c.updated_at
       FROM vod_collections c
      WHERE c.profile_id = ?
      ORDER BY c.sort_order ASC, c.created_at ASC, c.id ASC`,
    [pid],
  );
  if (rows.length === 0) return [];
  const filter = await loadActiveParentalFilter(db, pid, opts?.parentalUnlocked);
  if (filter === null) return rows.map(mapCollectionRow);

  const visibleItems = await db.all<{ collection_id: string; item_key: string }>(
    `SELECT ci.collection_id, ci.item_key
       FROM vod_collection_items ci
       JOIN vod_collections c ON c.id = ci.collection_id
       JOIN sources s ON s.id = ci.source_id AND s.deleting = 0
      WHERE c.profile_id = ?
        AND (
          (ci.kind = 'movie' AND EXISTS (
             SELECT 1 FROM movies m
              WHERE m.source_id = ci.source_id AND m.key = ci.item_key AND m.is_hidden = 0
          ))
          OR
          (ci.kind = 'series' AND EXISTS (
             SELECT 1 FROM series sr
              WHERE sr.source_id = ci.source_id AND sr.key = ci.item_key AND sr.is_hidden = 0
          ))
        )`,
    [pid],
  );
  const counts = new Map<string, number>();
  for (const item of visibleItems) {
    if (await isItemRestricted(db, filter, item.item_key)) continue;
    counts.set(item.collection_id, (counts.get(item.collection_id) ?? 0) + 1);
  }
  return rows.map((row) => ({
    ...mapCollectionRow(row),
    itemCount: counts.get(row.id) ?? 0,
  }));
}

/** Creates a new per-profile VOD collection appended at `MAX(sort_order) + 1`. */
export async function createCollection(
  db: SqlDriver,
  input: CreateVodCollectionInput,
  nowMs: number = Date.now(),
): Promise<Result<VodCollectionRecord>> {
  const name = validateCollectionName(input.name);
  if (name === null) return err(elvError('source-format', 'invalid-collection-name'));
  const pid = resolveQueryProfileId(input.profileId);
  const now = Math.max(0, Math.round(nowMs));
  const id = input.id !== undefined ? input.id.trim() : generateCollectionId(now);
  if (!VOD_COLLECTION_ID_RE.test(id)) {
    return err(elvError('storage', 'invalid-collection-id'));
  }
  const nameFold = foldText(name);

  try {
    const sortOrder = await db.transaction(async (tx) => {
      const maxRow = await tx.all<{ next_order: number }>(
        'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next_order FROM vod_collections WHERE profile_id = ?',
        [pid],
      );
      const nextOrder = maxRow[0]?.next_order ?? 0;
      await tx.run(
        `INSERT INTO vod_collections (id, profile_id, name, name_fold, sort_order, created_at, updated_at)
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
    return err(elvError('storage', 'collection-write-failed'));
  }
}

/** Renames an existing VOD collection owned by `profileId`. */
export async function renameCollection(
  db: SqlDriver,
  id: string,
  name: string,
  profileId?: string,
  nowMs: number = Date.now(),
): Promise<Result<VodCollectionRecord>> {
  const validName = validateCollectionName(name);
  if (validName === null) return err(elvError('source-format', 'invalid-collection-name'));
  const pid = resolveQueryProfileId(profileId);
  const now = Math.max(0, Math.round(nowMs));

  const res = await db.run(
    `UPDATE vod_collections
        SET name = ?, name_fold = ?, updated_at = ?
      WHERE id = ? AND profile_id = ?`,
    [validName, foldText(validName), now, id, pid],
  );
  if (res.changes === 0) {
    return err(elvError('storage', 'collection-not-found'));
  }
  const rows = await db.all<RawCollectionRow>(
    `SELECT c.id, c.profile_id, c.name, c.sort_order,
            ${LIVE_ITEM_COUNT_SUBQUERY} AS item_count,
            c.created_at, c.updated_at
       FROM vod_collections c
      WHERE c.id = ? AND c.profile_id = ?
      LIMIT 1`,
    [id, pid],
  );
  const row = rows[0];
  return row === undefined
    ? err(elvError('storage', 'collection-not-found'))
    : ok(mapCollectionRow(row));
}

/** Reorders a profile's VOD collections into contiguous `0..N-1` `sort_order` positions. */
export async function reorderCollections(
  db: SqlDriver,
  orderedIds: readonly string[],
  profileId?: string,
  nowMs: number = Date.now(),
): Promise<Result<VodCollectionRecord[]>> {
  const pid = resolveQueryProfileId(profileId);
  const now = Math.max(0, Math.round(nowMs));

  await db.transaction(async (tx) => {
    const existing = await tx.all<{ id: string }>(
      'SELECT id FROM vod_collections WHERE profile_id = ? ORDER BY sort_order ASC, created_at ASC, id ASC',
      [pid],
    );
    const validSet = new Set(existing.map((r) => r.id));
    const finalOrder: string[] = [];
    const seen = new Set<string>();
    for (const id of orderedIds) {
      if (validSet.has(id) && !seen.has(id)) {
        seen.add(id);
        finalOrder.push(id);
      }
    }
    for (const row of existing) {
      if (!seen.has(row.id)) finalOrder.push(row.id);
    }
    for (let i = 0; i < finalOrder.length; i += 1) {
      await tx.run(
        'UPDATE vod_collections SET sort_order = ?, updated_at = ? WHERE id = ? AND profile_id = ?',
        [i, now, finalOrder[i] as string, pid],
      );
    }
  });

  return ok(await listCollections(db, pid));
}

/** Deletes a VOD collection and its items, compacting remaining `sort_order` values for `profileId`. */
export async function deleteCollection(
  db: SqlDriver,
  id: string,
  profileId?: string,
): Promise<Result<void>> {
  const pid = resolveQueryProfileId(profileId);
  const deleted = await db.transaction(async (tx) => {
    const res = await tx.run('DELETE FROM vod_collections WHERE id = ? AND profile_id = ?', [
      id,
      pid,
    ]);
    if (res.changes === 0) return false;
    await tx.run('DELETE FROM vod_collection_items WHERE collection_id = ?', [id]);
    const remaining = await tx.all<{ id: string }>(
      'SELECT id FROM vod_collections WHERE profile_id = ? ORDER BY sort_order ASC, created_at ASC, id ASC',
      [pid],
    );
    for (let i = 0; i < remaining.length; i += 1) {
      const rem = remaining[i];
      if (rem === undefined) continue;
      await tx.run('UPDATE vod_collections SET sort_order = ? WHERE id = ? AND profile_id = ?', [
        i,
        rem.id,
        pid,
      ]);
    }
    return true;
  });
  return deleted ? ok(undefined) : err(elvError('storage', 'collection-not-found'));
}

/**
 * Hydrates ordered movies and series inside `collectionId` in `position ASC` order,
 * applying the active parental-control filter so restricted items never leak.
 */
export async function listCollectionItems(
  db: SqlDriver,
  collectionId: string,
  opts?: ParentalQueryOptions,
): Promise<ItemRow[]> {
  const pid = resolveQueryProfileId(opts?.profileId);
  const owns = await db.all<{ id: string }>(
    'SELECT id FROM vod_collections WHERE id = ? AND profile_id = ? LIMIT 1',
    [collectionId, pid],
  );
  if (owns.length === 0) return [];

  const rows = await db.all<RawItemRow & { kind: 'movie' | 'series'; source_id: string }>(
    `SELECT ci.kind AS kind,
            COALESCE(m.id, sr.id) AS id,
            COALESCE(m.key, sr.key) AS key,
            COALESCE(m.source_id, sr.source_id) AS source_id,
            COALESCE(m.provider_id, sr.provider_id) AS provider_id,
            COALESCE(m.name, sr.name) AS name,
            COALESCE(m.logo, sr.cover) AS logo,
            COALESCE(m.rating, sr.rating) AS rating,
            COALESCE(m.year, sr.year) AS year,
            NULL AS num
       FROM vod_collection_items ci
       LEFT JOIN movies m
         ON ci.kind = 'movie' AND m.source_id = ci.source_id AND m.key = ci.item_key AND m.is_hidden = 0
       LEFT JOIN series sr
         ON ci.kind = 'series' AND sr.source_id = ci.source_id AND sr.key = ci.item_key AND sr.is_hidden = 0
       JOIN sources s
         ON s.id = ci.source_id AND s.deleting = 0
      WHERE ci.collection_id = ?
        AND ((ci.kind = 'movie' AND m.id IS NOT NULL) OR (ci.kind = 'series' AND sr.id IS NOT NULL))
      ORDER BY ci.position ASC, ci.added_at ASC`,
    [collectionId],
  );

  const filter = await loadActiveParentalFilter(db, pid, opts?.parentalUnlocked);
  if (filter === null) {
    return rows.map((r) => mapItemRow(r.kind, r.source_id, r));
  }
  const visible: ItemRow[] = [];
  for (const r of rows) {
    if (await isItemRestricted(db, filter, r.key)) continue;
    visible.push(mapItemRow(r.kind, r.source_id, r));
  }
  return visible;
}

/** Lists IDs of all VOD collections owned by `profileId` that contain `itemKey`. */
export async function listCollectionsForItem(
  db: SqlDriver,
  itemKey: string,
  profileId?: string,
): Promise<string[]> {
  const pid = resolveQueryProfileId(profileId);
  const rows = await db.all<{ id: string }>(
    `SELECT c.id
       FROM vod_collection_items ci
       JOIN vod_collections c ON c.id = ci.collection_id
      WHERE ci.item_key = ? AND c.profile_id = ?
      ORDER BY c.sort_order ASC, c.created_at ASC, c.id ASC`,
    [itemKey, pid],
  );
  return rows.map((r) => r.id);
}

/**
 * Adds a movie or series to `collectionId` (verifying `profileId` ownership), enforcing folder
 * semantics (at most one collection per item per profile): if `itemKey` is already in another
 * collection belonging to the same profile, it is atomically removed from that collection and both
 * collections have `updated_at` bumped so LWW sync propagates the move. Idempotent when already in
 * `collectionId`.
 */
export async function addItemToCollection(
  db: SqlDriver,
  collectionId: string,
  itemKey: string,
  kind: 'movie' | 'series',
  profileId?: string,
  nowMs: number = Date.now(),
): Promise<Result<void>> {
  if (kind !== 'movie' && kind !== 'series') {
    return err(elvError('source-format', 'invalid-item-kind'));
  }
  const sourceId = sourceOfKey(itemKey);
  if (sourceId === undefined || itemKey.trim() === '') {
    return err(elvError('source-format', 'invalid-item-key'));
  }
  const pid = resolveQueryProfileId(profileId);
  const now = Math.max(0, Math.round(nowMs));

  const found = await db.transaction(async (tx) => {
    const col = await tx.all<{ id: string }>(
      'SELECT id FROM vod_collections WHERE id = ? AND profile_id = ? LIMIT 1',
      [collectionId, pid],
    );
    if (col.length === 0) return false;
    const exists = await tx.all<{ item_key: string }>(
      'SELECT item_key FROM vod_collection_items WHERE collection_id = ? AND item_key = ? LIMIT 1',
      [collectionId, itemKey],
    );
    if (exists.length > 0) return true;
    const siblingCols = await tx.all<{ collection_id: string }>(
      `SELECT ci.collection_id
         FROM vod_collection_items ci
         JOIN vod_collections c ON c.id = ci.collection_id
        WHERE ci.item_key = ? AND c.profile_id = ? AND ci.collection_id != ?`,
      [itemKey, pid, collectionId],
    );
    for (const sibling of siblingCols) {
      await tx.run('DELETE FROM vod_collection_items WHERE collection_id = ? AND item_key = ?', [
        sibling.collection_id,
        itemKey,
      ]);
      await tx.run('UPDATE vod_collections SET updated_at = ? WHERE id = ?', [
        now,
        sibling.collection_id,
      ]);
    }
    const posRow = await tx.all<{ next_pos: number }>(
      'SELECT COALESCE(MAX(position) + 1, 0) AS next_pos FROM vod_collection_items WHERE collection_id = ?',
      [collectionId],
    );
    const nextPos = posRow[0]?.next_pos ?? 0;
    await tx.run(
      `INSERT INTO vod_collection_items (collection_id, item_key, source_id, kind, position, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [collectionId, itemKey, sourceId, kind, nextPos, now],
    );
    await tx.run('UPDATE vod_collections SET updated_at = ? WHERE id = ?', [now, collectionId]);
    return true;
  });

  return found ? ok(undefined) : err(elvError('storage', 'collection-not-found'));
}

/** Removes `itemKey` from `collectionId` and compacts remaining positions to `0..N-1`. */
export async function removeItemFromCollection(
  db: SqlDriver,
  collectionId: string,
  itemKey: string,
  profileId?: string,
  nowMs: number = Date.now(),
): Promise<Result<void>> {
  const pid = resolveQueryProfileId(profileId);
  const now = Math.max(0, Math.round(nowMs));

  const found = await db.transaction(async (tx) => {
    const col = await tx.all<{ id: string }>(
      'SELECT id FROM vod_collections WHERE id = ? AND profile_id = ? LIMIT 1',
      [collectionId, pid],
    );
    if (col.length === 0) return false;
    await tx.run('DELETE FROM vod_collection_items WHERE collection_id = ? AND item_key = ?', [
      collectionId,
      itemKey,
    ]);
    const remaining = await tx.all<{ item_key: string }>(
      'SELECT item_key FROM vod_collection_items WHERE collection_id = ? ORDER BY position ASC, added_at ASC',
      [collectionId],
    );
    for (let i = 0; i < remaining.length; i += 1) {
      const rem = remaining[i];
      if (rem === undefined) continue;
      await tx.run(
        'UPDATE vod_collection_items SET position = ? WHERE collection_id = ? AND item_key = ?',
        [i, collectionId, rem.item_key],
      );
    }
    await tx.run('UPDATE vod_collections SET updated_at = ? WHERE id = ?', [now, collectionId]);
    return true;
  });

  return found ? ok(undefined) : err(elvError('storage', 'collection-not-found'));
}

/** Reorders items inside `collectionId` into contiguous `0..N-1` positions. */
export async function reorderCollectionItems(
  db: SqlDriver,
  collectionId: string,
  orderedItemKeys: readonly string[],
  profileId?: string,
  nowMs: number = Date.now(),
): Promise<Result<void>> {
  const pid = resolveQueryProfileId(profileId);
  const now = Math.max(0, Math.round(nowMs));

  const found = await db.transaction(async (tx) => {
    const col = await tx.all<{ id: string }>(
      'SELECT id FROM vod_collections WHERE id = ? AND profile_id = ? LIMIT 1',
      [collectionId, pid],
    );
    if (col.length === 0) return false;
    const existing = await tx.all<{ item_key: string }>(
      'SELECT item_key FROM vod_collection_items WHERE collection_id = ? ORDER BY position ASC, added_at ASC',
      [collectionId],
    );
    const validSet = new Set(existing.map((r) => r.item_key));
    const finalOrder: string[] = [];
    const seen = new Set<string>();
    for (const key of orderedItemKeys) {
      if (validSet.has(key) && !seen.has(key)) {
        seen.add(key);
        finalOrder.push(key);
      }
    }
    for (const row of existing) {
      if (!seen.has(row.item_key)) finalOrder.push(row.item_key);
    }
    for (let i = 0; i < finalOrder.length; i += 1) {
      await tx.run(
        'UPDATE vod_collection_items SET position = ? WHERE collection_id = ? AND item_key = ?',
        [i, collectionId, finalOrder[i] as string],
      );
    }
    await tx.run('UPDATE vod_collections SET updated_at = ? WHERE id = ?', [now, collectionId]);
    return true;
  });

  return found ? ok(undefined) : err(elvError('storage', 'collection-not-found'));
}
