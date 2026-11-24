import { elvError, err, ok, type Result, type SqlDriver, type SqlValue } from '@elv/domain';
import {
  DEFAULT_PARENTAL_UNLOCK_TIMEOUT_MIN,
  isAdultKeywordMatch,
  type ParentalLockFilter,
  type ParentalLockRecord,
  type ParentalLockTargetKind,
  type ParentalSettings,
  parseRatingAge,
  type SetParentalLockInput,
  type UpdateParentalSettingsPatch,
} from './parental-policy';
import type { ActiveParentalFilter } from './parental-sql';
import { type BrowseKind, categoryId, parseCategoryId } from './queries-shared';
import { SOURCE_ID } from './sources';
import { normalizeProfileId } from './user-state-helpers';

export {
  type ActiveParentalFilter,
  buildSqlAdultKeywordExclusionClause,
  buildSqlItemRestrictionClause,
  findRestrictedItemKeys,
  isItemRestricted,
  lockedItemKeysForKind,
  restrictedProviderIdsForSourceKind,
  sqlAdultKeywordMatchExpr,
} from './parental-sql';

const MAX_TARGET_KEY_LEN = 256;
const MAX_UNLOCK_TIMEOUT_MIN = 1_440;
const VALID_TARGET_KINDS = new Set<ParentalLockTargetKind>(['category', 'item']);
const VALID_ITEM_KINDS = new Set<BrowseKind>(['live', 'movie', 'series']);

const parentalActiveByDb = new WeakMap<object, boolean>();
const parentalEpochByDb = new WeakMap<object, number>();

function dbFastPathKey(db: SqlDriver): object {
  return db.exec;
}

/** @internal Marks a database handle as having potential parental state so subsequent queries check SQLite. */
export function markParentalStateDirty(db: SqlDriver): void {
  const key = dbFastPathKey(db);
  parentalEpochByDb.set(key, (parentalEpochByDb.get(key) ?? 0) + 1);
  parentalActiveByDb.set(key, true);
}

/** @internal Probes `parental_settings` & `parental_locks` once to arm the zero-query default fast path. */
export async function refreshParentalFastPath(db: SqlDriver): Promise<void> {
  const key = dbFastPathKey(db);
  const epochBefore = parentalEpochByDb.get(key) ?? 0;
  const rows = await db.all<{ active: number }>(
    `SELECT (
       EXISTS (SELECT 1 FROM parental_settings WHERE enabled != 0)
       OR EXISTS (SELECT 1 FROM parental_locks)
     ) AS active`,
  );
  const active = (rows[0]?.active ?? 0) !== 0;
  if (!active && (parentalEpochByDb.get(key) ?? 0) !== epochBefore) {
    return;
  }
  parentalActiveByDb.set(key, active);
}

interface RawParentalSettingsRow {
  profile_id: string;
  enabled: number;
  block_adult_keywords: number;
  max_rating_age: number | null;
  unlock_timeout_min: number;
  updated_at: number;
}

interface RawParentalLockRow {
  profile_id: string;
  source_id: string;
  target_kind: ParentalLockTargetKind;
  item_kind: BrowseKind;
  target_key: string;
  created_at: number;
}

function defaultParentalSettings(profileId: string): ParentalSettings {
  return {
    profileId,
    enabled: false,
    blockAdultKeywords: true,
    maxRatingAge: null,
    unlockTimeoutMin: DEFAULT_PARENTAL_UNLOCK_TIMEOUT_MIN,
    updatedAt: 0,
  };
}

function mapSettingsRow(row: RawParentalSettingsRow): ParentalSettings {
  return {
    profileId: row.profile_id,
    enabled: row.enabled !== 0,
    blockAdultKeywords: row.block_adult_keywords !== 0,
    maxRatingAge: row.max_rating_age,
    unlockTimeoutMin: row.unlock_timeout_min,
    updatedAt: row.updated_at,
  };
}

function mapLockRow(row: RawParentalLockRow): ParentalLockRecord {
  return {
    profileId: row.profile_id,
    sourceId: row.source_id,
    targetKind: row.target_kind,
    itemKind: row.item_kind,
    targetKey: row.target_key,
    createdAt: row.created_at,
  };
}

/** Reads per-profile parental settings (returning safe defaults when no row exists yet). */
export async function getParentalSettings(
  db: SqlDriver,
  profileId?: string,
): Promise<ParentalSettings> {
  const normalized = normalizeProfileId(profileId);
  const rows = await db.all<RawParentalSettingsRow>(
    `SELECT profile_id, enabled, block_adult_keywords, max_rating_age, unlock_timeout_min, updated_at
       FROM parental_settings
      WHERE profile_id = ?
      LIMIT 1`,
    [normalized],
  );
  const row = rows[0];
  return row === undefined ? defaultParentalSettings(normalized) : mapSettingsRow(row);
}

