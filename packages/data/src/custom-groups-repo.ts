import { elvError, err, ok, type Result, type SqlDriver, type SqlValue } from '@elv/domain';
import { hasControlChar, isSafeChannelKey } from './channel-overrides-repo';
import {
  buildSqlAdultKeywordExclusionClause,
  buildSqlItemRestrictionClause,
  loadActiveParentalFilter,
} from './parental-repo';
import { isValidProfileId } from './profiles-repo';
import { SOURCE_ID } from './sources';
import { normalizeProfileId } from './user-state-helpers';

/** Synthetic category ID prefix for user-defined live channel custom groups (`#60`). */
export const CUSTOM_GROUP_CATEGORY_PREFIX = '__custom:';

/** Maximum trimmed character length of a custom group display name (`#60`). */
export const MAX_CUSTOM_GROUP_NAME_LENGTH = 80;

/** Strict safe identifier pattern for custom group IDs (`<= 128` chars). */
export const CUSTOM_GROUP_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const GROUP_ITEMS_BATCH_SIZE = 500;

/** A user-defined live channel group persisted in `custom_groups` (`#60`). */
export interface CustomGroupRecord {
  readonly id: string;
  readonly profileId: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly isHidden: boolean;
  readonly itemCount: number;
  readonly updatedAt: number;
}

/** Input for {@link createCustomGroup}. */
export interface CreateCustomGroupInput {
  /** Optional explicit cross-device custom group ID (`<= 128` chars matching {@link CUSTOM_GROUP_ID_RE}). */
  readonly id?: string;
  readonly profileId?: string;
  readonly name: string;
  readonly sortOrder?: number;
  readonly isHidden?: boolean;
}

/** Partial update patch for {@link updateCustomGroup}. */
export interface UpdateCustomGroupPatch {
  readonly name?: string;
  readonly sortOrder?: number;
  readonly isHidden?: boolean;
}

/** One channel assignment entry for {@link setCustomGroupItems}. */
export interface CustomGroupItemInput {
  readonly itemKey: string;
  readonly sourceId: string;
}

/** Persisted row shape for `custom_group_items` (also used in user-state backup/restore). */
export interface CustomGroupItemRecord {
  readonly groupId: string;
  readonly itemKey: string;
  readonly sourceId: string;
  readonly position: number;
  readonly addedAt: number;
}

interface RawCustomGroupRow {
  id: string;
  profile_id: string;
  name: string;
  sort_order: number;
  is_hidden: number;
  updated_at: number;
  item_count?: number;
}

/** Type guard verifying a safe custom group ID matching {@link CUSTOM_GROUP_ID_RE}. */
export function isValidCustomGroupId(id: unknown): id is string {
  return typeof id === 'string' && CUSTOM_GROUP_ID_RE.test(id);
}

/** Encodes a custom group ID as a synthetic live category ID (`__custom:<groupId>`). */
export function customGroupCategoryId(groupId: string): string {
  return `${CUSTOM_GROUP_CATEGORY_PREFIX}${groupId}`;
}

/** Extracts the group ID from a synthetic `__custom:<groupId>` category ID, or `undefined` otherwise. */
export function parseCustomGroupCategoryId(categoryId: string): string | undefined {
  if (!categoryId.startsWith(CUSTOM_GROUP_CATEGORY_PREFIX)) return undefined;
  const groupId = categoryId.slice(CUSTOM_GROUP_CATEGORY_PREFIX.length);
  return isValidCustomGroupId(groupId) ? groupId : undefined;
}

function validateGroupName(raw: unknown): Result<string> {
  if (typeof raw !== 'string') {
    return err(elvError('source-format', 'invalid-custom-group-name'));
  }
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_CUSTOM_GROUP_NAME_LENGTH ||
    hasControlChar(trimmed)
  ) {
    return err(elvError('source-format', 'invalid-custom-group-name'));
  }
  return ok(trimmed);
}

function validateGroupSortOrder(raw: unknown): Result<number> {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return err(elvError('source-format', 'invalid-custom-group'));
  }
  return ok(Math.floor(raw));
}

function resolveProfile(profileId?: string): Result<string> {
  const normalized = normalizeProfileId(profileId);
  if (!isValidProfileId(normalized)) {
    return err(elvError('source-format', 'invalid-profile-id'));
  }
  return ok(normalized);
}

