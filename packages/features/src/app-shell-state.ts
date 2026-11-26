import {
  type BrowseKind,
  type CatalogService,
  resolveAccountPoolKey,
  type SourceRow,
} from '@elv/data';
import type { AppI18n } from '@elv/i18n';
import { type CatalogTabMemory, EMPTY_CATALOG_MEMORY } from './catalog';
import { EMPTY_LIVE_MEMORY, type LiveTabMemory } from './live';
import type { LiveChannelPlaylist, PlayableEntry, PlayTarget } from './ports/play-target';
import type { PlaybackGuard } from './ports/playback-guard';
import type { DiagnosticsPort } from './ports/wave-f7b-ports';
import type { DetailTarget } from './shared';
import type { NavDestination, NavUtility } from './shell';

/** Primary top-level destination tabs (`Home`, `Live`, `Movies`, `Series`, `Library`). */
export type PrimaryNavTab = 'home' | BrowseKind | 'library';

/** Top-level shell tab identifier. */
export type AppTab = 'home' | 'live' | 'movie' | 'series' | 'library' | 'search' | 'settings';

function buildShellDestinations(labels: {
  readonly home: string;
  readonly live: string;
  readonly movies: string;
  readonly series: string;
  readonly library: string;
}): readonly NavDestination<PrimaryNavTab>[] {
  return [
    { id: 'home', label: labels.home, icon: 'home', testID: 'nav-tab-home' },
    { id: 'live', label: labels.live, icon: 'tv', testID: 'nav-tab-live' },
    { id: 'movie', label: labels.movies, icon: 'film', testID: 'nav-tab-movie' },
    { id: 'series', label: labels.series, icon: 'series', testID: 'nav-tab-series' },
    { id: 'library', label: labels.library, icon: 'library', testID: 'nav-tab-library' },
  ];
}

function buildShellUtilities(input: {
  readonly searchLabel: string;
  readonly settingsLabel: string;
  readonly activeTab: string;
  readonly hasActiveDetail: boolean;
  readonly onOpenSearch: () => void;
  readonly onOpenSettings: () => void;
  readonly profileUtility?: NavUtility;
}): readonly NavUtility[] {
  const list: NavUtility[] = [
    {
      id: 'search',
      label: input.searchLabel,
      icon: 'search',
      active: input.activeTab === 'search' && !input.hasActiveDetail,
      showLabel: false,
      testID: 'nav-tab-search',
      onPress: input.onOpenSearch,
    },
    {
      id: 'settings',
      label: input.settingsLabel,
      icon: 'settings',
      active: input.activeTab === 'settings',
      showLabel: false,
      testID: 'nav-tab-settings',
      onPress: input.onOpenSettings,
    },
  ];
  if (input.profileUtility !== undefined) {
    list.push(input.profileUtility);
  }
  return list;
}

/** Per-tab discovery memory for Movies and Series tabs. */
export type CatalogMemoryMap = Readonly<Record<'movie' | 'series', CatalogTabMemory>>;

const MAX_DETAIL_STACK = 10;

export const INITIAL_CATALOG_MEMORY: CatalogMemoryMap = {
  movie: EMPTY_CATALOG_MEMORY,
  series: EMPTY_CATALOG_MEMORY,
};

function channelKeyMatchesSource(key: string | null, sourceId: string): boolean {
  if (key === null) return false;
  return key.split(':')[1] === sourceId;
}

/** Clears Live hub memory when its active category or active channel belongs to `sourceId`. */
export function clearSourceFromLiveMemory(mem: LiveTabMemory, sourceId: string): LiveTabMemory {
  if (
    mem.categoryId?.startsWith(`${sourceId}|`) ||
    channelKeyMatchesSource(mem.activeChannelKey, sourceId)
  ) {
    return EMPTY_LIVE_MEMORY;
  }
  if (channelKeyMatchesSource(mem.previousChannelKey, sourceId)) {
    return { ...mem, previousChannelKey: null };
  }
  return mem;
}

