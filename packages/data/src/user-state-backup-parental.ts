import type { SqlDriver } from '@elv/domain';
import {
  DEFAULT_PARENTAL_UNLOCK_TIMEOUT_MIN,
  type ParentalLockRecord,
  type ParentalLockTargetKind,
  type ParentalSettings,
} from './parental-policy';
import { isValidProfileId } from './profiles-repo';
import type { BrowseKind } from './queries-shared';
import { SOURCE_ID } from './sources';

const VALID_LOCK_TARGET_KINDS = new Set<ParentalLockTargetKind>(['category', 'item']);
const VALID_LOCK_ITEM_KINDS = new Set<BrowseKind>(['live', 'movie', 'series']);
const MAX_LOCK_KEY_LEN = 256;
const MAX_UNLOCK_TIMEOUT_MIN = 1_440;

interface RawParentalSettingsBackupRow {
  profile_id: string;
  enabled: number;
  block_adult_keywords: number;
  max_rating_age: number | null;
  unlock_timeout_min: number;
  updated_at: number;
}

interface RawParentalLockBackupRow {
  profile_id: string;
  source_id: string;
  target_kind: string;
  item_kind: string;
  target_key: string;
  created_at: number;
}

function hasCtrlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Parses and sanitizes one non-secret `ParentalSettings` snapshot entry. */
export function parseParentalSettingsEntry(raw: unknown): ParentalSettings | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.profileId !== 'string') return null;
  const profileId = r.profileId.trim();
  if (!isValidProfileId(profileId)) return null;
  if (
    typeof r.enabled !== 'boolean' ||
    typeof r.blockAdultKeywords !== 'boolean' ||
    typeof r.unlockTimeoutMin !== 'number' ||
    !Number.isFinite(r.unlockTimeoutMin) ||
    typeof r.updatedAt !== 'number' ||
    !Number.isFinite(r.updatedAt)
  ) {
    return null;
  }
  let maxRatingAge: number | null = null;
  if (r.maxRatingAge !== null && r.maxRatingAge !== undefined) {
    if (
      typeof r.maxRatingAge !== 'number' ||
      !Number.isFinite(r.maxRatingAge) ||
      r.maxRatingAge < 0 ||
      r.maxRatingAge > 21
    ) {
      return null;
    }
    maxRatingAge = Math.floor(r.maxRatingAge);
  }
  const unlockTimeoutMin = Math.min(
    MAX_UNLOCK_TIMEOUT_MIN,
    Math.max(0, Math.floor(r.unlockTimeoutMin)),
  );
  return {
    profileId,
    enabled: r.enabled,
    blockAdultKeywords: r.blockAdultKeywords,
    maxRatingAge,
    unlockTimeoutMin,
    updatedAt: Math.max(0, Math.round(r.updatedAt)),
  };
}

/** Deterministic sort order for `parentalSettings` snapshot entries. */
export function compareParentalSettings(a: ParentalSettings, b: ParentalSettings): number {
  return a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0;
}

/** Parses and sanitizes one non-secret `ParentalLockRecord` snapshot entry. */
export function parseParentalLockEntry(raw: unknown): ParentalLockRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.profileId !== 'string' ||
    typeof r.sourceId !== 'string' ||
    !SOURCE_ID.test(r.sourceId) ||
    typeof r.targetKind !== 'string' ||
    !VALID_LOCK_TARGET_KINDS.has(r.targetKind as ParentalLockTargetKind) ||
    typeof r.itemKind !== 'string' ||
    !VALID_LOCK_ITEM_KINDS.has(r.itemKind as BrowseKind) ||
    typeof r.targetKey !== 'string' ||
    typeof r.createdAt !== 'number' ||
    !Number.isFinite(r.createdAt)
  ) {
    return null;
  }
  const profileId = r.profileId.trim();
  const targetKey = r.targetKey.trim();
  if (
    !isValidProfileId(profileId) ||
    targetKey.length === 0 ||
    targetKey.length > MAX_LOCK_KEY_LEN ||
    hasCtrlChar(targetKey)
  ) {
    return null;
  }
  return {
    profileId,
    sourceId: r.sourceId,
    targetKind: r.targetKind as ParentalLockTargetKind,
    itemKind: r.itemKind as BrowseKind,
    targetKey,
    createdAt: Math.max(0, Math.round(r.createdAt)),
  };
}

/** Deterministic sort order for `parentalLocks` snapshot entries. */
export function compareParentalLocks(a: ParentalLockRecord, b: ParentalLockRecord): number {
  if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
  if (a.profileId !== b.profileId) return a.profileId < b.profileId ? -1 : 1;
  if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
  if (a.targetKind !== b.targetKind) return a.targetKind < b.targetKind ? -1 : 1;
  if (a.itemKind !== b.itemKind) return a.itemKind < b.itemKind ? -1 : 1;
  return a.targetKey < b.targetKey ? -1 : a.targetKey > b.targetKey ? 1 : 0;
}