/** Updates per-profile parental policy in `parental_settings` (`#31`). */
export async function updateParentalSettings(
  db: SqlDriver,
  profileId: string | undefined,
  patch: UpdateParentalSettingsPatch,
  clock: () => number = Date.now,
): Promise<Result<ParentalSettings>> {
  const normalized = normalizeProfileId(profileId);
  const current = await getParentalSettings(db, normalized);

  let maxRatingAge = current.maxRatingAge;
  if (patch.maxRatingAge !== undefined) {
    if (patch.maxRatingAge === null) {
      maxRatingAge = null;
    } else if (
      typeof patch.maxRatingAge === 'number' &&
      Number.isFinite(patch.maxRatingAge) &&
      patch.maxRatingAge >= 0 &&
      patch.maxRatingAge <= 21
    ) {
      maxRatingAge = Math.floor(patch.maxRatingAge);
    } else {
      return err(elvError('source-format', 'invalid-parental-settings'));
    }
  }

  let unlockTimeoutMin = current.unlockTimeoutMin;
  if (patch.unlockTimeoutMin !== undefined) {
    if (
      typeof patch.unlockTimeoutMin === 'number' &&
      Number.isFinite(patch.unlockTimeoutMin) &&
      patch.unlockTimeoutMin >= 0 &&
      patch.unlockTimeoutMin <= MAX_UNLOCK_TIMEOUT_MIN
    ) {
      unlockTimeoutMin = Math.floor(patch.unlockTimeoutMin);
    } else {
      return err(elvError('source-format', 'invalid-parental-settings'));
    }
  }

  const next: ParentalSettings = {
    profileId: normalized,
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    blockAdultKeywords:
      patch.blockAdultKeywords !== undefined
        ? patch.blockAdultKeywords
        : current.blockAdultKeywords,
    maxRatingAge,
    unlockTimeoutMin,
    updatedAt: Math.max(0, Math.round(clock())),
  };

  await db.run(
    `INSERT INTO parental_settings (
       profile_id, enabled, block_adult_keywords, max_rating_age, unlock_timeout_min, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id) DO UPDATE SET
       enabled = excluded.enabled,
       block_adult_keywords = excluded.block_adult_keywords,
       max_rating_age = excluded.max_rating_age,
       unlock_timeout_min = excluded.unlock_timeout_min,
       updated_at = excluded.updated_at`,
    [
      next.profileId,
      next.enabled ? 1 : 0,
      next.blockAdultKeywords ? 1 : 0,
      next.maxRatingAge,
      next.unlockTimeoutMin,
      next.updatedAt,
    ],
  );

  if (next.enabled) {
    markParentalStateDirty(db);
  } else {
    await refreshParentalFastPath(db);
  }

  return ok(next);
}

/** Lists persisted category/item parental locks for `profileId`, optionally narrowed by `filter`. */
export async function listParentalLocks(
  db: SqlDriver,
  profileId?: string,
  filter?: ParentalLockFilter,
): Promise<ParentalLockRecord[]> {
  const normalized = normalizeProfileId(profileId);
  const clauses = ['profile_id = ?'];
  const params: SqlValue[] = [normalized];
  if (filter?.sourceId !== undefined) {
    clauses.push('source_id = ?');
    params.push(filter.sourceId);
  }
  if (filter?.targetKind !== undefined) {
    clauses.push('target_kind = ?');
    params.push(filter.targetKind);
  }
  if (filter?.itemKind !== undefined) {
    clauses.push('item_kind = ?');
    params.push(filter.itemKind);
  }
  const rows = await db.all<RawParentalLockRow>(
    `SELECT profile_id, source_id, target_kind, item_kind, target_key, created_at
       FROM parental_locks
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, source_id ASC, target_kind ASC, item_kind ASC, target_key ASC`,
    params,
  );
  return rows.map(mapLockRow);
}

function normalizedCategoryProviderId(
  sourceId: string,
  itemKind: BrowseKind,
  targetKey: string,
): string {
  const parsed = parseCategoryId(targetKey);
  if (parsed !== undefined && parsed.sourceId === sourceId && parsed.kind === itemKind) {
    return parsed.providerId;
  }
  return targetKey;
}

