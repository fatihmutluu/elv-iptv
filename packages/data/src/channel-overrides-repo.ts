import { elvError, err, ok, type Result, type SqlDriver, type SqlValue } from '@elv/domain';
import { foldText } from './fold';
import { isValidProfileId } from './profiles-repo';
import { SOURCE_ID } from './sources';
import { normalizeProfileId } from './user-state-helpers';

/** Maximum trimmed character length of a custom channel display name (`#60`). */
export const MAX_CUSTOM_CHANNEL_NAME_LENGTH = 160;

/** Maximum manual `sort_order` value supported by cursor pagination (`#60`). */
export const MAX_CHANNEL_SORT_ORDER = 999_999_999;

const MAX_ITEM_KEY_LENGTH = 256;
const REORDER_BATCH_SIZE = 500;

const customNamesActiveByDb = new WeakMap<object, boolean>();
const customNamesEpochByDb = new WeakMap<object, number>();

function dbFastPathKey(db: SqlDriver): object {
  return db.exec;
}

/** @internal Marks a database handle as having custom channel names so live search queries `channel_overrides`. */
export function markChannelCustomNamesDirty(db: SqlDriver): void {
  const key = dbFastPathKey(db);
  customNamesEpochByDb.set(key, (customNamesEpochByDb.get(key) ?? 0) + 1);
  customNamesActiveByDb.set(key, true);
}

/** @internal Returns `false` when `openCatalog` / mutations verified zero visible custom channel names exist. */
export function hasActiveCustomChannelNames(db: SqlDriver): boolean {
  return customNamesActiveByDb.get(dbFastPathKey(db)) !== false;
}

/** @internal Probes `channel_overrides` once to arm the zero-query search fast path when no custom names exist. */
export async function refreshChannelOverridesFastPath(db: SqlDriver): Promise<void> {
  const key = dbFastPathKey(db);
  const epochBefore = customNamesEpochByDb.get(key) ?? 0;
  const rows = await db.all<{ active: number }>(
    `SELECT EXISTS (
       SELECT 1 FROM channel_overrides
        WHERE custom_name IS NOT NULL AND custom_name != '' AND is_hidden = 0
     ) AS active`,
  );
  const active = (rows[0]?.active ?? 0) !== 0;
  if (!active && (customNamesEpochByDb.get(key) ?? 0) !== epochBefore) {
    return;
  }
  customNamesActiveByDb.set(key, active);
}

/** A per-profile live channel override persisted in `channel_overrides` (`#60`). */
export interface ChannelOverrideRecord {
  readonly profileId: string;
  readonly itemKey: string;
  readonly sourceId: string;
  readonly customName: string | null;
  readonly isHidden: boolean;
  readonly sortOrder: number | null;
  readonly updatedAt: number;
}

/** Input for {@link setChannelOverride}; omitted fields preserve existing override values. */
export interface SetChannelOverrideInput {
  readonly profileId?: string;
  readonly itemKey: string;
  readonly sourceId: string;
  /** Custom display title (`null` or blank clears back to the provider title). */
  readonly customName?: string | null;
  /** When `true`, hides this channel from standard live queries for `profileId`. */
  readonly isHidden?: boolean;
  /** Manual sort position (`>= 0`, `null` clears manual ordering). */
  readonly sortOrder?: number | null;
}

/** @internal Raw SQLite row shape for `channel_overrides`. */
export interface RawChannelOverrideRow {
  profile_id: string;
  item_key: string;
  source_id: string;
  custom_name: string | null;
  is_hidden: number;
  sort_order: number | null;
  updated_at: number;
}

/** @internal Returns `true` when `value` contains ASCII control characters. */
export function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validates that a catalog channel key is safe to store in `channel_overrides` / `custom_group_items`:
 * non-empty, bounded, and free of URLs, templates, query strings, userinfo, or control chars.
 */
export function isSafeChannelKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ITEM_KEY_LENGTH) return false;
  if (
    hasControlChar(trimmed) ||
    trimmed.includes('://') ||
    trimmed.includes('{{') ||
    trimmed.includes('@') ||
    trimmed.includes('?')
  ) {
    return false;
  }
  return true;
}

