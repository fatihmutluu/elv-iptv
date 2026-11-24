import type { SqlDriver } from '@elv/domain';
import { findRestrictedItemKeys, loadActiveParentalFilter } from './parental-repo';
import { type ItemRow, mapItemRow, type RawItemRow } from './queries-shared';
import { SOURCE_ID } from './sources';
import { normalizeProfileId } from './user-state-helpers';

/** Default maximum recently watched channels returned by {@link listRecentChannels}. */
export const DEFAULT_RECENT_CHANNELS_LIMIT = 20;

/** Maximum recently watched channel rows retained per profile in `recent_channels`. */
export const MAX_RECENT_CHANNELS_PER_PROFILE = 50;

const MAX_ITEM_KEY_LENGTH = 256;

/** Persisted `recent_channels` row shape used for user-state backup/restore (`#53`). */
export interface RecentChannelRow {
  readonly profileId: string;
  readonly sourceId: string;
  readonly itemKey: string;
  readonly watchedAt: number;
}

/** @internal Raw SQLite row shape for `recent_channels`. */
export interface RawRecentChannelRow {
  profile_id: string;
  source_id: string;
  item_key: string;
  watched_at: number;
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validates that a catalog `itemKey` is safe to persist in `recent_channels`:
 * non-empty, bounded, and free of URLs, templates, query strings, userinfo, or control chars.
 */
export function isSafeRecentChannelKey(value: unknown): value is string {
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

/** @internal Maps a raw SQLite `recent_channels` row to {@link RecentChannelRow}. */
export function mapRecentChannelRow(row: RawRecentChannelRow): RecentChannelRow {
  return {
    profileId: row.profile_id,
    sourceId: row.source_id,
    itemKey: row.item_key,
    watchedAt: row.watched_at,
  };
}

const UPSERT_RECENT_SQL = `INSERT INTO recent_channels (profile_id, source_id, item_key, watched_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(profile_id, item_key) DO UPDATE SET
  source_id = excluded.source_id,
  watched_at = excluded.watched_at`;

const PRUNE_RECENT_SQL = `DELETE FROM recent_channels
WHERE profile_id = ?
  AND item_key NOT IN (
    SELECT item_key FROM recent_channels
    WHERE profile_id = ?
    ORDER BY watched_at DESC, item_key ASC
    LIMIT ?
  )`;

const LIST_RECENT_SQL = `SELECT t.id, t.key, t.source_id, t.provider_id, t.name,
  t.logo AS logo, NULL AS rating, NULL AS year, t.num AS num
FROM recent_channels r
INNER JOIN live t
  ON t.source_id = r.source_id AND t.key = r.item_key
WHERE r.profile_id = ?
  AND t.is_hidden = 0
  AND EXISTS (SELECT 1 FROM sources s WHERE s.id = t.source_id AND s.deleting = 0)
ORDER BY r.watched_at DESC, r.item_key ASC
LIMIT ?`;

/**
 * Records a recently watched live channel via parameterized UPSERT and prunes entries beyond
 * {@link MAX_RECENT_CHANNELS_PER_PROFILE} per profile (`#53`). Rejects URLs, templates,
 * credentials, and invalid source IDs without writing to SQLite.
 */
export async function recordRecentChannel(
  db: SqlDriver,
  itemKey: string,
  sourceId: string,
  profileId?: string,
  nowMs?: number,
): Promise<void> {
  if (!isSafeRecentChannelKey(itemKey) || !SOURCE_ID.test(sourceId)) return;
  const key = itemKey.trim();
  const profile = normalizeProfileId(profileId);
  const watchedAt =
    typeof nowMs === 'number' && Number.isFinite(nowMs)
      ? Math.max(0, Math.round(nowMs))
      : Date.now();

  await db.transaction(async (tx) => {
    await tx.run(UPSERT_RECENT_SQL, [profile, sourceId, key, watchedAt]);
    await tx.run(PRUNE_RECENT_SQL, [profile, profile, MAX_RECENT_CHANNELS_PER_PROFILE]);
  });
}

/**
 * Lists up to `limit` (default {@link DEFAULT_RECENT_CHANNELS_LIMIT}, max {@link MAX_RECENT_CHANNELS_PER_PROFILE})
 * recently watched visible live channels for `profileId`, ordered most-recently-watched first (`#53`).
 */
export async function listRecentChannels(
  db: SqlDriver,
  limit: number = DEFAULT_RECENT_CHANNELS_LIMIT,
  profileId?: string,
  opts?: { readonly parentalUnlocked?: boolean },
): Promise<ItemRow[]> {
  const n = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_RECENT_CHANNELS_LIMIT;
  const clamped = Math.min(MAX_RECENT_CHANNELS_PER_PROFILE, Math.max(0, n));
  if (clamped === 0) return [];
  const profile = normalizeProfileId(profileId);
  const filter = await loadActiveParentalFilter(db, profile, opts?.parentalUnlocked);
  const fetchLimit = filter === null ? clamped : MAX_RECENT_CHANNELS_PER_PROFILE;
  const rows = await db.all<RawItemRow & { source_id: string }>(LIST_RECENT_SQL, [
    profile,
    fetchLimit,
  ]);
  const mapped = rows.map((r) => mapItemRow('live', r.source_id, r));
  if (filter === null) return mapped;
  const restricted = await findRestrictedItemKeys(
    db,
    filter,
    mapped.map((r) => ({
      itemKey: r.key,
      sourceId: r.sourceId,
      kind: 'live' as const,
      title: r.name,
    })),
  );
  return mapped.filter((r) => !restricted.has(r.key)).slice(0, clamped);
}