/** Clears Movies/Series discovery memory when the selected category belongs to `sourceId`. */
export function clearSourceFromCatalogMemory(
  map: CatalogMemoryMap,
  sourceId: string,
): CatalogMemoryMap {
  const prefix = `${sourceId}|`;
  const clean = (mem: CatalogTabMemory): CatalogTabMemory =>
    mem.selectedCategoryId?.startsWith(prefix) ? EMPTY_CATALOG_MEMORY : mem;
  return { movie: clean(map.movie), series: clean(map.series) };
}

/** Pushes `target` onto the bounded detail stack, dropping the oldest entry beyond depth 10. */
export function pushDetailStack(
  stack: readonly DetailTarget[],
  target: DetailTarget,
): readonly DetailTarget[] {
  const next = [...stack, target];
  return next.length > MAX_DETAIL_STACK ? next.slice(next.length - MAX_DETAIL_STACK) : next;
}

/** Default confirmation window (ms) for TV root Back-to-exit (`#55`). */
export const DEFAULT_EXIT_BACK_CONFIRM_MS = 2_500;

/** Pure stateful guard for 2-step Back-to-exit confirmation (`#55`, zero `#425` Back-trap). */
export interface ExitBackConfirmGuard {
  /**
   * Evaluates a root-level Back press. Returns `true` on the first press when enabled
   * (arming the toast window), or `false` when disabled or pressed again within the window.
   */
  onRootBack(enabled: boolean): boolean;
  /** Disarms any pending confirmation window and hides the toast immediately. */
  reset(): void;
  /** Cancels any pending timer on unmount without invoking visibility listeners. */
  dispose(): void;
}

/**
 * Creates a bounded 2-step Back-to-exit confirmation guard (`#55`) so users never accidentally
 * quit on a single remote press while guaranteeing a second Back press exits cleanly (`#425`).
 */
export function createExitBackConfirmGuard(
  windowMs = DEFAULT_EXIT_BACK_CONFIRM_MS,
  deps?: {
    readonly onVisibleChange?: (visible: boolean) => void;
    readonly setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    readonly clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
  },
): ExitBackConfirmGuard {
  const safeWindowMs =
    Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_EXIT_BACK_CONFIRM_MS;
  const setTimer =
    deps?.setTimeoutFn ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearTimer =
    deps?.clearTimeoutFn ??
    ((handle: ReturnType<typeof setTimeout>) => {
      globalThis.clearTimeout(handle);
    });

  let armed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancelTimer = (): void => {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  };

  const setArmed = (next: boolean): void => {
    if (armed === next) return;
    armed = next;
    deps?.onVisibleChange?.(next);
  };

  return {
    onRootBack(enabled: boolean): boolean {
      if (!enabled) {
        cancelTimer();
        setArmed(false);
        return false;
      }
      if (armed) {
        cancelTimer();
        setArmed(false);
        return false;
      }
      setArmed(true);
      timer = setTimer(() => {
        timer = undefined;
        setArmed(false);
      }, safeWindowMs);
      return true;
    },
    reset(): void {
      cancelTimer();
      setArmed(false);
    },
    dispose(): void {
      cancelTimer();
      armed = false;
    },
  };
}

/**
 * Resolves TV top-nav `Back` presses in `AppShell` (`#425`, `#55`): pops any active detail overlay,
 * returns secondary tabs to `'home'` (keeping top-nav focused), or delegates root `'home'` Back
 * to `onRootHomeBack` (defaulting to `false` so Android TV exits cleanly to the system launcher).
 */
export function handleShellTopNavBack(input: {
  readonly activeTab: string;
  readonly hasActiveDetail: boolean;
  readonly popDetail: () => void;
  readonly exitNavFocus: () => void;
  readonly selectHomeInTopNav: () => void;
  readonly onRootHomeBack?: () => boolean;
}): boolean {
  if (input.hasActiveDetail) {
    input.popDetail();
    input.exitNavFocus();
    return true;
  }
  if (input.activeTab !== 'home') {
    input.selectHomeInTopNav();
    return true;
  }
  return input.onRootHomeBack ? input.onRootHomeBack() : false;
}

