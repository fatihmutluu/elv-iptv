import type { CatalogService } from '@elv/data';
import { elvError, err } from '@elv/domain';
import type { CatalogEpgOpsRpcCall } from '../shared/catalog-ipc-epg-guards.ts';

/** Dispatches all 16 Wave F3 catch-up, multi-guide, channel mapping, and reminder RPC calls to {@link CatalogService} (`#220`, `#306`, `#30`, `#35`). */
export function executeEpgOpsRpcCall(
  service: CatalogService,
  call: CatalogEpgOpsRpcCall,
): Promise<unknown> {
  switch (call.method) {
    case 'resolveCatchupStream':
      return service.resolveCatchupStream
        ? service.resolveCatchupStream(call.itemKey, call.programme, call.opts)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'fetchChannelArchiveEpg':
      return service.fetchChannelArchiveEpg
        ? service.fetchChannelArchiveEpg(call.itemKey, call.opts)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'listGuideSources':
      return service.listGuideSources
        ? service.listGuideSources(call.sourceId)
        : Promise.resolve([]);
    case 'addGuideSource':
      return service.addGuideSource
        ? service.addGuideSource(call.input)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'updateGuideSource':
      return service.updateGuideSource
        ? service.updateGuideSource(call.id, call.patch)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'removeGuideSource':
      return service.removeGuideSource
        ? service.removeGuideSource(call.id)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'reorderGuideSources':
      return service.reorderGuideSources
        ? service.reorderGuideSources(call.sourceId, call.orderedIds)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'listGuideChannels':
      return service.listGuideChannels
        ? service.listGuideChannels(call.sourceId, call.query, call.limit)
        : Promise.resolve([]);
    case 'listChannelGuideOverrides':
      return service.listChannelGuideOverrides
        ? service.listChannelGuideOverrides(call.sourceId)
        : Promise.resolve([]);
    case 'setChannelGuideOverride':
      return service.setChannelGuideOverride
        ? service.setChannelGuideOverride(call.input)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'clearChannelGuideOverride':
      return service.clearChannelGuideOverride
        ? service.clearChannelGuideOverride(call.sourceId, call.channelKey)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'listReminders':
      return service.listReminders
        ? service.listReminders(call.profileId, call.opts)
        : Promise.resolve([]);
    case 'upsertReminder':
      return service.upsertReminder
        ? service.upsertReminder(call.input)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'removeReminder':
      return service.removeReminder
        ? service.removeReminder(call.channelKey, call.programmeStart, call.profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'markReminderFired':
      return service.markReminderFired
        ? service.markReminderFired(call.channelKey, call.programmeStart, call.profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'pruneExpiredReminders':
      return service.pruneExpiredReminders
        ? service.pruneExpiredReminders(call.nowMs)
        : Promise.resolve(0);
  }
}
