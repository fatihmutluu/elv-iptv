import type { DownloadRecord } from '@elv/domain';
import type { KeyEvent } from '@elv/focus-core';
import { useCallback, useRef, useState } from 'react';
import {
  type DownloadedSeriesGroup,
  LIBRARY_SUB_TABS,
  type LibraryCardItem,
  type LibrarySeeAllState,
  type LibrarySubTab,
  type PartitionedLibraryFavorites,
  type PartitionedLibraryRatings,
} from './library-model';

/** One focusable rail, collection header action row, or active download row in TV D-pad order. */
export interface LibraryNavRailDescriptor {
  readonly id: string;
  readonly kind:
    | 'live'
    | 'vod'
    | 'collection-actions'
    | 'downloaded-movie'
    | 'downloaded-series'
    | 'active-download';
  readonly items?: readonly LibraryCardItem[];
  readonly seriesGroups?: readonly DownloadedSeriesGroup[];
  readonly activeRecord?: DownloadRecord;
  readonly collectionId?: string;
  readonly collectionName?: string;
}

/** Builds the ordered list of TV D-pad focusable rows for the active Library sub-tab. */
export function buildLibraryNavRails(input: {
  readonly activeTab: LibrarySubTab;
  readonly favPartition: PartitionedLibraryFavorites;
  readonly collectionRails: readonly {
    readonly railId: string;
    readonly collectionId: string;
    readonly title: string;
    readonly items: readonly LibraryCardItem[];
  }[];
  readonly ratingPartition: PartitionedLibraryRatings;
  readonly watchedMovieCards: readonly LibraryCardItem[];
  readonly watchedSeriesCards: readonly LibraryCardItem[];
  readonly activeDownloads: readonly DownloadRecord[];
  readonly completedMovieCards: readonly LibraryCardItem[];
  readonly downloadedSeriesGroups: readonly DownloadedSeriesGroup[];
}): readonly LibraryNavRailDescriptor[] {
  if (input.activeTab === 'following') {
    const out: LibraryNavRailDescriptor[] = [];
    if (input.favPartition.live.length > 0)
      out.push({ id: 'live', kind: 'live', items: input.favPartition.live });
    if (input.favPartition.series.length > 0)
      out.push({ id: 'series', kind: 'vod', items: input.favPartition.series });
    if (input.favPartition.movies.length > 0)
      out.push({ id: 'movies', kind: 'vod', items: input.favPartition.movies });
    for (const col of input.collectionRails) {
      out.push({
        id: `collection-actions-${col.collectionId}`,
        kind: 'collection-actions',
        collectionId: col.collectionId,
        collectionName: col.title,
      });
      if (col.items.length > 0) {
        out.push({
          id: col.railId,
          kind: 'vod',
          items: col.items,
          collectionId: col.collectionId,
        });
      }
    }
    return out;
  }
  if (input.activeTab === 'likes') {
    const out: LibraryNavRailDescriptor[] = [];
    if (input.ratingPartition.likedMovies.length > 0)
      out.push({ id: 'liked-movies', kind: 'vod', items: input.ratingPartition.likedMovies });
    if (input.ratingPartition.likedSeries.length > 0)
      out.push({ id: 'liked-series', kind: 'vod', items: input.ratingPartition.likedSeries });
    if (input.ratingPartition.dislikedMovies.length > 0)
      out.push({ id: 'disliked-movies', kind: 'vod', items: input.ratingPartition.dislikedMovies });
    if (input.ratingPartition.dislikedSeries.length > 0)
      out.push({ id: 'disliked-series', kind: 'vod', items: input.ratingPartition.dislikedSeries });
    return out;
  }
  if (input.activeTab === 'watched') {
    const out: LibraryNavRailDescriptor[] = [];
    if (input.watchedMovieCards.length > 0)
      out.push({ id: 'watched-movies', kind: 'vod', items: input.watchedMovieCards });
    if (input.watchedSeriesCards.length > 0)
      out.push({ id: 'watched-series', kind: 'vod', items: input.watchedSeriesCards });
    return out;
  }
  const out: LibraryNavRailDescriptor[] = [];
  for (const rec of input.activeDownloads) {
    out.push({ id: `active-${rec.id}`, kind: 'active-download', activeRecord: rec });
  }
  if (input.completedMovieCards.length > 0) {
    out.push({
      id: 'downloaded-movies',
      kind: 'downloaded-movie',
      items: input.completedMovieCards,
    });
  }
  if (input.downloadedSeriesGroups.length > 0) {
    out.push({
      id: 'downloaded-series',
      kind: 'downloaded-series',
      seriesGroups: input.downloadedSeriesGroups,
    });
  }
  return out;
}