/** Builds the `CrashRecoveryBoundary` recovery handlers shared by `AppShell` stage & player trees. */
export function buildShellCrashProps(input: {
  readonly stageKey: number;
  readonly bumpStageKey: () => void;
  readonly clearCaches: () => void;
  readonly switchSource: () => void;
  readonly crashReportsOptIn?: boolean;
  readonly crashReportsIncludeLogs?: boolean;
  readonly diagnostics?: DiagnosticsPort;
  readonly onToggleIncludeLogs?: (next: boolean) => void;
}) {
  return {
    remountKey: input.stageKey,
    onReload: input.bumpStageKey,
    onClearUiCache: () => {
      input.clearCaches();
      input.bumpStageKey();
    },
    onSwitchSource: () => {
      input.switchSource();
      input.bumpStageKey();
    },
    ...(input.crashReportsOptIn !== undefined
      ? { crashReportsOptIn: input.crashReportsOptIn }
      : {}),
    ...(input.crashReportsIncludeLogs !== undefined
      ? { crashReportsIncludeLogs: input.crashReportsIncludeLogs }
      : {}),
    ...(input.diagnostics !== undefined ? { diagnostics: input.diagnostics } : {}),
    ...(input.onToggleIncludeLogs !== undefined
      ? { onToggleIncludeLogs: input.onToggleIncludeLogs }
      : {}),
  };
}

/** Builds the canonical 5+2 `AdaptiveNavShell` destinations and utilities in one call. */
export function buildShellNavigation(input: {
  readonly t: AppI18n['t'];
  readonly activeTab: string;
  readonly hasActiveDetail: boolean;
  readonly onOpenSearch: () => void;
  readonly onOpenSettings: () => void;
  readonly profileUtility?: NavUtility;
}) {
  return {
    destinations: buildShellDestinations({
      home: input.t('nav.home'),
      live: input.t('nav.live'),
      movies: input.t('nav.movies'),
      series: input.t('nav.series'),
      library: input.t('nav.library'),
    }),
    utilities: buildShellUtilities({
      searchLabel: input.t('nav.search'),
      settingsLabel: input.t('nav.settings'),
      activeTab: input.activeTab,
      hasActiveDetail: input.hasActiveDetail,
      onOpenSearch: input.onOpenSearch,
      onOpenSettings: input.onOpenSettings,
      ...(input.profileUtility !== undefined ? { profileUtility: input.profileUtility } : {}),
    }),
  };
}

const rawPlaylistOf = new WeakMap<LiveChannelPlaylist, LiveChannelPlaylist>();

function enrichPlayableEntryAccountKey<T extends PlayableEntry>(
  entry: T,
  byId: ReadonlyMap<string, SourceRow>,
): T {
  if (entry.accountKey !== undefined) return entry;
  const source = byId.get(entry.sourceId);
  if (source === undefined) return entry;
  return { ...entry, accountKey: resolveAccountPoolKey(source) };
}

/**
 * Enriches a {@link PlayTarget} (including `previousChannel`, `nextEpisodes`, and lazy
 * `playlist.getAt` results) with each source's credential-fingerprint pool key (#265) while
 * preserving any explicit `accountKey` already set.
 */
