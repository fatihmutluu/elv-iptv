import {
  type BrowseKind,
  type CatalogService,
  resolveAccountPoolKey,
  type SourceRow,
} from '@elv/data';
import { type CatalogTabMemory, EMPTY_CATALOG_MEMORY } from './catalog';
import { EMPTY_LIVE_MEMORY, type LiveTabMemory } from './live';
import type { LiveChannelPlaylist, PlayableEntry, PlayTarget } from './ports/play-target';
import type { PlaybackGuard } from './ports/playback-guard';
import type { DetailTarget } from './shared';
import type { NavDestination, NavUtility } from './shell';

/** Primary top-level destination tabs (`Home`, `Live`, `Movies`, `Series`). */
export type PrimaryNavTab = 'home' | BrowseKind;

/** Builds the canonical 4-destination navigation items for `AdaptiveNavShell`. */
export function buildShellDestinations(labels: {
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

/** Builds the canonical 2-utility navigation items (`Search`, `Settings`) for `AdaptiveNavShell`. */
export function buildShellUtilities(input: {
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
    categories: (sourceId, kind) => c.categories(sourceId, kind),
    items: (categoryId, offset, limit) => c.items(categoryId, offset, limit),
    seasons: (seriesId) => c.seasons(seriesId),
    episodes: (seriesId, season) => c.episodes(seriesId, season),
    resolveStream: (itemKey) => c.resolveStream(itemKey),
    ...(c.itemDetail ? { itemDetail: c.itemDetail.bind(c) } : {}),
    ...(c.saveProgress ? { saveProgress: c.saveProgress.bind(c) } : {}),
    ...(c.setWatched ? { setWatched: c.setWatched.bind(c) } : {}),
    ...(c.getProgress ? { getProgress: c.getProgress.bind(c) } : {}),
    ...(c.listContinueWatching ? { listContinueWatching: c.listContinueWatching.bind(c) } : {}),
    ...(c.listProgressByKeys ? { listProgressByKeys: c.listProgressByKeys.bind(c) } : {}),
    ...(c.clearProgress ? { clearProgress: c.clearProgress.bind(c) } : {}),
    ...(c.toggleFavorite ? { toggleFavorite: c.toggleFavorite.bind(c) } : {}),
    ...(c.setFavorite ? { setFavorite: c.setFavorite.bind(c) } : {}),
    ...(c.listFavorites ? { listFavorites: c.listFavorites.bind(c) } : {}),
    ...(c.listFavoriteKeys ? { listFavoriteKeys: c.listFavoriteKeys.bind(c) } : {}),
    ...(c.flushPendingWrites ? { flushPendingWrites: c.flushPendingWrites.bind(c) } : {}),
    ...(c.search ? { search: c.search.bind(c) } : {}),
    ...(c.importGuide ? { importGuide: c.importGuide.bind(c) } : {}),
    ...(c.nowNext ? { nowNext: c.nowNext.bind(c) } : {}),
    ...(c.epgWindow ? { epgWindow: c.epgWindow.bind(c) } : {}),
    ...(c.channelByNumber ? { channelByNumber: c.channelByNumber.bind(c) } : {}),
    close: () => c.close(),
  };
}
