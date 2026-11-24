import type { SqlDriver } from '@elv/domain';
import {
  type ChannelOverrideRecord,
  hasControlChar,
  isSafeChannelKey,
  MAX_CHANNEL_SORT_ORDER,
  MAX_CUSTOM_CHANNEL_NAME_LENGTH,
  type RawChannelOverrideRow,
} from './channel-overrides-repo';
import {
  type CustomGroupItemRecord,
  isValidCustomGroupId,
  MAX_CUSTOM_GROUP_NAME_LENGTH,
} from './custom-groups-repo';
import { isValidProfileId } from './profiles-repo';
import { SOURCE_ID } from './sources';

/** Compact backup entry for one `custom_groups` row (`#60`). */
export interface UserDataCustomGroupEntry {
  readonly id: string;
  readonly profileId: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly isHidden: boolean;
  readonly updatedAt: number;
}

interface RawCustomGroupBackupRow {
  id: string;
  profile_id: string;
  name: string;
  sort_order: number;
  is_hidden: number;
  updated_at: number;
}

interface RawCustomGroupItemBackupRow {
  group_id: string;
  item_key: string;
  source_id: string;
  position: number;
  added_at: number;
}

/** Parses and sanitizes one `channel_overrides` snapshot entry. */
export function parseChannelOverrideEntry(raw: unknown): ChannelOverrideRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.profileId !== 'string' ||
    typeof r.sourceId !== 'string' ||
    !SOURCE_ID.test(r.sourceId) ||
    !isSafeChannelKey(r.itemKey) ||
    typeof r.isHidden !== 'boolean' ||
    typeof r.updatedAt !== 'number' ||
    !Number.isFinite(r.updatedAt)
  ) {
    return null;
  }
  const profileId = r.profileId.trim();
  if (!isValidProfileId(profileId)) return null;

  let customName: string | null = null;
  if (r.customName !== null && r.customName !== undefined) {
    if (typeof r.customName !== 'string') return null;
    const trimmed = r.customName.trim();
    if (trimmed.length > 0) {
      if (trimmed.length > MAX_CUSTOM_CHANNEL_NAME_LENGTH || hasControlChar(trimmed)) return null;
      customName = trimmed;
    }
  }

  let sortOrder: number | null = null;
  if (r.sortOrder !== null && r.sortOrder !== undefined) {
    if (
      typeof r.sortOrder !== 'number' ||
      !Number.isFinite(r.sortOrder) ||
      r.sortOrder < 0 ||
      r.sortOrder > MAX_CHANNEL_SORT_ORDER
    ) {
      return null;
    }
    sortOrder = Math.floor(r.sortOrder);
  }

  if (customName === null && !r.isHidden && sortOrder === null) return null;

  return {
    profileId,
    itemKey: r.itemKey.trim(),
    sourceId: r.sourceId,
    customName,
    isHidden: r.isHidden,
    sortOrder,
    updatedAt: Math.max(0, Math.round(r.updatedAt)),
  };
}

/** Deterministic sort order for `channelOverrides` snapshot entries. */
export function compareChannelOverrides(
  a: ChannelOverrideRecord,
  b: ChannelOverrideRecord,
): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  if (a.profileId !== b.profileId) return a.profileId < b.profileId ? -1 : 1;
  return a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0;
}

/** Parses and sanitizes one `custom_groups` snapshot entry. */
export function parseCustomGroupEntry(raw: unknown): UserDataCustomGroupEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isValidCustomGroupId(r.id) ||
    typeof r.profileId !== 'string' ||
    typeof r.name !== 'string' ||
    typeof r.sortOrder !== 'number' ||
    !Number.isFinite(r.sortOrder) ||
    typeof r.isHidden !== 'boolean' ||
    typeof r.updatedAt !== 'number' ||
    !Number.isFinite(r.updatedAt)
  ) {
    return null;
  }
  const profileId = r.profileId.trim();
  const name = r.name.trim();
  if (
    !isValidProfileId(profileId) ||
    name.length === 0 ||
    name.length > MAX_CUSTOM_GROUP_NAME_LENGTH ||
    hasControlChar(name)
  ) {
    return null;
  }
  return {
    id: r.id,
    profileId,
    name,
    sortOrder: Math.floor(r.sortOrder),
    isHidden: r.isHidden,
    updatedAt: Math.max(0, Math.round(r.updatedAt)),
  };
}

/** Deterministic sort order for `customGroups` snapshot entries. */
export function compareCustomGroups(
  a: UserDataCustomGroupEntry,
  b: UserDataCustomGroupEntry,
): number {
  if (a.profileId !== b.profileId) return a.profileId < b.profileId ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Parses and sanitizes one `custom_group_items` snapshot entry. */
export function parseCustomGroupItemEntry(raw: unknown): CustomGroupItemRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isValidCustomGroupId(r.groupId) ||
    !isSafeChannelKey(r.itemKey) ||
    typeof r.sourceId !== 'string' ||
    !SOURCE_ID.test(r.sourceId) ||
    typeof r.position !== 'number' ||
    !Number.isFinite(r.position) ||
    r.position < 0 ||
    typeof r.addedAt !== 'number' ||
    !Number.isFinite(r.addedAt)
  ) {
    return null;
  }
  return {
    groupId: r.groupId,
    itemKey: r.itemKey.trim(),
    sourceId: r.sourceId,
    position: Math.floor(r.position),
    addedAt: Math.max(0, Math.round(r.addedAt)),
  };
}