/** Options for {@link useTvLibraryNavigation}. */
export interface UseTvLibraryNavigationOptions {
  readonly activeTab: LibrarySubTab;
  readonly navRails: readonly LibraryNavRailDescriptor[];
  readonly seeAll: LibrarySeeAllState | null;
  readonly seeAllItems: readonly LibraryCardItem[];
  readonly selectedSeriesGroup: DownloadedSeriesGroup | null;
  readonly canCreateCollection?: boolean;
  readonly onOpenCreateCollection?: () => void;
  readonly onRenameCollection?: (collectionId: string, currentName: string) => void;
  readonly onDeleteCollection?: (collectionId: string, name: string) => void;
  readonly onSelectTab: (tab: LibrarySubTab) => void;
  readonly onCloseSeeAll: () => void;
  readonly onSelectSeriesGroup: (groupId: string | null) => void;
  readonly onPressCard: (item: LibraryCardItem) => void;
  readonly onPlayOfflineEpisode: (record: DownloadRecord) => void;
  readonly onTogglePauseResume: (record: DownloadRecord) => void;
  readonly onOpenLiveMenu: (item: LibraryCardItem) => void;
  readonly onOpenVodMenu: (item: LibraryCardItem, currentCollectionId?: string | null) => void;
  readonly onOpenDownloadedMenu: (record: DownloadRecord) => void;
  readonly onOpenActiveMenu: (record: DownloadRecord) => void;
  readonly onFocusTopNav?: (() => void) | undefined;
}