/** @internal Maps a raw SQLite `channel_overrides` row to {@link ChannelOverrideRecord}. */
export function mapChannelOverrideRow(row: RawChannelOverrideRow): ChannelOverrideRecord {
  return {
    profileId: row.profile_id,
    itemKey: row.item_key,
    sourceId: row.source_id,
    customName: row.custom_name !== null && row.custom_name !== '' ? row.custom_name : null,
    isHidden: row.is_hidden !== 0,
    sortOrder: row.sort_order,
    updatedAt: row.updated_at,
  };
}

function validateCustomChannelName(raw: string | null): Result<string | null> {
  if (raw === null) return ok(null);
  if (typeof raw !== 'string') {
    return err(elvError('source-format', 'invalid-channel-override'));
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return ok(null);
  if (trimmed.length > MAX_CUSTOM_CHANNEL_NAME_LENGTH || hasControlChar(trimmed)) {
    return err(elvError('source-format', 'invalid-channel-override'));
  }
  return ok(trimmed);
}

function validateSortOrder(raw: number | null): Result<number | null> {
  if (raw === null) return ok(null);
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > MAX_CHANNEL_SORT_ORDER) {
    return err(elvError('source-format', 'invalid-channel-override'));
  }
  return ok(Math.floor(raw));
}

function resolveValidatedProfileId(profileId?: string): Result<string> {
  const normalized = normalizeProfileId(profileId);
  if (!isValidProfileId(normalized)) {
    return err(elvError('source-format', 'invalid-profile-id'));
  }
  return ok(normalized);
}

/** Lists all persisted channel overrides for `profileId`, ordered by manual `sortOrder` then `itemKey`. */
export async function listChannelOverrides(
  db: SqlDriver,
  profileId?: string,
): Promise<ChannelOverrideRecord[]> {
  const profile = resolveValidatedProfileId(profileId);
  if (!profile.ok) return [];
  const rows = await db.all<RawChannelOverrideRow>(
    `SELECT profile_id, item_key, source_id, custom_name, is_hidden, sort_order, updated_at
       FROM channel_overrides
      WHERE profile_id = ?
      ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END ASC, sort_order ASC, item_key ASC`,
    [profile.value],
  );
  return rows.map(mapChannelOverrideRow);
}

const UPSERT_OVERRIDE_SQL = `INSERT INTO channel_overrides (
  profile_id, item_key, source_id, custom_name, custom_name_fold, is_hidden, sort_order, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(profile_id, item_key) DO UPDATE SET
  source_id = excluded.source_id,
  custom_name = excluded.custom_name,
  custom_name_fold = excluded.custom_name_fold,
  is_hidden = excluded.is_hidden,
  sort_order = excluded.sort_order,
  updated_at = excluded.updated_at`;

/**
 * Sets or patches a per-profile channel override (`customName`, `isHidden`, `sortOrder`) (`#60`).
 * Omitted fields preserve existing stored values. When all three fields resolve to default
 * (`customName: null, isHidden: false, sortOrder: null`), deletes the override row to keep storage lean.
 */