function defaultGroupId(clock: () => number): string {
  const ts = Math.max(0, Math.floor(clock())).toString(36);
  const rand = Math.random().toString(36).slice(2, 10).padEnd(6, '0');
  return `g_${ts}_${rand}`;
}

function mapGroupRow(row: RawCustomGroupRow): CustomGroupRecord {
  return {
    id: row.id,
    profileId: row.profile_id,
    name: row.name,
    sortOrder: row.sort_order,
    isHidden: row.is_hidden !== 0,
    itemCount: row.item_count ?? 0,
    updatedAt: row.updated_at,
  };
}

/**
 * Lists custom live channel groups for `profileId` ordered by `sortOrder ASC, updatedAt ASC, id ASC`,
 * with live visible item counts honoring `channel_overrides.is_hidden` and active parental controls (`#60`, `#31`).
 */
export async function listCustomGroups(
  db: SqlDriver,
  profileId?: string,
  opts?: { readonly includeHidden?: boolean; readonly parentalUnlocked?: boolean },
): Promise<CustomGroupRecord[]> {
  const profile = resolveProfile(profileId);
  if (!profile.ok) return [];
  const includeHidden = opts?.includeHidden === true;
  const filter = await loadActiveParentalFilter(db, profile.value, opts?.parentalUnlocked);
  const restrict =
    filter === null
      ? { clause: '', params: [] as readonly SqlValue[] }
      : buildSqlItemRestrictionClause(filter, 'live', 'l.source_id', 'l.key');
  const adultExcl = buildSqlAdultKeywordExclusionClause(filter, 'l.name', 'l.name_fold');
  const groupHiddenClause = includeHidden ? '' : ' AND g.is_hidden = 0';
  const itemOverrideClause = includeHidden ? '' : ' AND COALESCE(co.is_hidden, 0) = 0';

  const rows = await db.all<RawCustomGroupRow>(
    `SELECT g.id, g.profile_id, g.name, g.sort_order, g.is_hidden, g.updated_at,
            COALESCE(counts.n, 0) AS item_count
       FROM custom_groups g
       LEFT JOIN (
         SELECT cgi.group_id, COUNT(*) AS n
           FROM custom_group_items cgi
           JOIN live l ON l.source_id = cgi.source_id AND l.key = cgi.item_key AND l.is_hidden = 0
           JOIN sources s ON s.id = cgi.source_id AND s.deleting = 0
           LEFT JOIN channel_overrides co ON co.profile_id = ? AND co.item_key = cgi.item_key
          WHERE 1 = 1${itemOverrideClause}${restrict.clause}${adultExcl}
          GROUP BY cgi.group_id
       ) counts ON counts.group_id = g.id
      WHERE g.profile_id = ?${groupHiddenClause}
      ORDER BY g.sort_order ASC, g.updated_at ASC, g.id ASC`,
    [profile.value, ...restrict.params, profile.value],
  );
  return rows.map(mapGroupRow);
}

