import { elvError, err, ok, type Result, type SqlDriver } from '@elv/domain';
import {
  cleanSuggestedGroupName,
  normalizeFailoverChannelName,
  type SuggestedFailoverCluster,
  type SuggestedFailoverClusterMember,
  suggestFailoverGroups,
} from './failover-groups-suggest';
import { foldText } from './fold';
import { sourceOfKey } from './queries-shared';

const MAX_ITEM_KEY_LENGTH = 256;

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isSafeChannelKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ITEM_KEY_LENGTH) return false;
  return !(
    hasControlChar(trimmed) ||
    trimmed.includes('://') ||
    trimmed.includes('{{') ||
    trimmed.includes('@') ||
    trimmed.includes('?')
  );
}

export {
  cleanSuggestedGroupName,
  normalizeFailoverChannelName,
  type SuggestedFailoverCluster,
  type SuggestedFailoverClusterMember,
  suggestFailoverGroups,
};

/** Maximum trimmed character length of a failover group display name (`#157`). */
export const MAX_FAILOVER_GROUP_NAME_LENGTH = 100;

/** Strict safe identifier pattern for failover group IDs (`#157`). */
export const FAILOVER_GROUP_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** One prioritized live channel member inside a {@link FailoverGroupRecord} (`#157`). */
export interface FailoverGroupMember {
  readonly groupId: string;
  readonly sourceId: string;
  readonly channelKey: string;
  readonly position: number;
  readonly channelName?: string;
  readonly logo?: string | null;
  readonly sourceName?: string;
}

/** A persisted multi-source failover group with its priority-ordered members (`#157`). */
export interface FailoverGroupRecord {
  readonly id: string;
  readonly name: string;
  readonly autoMatched: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly members: readonly FailoverGroupMember[];
}

/** Input for {@link createFailoverGroup}. */
export interface CreateFailoverGroupInput {
  readonly id?: string;
  readonly name: string;
  readonly autoMatched?: boolean;
  readonly channelKeys?: readonly string[];
  readonly nowMs?: number;
}

interface RawGroupRow {
  id: string;
  name: string;
  auto_matched: number;
  created_at: number;
  updated_at: number;
}

interface RawMemberRow {
  group_id: string;
  source_id: string;
  channel_key: string;
  position: number;
  channel_name: string | null;
  logo: string | null;
  source_name: string | null;
}

function validateGroupName(raw: unknown): Result<string> {
  if (typeof raw !== 'string') {
    return err(elvError('source-format', 'invalid-failover-group-name'));
  }
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_FAILOVER_GROUP_NAME_LENGTH ||
    hasControlChar(trimmed)
  ) {
    return err(elvError('source-format', 'invalid-failover-group-name'));
  }
  return ok(trimmed);
}

function resolveGroupId(raw: string | undefined, nowMs: number): Result<string> {
  if (raw !== undefined) {
    if (!FAILOVER_GROUP_ID_RE.test(raw)) {
      return err(elvError('source-format', 'invalid-failover-group-id'));
    }
    return ok(raw);
  }
  const ts = Math.max(0, Math.floor(nowMs)).toString(36);
  const rand = Math.random().toString(36).slice(2, 10).padEnd(6, '0');
  return ok(`fg_${ts}_${rand}`);
}

function mapMemberRow(row: RawMemberRow): FailoverGroupMember {
  return {
    groupId: row.group_id,
    sourceId: row.source_id,
    channelKey: row.channel_key,
    position: row.position,
    ...(row.channel_name !== null ? { channelName: row.channel_name } : {}),
    logo: row.logo,
    ...(row.source_name !== null ? { sourceName: row.source_name } : {}),
  };
}

function mapGroupRow(
  row: RawGroupRow,
  members: readonly FailoverGroupMember[],
): FailoverGroupRecord {
  return {
    id: row.id,
    name: row.name,
    autoMatched: row.auto_matched !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    members,
  };
}

async function resolveChannelSourceId(
  db: SqlDriver,
  channelKey: string,
): Promise<string | undefined> {
  if (!isSafeChannelKey(channelKey)) return undefined;
  const rows = await db.all<{ source_id: string }>(
    'SELECT source_id FROM live WHERE key = ? LIMIT 1',
    [channelKey],
  );
  return rows[0]?.source_id ?? sourceOfKey(channelKey);
}