export function enrichPlayTargetAccountKey(
  target: PlayTarget,
  sources: readonly SourceRow[],
): PlayTarget {
  if (sources.length === 0) return target;
  const byId = new Map<string, SourceRow>();
  for (const s of sources) byId.set(s.id, s);

  const enrichedBase = enrichPlayableEntryAccountKey(target, byId);
  const enrichedCatchup =
    target.catchup !== undefined
      ? {
          ...target.catchup,
          liveTarget: enrichPlayableEntryAccountKey(target.catchup.liveTarget, byId),
        }
      : undefined;
  const enrichedPrev =
    target.previousChannel !== undefined
      ? enrichPlayableEntryAccountKey(target.previousChannel, byId)
      : undefined;
  const enrichedNext =
    target.nextEpisodes !== undefined
      ? target.nextEpisodes.map((ep) => enrichPlayableEntryAccountKey(ep, byId))
      : undefined;

  let enrichedPlaylist: LiveChannelPlaylist | undefined;
  if (target.playlist !== undefined) {
    const basePlaylist = rawPlaylistOf.get(target.playlist) ?? target.playlist;
    const currentIndex = target.playlist.currentIndex;
    enrichedPlaylist = {
      count: basePlaylist.count,
      currentIndex,
      onChangeIndex: (index) => basePlaylist.onChangeIndex(index),
      getAt: async (index) => {
        const entry = await basePlaylist.getAt(index);
        return entry === undefined ? undefined : enrichPlayableEntryAccountKey(entry, byId);
      },
    };
    rawPlaylistOf.set(enrichedPlaylist, basePlaylist);
  }

  return {
    ...enrichedBase,
    ...(enrichedCatchup !== undefined ? { catchup: enrichedCatchup } : {}),
    ...(enrichedPlaylist !== undefined ? { playlist: enrichedPlaylist } : {}),
    ...(enrichedNext !== undefined ? { nextEpisodes: enrichedNext } : {}),
    ...(enrichedPrev !== undefined ? { previousChannel: enrichedPrev } : {}),
  };
}

