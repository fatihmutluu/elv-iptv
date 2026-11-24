import type { Result, SqlDriver } from '@elv/domain';
import {
  type ChannelOverrideRecord,
  clearChannelOverride,
  listChannelOverrides,
  reorderChannels,
  type SetChannelOverrideInput,
  setChannelOverride,
} from './channel-overrides-repo';
import {
  addChannelToCustomGroup,
  type CreateCustomGroupInput,
  type CustomGroupItemInput,
  type CustomGroupRecord,
  createCustomGroup,
  deleteCustomGroup,
  listCustomGroups,
  removeChannelFromCustomGroup,
  setCustomGroupItems,
  type UpdateCustomGroupPatch,
  updateCustomGroup,
} from './custom-groups-repo';

/** Channel overrides and custom groups subset of `CatalogService` (`#60`). */
export interface CatalogChannelOpsMethods {
  listChannelOverrides(profileId?: string): Promise<ChannelOverrideRecord[]>;
  setChannelOverride(input: SetChannelOverrideInput): Promise<Result<ChannelOverrideRecord>>;
  clearChannelOverride(itemKey: string, profileId?: string): Promise<Result<void>>;
  reorderChannels(
    itemKeys: readonly string[],
    sourceId: string,
    profileId?: string,
  ): Promise<Result<void>>;
  listCustomGroups(
    profileId?: string,
    opts?: { readonly includeHidden?: boolean; readonly parentalUnlocked?: boolean },
  ): Promise<CustomGroupRecord[]>;
  createCustomGroup(input: CreateCustomGroupInput): Promise<Result<CustomGroupRecord>>;
  updateCustomGroup(
    groupId: string,
    patch: UpdateCustomGroupPatch,
  ): Promise<Result<CustomGroupRecord>>;
  deleteCustomGroup(groupId: string): Promise<Result<void>>;
  setCustomGroupItems(
    groupId: string,
    items: readonly CustomGroupItemInput[],
  ): Promise<Result<void>>;
  addChannelToCustomGroup(
    groupId: string,
    itemKey: string,
    sourceId: string,
  ): Promise<Result<void>>;
  removeChannelFromCustomGroup(groupId: string, itemKey: string): Promise<Result<void>>;
}

/** @internal Creates channel override & custom group management methods for `CatalogService`. */
export function createCatalogChannelOpsMethods(deps: {
  db: SqlDriver;
  clock: () => number;
  syncUserData: () => Promise<void> | undefined;
}): CatalogChannelOpsMethods {
  const { db, clock, syncUserData } = deps;

  return {
    listChannelOverrides: (profileId) => listChannelOverrides(db, profileId),

    async setChannelOverride(input) {
      const updated = await setChannelOverride(db, input, clock);
      if (updated.ok) await syncUserData();
      return updated;
    },

    async clearChannelOverride(itemKey, profileId) {
      const cleared = await clearChannelOverride(db, itemKey, profileId);
      if (cleared.ok) await syncUserData();
      return cleared;
    },

    async reorderChannels(itemKeys, sourceId, profileId) {
      const reordered = await reorderChannels(db, itemKeys, sourceId, profileId, clock);
      if (reordered.ok) await syncUserData();
      return reordered;
    },

    listCustomGroups: (profileId, opts) => listCustomGroups(db, profileId, opts),

    async createCustomGroup(input) {
      const created = await createCustomGroup(db, input, clock);
      if (created.ok) await syncUserData();
      return created;
    },

    async updateCustomGroup(groupId, patch) {
      const updated = await updateCustomGroup(db, groupId, patch, clock);
      if (updated.ok) await syncUserData();
      return updated;
    },

    async deleteCustomGroup(groupId) {
      const deleted = await deleteCustomGroup(db, groupId);
      if (deleted.ok) await syncUserData();
      return deleted;
    },

    async setCustomGroupItems(groupId, items) {
      const updated = await setCustomGroupItems(db, groupId, items, clock);
      if (updated.ok) await syncUserData();
      return updated;
    },

    async addChannelToCustomGroup(groupId, itemKey, sourceId) {
      const added = await addChannelToCustomGroup(db, groupId, itemKey, sourceId, clock);
      if (added.ok) await syncUserData();
      return added;
    },

    async removeChannelFromCustomGroup(groupId, itemKey) {
      const removed = await removeChannelFromCustomGroup(db, groupId, itemKey, clock);
      if (removed.ok) await syncUserData();
      return removed;
    },
  };
}