async function getFailoverGroupById(
  db: SqlDriver,
  groupId: string,
): Promise<FailoverGroupRecord | undefined> {
  const groups = await db.all<RawGroupRow>(
    `SELECT id, name, auto_matched, created_at, updated_at
       FROM failover_groups
      WHERE id = ?
      LIMIT 1`,
    [groupId],
  );
  const group = groups[0];
  if (group === undefined) return undefined;
  const members = await db.all<RawMemberRow>(
    `SELECT m.group_id, m.source_id, m.channel_key, m.position,
            l.name AS channel_name, l.logo AS logo, s.name AS source_name
       FROM failover_group_members m
       LEFT JOIN live l ON l.source_id = m.source_id AND l.key = m.channel_key
       LEFT JOIN sources s ON s.id = m.source_id AND s.deleting = 0
      WHERE m.group_id = ?
      ORDER BY m.position ASC, m.channel_key ASC`,
    [groupId],
  );
  return mapGroupRow(group, members.map(mapMemberRow));
}

async function compactGroupPositionsInTx(tx: SqlDriver, groupId: string): Promise<void> {
  const rows = await tx.all<{ channel_key: string; position: number }>(
    `SELECT channel_key, position
       FROM failover_group_members
      WHERE group_id = ?
      ORDER BY position ASC, channel_key ASC`,
    [groupId],
  );
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] as { channel_key: string; position: number };
    if (row.position !== i) {
      await tx.run(
        'UPDATE failover_group_members SET position = ? WHERE group_id = ? AND channel_key = ?',
        [i, groupId, row.channel_key],
      );
    }
  }
}

/** Lists all persisted failover groups with hydrated channel names, logos, and source names (`#157`). */
export async function listFailoverGroups(db: SqlDriver): Promise<FailoverGroupRecord[]> {
  const groups = await db.all<RawGroupRow>(
    `SELECT id, name, auto_matched, created_at, updated_at
       FROM failover_groups
      ORDER BY name_fold ASC, created_at ASC, id ASC`,
  );
  if (groups.length === 0) return [];
  const members = await db.all<RawMemberRow>(
    `SELECT m.group_id, m.source_id, m.channel_key, m.position,
            l.name AS channel_name, l.logo AS logo, s.name AS source_name
       FROM failover_group_members m
       LEFT JOIN live l ON l.source_id = m.source_id AND l.key = m.channel_key
       LEFT JOIN sources s ON s.id = m.source_id AND s.deleting = 0
      ORDER BY m.group_id ASC, m.position ASC, m.channel_key ASC`,
  );
  const byGroup = new Map<string, FailoverGroupMember[]>();
  for (const row of members) {
    const list = byGroup.get(row.group_id);
    const mapped = mapMemberRow(row);
    if (list === undefined) byGroup.set(row.group_id, [mapped]);
    else list.push(mapped);
  }
  return groups.map((g) => mapGroupRow(g, byGroup.get(g.id) ?? []));
}

/** Looks up the failover group containing `channelKey` (if any) with priority-ordered members (`#157`). */
export async function getFailoverGroupByChannel(
  db: SqlDriver,
  channelKey: string,
): Promise<FailoverGroupRecord | undefined> {
  if (!isSafeChannelKey(channelKey)) return undefined;
  const rows = await db.all<{ group_id: string }>(
    'SELECT group_id FROM failover_group_members WHERE channel_key = ? LIMIT 1',
    [channelKey],
  );
  const groupId = rows[0]?.group_id;
  if (groupId === undefined) return undefined;
  return getFailoverGroupById(db, groupId);
}

/** Creates a failover group and inserts deduplicated initial members in priority order `0..N-1` (`#157`). */
export async function createFailoverGroup(
  db: SqlDriver,
  input: CreateFailoverGroupInput,
): Promise<Result<FailoverGroupRecord>> {
  const nameRes = validateGroupName(input.name);
  if (!nameRes.ok) return nameRes;
  const now = input.nowMs ?? Date.now();
  const idRes = resolveGroupId(input.id, now);
  if (!idRes.ok) return idRes;
  const id = idRes.value;
  const name = nameRes.value;
  const autoMatched = input.autoMatched === true ? 1 : 0;

  const uniqueKeys: string[] = [];
  const seen = new Set<string>();
  for (const rawKey of input.channelKeys ?? []) {
    if (!isSafeChannelKey(rawKey) || seen.has(rawKey)) continue;
    seen.add(rawKey);
    uniqueKeys.push(rawKey);
  }

  try {
    await db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO failover_groups (id, name, name_fold, auto_matched, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, name, foldText(name), autoMatched, now, now],
      );
      let pos = 0;
      for (const channelKey of uniqueKeys) {
        const sourceId = await resolveChannelSourceId(tx, channelKey);
        if (sourceId === undefined) continue;
        await tx.run(
          `INSERT OR IGNORE INTO failover_group_members (group_id, source_id, channel_key, position)
           VALUES (?, ?, ?, ?)`,
          [id, sourceId, channelKey, pos],
        );
        pos += 1;
      }
    });
  } catch {
    return err(elvError('storage', 'failover-group-write-failed'));
  }

  const created = await getFailoverGroupById(db, id);
  return created === undefined ? err(elvError('storage', 'item-not-found')) : ok(created);
}

