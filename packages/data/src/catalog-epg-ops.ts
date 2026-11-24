import { elvError, err, ok, type Result, type SecretStore, type SqlDriver } from '@elv/domain';
import type { ProgrammeRow } from './guide-queries';
import {
  type AddGuideSourceInput,
  addGuideSource,
  type ChannelGuideOverrideRecord,
  clearChannelGuideOverride,
  type GuideChannelOption,
  type GuideSourceRecord,
  listChannelGuideOverrides,
  listGuideChannels,
  listGuideSources,
  removeGuideSource,
  reorderGuideSources,
  type SetChannelGuideOverrideInput,
  setChannelGuideOverride,
  type UpdateGuideSourcePatch,
  updateGuideSource,
} from './guide-sources-repo';
import type { ImportDeps } from './import-types';
import { openClient } from './import-xtream';
import type { ParentalQueryOptions } from './parental-policy';
import { isItemRestricted, isProgrammeRestricted, loadActiveParentalFilter } from './parental-repo';
import { sourceOfKey } from './queries-shared';
import {
  type ListRemindersOptions,
  listReminders,
  markReminderFired,
  type ProgrammeReminderRecord,
  pruneExpiredReminders,
  removeReminder,
  type UpsertReminderInput,
  upsertReminder,
} from './reminders-repo';
import { getSource } from './sources';
import type {
  CatchupProgrammeInput,
  PlaytimeResolverCache,
  StreamRequest,
} from './stream-resolver';

/** Catch-up, multi-guide source management, manual channel mapping, and reminder methods on `CatalogService` (`#220`, `#306`, `#30`, `#35`). */
export interface CatalogEpgOpsMethods {
  resolveCatchupStream(
    itemKey: string,
    programme: CatchupProgrammeInput,
    opts?: ParentalQueryOptions,
  ): Promise<Result<StreamRequest>>;
  fetchChannelArchiveEpg(
    itemKey: string,
    opts?: ParentalQueryOptions,
  ): Promise<Result<ProgrammeRow[]>>;
  listGuideSources(sourceId: string): Promise<GuideSourceRecord[]>;
  addGuideSource(input: AddGuideSourceInput): Promise<Result<GuideSourceRecord>>;
  updateGuideSource(id: string, patch: UpdateGuideSourcePatch): Promise<Result<GuideSourceRecord>>;
  removeGuideSource(id: string): Promise<Result<void>>;
  reorderGuideSources(sourceId: string, orderedIds: readonly string[]): Promise<Result<void>>;
  listGuideChannels(
    sourceId: string,
    query?: string,
    limit?: number,
  ): Promise<GuideChannelOption[]>;
  listChannelGuideOverrides(sourceId: string): Promise<ChannelGuideOverrideRecord[]>;
  setChannelGuideOverride(
    input: SetChannelGuideOverrideInput,
  ): Promise<Result<ChannelGuideOverrideRecord>>;
  clearChannelGuideOverride(sourceId: string, channelKey: string): Promise<Result<void>>;
  listReminders(
    profileId?: string,
    opts?: ListRemindersOptions,
  ): Promise<ProgrammeReminderRecord[]>;
  upsertReminder(input: UpsertReminderInput): Promise<Result<ProgrammeReminderRecord>>;
  removeReminder(
    channelKey: string,
    programmeStart: number,
    profileId?: string,
  ): Promise<Result<void>>;
  markReminderFired(
    channelKey: string,
    programmeStart: number,
    profileId?: string,
  ): Promise<Result<void>>;
  pruneExpiredReminders(nowMs?: number): Promise<number>;
}

