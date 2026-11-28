import type { SqlDriver } from '@elv/domain';
import { DEFAULT_PROFILE_ID, normalizeProfileId } from './user-state-helpers';

/** Supported catalog item kinds for recommendation dismissals (strictly Movies & Series). */
export type RecommendationDismissalKind = 'movie' | 'series';

/** Maximum allowed length of a dismissed recommendation item key. */
export const MAX_RECOMMENDATION_DISMISSAL_KEY_CHARS = 1_024;

/** Maximum dismissed recommendation keys returned in a single list query. */
export const MAX_RECOMMENDATION_DISMISSAL_KEYS = 2_000;

/** Recommendation dismissal methods exposed on `CatalogService` (`Wave R3`). */
export interface CatalogRecommendationDismissalsOpsMethods {
  dismissRecommendation(
    itemKey: string,
    kind: RecommendationDismissalKind,
    profileId?: string,
  ): Promise<void>;
  restoreRecommendation(itemKey: string, profileId?: string): Promise<void>;
  listDismissedRecommendationKeys(profileId?: string): Promise<readonly string[]>;
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateDismissalItemKey(itemKey: unknown): string {
  if (typeof itemKey !== 'string') {
    throw new Error('dismissRecommendation: itemKey must be a non-empty string');
  }
  const trimmed = itemKey.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_RECOMMENDATION_DISMISSAL_KEY_CHARS ||
    hasControlChar(trimmed)
  ) {
    throw new Error('dismissRecommendation: itemKey must be a valid non-empty key');
  }
  return trimmed;
}

function normalizeOptionalDismissalKey(itemKey: unknown): string | null {
  if (typeof itemKey !== 'string') return null;
  const trimmed = itemKey.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_RECOMMENDATION_DISMISSAL_KEY_CHARS ||
    hasControlChar(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function isRecommendationDismissalKind(kind: unknown): kind is RecommendationDismissalKind {
  return kind === 'movie' || kind === 'series';
}

const UPSERT_DISMISSAL_SQL = `INSERT INTO recommendation_dismissals (
  profile_id, item_key, kind, dismissed_at
) VALUES (?, ?, ?, ?)
ON CONFLICT(profile_id, item_key) DO UPDATE SET
  kind = excluded.kind,
  dismissed_at = excluded.dismissed_at`;

/**
 * Persists a per-profile `"Don't recommend again"` dismissal for a Movie or Series.
 * Rejects blank, overlong, or control-character `itemKey`s and non-`'movie'`/`'series'` kinds.
 */
export async function dismissRecommendation(
  db: SqlDriver,
  itemKey: string,
  kind: RecommendationDismissalKind,
  profileId: string = DEFAULT_PROFILE_ID,
  dismissedAtMs: number = Date.now(),
): Promise<void> {
  const key = validateDismissalItemKey(itemKey);
  if (!isRecommendationDismissalKind(kind)) {
    throw new Error('dismissRecommendation: kind must be "movie" or "series"');
  }
  const normalizedProfile = normalizeProfileId(profileId);
  const dismissedAt = Number.isFinite(dismissedAtMs)
    ? Math.max(0, Math.round(dismissedAtMs))
    : Math.max(0, Math.round(Date.now()));
  await db.run(UPSERT_DISMISSAL_SQL, [normalizedProfile, key, kind, dismissedAt]);
}

async function deleteDismissedRecommendationRow(
  db: SqlDriver,
  itemKey: string,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<number> {
  const key = normalizeOptionalDismissalKey(itemKey);
  if (key === null) return 0;
  const normalizedProfile = normalizeProfileId(profileId);
  const res = await db.run(
    'DELETE FROM recommendation_dismissals WHERE profile_id = ? AND item_key = ?',
    [normalizedProfile, key],
  );
  return res.changes;
}

/** Removes a previously dismissed recommendation entry for `(profileId, itemKey)`. */
export async function restoreRecommendation(
  db: SqlDriver,
  itemKey: string,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<void> {
  await deleteDismissedRecommendationRow(db, itemKey, profileId);
}

/**
 * Lists dismissed recommendation `item_key`s for `profileId` ordered most recently dismissed first
 * (`dismissed_at DESC, item_key ASC`).
 */
export async function listDismissedRecommendationKeys(
  db: SqlDriver,
  profileId: string = DEFAULT_PROFILE_ID,
  limit: number = MAX_RECOMMENDATION_DISMISSAL_KEYS,
): Promise<readonly string[]> {
  const bounded = Number.isFinite(limit)
    ? Math.min(MAX_RECOMMENDATION_DISMISSAL_KEYS, Math.max(0, Math.floor(limit)))
    : MAX_RECOMMENDATION_DISMISSAL_KEYS;
  if (bounded === 0) return [];
  const normalizedProfile = normalizeProfileId(profileId);
  const rows = await db.all<{ item_key: string }>(
    `SELECT item_key
       FROM recommendation_dismissals
      WHERE profile_id = ?
      ORDER BY dismissed_at DESC, item_key ASC
      LIMIT ?`,
    [normalizedProfile, bounded],
  );
  return rows.map((r) => r.item_key);
}

/** @internal Creates recommendation dismissal methods for `CatalogService`. */
export function createCatalogRecommendationDismissalsOpsMethods(deps: {
  db: SqlDriver;
  clock: () => number;
  syncUserData: () => Promise<void> | undefined;
}): CatalogRecommendationDismissalsOpsMethods {
  const { db, clock, syncUserData } = deps;
  return {
    async dismissRecommendation(itemKey, kind, profileId) {
      await dismissRecommendation(db, itemKey, kind, profileId, clock());
      await syncUserData();
    },
    async restoreRecommendation(itemKey, profileId) {
      const deleted = await deleteDismissedRecommendationRow(db, itemKey, profileId);
      if (deleted > 0) await syncUserData();
    },
    listDismissedRecommendationKeys: (profileId) => listDismissedRecommendationKeys(db, profileId),
  };
}