/** TV D-pad focus coordinates and key event handler for {@link LibraryScreen}. */
export function useTvLibraryNavigation({
  activeTab,
  navRails,
  seeAll,
  seeAllItems,
  selectedSeriesGroup,
  canCreateCollection = false,
  onOpenCreateCollection,
  onRenameCollection,
  onDeleteCollection,
  onSelectTab,
  onCloseSeeAll,
  onSelectSeriesGroup,
  onPressCard,
  onPlayOfflineEpisode,
  onTogglePauseResume,
  onOpenLiveMenu,
  onOpenVodMenu,
  onOpenDownloadedMenu,
  onOpenActiveMenu,
  onFocusTopNav,
}: UseTvLibraryNavigationOptions) {
  const [tvZone, setTvZone] = useState<'create-collection' | 'tabs' | 'content'>('tabs');
  const [tvRowIdx, setTvRowIdx] = useState(0);
  const [tvColIdx, setTvColIdx] = useState(0);
  const hasBottomCreate = canCreateCollection && activeTab === 'following';
  const effectiveTvZone =
    tvZone === 'create-collection' && !hasBottomCreate
      ? 'tabs'
      : tvZone === 'content' && navRails.length === 0
        ? 'tabs'
        : tvZone;

  const clampedRowIdx =
    navRails.length === 0 ? 0 : Math.min(Math.max(0, tvRowIdx), navRails.length - 1);

  const tvZoneRef = useRef(effectiveTvZone);
  const tvRowIdxRef = useRef(clampedRowIdx);
  const tvColIdxRef = useRef(tvColIdx);
  tvZoneRef.current = effectiveTvZone;
  tvRowIdxRef.current = clampedRowIdx;
  tvColIdxRef.current = tvColIdx;

  const updateZone = useCallback((next: 'create-collection' | 'tabs' | 'content') => {
    tvZoneRef.current = next;
    setTvZone(next);
  }, []);
  const updateRowIdx = useCallback((next: number) => {
    tvRowIdxRef.current = next;
    setTvRowIdx(next);
  }, []);
  const updateColIdx = useCallback((next: number) => {
    tvColIdxRef.current = next;
    setTvColIdx(next);
  }, []);

  const resetFocus = useCallback(() => {
    updateZone('tabs');
    updateRowIdx(0);
    updateColIdx(0);
  }, [updateColIdx, updateRowIdx, updateZone]);

  const handleTvKey = useCallback(
    (event: KeyEvent): boolean => {
      const currentZone = tvZoneRef.current;
      const currentRowIdx =
        navRails.length === 0 ? 0 : Math.min(Math.max(0, tvRowIdxRef.current), navRails.length - 1);
      const currentColIdx = tvColIdxRef.current;

      const isMenuTrigger =
        (event.kind === 'press' && (event.key === 'menu' || event.key === 'info')) ||
        (event.kind === 'long' && event.key === 'select');

      if (selectedSeriesGroup !== null) {
        if (event.kind === 'press' && event.key === 'back') {
          onSelectSeriesGroup(null);
          return true;
        }
        const eps = selectedSeriesGroup.episodes;
        const idx = eps.length === 0 ? -1 : Math.min(Math.max(0, currentRowIdx), eps.length - 1);
        if (isMenuTrigger && idx >= 0) {
          const ep = eps[idx];
          if (ep) onOpenDownloadedMenu(ep);
          return true;
        }
        if (event.kind !== 'press' && event.kind !== 'repeat') return false;
        if (event.key === 'up') {
          if (idx <= 0) onFocusTopNav?.();
          else updateRowIdx(idx - 1);
          return true;
        }
        if (event.key === 'down' && idx < eps.length - 1) {
          updateRowIdx(idx + 1);
          return true;
        }
        if (event.key === 'select' && idx >= 0) {
          const ep = eps[idx];
          if (ep) onPlayOfflineEpisode(ep);
          return true;
        }
        return false;
      }

      if (seeAll !== null) {
        if (event.kind === 'press' && event.key === 'back') {
          onCloseSeeAll();
          return true;
        }
        const idx =
          seeAllItems.length === 0
            ? -1
            : Math.min(Math.max(0, currentColIdx), seeAllItems.length - 1);
        if (isMenuTrigger && idx >= 0) {
          const item = seeAllItems[idx];
          if (!item) return false;
          if (seeAll.kind === 'live') onOpenLiveMenu(item);
          else if (item.downloadRecord) onOpenDownloadedMenu(item.downloadRecord);
          else if (seeAll.kind !== 'downloaded-series') onOpenVodMenu(item);
          return true;
        }
        if (event.kind !== 'press' && event.kind !== 'repeat') return false;
        if (event.key === 'left' && idx > 0) {
          updateColIdx(idx - 1);
          return true;
        }
        if (event.key === 'right' && idx < seeAllItems.length - 1) {
          updateColIdx(idx + 1);
          return true;
        }
        if (event.key === 'up') {
          if (idx <= 0) onFocusTopNav?.();
          else updateColIdx(Math.max(0, idx - 4));
          return true;
        }
        if (event.key === 'down' && idx < seeAllItems.length - 1) {
          updateColIdx(Math.min(seeAllItems.length - 1, idx + 4));
          return true;
        }
        if (event.key === 'select' && idx >= 0) {
          const item = seeAllItems[idx];
          if (!item) return false;
          if (seeAll.kind === 'downloaded-series') {
            onSelectSeriesGroup(item.id);
            updateRowIdx(0);
          } else {
            onPressCard(item);
          }
          return true;
        }
        return false;
      }

      if (event.kind === 'press' && event.key === 'back') {
        if (currentZone === 'content' || currentZone === 'create-collection') {
          updateZone('tabs');
          return true;
        }
        onFocusTopNav?.();
        return true;
      }

      if (currentZone === 'create-collection') {
        if (event.kind !== 'press' && event.kind !== 'repeat') return false;
        if (event.key === 'up') {
          if (navRails.length > 0) {
            updateZone('content');
            updateRowIdx(navRails.length - 1);
            updateColIdx(0);
          } else {
            updateZone('tabs');
          }
          return true;
        }
        if (event.key === 'down') {
          return true;
        }
        if (event.key === 'select') {
          onOpenCreateCollection?.();
          return true;
        }
        return false;
      }

      if (currentZone === 'tabs') {
        if (event.kind !== 'press' && event.kind !== 'repeat') return false;
        const tabIdx = LIBRARY_SUB_TABS.indexOf(activeTab);
        if (event.key === 'left' && tabIdx > 0) {
          const next = LIBRARY_SUB_TABS[tabIdx - 1];
          if (next) onSelectTab(next);
          return true;
        }
        if (event.key === 'right' && tabIdx < LIBRARY_SUB_TABS.length - 1) {
          const next = LIBRARY_SUB_TABS[tabIdx + 1];
          if (next) onSelectTab(next);
          return true;
        }
        if (event.key === 'up') {
          onFocusTopNav?.();
          return true;
        }
        if (event.key === 'down') {
          if (navRails.length > 0) {
            updateZone('content');
            updateRowIdx(0);
            updateColIdx(0);
            return true;
          }
          if (hasBottomCreate) {
            updateZone('create-collection');
            return true;
          }
        }
        return false;
      }

      const rail = navRails[currentRowIdx];
      if (!rail) return false;
      const railLen =
        rail.kind === 'collection-actions'
          ? 2
          : rail.kind === 'active-download'
            ? 1
            : rail.kind === 'downloaded-series'
              ? (rail.seriesGroups?.length ?? 0)
              : (rail.items?.length ?? 0);
      const col = railLen === 0 ? 0 : Math.min(Math.max(0, currentColIdx), railLen - 1);

      if (isMenuTrigger) {
        if (rail.kind === 'active-download' && rail.activeRecord) {
          onOpenActiveMenu(rail.activeRecord);
          return true;
        }
        if (rail.kind === 'live') {
          const item = rail.items?.[col];
          if (item) onOpenLiveMenu(item);
          return true;
        }
        if (rail.kind === 'vod') {
          const item = rail.items?.[col];
          if (item) onOpenVodMenu(item, rail.collectionId);
          return true;
        }
        if (rail.kind === 'downloaded-movie') {
          const item = rail.items?.[col];
          if (item?.downloadRecord) onOpenDownloadedMenu(item.downloadRecord);
          return true;
        }
        return false;
      }

      if (event.kind !== 'press' && event.kind !== 'repeat') return false;
      if (event.key === 'up') {
        if (currentRowIdx <= 0) {
          updateZone('tabs');
          return true;
        }
        updateRowIdx(currentRowIdx - 1);
        updateColIdx(0);
        return true;
      }
      if (event.key === 'down') {
        if (currentRowIdx < navRails.length - 1) {
          updateRowIdx(currentRowIdx + 1);
          updateColIdx(0);
          return true;
        }
        if (hasBottomCreate) {
          updateZone('create-collection');
          return true;
        }
        return true;
      }
      if (event.key === 'left' && col > 0) {
        updateColIdx(col - 1);
        return true;
      }
      if (event.key === 'right' && col < railLen - 1) {
        updateColIdx(col + 1);
        return true;
      }
      if (event.key === 'select') {
        if (rail.kind === 'collection-actions' && rail.collectionId !== undefined) {
          const colName = rail.collectionName ?? '';
          if (col === 0) onRenameCollection?.(rail.collectionId, colName);
          else onDeleteCollection?.(rail.collectionId, colName);
          return true;
        }
        if (rail.kind === 'active-download' && rail.activeRecord) {
          onTogglePauseResume(rail.activeRecord);
          return true;
        }
        if (rail.kind === 'downloaded-series') {
          const group = rail.seriesGroups?.[col];
          if (group) {
            onSelectSeriesGroup(group.groupId);
            updateRowIdx(0);
          }
          return true;
        }
        const item = rail.items?.[col];
        if (item) onPressCard(item);
        return true;
      }
      return false;
    },
    [
      activeTab,
      hasBottomCreate,
      navRails,
      onCloseSeeAll,
      onDeleteCollection,
      onFocusTopNav,
      onOpenActiveMenu,
      onOpenCreateCollection,
      onOpenDownloadedMenu,
      onOpenLiveMenu,
      onOpenVodMenu,
      onPlayOfflineEpisode,
      onPressCard,
      onRenameCollection,
      onSelectSeriesGroup,
      onSelectTab,
      onTogglePauseResume,
      seeAll,
      seeAllItems,
      selectedSeriesGroup,
      updateColIdx,
      updateRowIdx,
      updateZone,
    ],
  );

  return {
    tvZone: effectiveTvZone,
    tvRowIdx,
    tvColIdx,
    clampedRowIdx,
    resetFocus,
    setTvRowIdx: updateRowIdx,
    handleTvKey,
  };
}