/** Renames an existing failover group (`#157`). */
export async function renameFailoverGroup(
  db: SqlDriver,
  groupId: string,
  name: string,
  nowMs?: number,
): Promise<Result<FailoverGroupRecord>> {
  const nameRes = validateGroupName(name);
  if (!nameRes.ok) return nameRes;
  const now = nowMs ?? Date.now();
  const { changes } = await db.run(
    'UPDATE failover_groups SET name = ?, name_fold = ?, updated_at = ? WHERE id = ?',
    [nameRes.value, foldText(nameRes.value), now, groupId],
  );
  if (changes === 0) return err(elvError('storage', 'item-not-found'));
  const updated = await getFailoverGroupById(db, groupId);
  return updated === undefined ? err(elvError('storage', 'item-not-found')) : ok(updated);
}

/** Deletes a failover group and all of its member links atomically (`#157`). */
export async function deleteFailoverGroup(db: SqlDriver, groupId: string): Promise<Result<void>> {
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM failover_group_members WHERE group_id = ?', [groupId]);
    await tx.run('DELETE FROM failover_groups WHERE id = ?', [groupId]);
  });
  return ok(undefined);
}

/** Appends a channel member at `MAX(position) + 1` (idempotent if already in the group, `#157`). */
export async function addFailoverGroupMember(
  db: SqlDriver,
  groupId: string,
  channelKey: string,
  nowMs?: number,
): Promise<Result<FailoverGroupRecord>> {
  if (!isSafeChannelKey(channelKey)) {
    return err(elvError('source-format', 'invalid-channel-key'));
  }
  const now = nowMs ?? Date.now();
  const outcome = await db.transaction<'ok' | 'missing-group' | 'missing-channel'>(async (tx) => {
    const exists = await tx.all<{ id: string }>(
      'SELECT id FROM failover_groups WHERE id = ? LIMIT 1',
      [groupId],
    );
    if (exists.length === 0) return 'missing-group';
    const dup = await tx.all<{ one: number }>(
      'SELECT 1 AS one FROM failover_group_members WHERE group_id = ? AND channel_key = ? LIMIT 1',
      [groupId, channelKey],
    );
    if (dup.length > 0) return 'ok';
    const sourceId = await resolveChannelSourceId(tx, channelKey);
    if (sourceId === undefined) return 'missing-channel';
    const maxRow = await tx.all<{ max_pos: number }>(
      'SELECT COALESCE(MAX(position), -1) AS max_pos FROM failover_group_members WHERE group_id = ?',
      [groupId],
    );
    const nextPos = (maxRow[0]?.max_pos ?? -1) + 1;
    await tx.run(
      `INSERT INTO failover_group_members (group_id, source_id, channel_key, position)
       VALUES (?, ?, ?, ?)`,
      [groupId, sourceId, channelKey, nextPos],
    );
    await tx.run('UPDATE failover_groups SET updated_at = ? WHERE id = ?', [now, groupId]);
    return 'ok';
  });
  if (outcome !== 'ok') return err(elvError('storage', 'item-not-found'));
  const updated = await getFailoverGroupById(db, groupId);
  return updated === undefined ? err(elvError('storage', 'item-not-found')) : ok(updated);
}

/** Removes a channel member from a failover group and compacts remaining positions `0..N-1` (`#157`). */
export async function removeFailoverGroupMember(
  db: SqlDriver,
  groupId: string,
  channelKey: string,
  nowMs?: number,
): Promise<Result<FailoverGroupRecord>> {
  const now = nowMs ?? Date.now();
  const found = await db.transaction<boolean>(async (tx) => {
    const exists = await tx.all<{ id: string }>(
      'SELECT id FROM failover_groups WHERE id = ? LIMIT 1',
      [groupId],
    );
    if (exists.length === 0) return false;
    await tx.run('DELETE FROM failover_group_members WHERE group_id = ? AND channel_key = ?', [
      groupId,
      channelKey,
    ]);
    await compactGroupPositionsInTx(tx, groupId);
    await tx.run('UPDATE failover_groups SET updated_at = ? WHERE id = ?', [now, groupId]);
    return true;
  });
  if (!found) return err(elvError('storage', 'item-not-found'));
  const updated = await getFailoverGroupById(db, groupId);
  return updated === undefined ? err(elvError('storage', 'item-not-found')) : ok(updated);
}