/** Locks or unlocks a category or item for `input.profileId` (`parental_locks`). */
export async function setParentalLock(
  db: SqlDriver,
  input: SetParentalLockInput,
  locked: boolean,
  clock: () => number = Date.now,
): Promise<Result<void>> {
  const targetKey = input.targetKey.trim();
  if (
    !SOURCE_ID.test(input.sourceId) ||
    !VALID_TARGET_KINDS.has(input.targetKind) ||
    !VALID_ITEM_KINDS.has(input.itemKind) ||
    targetKey.length === 0 ||
    targetKey.length > MAX_TARGET_KEY_LEN
  ) {
    return err(elvError('source-format', 'invalid-parental-lock'));
  }
  const profileId = normalizeProfileId(input.profileId);

  if (locked) {
    const createdAt = Math.max(0, Math.round(clock()));
    await db.run(
      `INSERT INTO parental_locks (profile_id, source_id, target_kind, item_kind, target_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, source_id, target_kind, item_kind, target_key) DO UPDATE SET
         created_at = excluded.created_at`,
      [profileId, input.sourceId, input.targetKind, input.itemKind, targetKey, createdAt],
    );
    markParentalStateDirty(db);
    return ok(undefined);
  }

  if (input.targetKind === 'category') {
    const providerId = normalizedCategoryProviderId(input.sourceId, input.itemKind, targetKey);
    const fullCatId = categoryId(input.sourceId, input.itemKind, providerId);
    await db.run(
      `DELETE FROM parental_locks
        WHERE profile_id = ? AND source_id = ? AND target_kind = 'category' AND item_kind = ?
          AND target_key IN (?, ?, ?)`,
      [profileId, input.sourceId, input.itemKind, targetKey, providerId, fullCatId],
    );
    await refreshParentalFastPath(db);
    return ok(undefined);
  }

  await db.run(
    `DELETE FROM parental_locks
      WHERE profile_id = ? AND source_id = ? AND target_kind = ? AND item_kind = ? AND target_key = ?`,
    [profileId, input.sourceId, input.targetKind, input.itemKind, targetKey],
  );
  await refreshParentalFastPath(db);
  return ok(undefined);
}

/**
 * Loads the active parental filter for `(profileId, parentalUnlocked)`.
 * Returns `null` immediately with zero extra work when `parentalUnlocked === true` or when
 * `!settings.enabled && locks.length === 0` (zero-overhead default fast path).
 */
export async function loadActiveParentalFilter(
  db: SqlDriver,
  profileId?: string,
  parentalUnlocked?: boolean,
): Promise<ActiveParentalFilter | null> {
  if (parentalUnlocked === true) return null;
  if (parentalActiveByDb.get(dbFastPathKey(db)) === false) return null;
  const normalized = normalizeProfileId(profileId);
  const [settings, locks] = await Promise.all([
    getParentalSettings(db, normalized),
    listParentalLocks(db, normalized),
  ]);
  if (!settings.enabled && locks.length === 0) return null;

  const blockAdultKeywords = settings.enabled && settings.blockAdultKeywords;
  const maxRatingAge = settings.enabled ? settings.maxRatingAge : null;

  const lockedCategories = new Set<string>();
  const restrictedCategories = new Set<string>();
  const lockedItems = new Set<string>();
  const lockedItemKeys = new Set<string>();

  for (const lock of locks) {
    if (lock.targetKind === 'category') {
      const providerId = normalizedCategoryProviderId(lock.sourceId, lock.itemKind, lock.targetKey);
      const composite = categoryId(lock.sourceId, lock.itemKind, providerId);
      lockedCategories.add(composite);
      restrictedCategories.add(composite);
    } else {
      lockedItems.add(`${lock.sourceId}|${lock.itemKind}|${lock.targetKey}`);
      lockedItemKeys.add(lock.targetKey);
    }
  }

  if (blockAdultKeywords) {
    const catRows = await db.all<{
      source_id: string;
      kind: BrowseKind;
      provider_id: string;
      name: string;
      name_fold: string;
    }>('SELECT source_id, kind, provider_id, name, name_fold FROM categories');
    for (const row of catRows) {
      if (isAdultKeywordMatch(row.name) || isAdultKeywordMatch(row.name_fold)) {
        restrictedCategories.add(categoryId(row.source_id, row.kind, row.provider_id));
      }
    }
  }

  return {
    profileId: normalized,
    enabled: settings.enabled,
    blockAdultKeywords,
    maxRatingAge,
    lockedCategories,
    restrictedCategories,
    lockedItems,
    lockedItemKeys,
    locks,
  };
}

/** Returns `true` when a category is locked or matches adult keywords under `filter`. */
export function isCategoryRestricted(
  filter: ActiveParentalFilter,
  sourceId: string,
  kind: BrowseKind,
  providerId: string,
  name?: string,
  nameFold?: string,
): boolean {
  if (filter.restrictedCategories.has(categoryId(sourceId, kind, providerId))) {
    return true;
  }
  if (filter.blockAdultKeywords) {
    if (name !== undefined && isAdultKeywordMatch(name)) return true;
    if (nameFold !== undefined && isAdultKeywordMatch(nameFold)) return true;
  }
  return false;
}

/** Returns `true` when an EPG programme violates `blockAdultKeywords` or `maxRatingAge`. */
export function isProgrammeRestricted(
  filter: ActiveParentalFilter,
  title: string,
  description?: string | null,
  ratingValue?: string | null,
): boolean {
  if (filter.blockAdultKeywords) {
    if (isAdultKeywordMatch(title)) return true;
    if (description !== null && description !== undefined && isAdultKeywordMatch(description)) {
      return true;
    }
  }
  if (filter.maxRatingAge !== null) {
    const age = parseRatingAge(ratingValue);
    if (age !== null && age > filter.maxRatingAge) return true;
  }
  return false;
}