/** Creates a new per-profile custom live channel group (`#60`). */
export async function createCustomGroup(
  db: SqlDriver,
  input: CreateCustomGroupInput,
  clock: () => number = Date.now,
  newId?: () => string,
): Promise<Result<CustomGroupRecord>> {
  const profile = resolveProfile(input.profileId);
  if (!profile.ok) return profile;
  const name = validateGroupName(input.name);
  if (!name.ok) return name;

  let explicitSortOrder: number | undefined;
  if (input.sortOrder !== undefined) {
    const validated = validateGroupSortOrder(input.sortOrder);
    if (!validated.ok) return validated;
    explicitSortOrder = validated.value;
  }

  const id =
    input.id !== undefined
      ? input.id.trim()
      : newId !== undefined
        ? newId()
        : defaultGroupId(clock);
  if (!isValidCustomGroupId(id)) {
    return err(elvError('storage', 'invalid-custom-group-id'));
  }
  const isHidden = input.isHidden === true;
  const now = Math.max(0, Math.round(clock()));

  try {
    const sortOrder = await db.transaction(async (tx) => {
      let resolvedSort = explicitSortOrder;
      if (resolvedSort === undefined) {
        const rows = await tx.all<{ next_sort: number }>(
          'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort FROM custom_groups WHERE profile_id = ?',
          [profile.value],
        );
        resolvedSort = rows[0]?.next_sort ?? 0;
      }
      await tx.run(
        `INSERT INTO custom_groups (id, profile_id, name, sort_order, is_hidden, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, profile.value, name.value, resolvedSort, isHidden ? 1 : 0, now],
      );
      return resolvedSort;
    });
    return ok({
      id,
      profileId: profile.value,
      name: name.value,
      sortOrder,
      isHidden,
      itemCount: 0,
      updatedAt: now,
    });
  } catch {
    return err(elvError('storage', 'custom-group-write-failed'));
  }
}

/** Updates a custom group's name, sort order, or visibility flag (`#60`). */
export async function updateCustomGroup(
  db: SqlDriver,
  groupId: string,
  patch: UpdateCustomGroupPatch,
  clock: () => number = Date.now,
): Promise<Result<CustomGroupRecord>> {
  if (!isValidCustomGroupId(groupId)) {
    return err(elvError('storage', 'custom-group-not-found'));
  }
  const existingRows = await db.all<RawCustomGroupRow>(
    'SELECT id, profile_id, name, sort_order, is_hidden, updated_at FROM custom_groups WHERE id = ? LIMIT 1',
    [groupId],
  );
  const existing = existingRows[0];
  if (existing === undefined) {
    return err(elvError('storage', 'custom-group-not-found'));
  }

  let nextName = existing.name;
  if (patch.name !== undefined) {
    const validated = validateGroupName(patch.name);
    if (!validated.ok) return validated;
    nextName = validated.value;
  }

  let nextSortOrder = existing.sort_order;
  if (patch.sortOrder !== undefined) {
    const validated = validateGroupSortOrder(patch.sortOrder);
    if (!validated.ok) return validated;
    nextSortOrder = validated.value;
  }

  const nextIsHidden = patch.isHidden !== undefined ? patch.isHidden : existing.is_hidden !== 0;
  const now = Math.max(0, Math.round(clock()));

  await db.run(
    'UPDATE custom_groups SET name = ?, sort_order = ?, is_hidden = ?, updated_at = ? WHERE id = ?',
    [nextName, nextSortOrder, nextIsHidden ? 1 : 0, now, groupId],
  );

  const countRows = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM custom_group_items cgi
       JOIN live l ON l.source_id = cgi.source_id AND l.key = cgi.item_key AND l.is_hidden = 0
       JOIN sources s ON s.id = cgi.source_id AND s.deleting = 0
       LEFT JOIN channel_overrides co ON co.profile_id = ? AND co.item_key = cgi.item_key
      WHERE cgi.group_id = ? AND COALESCE(co.is_hidden, 0) = 0`,
    [existing.profile_id, groupId],
  );

  return ok({
    id: existing.id,
    profileId: existing.profile_id,
    name: nextName,
    sortOrder: nextSortOrder,
    isHidden: nextIsHidden,
    itemCount: countRows[0]?.n ?? 0,
    updatedAt: now,
  });
}

/** Deletes a custom group and all of its channel assignments atomically (`#60`). */
export async function deleteCustomGroup(db: SqlDriver, groupId: string): Promise<Result<void>> {
  if (!isValidCustomGroupId(groupId)) {
    return err(elvError('storage', 'custom-group-not-found'));
  }
  const deleted = await db.transaction(async (tx) => {
    const res = await tx.run('DELETE FROM custom_groups WHERE id = ?', [groupId]);
    if (res.changes === 0) return false;
    await tx.run('DELETE FROM custom_group_items WHERE group_id = ?', [groupId]);
    return true;
  });
  if (!deleted) return err(elvError('storage', 'custom-group-not-found'));
  return ok(undefined);
}

const INSERT_GROUP_ITEM_SQL = `INSERT INTO custom_group_items (
  group_id, item_key, source_id, position, added_at
) VALUES (?, ?, ?, ?, ?)`;

/** Atomically replaces the ordered live channel membership list of `groupId` (`#60`). */
export async function setCustomGroupItems(
  db: SqlDriver,
  groupId: string,
  items: readonly CustomGroupItemInput[],
  clock: () => number = Date.now,
): Promise<Result<void>> {
  if (!isValidCustomGroupId(groupId)) {
    return err(elvError('storage', 'custom-group-not-found'));
  }
  const deduped: CustomGroupItemInput[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isSafeChannelKey(item.itemKey) || !SOURCE_ID.test(item.sourceId)) {
      return err(elvError('source-format', 'invalid-custom-group-item'));
    }
    const key = item.itemKey.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ itemKey: key, sourceId: item.sourceId });
  }

  const now = Math.max(0, Math.round(clock()));
  const found = await db.transaction(async (tx) => {
    const exists = await tx.all<{ found: number }>(
      'SELECT 1 AS found FROM custom_groups WHERE id = ? LIMIT 1',
      [groupId],
    );
    if (exists.length === 0) return false;
    await tx.run('DELETE FROM custom_group_items WHERE group_id = ?', [groupId]);
    for (let i = 0; i < deduped.length; i += GROUP_ITEMS_BATCH_SIZE) {
      const slice = deduped.slice(i, i + GROUP_ITEMS_BATCH_SIZE);
      await tx.batch(
        INSERT_GROUP_ITEM_SQL,
        slice.map((entry, offset) => [groupId, entry.itemKey, entry.sourceId, i + offset, now]),
      );
    }
    await tx.run('UPDATE custom_groups SET updated_at = ? WHERE id = ?', [now, groupId]);
    return true;
  });

  if (!found) return err(elvError('storage', 'custom-group-not-found'));
  return ok(undefined);
}

/** Appends a live channel to `groupId` (idempotent when already present) (`#60`). */
export async function addChannelToCustomGroup(
  db: SqlDriver,
  groupId: string,
  itemKey: string,
  sourceId: string,
  clock: () => number = Date.now,
): Promise<Result<void>> {
  if (!isValidCustomGroupId(groupId)) {
    return err(elvError('storage', 'custom-group-not-found'));
  }
  if (!isSafeChannelKey(itemKey) || !SOURCE_ID.test(sourceId)) {
    return err(elvError('source-format', 'invalid-custom-group-item'));
  }
  const key = itemKey.trim();
  const now = Math.max(0, Math.round(clock()));

  const found = await db.transaction(async (tx) => {
    const exists = await tx.all<{ found: number }>(
      'SELECT 1 AS found FROM custom_groups WHERE id = ? LIMIT 1',
      [groupId],
    );
    if (exists.length === 0) return false;
    const existingItem = await tx.all<{ position: number }>(
      'SELECT position FROM custom_group_items WHERE group_id = ? AND item_key = ? LIMIT 1',
      [groupId, key],
    );
    if (existingItem.length > 0) {
      await tx.run(
        'UPDATE custom_group_items SET source_id = ? WHERE group_id = ? AND item_key = ?',
        [sourceId, groupId, key],
      );
    } else {
      const posRows = await tx.all<{ next_pos: number }>(
        'SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM custom_group_items WHERE group_id = ?',
        [groupId],
      );
      const nextPos = posRows[0]?.next_pos ?? 0;
      await tx.run(INSERT_GROUP_ITEM_SQL, [groupId, key, sourceId, nextPos, now]);
    }
    await tx.run('UPDATE custom_groups SET updated_at = ? WHERE id = ?', [now, groupId]);
    return true;
  });

  if (!found) return err(elvError('storage', 'custom-group-not-found'));
  return ok(undefined);
}

/** Removes a live channel from `groupId` (`#60`). */
export async function removeChannelFromCustomGroup(
  db: SqlDriver,
  groupId: string,
  itemKey: string,
  clock: () => number = Date.now,
): Promise<Result<void>> {
  if (!isValidCustomGroupId(groupId)) {
    return err(elvError('storage', 'custom-group-not-found'));
  }
  const key = itemKey.trim();
  if (key === '') return ok(undefined);
  const now = Math.max(0, Math.round(clock()));

  const found = await db.transaction(async (tx) => {
    const exists = await tx.all<{ found: number }>(
      'SELECT 1 AS found FROM custom_groups WHERE id = ? LIMIT 1',
      [groupId],
    );
    if (exists.length === 0) return false;
    await tx.run('DELETE FROM custom_group_items WHERE group_id = ? AND item_key = ?', [
      groupId,
      key,
    ]);
    await tx.run('UPDATE custom_groups SET updated_at = ? WHERE id = ?', [now, groupId]);
    return true;
  });

  if (!found) return err(elvError('storage', 'custom-group-not-found'));
  return ok(undefined);
}