/** Reorders members of a failover group inside one transaction (`#157`). */
export async function reorderFailoverGroupMembers(
  db: SqlDriver,
  groupId: string,
  orderedChannelKeys: readonly string[],
  nowMs?: number,
): Promise<Result<FailoverGroupRecord>> {
  const now = nowMs ?? Date.now();
  const found = await db.transaction<boolean>(async (tx) => {
    const exists = await tx.all<{ id: string }>(
      'SELECT id FROM failover_groups WHERE id = ? LIMIT 1',
      [groupId],
    );
    if (exists.length === 0) return false;
    const current = await tx.all<{ channel_key: string }>(
      `SELECT channel_key
         FROM failover_group_members
        WHERE group_id = ?
        ORDER BY position ASC, channel_key ASC`,
      [groupId],
    );
    const existingSet = new Set(current.map((r) => r.channel_key));
    const ordered: string[] = [];
    const placed = new Set<string>();
    for (const key of orderedChannelKeys) {
      if (existingSet.has(key) && !placed.has(key)) {
        placed.add(key);
        ordered.push(key);
      }
    }
    for (const row of current) {
      if (!placed.has(row.channel_key)) ordered.push(row.channel_key);
    }
    for (let i = 0; i < ordered.length; i += 1) {
      await tx.run(
        'UPDATE failover_group_members SET position = ? WHERE group_id = ? AND channel_key = ?',
        [i, groupId, ordered[i] as string],
      );
    }
    await tx.run('UPDATE failover_groups SET updated_at = ? WHERE id = ?', [now, groupId]);
    return true;
  });
  if (!found) return err(elvError('storage', 'item-not-found'));
  const updated = await getFailoverGroupById(db, groupId);
  return updated === undefined ? err(elvError('storage', 'item-not-found')) : ok(updated);
}

/** @internal Prunes all failover group members belonging to `sourceId` inside an active transaction and compacts positions. */
export async function pruneSourceFailoverMembersInTx(
  tx: SqlDriver,
  sourceId: string,
): Promise<number> {
  const affected = await tx.all<{ group_id: string }>(
    'SELECT DISTINCT group_id FROM failover_group_members WHERE source_id = ?',
    [sourceId],
  );
  if (affected.length === 0) return 0;
  const { changes } = await tx.run('DELETE FROM failover_group_members WHERE source_id = ?', [
    sourceId,
  ]);
  for (const row of affected) {
    await compactGroupPositionsInTx(tx, row.group_id);
  }
  return changes;
}

/** Prunes all failover group members belonging to `sourceId` and compacts remaining positions (`#157`). */
export async function pruneSourceFailoverMembers(db: SqlDriver, sourceId: string): Promise<number> {
  return db.transaction((tx) => pruneSourceFailoverMembersInTx(tx, sourceId));
}

/**
 * Persists selected {@link SuggestedFailoverCluster} entries as `auto_matched = 1` failover groups
 * inside a single transaction and returns the created records (`#157`).
 */
export async function applySuggestedFailoverGroups(
  db: SqlDriver,
  clusters: readonly SuggestedFailoverCluster[],
  nowMs?: number,
): Promise<Result<FailoverGroupRecord[]>> {
  const now = nowMs ?? Date.now();
  const createdIds: string[] = [];

  await db.transaction(async (tx) => {
    for (let idx = 0; idx < clusters.length; idx += 1) {
      const cluster = clusters[idx] as SuggestedFailoverCluster;
      const nameRes = validateGroupName(cluster.suggestedName);
      if (!nameRes.ok) continue;
      const uniqueMembers: { sourceId: string; channelKey: string }[] = [];
      const seenKeys = new Set<string>();
      for (const m of cluster.members) {
        if (!isSafeChannelKey(m.channelKey) || seenKeys.has(m.channelKey)) continue;
        seenKeys.add(m.channelKey);
        const alreadyGrouped = await tx.all<{ one: number }>(
          'SELECT 1 AS one FROM failover_group_members WHERE channel_key = ? LIMIT 1',
          [m.channelKey],
        );
        if (alreadyGrouped.length > 0) continue;
        const sourceId = (await resolveChannelSourceId(tx, m.channelKey)) ?? m.sourceId;
        uniqueMembers.push({ sourceId, channelKey: m.channelKey });
      }
      if (uniqueMembers.length === 0) continue;

      const ts = Math.max(0, Math.floor(now)).toString(36);
      const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
      const id = `fg_${ts}_${idx}_${rand}`;
      await tx.run(
        `INSERT INTO failover_groups (id, name, name_fold, auto_matched, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
        [id, nameRes.value, foldText(nameRes.value), now, now],
      );
      for (let pos = 0; pos < uniqueMembers.length; pos += 1) {
        const mem = uniqueMembers[pos] as { sourceId: string; channelKey: string };
        await tx.run(
          `INSERT OR IGNORE INTO failover_group_members (group_id, source_id, channel_key, position)
           VALUES (?, ?, ?, ?)`,
          [id, mem.sourceId, mem.channelKey, pos],
        );
      }
      createdIds.push(id);
    }
  });

  const records: FailoverGroupRecord[] = [];
  for (const id of createdIds) {
    const rec = await getFailoverGroupById(db, id);
    if (rec !== undefined) records.push(rec);
  }
  return ok(records);
}
