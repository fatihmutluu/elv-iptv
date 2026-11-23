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
import type { DetailTarget } from './shared';
import type { NavDestination, NavUtility } from './shell';

/** Primary top-level destination tabs (`Home`, `Live`, `Movies`, `Series`). */
export type PrimaryNavTab = 'home' | BrowseKind;

function buildShellDestinations(labels: {
  readonly home: string;
  readonly live: string;
  readonly movies: string;
  readonly series: string;
}): readonly NavDestination<PrimaryNavTab>[] {
  return [
    { id: 'home', label: labels.home, icon: 'home', testID: 'nav-tab-home' },
    { id: 'live', label: labels.live, icon: 'tv', testID: 'nav-tab-live' },
    { id: 'movie', label: labels.movies, icon: 'film', testID: 'nav-tab-movie' },
    { id: 'series', label: labels.series, icon: 'series', testID: 'nav-tab-series' },
  ];
}

function buildShellUtilities(input: {
  readonly searchLabel: string;
  readonly settingsLabel: string;
  readonly activeTab: string;
  readonly hasActiveDetail: boolean;
  readonly onOpenSearch: () => void;
  readonly onOpenSettings: () => void;
}): readonly NavUtility<'search' | 'settings'>[] {
  return [
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
  };
}

/** Builds the canonical 4+2 `AdaptiveNavShell` destinations and utilities in one call. */
export function buildShellNavigation(input: {
  readonly t: AppI18n['t'];
  readonly activeTab: string;
  readonly hasActiveDetail: boolean;
  readonly onOpenSearch: () => void;
  readonly onOpenSettings: () => void;
}) {
  return {
    destinations: buildShellDestinations({
      home: input.t('nav.home'),
      live: input.t('nav.live'),
      movies: input.t('nav.movies'),
      series: input.t('nav.series'),
    }),
    utilities: buildShellUtilities({
      searchLabel: input.t('nav.search'),
      settingsLabel: input.t('nav.settings'),
      activeTab: input.activeTab,
      hasActiveDetail: input.hasActiveDetail,
      onOpenSearch: input.onOpenSearch,
      onOpenSettings: input.onOpenSettings,
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
): CatalogService {
  const c = catalog;
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
    seasons: (seriesId) => c.seasons(seriesId),
    episodes: (seriesId, season) => c.episodes(seriesId, season),
    resolveStream: (itemKey) => c.resolveStream(itemKey),
    ...(c.itemDetail ? { itemDetail: c.itemDetail.bind(c) } : {}),
    ...(c.saveProgress ? { saveProgress: c.saveProgress.bind(c) } : {}),
    ...(c.setWatched ? { setWatched: c.setWatched.bind(c) } : {}),
    ...(c.getProgress ? { getProgress: c.getProgress.bind(c) } : {}),
    ...(c.listContinueWatching ? { listContinueWatching: c.listContinueWatching.bind(c) } : {}),
    ...(c.listProgressByKeys ? { listProgressByKeys: c.listProgressByKeys.bind(c) } : {}),
    ...(c.listSeriesUnplayedCounts
      ? { listSeriesUnplayedCounts: c.listSeriesUnplayedCounts.bind(c) }
      : {}),
    ...(c.clearProgress ? { clearProgress: c.clearProgress.bind(c) } : {}),
    ...(c.toggleFavorite ? { toggleFavorite: c.toggleFavorite.bind(c) } : {}),
    ...(c.setFavorite ? { setFavorite: c.setFavorite.bind(c) } : {}),
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
    close: () => c.close(),
  };
}
