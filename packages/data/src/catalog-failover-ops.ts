import type { Result, SqlDriver } from '@elv/domain';
import {
  addFailoverGroupMember,
  applySuggestedFailoverGroups,
  type CreateFailoverGroupInput,
  createFailoverGroup,
  deleteFailoverGroup,
  type FailoverGroupRecord,
  getFailoverGroupByChannel,
  listFailoverGroups,
  removeFailoverGroupMember,
  renameFailoverGroup,
  reorderFailoverGroupMembers,
  type SuggestedFailoverCluster,
  suggestFailoverGroups,
} from './failover-groups-repo';
import type { PlaytimeResolverCache } from './stream-resolver';

/** Multi-source failover group management and split Xtream stream outcome reporting (`#157`, `#317`). */
export interface CatalogFailoverOpsMethods {
  listFailoverGroups(): Promise<FailoverGroupRecord[]>;
  getFailoverGroupByChannel(channelKey: string): Promise<FailoverGroupRecord | undefined>;
  createFailoverGroup(input: CreateFailoverGroupInput): Promise<Result<FailoverGroupRecord>>;
  renameFailoverGroup(groupId: string, name: string): Promise<Result<FailoverGroupRecord>>;
  deleteFailoverGroup(groupId: string): Promise<Result<void>>;
  addFailoverGroupMember(groupId: string, channelKey: string): Promise<Result<FailoverGroupRecord>>;
  removeFailoverGroupMember(
    groupId: string,
    channelKey: string,
  ): Promise<Result<FailoverGroupRecord>>;
  reorderFailoverGroupMembers(
    groupId: string,
    orderedChannelKeys: readonly string[],
  ): Promise<Result<FailoverGroupRecord>>;
  suggestFailoverGroups(): Promise<SuggestedFailoverCluster[]>;
  applySuggestedFailoverGroups(
    clusters: readonly SuggestedFailoverCluster[],
  ): Promise<Result<FailoverGroupRecord[]>>;
  reportStreamOutcome(sourceId: string, serverUrl: string, succeeded: boolean): void;
}

/** @internal Creates multi-source failover group and stream outcome methods for `CatalogService`. */
export function createCatalogFailoverOpsMethods(deps: {
  db: SqlDriver;
  clock: () => number;
  playtime: PlaytimeResolverCache;
}): CatalogFailoverOpsMethods {
  const { db, clock, playtime } = deps;

  return {
    listFailoverGroups: () => listFailoverGroups(db),
    getFailoverGroupByChannel: (channelKey) => getFailoverGroupByChannel(db, channelKey),
    createFailoverGroup: (input) =>
      createFailoverGroup(db, {
        ...input,
        ...(input.nowMs === undefined ? { nowMs: clock() } : {}),
      }),
    renameFailoverGroup: (groupId, name) => renameFailoverGroup(db, groupId, name, clock()),
    deleteFailoverGroup: (groupId) => deleteFailoverGroup(db, groupId),
    addFailoverGroupMember: (groupId, channelKey) =>
      addFailoverGroupMember(db, groupId, channelKey, clock()),
    removeFailoverGroupMember: (groupId, channelKey) =>
      removeFailoverGroupMember(db, groupId, channelKey, clock()),
    reorderFailoverGroupMembers: (groupId, orderedChannelKeys) =>
      reorderFailoverGroupMembers(db, groupId, orderedChannelKeys, clock()),
    suggestFailoverGroups: () => suggestFailoverGroups(db),
    applySuggestedFailoverGroups: (clusters) => applySuggestedFailoverGroups(db, clusters, clock()),
    reportStreamOutcome: (sourceId, serverUrl, succeeded) =>
      playtime.reportStreamOutcome(sourceId, serverUrl, succeeded),
  };
}