/** Reads non-secret `parental_settings` and `parental_locks` rows from `db` for backup mirroring. */
export async function readParentalBackupRows(db: SqlDriver): Promise<{
  parentalSettings: ParentalSettings[];
  parentalLocks: ParentalLockRecord[];
}> {
  const [rawSettings, rawLocks] = await Promise.all([
    db.all<RawParentalSettingsBackupRow>(
      'SELECT profile_id, enabled, block_adult_keywords, max_rating_age, unlock_timeout_min, updated_at FROM parental_settings ORDER BY profile_id ASC',
    ),
    db.all<RawParentalLockBackupRow>(
      'SELECT profile_id, source_id, target_kind, item_kind, target_key, created_at FROM parental_locks ORDER BY created_at DESC, profile_id ASC, source_id ASC, target_kind ASC, item_kind ASC, target_key ASC',
    ),
  ]);
  const parentalSettings: ParentalSettings[] = rawSettings.map((r) => ({
    profileId: r.profile_id,
    enabled: r.enabled !== 0,
    blockAdultKeywords: r.block_adult_keywords !== 0,
    maxRatingAge: r.max_rating_age,
    unlockTimeoutMin: r.unlock_timeout_min,
    updatedAt: r.updated_at,
  }));
  const parentalLocks: ParentalLockRecord[] = [];
  for (const r of rawLocks) {
    const parsed = parseParentalLockEntry({
      profileId: r.profile_id,
      sourceId: r.source_id,
      targetKind: r.target_kind,
      itemKind: r.item_kind,
      targetKey: r.target_key,
      createdAt: r.created_at,
    });
    if (parsed !== null) parentalLocks.push(parsed);
  }
  return { parentalSettings, parentalLocks };
}

const RESTORE_PARENTAL_SETTINGS_SQL = `INSERT OR IGNORE INTO parental_settings (
  profile_id, enabled, block_adult_keywords, max_rating_age, unlock_timeout_min, updated_at
) VALUES (?, ?, ?, ?, ?, ?)`;

const RESTORE_PARENTAL_LOCK_SQL = `INSERT OR IGNORE INTO parental_locks (
  profile_id, source_id, target_kind, item_kind, target_key, created_at
) VALUES (?, ?, ?, ?, ?, ?)`;

/**
 * Restores non-secret `parental_settings` & `parental_locks` inside a `reconcileUserData`
 * transaction and re-seeds child-safe defaults (`enabled: true, blockAdultKeywords: true,
 * maxRatingAge: 12`) for any restored `isKids: true` profile missing a settings row.
 */
export async function restoreParentalBackupRows(
  tx: SqlDriver,
  input: {
    readonly profiles: readonly { id: string; isKids?: boolean; createdAt: number }[];
    readonly parentalSettings: readonly ParentalSettings[];
    readonly parentalLocks: readonly ParentalLockRecord[];
  },
): Promise<{
  parentalSettingsRestored: number;
  parentalLocksRestored: number;
  hasParentalState: boolean;
}> {
  let parentalSettingsRestored = 0;
  let parentalLocksRestored = 0;
  const restoredSettingsProfiles = new Set<string>();

  for (const s of input.parentalSettings) {
    const res = await tx.run(RESTORE_PARENTAL_SETTINGS_SQL, [
      s.profileId,
      s.enabled ? 1 : 0,
      s.blockAdultKeywords ? 1 : 0,
      s.maxRatingAge,
      s.unlockTimeoutMin,
      s.updatedAt,
    ]);
    parentalSettingsRestored += res.changes;
    restoredSettingsProfiles.add(s.profileId);
  }

  for (const profile of input.profiles) {
    if (!isValidProfileId(profile.id) || profile.isKids !== true) continue;
    if (restoredSettingsProfiles.has(profile.id)) continue;
    const res = await tx.run(RESTORE_PARENTAL_SETTINGS_SQL, [
      profile.id,
      1,
      1,
      12,
      DEFAULT_PARENTAL_UNLOCK_TIMEOUT_MIN,
      Math.max(0, Math.round(profile.createdAt)),
    ]);
    parentalSettingsRestored += res.changes;
  }

  for (const lock of input.parentalLocks) {
    const res = await tx.run(RESTORE_PARENTAL_LOCK_SQL, [
      lock.profileId,
      lock.sourceId,
      lock.targetKind,
      lock.itemKind,
      lock.targetKey,
      lock.createdAt,
    ]);
    parentalLocksRestored += res.changes;
  }

  return {
    parentalSettingsRestored,
    parentalLocksRestored,
    hasParentalState:
      parentalSettingsRestored > 0 ||
      parentalLocksRestored > 0 ||
      input.profiles.some((p) => p.isKids === true),
  };
}