/** Deterministic sort order for `customGroupItems` snapshot entries. */
export function compareCustomGroupItems(
  a: CustomGroupItemRecord,
  b: CustomGroupItemRecord,
): number {
  if (a.groupId !== b.groupId) return a.groupId < b.groupId ? -1 : 1;
  if (a.position !== b.position) return a.position - b.position;
  return a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0;
}

/** Reads `channel_overrides`, `custom_groups`, and `custom_group_items` rows for backup mirroring. */
export async function readChannelManagementBackupRows(db: SqlDriver): Promise<{
  channelOverrides: ChannelOverrideRecord[];
  customGroups: UserDataCustomGroupEntry[];
  customGroupItems: CustomGroupItemRecord[];
}> {
  const [rawOverrides, rawGroups, rawItems] = await Promise.all([
    db.all<RawChannelOverrideRow>(
      'SELECT profile_id, item_key, source_id, custom_name, is_hidden, sort_order, updated_at FROM channel_overrides ORDER BY updated_at DESC, profile_id ASC, item_key ASC',
    ),
    db.all<RawCustomGroupBackupRow>(
      'SELECT id, profile_id, name, sort_order, is_hidden, updated_at FROM custom_groups ORDER BY profile_id ASC, sort_order ASC, id ASC',
    ),
    db.all<RawCustomGroupItemBackupRow>(
      'SELECT group_id, item_key, source_id, position, added_at FROM custom_group_items ORDER BY group_id ASC, position ASC, item_key ASC',
    ),
  ]);

  const channelOverrides: ChannelOverrideRecord[] = [];
  for (const r of rawOverrides) {
    const parsed = parseChannelOverrideEntry({
      profileId: r.profile_id,
      itemKey: r.item_key,
      sourceId: r.source_id,
      customName: r.custom_name,
      isHidden: r.is_hidden !== 0,
      sortOrder: r.sort_order,
      updatedAt: r.updated_at,
    });
    if (parsed !== null) channelOverrides.push(parsed);
  }

  const customGroups: UserDataCustomGroupEntry[] = [];
  for (const r of rawGroups) {
    const parsed = parseCustomGroupEntry({
      id: r.id,
      profileId: r.profile_id,
      name: r.name,
      sortOrder: r.sort_order,
      isHidden: r.is_hidden !== 0,
      updatedAt: r.updated_at,
    });
    if (parsed !== null) customGroups.push(parsed);
  }

  const customGroupItems: CustomGroupItemRecord[] = [];
  for (const r of rawItems) {
    const parsed = parseCustomGroupItemEntry({
      groupId: r.group_id,
      itemKey: r.item_key,
      sourceId: r.source_id,
      position: r.position,
      addedAt: r.added_at,
    });
    if (parsed !== null) customGroupItems.push(parsed);
  }

  return { channelOverrides, customGroups, customGroupItems };
}

const RESTORE_OVERRIDE_SQL = `INSERT OR IGNORE INTO channel_overrides (
  profile_id, item_key, source_id, custom_name, is_hidden, sort_order, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?)`;

const RESTORE_CUSTOM_GROUP_SQL = `INSERT OR IGNORE INTO custom_groups (
  id, profile_id, name, sort_order, is_hidden, updated_at
) VALUES (?, ?, ?, ?, ?, ?)`;

const RESTORE_CUSTOM_GROUP_ITEM_SQL = `INSERT OR IGNORE INTO custom_group_items (
  group_id, item_key, source_id, position, added_at
) VALUES (?, ?, ?, ?, ?)`;

/** Restores `channel_overrides`, `custom_groups`, and `custom_group_items` inside a `reconcileUserData` transaction. */
export async function restoreChannelManagementBackupRows(
  tx: SqlDriver,
  input: {
    readonly channelOverrides: readonly ChannelOverrideRecord[];
    readonly customGroups: readonly UserDataCustomGroupEntry[];
    readonly customGroupItems: readonly CustomGroupItemRecord[];
  },
): Promise<{
  channelOverridesRestored: number;
  customGroupsRestored: number;
  customGroupItemsRestored: number;
  hasCustomNames: boolean;
}> {
  let channelOverridesRestored = 0;
  let customGroupsRestored = 0;
  let customGroupItemsRestored = 0;
  let hasCustomNames = false;

  const validGroupIds = new Set<string>();
  for (const g of input.customGroups) {
    const res = await tx.run(RESTORE_CUSTOM_GROUP_SQL, [
      g.id,
      g.profileId,
      g.name,
      g.sortOrder,
      g.isHidden ? 1 : 0,
      g.updatedAt,
    ]);
    customGroupsRestored += res.changes;
    validGroupIds.add(g.id);
  }

  for (const item of input.customGroupItems) {
    if (!validGroupIds.has(item.groupId)) continue;
    const res = await tx.run(RESTORE_CUSTOM_GROUP_ITEM_SQL, [
      item.groupId,
      item.itemKey,
      item.sourceId,
      item.position,
      item.addedAt,
    ]);
    customGroupItemsRestored += res.changes;
  }

  for (const ov of input.channelOverrides) {
    const res = await tx.run(RESTORE_OVERRIDE_SQL, [
      ov.profileId,
      ov.itemKey,
      ov.sourceId,
      ov.customName,
      ov.isHidden ? 1 : 0,
      ov.sortOrder,
      ov.updatedAt,
    ]);
    channelOverridesRestored += res.changes;
    if (res.changes > 0 && ov.customName !== null && !ov.isHidden) {
      hasCustomNames = true;
    }
  }

  return {
    channelOverridesRestored,
    customGroupsRestored,
    customGroupItemsRestored,
    hasCustomNames,
  };
}
