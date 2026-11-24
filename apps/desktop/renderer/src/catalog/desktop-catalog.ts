import type { CatalogService, DeviceImportOptions, ParentalQueryOptions } from '@elv/data';
import { type ElvError, elvError, err } from '@elv/domain';
import type { CatalogBridge } from '../../../src/shared/catalog-ipc.ts';

/** The catalog utility process could not open or migrate SQLite; `error` carries the typed cause (no secrets). */
export class CatalogOpenError extends Error {
  constructor(readonly error: ElvError) {
    super(`catalog open failed: ${error.category}/${error.code}`);
  }
}

let instance: Promise<CatalogService> | undefined;

function sanitizeDisplayText(text: string): string {
  let out = '';
  let lastSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      if (!lastSpace) {
        out += ' ';
        lastSpace = true;
      }
    } else {
      out += text[i];
      lastSpace = code === 0x20;
    }
  }
  return out.trim();
}

/**
 * Adapts the preload's {@link CatalogBridge} into `@elv/data`'s {@link CatalogService}, mapping
 * `AbortSignal` cancellations onto `cancelImport(reqId)` and isolating progress callback throws.
 */
export function createDesktopCatalogFromBridge(
  bridge: CatalogBridge,
  onClose?: () => void,
): CatalogService {
  return {
    addSource: (input) => bridge.addSource(input),
    addSourceFromLink: (input) => bridge.addSourceFromLink(input),
    addLocalM3uSource: (input) =>
      bridge.addLocalM3uSource
        ? bridge.addLocalM3uSource(input)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    discoverSourceCategories: (sourceId, opts) => {
      if (opts?.signal?.aborted) {
        return Promise.resolve(err(elvError('network', 'aborted')));
      }
      return bridge.discoverSourceCategories
        ? bridge.discoverSourceCategories(sourceId)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    },
    updateSourceSettings: (sourceId, patch) =>
      bridge.updateSourceSettings
        ? bridge.updateSourceSettings(sourceId, patch)
        : Promise.resolve(),
    removeSource: (id) => bridge.removeSource(id),
    async importSource(id, opts?: DeviceImportOptions) {
      if (opts?.signal?.aborted) {
        return err(elvError('network', 'aborted'));
      }
      const handle = bridge.startImport(id, {
        ...(opts?.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
        ...(opts?.maxBodyBytes === undefined ? {} : { maxBodyBytes: opts.maxBodyBytes }),
        ...(opts?.onProgress === undefined
          ? {}
          : {
              onProgress: (progress) => {
                try {
                  opts.onProgress?.(progress);
                } catch {
                  // isolate caller callback errors
                }
              },
            }),
      });
      if (!opts?.signal) {
        return handle.result;
      }
      const onAbort = (): void => {
        bridge.cancelImport(handle.reqId);
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      try {
        return await handle.result;
      } finally {
        opts.signal.removeEventListener('abort', onAbort);
      }
    },
    listSources: () => bridge.listSources(),
    importGuide: (id, opts) =>
      opts?.signal?.aborted
        ? Promise.resolve(err(elvError('network', 'aborted')))
        : bridge.importGuide(id),
    categories: (sourceId, kind, opts) => bridge.categories(sourceId, kind, opts),
    items: (categoryId, offset, limit, opts) => bridge.items(categoryId, offset, limit, opts),
    liveVariants: (itemKey, categoryId, opts?: ParentalQueryOptions) =>
      bridge.liveVariants ? bridge.liveVariants(itemKey, categoryId, opts) : Promise.resolve([]),
    itemVersions: (itemKey, opts?: ParentalQueryOptions) =>
      bridge.itemVersions ? bridge.itemVersions(itemKey, opts) : Promise.resolve([]),
    allSourcesItems: (kind, offset, limit, sourceIds, opts) =>
      bridge.allSourcesItems
        ? bridge.allSourcesItems(kind, offset, limit, sourceIds, opts)
        : Promise.resolve([]),
    itemDetail: (itemKey, opts) => bridge.itemDetail(itemKey, opts),
    search: (query, opts) => bridge.search(sanitizeDisplayText(query).slice(0, 256), opts),
    searchSuggestions: (options) =>
      bridge.searchSuggestions ? bridge.searchSuggestions(options) : Promise.resolve([]),
    alphabetIndex: (input) =>
      bridge.alphabetIndex ? bridge.alphabetIndex(input) : Promise.resolve([]),
    nowNext: (channelKeys, nowMs, opts) => bridge.nowNext(channelKeys, nowMs, opts),
    epgWindow: (channelKeys, fromMs, toMs, opts) =>
      bridge.epgWindow(channelKeys, fromMs, toMs, opts),
    epgSlice: (sourceId, fromMs, toMs, limit, opts) =>
      bridge.epgSlice ? bridge.epgSlice(sourceId, fromMs, toMs, limit, opts) : Promise.resolve([]),
    channelByNumber: (num, sourceId, opts) => bridge.channelByNumber(num, sourceId, opts),
    seasons: (seriesId, opts?: ParentalQueryOptions) => bridge.seasons(seriesId, opts),
    episodes: (seriesId, season, opts?: ParentalQueryOptions) =>
      bridge.episodes(seriesId, season, opts),
    queryNextEpisode: (
      seriesKey,
      currentItemKey,
      profileId,
      opts?: { readonly parentalUnlocked?: boolean },
    ) => bridge.queryNextEpisode(seriesKey, currentItemKey, profileId, opts),
    resolveStream: (itemKey, opts) => bridge.resolveStream(itemKey, opts),
    saveProgress: (input) =>
      bridge.saveProgress({
        ...input,
        title: sanitizeDisplayText(input.title),
        ...(typeof input.subtitle === 'string'
          ? { subtitle: sanitizeDisplayText(input.subtitle) }
          : {}),
      }),
    setWatched: (itemKey, watched, profileId) => bridge.setWatched(itemKey, watched, profileId),
    getProgress: (itemKey, profileId) => bridge.getProgress(itemKey, profileId),
    listContinueWatching: (limit, profileId, opts) =>
      bridge.listContinueWatching(limit, profileId, opts),
    listProgressByKeys: (itemKeys, profileId) => bridge.listProgressByKeys(itemKeys, profileId),
    listSeriesUnplayedCounts: (seriesKeys, profileId) =>
      bridge.listSeriesUnplayedCounts
        ? bridge.listSeriesUnplayedCounts(seriesKeys, profileId)
        : Promise.resolve([]),
    clearProgress: (itemKey, profileId) => bridge.clearProgress(itemKey, profileId),
    toggleFavorite: (input) =>
      bridge.toggleFavorite({ ...input, title: sanitizeDisplayText(input.title) }),
    setFavorite: (input, active) =>
      bridge.setFavorite({ ...input, title: sanitizeDisplayText(input.title) }, active),
    listFavorites: (limit, profileId, opts) => bridge.listFavorites(limit, profileId, opts),
    listFavoriteKeys: (profileId) => bridge.listFavoriteKeys(profileId),
    getTrackPreference: (scopeKey, profileId) =>
      bridge.getTrackPreference
        ? bridge.getTrackPreference(scopeKey, profileId)
        : Promise.resolve(null),
    saveTrackPreference: (input) =>
      bridge.saveTrackPreference ? bridge.saveTrackPreference(input) : Promise.resolve(),
    clearTrackPreference: (scopeKey, profileId) =>
      bridge.clearTrackPreference
        ? bridge.clearTrackPreference(scopeKey, profileId)
        : Promise.resolve(),
    recordRecentChannel: (itemKey, sourceId, profileId) =>
      bridge.recordRecentChannel
        ? bridge.recordRecentChannel(itemKey, sourceId, profileId)
        : Promise.resolve(),
    listRecentChannels: (limit, profileId, opts) =>
      bridge.listRecentChannels
        ? bridge.listRecentChannels(limit, profileId, opts)
        : Promise.resolve([]),
    listProfiles: () => (bridge.listProfiles ? bridge.listProfiles() : Promise.resolve([])),
    createProfile: (input) =>
      bridge.createProfile
        ? bridge.createProfile({ ...input, name: sanitizeDisplayText(input.name) })
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    updateProfile: (id, patch) =>
      bridge.updateProfile
        ? bridge.updateProfile(id, {
            ...patch,
            ...(patch.name === undefined ? {} : { name: sanitizeDisplayText(patch.name) }),
          })
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    deleteProfile: (id) =>
      bridge.deleteProfile
        ? bridge.deleteProfile(id)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    getParentalSettings: (profileId) =>
      bridge.getParentalSettings
        ? bridge.getParentalSettings(profileId)
        : Promise.resolve({
            profileId: profileId ?? 'default',
            enabled: false,
            blockAdultKeywords: true,
            maxRatingAge: null,
            unlockTimeoutMin: 30,
            updatedAt: 0,
          }),
    updateParentalSettings: (patch, profileId) =>
      bridge.updateParentalSettings
        ? bridge.updateParentalSettings(patch, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    listParentalLocks: (profileId, filter) =>
      bridge.listParentalLocks ? bridge.listParentalLocks(profileId, filter) : Promise.resolve([]),
    setParentalLock: (input, locked) =>
      bridge.setParentalLock
        ? bridge.setParentalLock(input, locked)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    hasParentalPin: (profileId) =>
      bridge.hasParentalPin ? bridge.hasParentalPin(profileId) : Promise.resolve(false),
    setParentalPin: (pin, profileId, currentPin) =>
      bridge.setParentalPin
        ? bridge.setParentalPin(pin, profileId, currentPin)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    verifyParentalPin: (pin, profileId) =>
      bridge.verifyParentalPin
        ? bridge.verifyParentalPin(pin, profileId)
        : Promise.resolve({ ok: false, remainingAttempts: 0 }),
    clearParentalPin: (currentPin, profileId) =>
      bridge.clearParentalPin
        ? bridge.clearParentalPin(currentPin, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    listChannelOverrides: (profileId) =>
      bridge.listChannelOverrides ? bridge.listChannelOverrides(profileId) : Promise.resolve([]),
    setChannelOverride: (input) =>
      bridge.setChannelOverride
        ? bridge.setChannelOverride(input)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    clearChannelOverride: (itemKey, profileId) =>
      bridge.clearChannelOverride
        ? bridge.clearChannelOverride(itemKey, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    reorderChannels: (itemKeys, sourceId, profileId) =>
      bridge.reorderChannels
        ? bridge.reorderChannels(itemKeys, sourceId, profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    listCustomGroups: (profileId, opts) =>
      bridge.listCustomGroups ? bridge.listCustomGroups(profileId, opts) : Promise.resolve([]),
    createCustomGroup: (input) =>
      bridge.createCustomGroup
        ? bridge.createCustomGroup(input)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    updateCustomGroup: (groupId, patch) =>
      bridge.updateCustomGroup
        ? bridge.updateCustomGroup(groupId, patch)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    deleteCustomGroup: (groupId) =>
      bridge.deleteCustomGroup
        ? bridge.deleteCustomGroup(groupId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    setCustomGroupItems: (groupId, items) =>
      bridge.setCustomGroupItems
        ? bridge.setCustomGroupItems(groupId, items)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    addChannelToCustomGroup: (groupId, itemKey, sourceId) =>
      bridge.addChannelToCustomGroup
        ? bridge.addChannelToCustomGroup(groupId, itemKey, sourceId)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    removeChannelFromCustomGroup: (groupId, itemKey) =>
      bridge.removeChannelFromCustomGroup
        ? bridge.removeChannelFromCustomGroup(groupId, itemKey)
        : Promise.resolve(err(elvError('storage', 'unsupported'))),
    flushPendingWrites: () =>
      bridge.flushPendingWrites ? bridge.flushPendingWrites() : Promise.resolve(),
    async close() {
      onClose?.();
      await bridge.close();
    },
  };
}

async function open(): Promise<CatalogService> {
  const bridge = typeof window === 'undefined' ? undefined : window.elv?.catalog;
  if (!bridge) {
    throw new CatalogOpenError(elvError('storage', 'bridge-unavailable'));
  }
  const opened = await bridge.open();
  if (!opened.ok) {
    throw new CatalogOpenError(opened.error);
  }
  return createDesktopCatalogFromBridge(bridge, () => {
    instance = undefined;
  });
}

/**
 * The singleton desktop catalog of this renderer window, backed by the Electron catalog
 * `utilityProcess` over `MessagePort`. A failed open is not cached so the next call retries.
 */
export function createDesktopCatalog(): Promise<CatalogService> {
  instance ??= open().catch((e: unknown) => {
    instance = undefined;
    throw e;
  });
  return instance;
}
