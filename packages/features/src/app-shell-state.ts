import type { BrowseKind, CatalogService } from '@elv/data';
import { EMPTY_TAB_MEMORY, type TabBrowseMemory } from './browse';
import { type CatalogTabMemory, EMPTY_CATALOG_MEMORY } from './catalog';
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

/** Clears Live browse memory when its active category belongs to `sourceId`. */
export function clearSourceFromLiveMemory(mem: TabBrowseMemory, sourceId: string): TabBrowseMemory {
  return mem.categoryId?.startsWith(`${sourceId}|`) ? EMPTY_TAB_MEMORY : mem;
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
    ...(c.listFavorites ? { listFavorites: c.listFavorites.bind(c) } : {}),
    ...(c.listFavoriteKeys ? { listFavoriteKeys: c.listFavoriteKeys.bind(c) } : {}),
    ...(c.search ? { search: c.search.bind(c) } : {}),
    close: () => c.close(),
  };
}