/** @internal Creates catch-up, multi-guide, manual EPG mapping, and reminder methods for `CatalogService`. */
export function createCatalogEpgOpsMethods(deps: {
  db: SqlDriver;
  secrets: SecretStore;
  clock: () => number;
  importDeps: ImportDeps;
  playtime: PlaytimeResolverCache;
}): CatalogEpgOpsMethods {
  const { db, secrets, clock, importDeps, playtime } = deps;

  return {
    async resolveCatchupStream(itemKey, programme, opts) {
      const filter = await loadActiveParentalFilter(db, opts?.profileId, opts?.parentalUnlocked);
      if (filter !== null && (await isItemRestricted(db, filter, itemKey))) {
        return err(elvError('auth', 'parental-locked'));
      }
      return playtime.resolveCatchupStream(itemKey, programme, clock());
    },

    async fetchChannelArchiveEpg(itemKey, opts) {
      const filter = await loadActiveParentalFilter(db, opts?.profileId, opts?.parentalUnlocked);
      if (filter !== null && (await isItemRestricted(db, filter, itemKey))) {
        return err(elvError('auth', 'parental-locked'));
      }
      const sourceId = sourceOfKey(itemKey);
      if (sourceId === undefined) return ok([]);
      const source = await getSource(db, sourceId);
      if (source === undefined || source.kind !== 'xtream') return ok([]);
      const rows = await db.all<{ provider_id: string | null; guide_id: string | null }>(
        'SELECT provider_id, guide_id FROM live WHERE source_id = ? AND key = ? LIMIT 1',
        [sourceId, itemKey],
      );
      const liveRow = rows[0];
      if (liveRow?.provider_id == null) return ok([]);
      const streamId = Number(liveRow.provider_id);
      if (!Number.isFinite(streamId)) return ok([]);
      const opened = await openClient(source, importDeps);
      if (!opened.ok) return opened;
      const fetched = await opened.value.simpleEpg(streamId);
      if (!fetched.ok) return fetched;
      const guideId = liveRow.guide_id ?? String(streamId);
      const out: ProgrammeRow[] = [];
      for (const entry of fetched.value) {
        if (
          filter !== null &&
          isProgrammeRestricted(filter, entry.title, entry.desc ?? null, null)
        ) {
          continue;
        }
        out.push({
          channelKey: itemKey,
          sourceId,
          guideId,
          start: entry.start,
          stop: entry.stop,
          title: entry.title,
          subTitle: null,
          description: entry.desc ?? null,
          episodeNum: null,
          icon: null,
          genre: null,
          flags: 0,
          ...(entry.hasArchive !== undefined ? { hasArchive: entry.hasArchive } : {}),
        });
      }
      out.sort((a, b) => a.start - b.start);
      return ok(out);
    },

    listGuideSources: (sourceId) => listGuideSources(db, sourceId),

    async addGuideSource(input) {
      const created = await addGuideSource(db, secrets, input, clock);
      if (created.ok) playtime.evict(input.sourceId);
      return created;
    },

    async updateGuideSource(id, patch) {
      const updated = await updateGuideSource(db, secrets, id, patch);
      if (updated.ok) playtime.evict(updated.value.sourceId);
      return updated;
    },

    async removeGuideSource(id) {
      const existing = await db.all<{ source_id: string }>(
        'SELECT source_id FROM guide_sources WHERE id = ? LIMIT 1',
        [id],
      );
      const removed = await removeGuideSource(db, secrets, id);
      if (removed.ok && existing[0]?.source_id !== undefined) {
        playtime.evict(existing[0].source_id);
      }
      return removed;
    },

    reorderGuideSources: (sourceId, orderedIds) => reorderGuideSources(db, sourceId, orderedIds),
    listGuideChannels: (sourceId, query, limit) => listGuideChannels(db, sourceId, query, limit),
    listChannelGuideOverrides: (sourceId) => listChannelGuideOverrides(db, sourceId),
    setChannelGuideOverride: (input) => setChannelGuideOverride(db, input, clock),
    clearChannelGuideOverride: (sourceId, channelKey) =>
      clearChannelGuideOverride(db, sourceId, channelKey),

    listReminders: (profileId, opts) => listReminders(db, profileId, opts),
    upsertReminder: (input) => upsertReminder(db, input, clock),
    removeReminder: (channelKey, programmeStart, profileId) =>
      removeReminder(db, channelKey, programmeStart, profileId),
    markReminderFired: (channelKey, programmeStart, profileId) =>
      markReminderFired(db, channelKey, programmeStart, profileId),
    pruneExpiredReminders: (nowMs) => pruneExpiredReminders(db, nowMs ?? clock()),
  };
}