export async function setChannelOverride(
  db: SqlDriver,
  input: SetChannelOverrideInput,
  clock: () => number = Date.now,
): Promise<Result<ChannelOverrideRecord>> {
  const profile = resolveValidatedProfileId(input.profileId);
  if (!profile.ok) return profile;
  if (!isSafeChannelKey(input.itemKey) || !SOURCE_ID.test(input.sourceId)) {
    return err(elvError('source-format', 'invalid-channel-override'));
  }
  const itemKey = input.itemKey.trim();

  let parsedName: string | null | undefined;
  if (input.customName !== undefined) {
    const validated = validateCustomChannelName(input.customName);
    if (!validated.ok) return validated;
    parsedName = validated.value;
  }

  let parsedSort: number | null | undefined;
  if (input.sortOrder !== undefined) {
    const validated = validateSortOrder(input.sortOrder);
    if (!validated.ok) return validated;
    parsedSort = validated.value;
  }

  if (input.isHidden !== undefined && typeof input.isHidden !== 'boolean') {
    return err(elvError('source-format', 'invalid-channel-override'));
  }

  const now = Math.max(0, Math.round(clock()));

  const record = await db.transaction(async (tx): Promise<ChannelOverrideRecord> => {
    const existingRows = await tx.all<RawChannelOverrideRow>(
      `SELECT profile_id, item_key, source_id, custom_name, is_hidden, sort_order, updated_at
         FROM channel_overrides
        WHERE profile_id = ? AND item_key = ?
        LIMIT 1`,
      [profile.value, itemKey],
    );
    const existing = existingRows[0];
    const nextCustomName = parsedName !== undefined ? parsedName : (existing?.custom_name ?? null);
    const nextIsHidden =
      input.isHidden !== undefined
        ? input.isHidden
        : existing !== undefined && existing.is_hidden !== 0;
    const nextSortOrder = parsedSort !== undefined ? parsedSort : (existing?.sort_order ?? null);

    if (nextCustomName === null && !nextIsHidden && nextSortOrder === null) {
      if (existing !== undefined) {
        await tx.run('DELETE FROM channel_overrides WHERE profile_id = ? AND item_key = ?', [
          profile.value,
          itemKey,
        ]);
      }
    } else {
      const nextCustomNameFold = nextCustomName !== null ? foldText(nextCustomName) : null;
      await tx.run(UPSERT_OVERRIDE_SQL, [
        profile.value,
        itemKey,
        input.sourceId,
        nextCustomName,
        nextCustomNameFold,
        nextIsHidden ? 1 : 0,
        nextSortOrder,
        now,
      ]);
    }

    return {
      profileId: profile.value,
      itemKey,
      sourceId: input.sourceId,
      customName: nextCustomName,
      isHidden: nextIsHidden,
      sortOrder: nextSortOrder,
      updatedAt: now,
    };
  });

  if (record.customName !== null && !record.isHidden) {
    markChannelCustomNamesDirty(db);
  } else {
    await refreshChannelOverridesFastPath(db);
  }

  return ok(record);
}

/** Removes any persisted channel override for `(profileId, itemKey)` (`#60`). */
export async function clearChannelOverride(
  db: SqlDriver,
  itemKey: string,
  profileId?: string,
): Promise<Result<void>> {
  const profile = resolveValidatedProfileId(profileId);
  if (!profile.ok) return profile;
  const trimmed = itemKey.trim();
  if (trimmed === '') return ok(undefined);
  await db.run('DELETE FROM channel_overrides WHERE profile_id = ? AND item_key = ?', [
    profile.value,
    trimmed,
  ]);
  await refreshChannelOverridesFastPath(db);
  return ok(undefined);
}

const REORDER_UPSERT_SQL = `INSERT INTO channel_overrides (
  profile_id, item_key, source_id, custom_name, custom_name_fold, is_hidden, sort_order, updated_at
) VALUES (?, ?, ?, NULL, NULL, 0, ?, ?)
ON CONFLICT(profile_id, item_key) DO UPDATE SET
  source_id = excluded.source_id,
  sort_order = excluded.sort_order,
  updated_at = excluded.updated_at`;

/**
 * Assigns consecutive 0-based `sort_order` indices to `itemKeys` in a single atomic transaction
 * while preserving each channel's existing `custom_name` and `is_hidden` flags (`#60`).
 */
export async function reorderChannels(
  db: SqlDriver,
  itemKeys: readonly string[],
  sourceId: string,
  profileId?: string,
  clock: () => number = Date.now,
): Promise<Result<void>> {
  const profile = resolveValidatedProfileId(profileId);
  if (!profile.ok) return profile;
  if (!SOURCE_ID.test(sourceId)) {
    return err(elvError('source-format', 'invalid-channel-override'));
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const rawKey of itemKeys) {
    if (!isSafeChannelKey(rawKey)) {
      return err(elvError('source-format', 'invalid-channel-override'));
    }
    const key = rawKey.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(key);
  }
  if (deduped.length === 0) return ok(undefined);
  if (deduped.length > MAX_CHANNEL_SORT_ORDER + 1) {
    return err(elvError('source-format', 'invalid-channel-override'));
  }

  const now = Math.max(0, Math.round(clock()));
  await db.transaction(async (tx) => {
    for (let i = 0; i < deduped.length; i += REORDER_BATCH_SIZE) {
      const slice = deduped.slice(i, i + REORDER_BATCH_SIZE);
      const batchParams: SqlValue[][] = slice.map((key, offset) => [
        profile.value,
        key,
        sourceId,
        i + offset,
        now,
      ]);
      await tx.batch(REORDER_UPSERT_SQL, batchParams);
    }
  });
  return ok(undefined);
}