/** Wraps `catalog` so source mutations stop playback and trigger shell source reconciliation. */
export function createObservedCatalog(
  catalog: CatalogService,
  playbackGuard: PlaybackGuard,
  syncSourcesAndBump: () => Promise<void>,
  onUserStateMutated?: () => void,
): CatalogService {
  const c = catalog;
  const wrapUserStateMutation = <Args extends unknown[], R extends { readonly ok: boolean }>(
    fn: ((...args: Args) => Promise<R>) | undefined,
  ): ((...args: Args) => Promise<R>) | undefined => {
    if (fn === undefined) return undefined;
    return async (...args: Args) => {
      const res = await fn.apply(c, args);
      if (res.ok) onUserStateMutated?.();
      return res;
    };
  };
  const createCollection = wrapUserStateMutation(c.createCollection);
  const renameCollection = wrapUserStateMutation(c.renameCollection);
  const reorderCollections = wrapUserStateMutation(c.reorderCollections);
  const deleteCollection = wrapUserStateMutation(c.deleteCollection);
  const addItemToCollection = wrapUserStateMutation(c.addItemToCollection);
  const removeItemFromCollection = wrapUserStateMutation(c.removeItemFromCollection);
  const reorderCollectionItems = wrapUserStateMutation(c.reorderCollectionItems);
  return {
    addSource: async (input) => {
      const res = await c.addSource(input);
      if (res.ok) await syncSourcesAndBump();
      return res;
    },
    addSourceFromLink: async (input) => {
      const res = await c.addSourceFromLink(input);
      if (res.ok) await syncSourcesAndBump();
      return res;
    },
    ...(c.addLocalM3uSource
      ? {
          addLocalM3uSource: async (
            input: Parameters<NonNullable<CatalogService['addLocalM3uSource']>>[0],
          ) => {
            const fn = c.addLocalM3uSource;
            if (fn === undefined) throw new Error('addLocalM3uSource unavailable');
            const res = await fn.call(c, input);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.discoverSourceCategories
      ? { discoverSourceCategories: c.discoverSourceCategories.bind(c) }
      : {}),
    ...(c.updateSourceSettings
      ? {
          updateSourceSettings: async (
            sourceId: Parameters<NonNullable<CatalogService['updateSourceSettings']>>[0],
            patch: Parameters<NonNullable<CatalogService['updateSourceSettings']>>[1],
          ) => {
            const fn = c.updateSourceSettings;
            if (fn === undefined) return;
            await fn.call(c, sourceId, patch);
            await syncSourcesAndBump();
          },
        }
      : {}),
    removeSource: async (id) => {
      await playbackGuard.stopIfUsingSource(id);
      const res = await c.removeSource(id);
      if (res.ok) await syncSourcesAndBump();
      return res;
    },
    importSource: async (id, opts) => {
      const res = await c.importSource(id, opts);
      await syncSourcesAndBump();
      return res;
    },
    listSources: () => c.listSources(),
    categories: (sourceId, kind, opts) => c.categories(sourceId, kind, opts),
    items: (categoryId, offset, limit, opts) => c.items(categoryId, offset, limit, opts),
    ...(c.liveVariants ? { liveVariants: c.liveVariants.bind(c) } : {}),
    ...(c.itemVersions ? { itemVersions: c.itemVersions.bind(c) } : {}),
    ...(c.allSourcesItems ? { allSourcesItems: c.allSourcesItems.bind(c) } : {}),
    seasons: (seriesId, opts) => c.seasons(seriesId, opts),
    episodes: (seriesId, season, opts) => c.episodes(seriesId, season, opts),
    resolveStream: (itemKey, opts) => c.resolveStream(itemKey, opts),
    ...(c.resolveCatchupStream ? { resolveCatchupStream: c.resolveCatchupStream.bind(c) } : {}),
    ...(c.fetchChannelArchiveEpg
      ? { fetchChannelArchiveEpg: c.fetchChannelArchiveEpg.bind(c) }
      : {}),
    ...(c.listGuideSources ? { listGuideSources: c.listGuideSources.bind(c) } : {}),
    ...(c.addGuideSource
      ? {
          addGuideSource: async (
            input: Parameters<NonNullable<CatalogService['addGuideSource']>>[0],
          ) => {
            const fn = c.addGuideSource;
            if (fn === undefined) throw new Error('addGuideSource unavailable');
            const res = await fn.call(c, input);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.updateGuideSource
      ? {
          updateGuideSource: async (
            id: Parameters<NonNullable<CatalogService['updateGuideSource']>>[0],
            patch: Parameters<NonNullable<CatalogService['updateGuideSource']>>[1],
          ) => {
            const fn = c.updateGuideSource;
            if (fn === undefined) throw new Error('updateGuideSource unavailable');
            const res = await fn.call(c, id, patch);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.removeGuideSource
      ? {
          removeGuideSource: async (
            id: Parameters<NonNullable<CatalogService['removeGuideSource']>>[0],
          ) => {
            const fn = c.removeGuideSource;
            if (fn === undefined) throw new Error('removeGuideSource unavailable');
            const res = await fn.call(c, id);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.reorderGuideSources
      ? {
          reorderGuideSources: async (
            sourceId: Parameters<NonNullable<CatalogService['reorderGuideSources']>>[0],
            orderedIds: Parameters<NonNullable<CatalogService['reorderGuideSources']>>[1],
          ) => {
            const fn = c.reorderGuideSources;
            if (fn === undefined) throw new Error('reorderGuideSources unavailable');
            const res = await fn.call(c, sourceId, orderedIds);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.listGuideChannels ? { listGuideChannels: c.listGuideChannels.bind(c) } : {}),
    ...(c.listChannelGuideOverrides
      ? { listChannelGuideOverrides: c.listChannelGuideOverrides.bind(c) }
      : {}),
    ...(c.setChannelGuideOverride
      ? {
          setChannelGuideOverride: async (
            input: Parameters<NonNullable<CatalogService['setChannelGuideOverride']>>[0],
          ) => {
            const fn = c.setChannelGuideOverride;
            if (fn === undefined) throw new Error('setChannelGuideOverride unavailable');
            const res = await fn.call(c, input);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.clearChannelGuideOverride
      ? {
          clearChannelGuideOverride: async (
            sourceId: Parameters<NonNullable<CatalogService['clearChannelGuideOverride']>>[0],
            channelKey: Parameters<NonNullable<CatalogService['clearChannelGuideOverride']>>[1],
          ) => {
            const fn = c.clearChannelGuideOverride;
            if (fn === undefined) throw new Error('clearChannelGuideOverride unavailable');
            const res = await fn.call(c, sourceId, channelKey);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.listReminders ? { listReminders: c.listReminders.bind(c) } : {}),
    ...(c.upsertReminder ? { upsertReminder: c.upsertReminder.bind(c) } : {}),
    ...(c.removeReminder ? { removeReminder: c.removeReminder.bind(c) } : {}),
    ...(c.markReminderFired ? { markReminderFired: c.markReminderFired.bind(c) } : {}),
    ...(c.pruneExpiredReminders ? { pruneExpiredReminders: c.pruneExpiredReminders.bind(c) } : {}),
    ...(c.itemDetail ? { itemDetail: c.itemDetail.bind(c) } : {}),
    ...(c.saveProgress ? { saveProgress: c.saveProgress.bind(c) } : {}),
    ...(c.setWatched ? { setWatched: c.setWatched.bind(c) } : {}),
    ...(c.getProgress ? { getProgress: c.getProgress.bind(c) } : {}),
    ...(c.listContinueWatching ? { listContinueWatching: c.listContinueWatching.bind(c) } : {}),
    ...(c.listWatched ? { listWatched: c.listWatched.bind(c) } : {}),
    ...(c.listProgressByKeys ? { listProgressByKeys: c.listProgressByKeys.bind(c) } : {}),
    ...(c.listSeriesUnplayedCounts
      ? { listSeriesUnplayedCounts: c.listSeriesUnplayedCounts.bind(c) }
      : {}),
    ...(c.listMyListNewEpisodes ? { listMyListNewEpisodes: c.listMyListNewEpisodes.bind(c) } : {}),
    ...(c.dismissMyListNewEpisode
      ? { dismissMyListNewEpisode: c.dismissMyListNewEpisode.bind(c) }
      : {}),
    ...(c.refreshMyListNewEpisodes
      ? { refreshMyListNewEpisodes: c.refreshMyListNewEpisodes.bind(c) }
      : {}),
    ...(c.clearProgress ? { clearProgress: c.clearProgress.bind(c) } : {}),
    ...(c.toggleFavorite ? { toggleFavorite: c.toggleFavorite.bind(c) } : {}),
    ...(c.setFavorite ? { setFavorite: c.setFavorite.bind(c) } : {}),
    ...(c.reorderFavorites ? { reorderFavorites: c.reorderFavorites.bind(c) } : {}),
    ...(c.listFavorites ? { listFavorites: c.listFavorites.bind(c) } : {}),
    ...(c.listFavoriteKeys ? { listFavoriteKeys: c.listFavoriteKeys.bind(c) } : {}),
    ...(c.flushPendingWrites ? { flushPendingWrites: c.flushPendingWrites.bind(c) } : {}),
    ...(c.search ? { search: c.search.bind(c) } : {}),
    ...(c.searchSuggestions ? { searchSuggestions: c.searchSuggestions.bind(c) } : {}),
    ...(c.alphabetIndex ? { alphabetIndex: c.alphabetIndex.bind(c) } : {}),
    ...(c.epgSlice ? { epgSlice: c.epgSlice.bind(c) } : {}),
    ...(c.importGuide
      ? {
          importGuide: async (
            id: Parameters<NonNullable<CatalogService['importGuide']>>[0],
            opts?: Parameters<NonNullable<CatalogService['importGuide']>>[1],
          ) => {
            const fn = c.importGuide;
            if (fn === undefined) throw new Error('importGuide unavailable');
            const res = await fn.call(c, id, opts);
            await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.latestImportHealth ? { latestImportHealth: c.latestImportHealth.bind(c) } : {}),
    ...(c.nowNext ? { nowNext: c.nowNext.bind(c) } : {}),
    ...(c.epgWindow ? { epgWindow: c.epgWindow.bind(c) } : {}),
    ...(c.channelByNumber ? { channelByNumber: c.channelByNumber.bind(c) } : {}),
    ...(c.queryNextEpisode ? { queryNextEpisode: c.queryNextEpisode.bind(c) } : {}),
    ...(c.getTrackPreference ? { getTrackPreference: c.getTrackPreference.bind(c) } : {}),
    ...(c.saveTrackPreference ? { saveTrackPreference: c.saveTrackPreference.bind(c) } : {}),
    ...(c.clearTrackPreference ? { clearTrackPreference: c.clearTrackPreference.bind(c) } : {}),
    ...(c.recordRecentChannel ? { recordRecentChannel: c.recordRecentChannel.bind(c) } : {}),
    ...(c.listRecentChannels ? { listRecentChannels: c.listRecentChannels.bind(c) } : {}),
    ...(c.listProfiles ? { listProfiles: c.listProfiles.bind(c) } : {}),
    ...(c.createProfile ? { createProfile: c.createProfile.bind(c) } : {}),
    ...(c.updateProfile ? { updateProfile: c.updateProfile.bind(c) } : {}),
    ...(c.deleteProfile ? { deleteProfile: c.deleteProfile.bind(c) } : {}),
    ...(c.getParentalSettings ? { getParentalSettings: c.getParentalSettings.bind(c) } : {}),
    ...(c.updateParentalSettings
      ? { updateParentalSettings: c.updateParentalSettings.bind(c) }
      : {}),
    ...(c.listParentalLocks ? { listParentalLocks: c.listParentalLocks.bind(c) } : {}),
    ...(c.setParentalLock ? { setParentalLock: c.setParentalLock.bind(c) } : {}),
    ...(c.hasParentalPin ? { hasParentalPin: c.hasParentalPin.bind(c) } : {}),
    ...(c.setParentalPin ? { setParentalPin: c.setParentalPin.bind(c) } : {}),
    ...(c.verifyParentalPin ? { verifyParentalPin: c.verifyParentalPin.bind(c) } : {}),
    ...(c.clearParentalPin ? { clearParentalPin: c.clearParentalPin.bind(c) } : {}),
    ...(c.listChannelOverrides ? { listChannelOverrides: c.listChannelOverrides.bind(c) } : {}),
    ...(c.setChannelOverride
      ? {
          setChannelOverride: async (
            input: Parameters<NonNullable<CatalogService['setChannelOverride']>>[0],
          ) => {
            const fn = c.setChannelOverride;
            if (fn === undefined) throw new Error('setChannelOverride unavailable');
            const res = await fn.call(c, input);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.clearChannelOverride
      ? {
          clearChannelOverride: async (
            itemKey: Parameters<NonNullable<CatalogService['clearChannelOverride']>>[0],
            profileId?: Parameters<NonNullable<CatalogService['clearChannelOverride']>>[1],
          ) => {
            const fn = c.clearChannelOverride;
            if (fn === undefined) throw new Error('clearChannelOverride unavailable');
            const res = await fn.call(c, itemKey, profileId);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.reorderChannels
      ? {
          reorderChannels: async (
            itemKeys: Parameters<NonNullable<CatalogService['reorderChannels']>>[0],
            sourceId: Parameters<NonNullable<CatalogService['reorderChannels']>>[1],
            profileId?: Parameters<NonNullable<CatalogService['reorderChannels']>>[2],
          ) => {
            const fn = c.reorderChannels;
            if (fn === undefined) throw new Error('reorderChannels unavailable');
            const res = await fn.call(c, itemKeys, sourceId, profileId);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.listCustomGroups ? { listCustomGroups: c.listCustomGroups.bind(c) } : {}),
    ...(c.createCustomGroup
      ? {
          createCustomGroup: async (
            input: Parameters<NonNullable<CatalogService['createCustomGroup']>>[0],
          ) => {
            const fn = c.createCustomGroup;
            if (fn === undefined) throw new Error('createCustomGroup unavailable');
            const res = await fn.call(c, input);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.updateCustomGroup
      ? {
          updateCustomGroup: async (
            groupId: Parameters<NonNullable<CatalogService['updateCustomGroup']>>[0],
            patch: Parameters<NonNullable<CatalogService['updateCustomGroup']>>[1],
          ) => {
            const fn = c.updateCustomGroup;
            if (fn === undefined) throw new Error('updateCustomGroup unavailable');
            const res = await fn.call(c, groupId, patch);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.deleteCustomGroup
      ? {
          deleteCustomGroup: async (
            groupId: Parameters<NonNullable<CatalogService['deleteCustomGroup']>>[0],
          ) => {
            const fn = c.deleteCustomGroup;
            if (fn === undefined) throw new Error('deleteCustomGroup unavailable');
            const res = await fn.call(c, groupId);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.setCustomGroupItems
      ? {
          setCustomGroupItems: async (
            groupId: Parameters<NonNullable<CatalogService['setCustomGroupItems']>>[0],
            items: Parameters<NonNullable<CatalogService['setCustomGroupItems']>>[1],
          ) => {
            const fn = c.setCustomGroupItems;
            if (fn === undefined) throw new Error('setCustomGroupItems unavailable');
            const res = await fn.call(c, groupId, items);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.addChannelToCustomGroup
      ? {
          addChannelToCustomGroup: async (
            groupId: Parameters<NonNullable<CatalogService['addChannelToCustomGroup']>>[0],
            itemKey: Parameters<NonNullable<CatalogService['addChannelToCustomGroup']>>[1],
            sourceId: Parameters<NonNullable<CatalogService['addChannelToCustomGroup']>>[2],
          ) => {
            const fn = c.addChannelToCustomGroup;
            if (fn === undefined) throw new Error('addChannelToCustomGroup unavailable');
            const res = await fn.call(c, groupId, itemKey, sourceId);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.removeChannelFromCustomGroup
      ? {
          removeChannelFromCustomGroup: async (
            groupId: Parameters<NonNullable<CatalogService['removeChannelFromCustomGroup']>>[0],
            itemKey: Parameters<NonNullable<CatalogService['removeChannelFromCustomGroup']>>[1],
          ) => {
            const fn = c.removeChannelFromCustomGroup;
            if (fn === undefined) throw new Error('removeChannelFromCustomGroup unavailable');
            const res = await fn.call(c, groupId, itemKey);
            if (res.ok) await syncSourcesAndBump();
            return res;
          },
        }
      : {}),
    ...(c.getVodEnrichment ? { getVodEnrichment: c.getVodEnrichment.bind(c) } : {}),
    ...(c.enrichVodItem ? { enrichVodItem: c.enrichVodItem.bind(c) } : {}),
    ...(c.listCollections ? { listCollections: c.listCollections.bind(c) } : {}),
    ...(createCollection ? { createCollection } : {}),
    ...(renameCollection ? { renameCollection } : {}),
    ...(reorderCollections ? { reorderCollections } : {}),
    ...(deleteCollection ? { deleteCollection } : {}),
    ...(c.listCollectionItems ? { listCollectionItems: c.listCollectionItems.bind(c) } : {}),
    ...(c.listCollectionsForItem
      ? { listCollectionsForItem: c.listCollectionsForItem.bind(c) }
      : {}),
    ...(addItemToCollection ? { addItemToCollection } : {}),
    ...(removeItemFromCollection ? { removeItemFromCollection } : {}),
    ...(reorderCollectionItems ? { reorderCollectionItems } : {}),
    ...(c.listDownloads ? { listDownloads: c.listDownloads.bind(c) } : {}),
    ...(c.getDownload ? { getDownload: c.getDownload.bind(c) } : {}),
    ...(c.upsertDownload ? { upsertDownload: c.upsertDownload.bind(c) } : {}),
    ...(c.deleteDownload ? { deleteDownload: c.deleteDownload.bind(c) } : {}),
    ...(c.setRating ? { setRating: c.setRating.bind(c) } : {}),
    ...(c.getRating ? { getRating: c.getRating.bind(c) } : {}),
    ...(c.listRatings ? { listRatings: c.listRatings.bind(c) } : {}),
    ...(c.listRatingMap ? { listRatingMap: c.listRatingMap.bind(c) } : {}),
    close: () => c.close(),
  };
}
