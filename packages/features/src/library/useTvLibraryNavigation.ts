import type { DownloadRecord } from '@elv/domain';
import type { KeyEvent } from '@elv/focus-core';
import { useCallback, useState } from 'react';
import {
  type DownloadedSeriesGroup,
  LIBRARY_SUB_TABS,
  type LibraryCardItem,
  type LibrarySeeAllState,
  type LibrarySubTab,
} from './library-model';

/** One focusable rail or active download row in TV D-pad traversal order. */
export interface LibraryNavRailDescriptor {
  readonly id: string;
  readonly kind: 'live' | 'vod' | 'downloaded-movie' | 'downloaded-series' | 'active-download';
  readonly items?: readonly LibraryCardItem[];
  readonly seriesGroups?: readonly DownloadedSeriesGroup[];
  readonly activeRecord?: DownloadRecord;
}

/** Options for {@link useTvLibraryNavigation}. */
export interface UseTvLibraryNavigationOptions {
  readonly activeTab: LibrarySubTab;
  readonly navRails: readonly LibraryNavRailDescriptor[];
  readonly seeAll: LibrarySeeAllState | null;
  readonly seeAllItems: readonly LibraryCardItem[];
  readonly selectedSeriesGroup: DownloadedSeriesGroup | null;
  readonly onSelectTab: (tab: LibrarySubTab) => void;
  readonly onCloseSeeAll: () => void;
  readonly onSelectSeriesGroup: (groupId: string | null) => void;
  readonly onPressCard: (item: LibraryCardItem) => void;
  readonly onPlayOfflineEpisode: (record: DownloadRecord) => void;
  readonly onTogglePauseResume: (record: DownloadRecord) => void;
  readonly onOpenLiveMenu: (item: LibraryCardItem) => void;
  readonly onOpenVodMenu: (item: LibraryCardItem) => void;
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
  const [tvZone, setTvZone] = useState<'tabs' | 'content'>('tabs');
  const [tvRowIdx, setTvRowIdx] = useState(0);
  const [tvColIdx, setTvColIdx] = useState(0);

  const resetFocus = useCallback(() => {
    setTvRowIdx(0);
    setTvColIdx(0);
  }, []);

  const clampedRowIdx =
    navRails.length === 0 ? 0 : Math.min(Math.max(0, tvRowIdx), navRails.length - 1);

  const handleTvKey = useCallback(
    (event: KeyEvent): boolean => {
      const isMenuTrigger =
        (event.kind === 'press' && (event.key === 'menu' || event.key === 'info')) ||
        (event.kind === 'long' && event.key === 'select');

      if (selectedSeriesGroup !== null) {
        if (event.kind === 'press' && event.key === 'back') {
          onSelectSeriesGroup(null);
          return true;
        }
        const eps = selectedSeriesGroup.episodes;
        const idx = eps.length === 0 ? -1 : Math.min(Math.max(0, tvRowIdx), eps.length - 1);
        if (isMenuTrigger && idx >= 0) {
          const ep = eps[idx];
          if (ep) onOpenDownloadedMenu(ep);
          return true;
        }
        if (event.kind !== 'press' && event.kind !== 'repeat') return false;
        if (event.key === 'up') {
          if (idx <= 0) onFocusTopNav?.();
          else setTvRowIdx(idx - 1);
          return true;
        }
        if (event.key === 'down' && idx < eps.length - 1) {
          setTvRowIdx(idx + 1);
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
          seeAllItems.length === 0 ? -1 : Math.min(Math.max(0, tvColIdx), seeAllItems.length - 1);
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
          setTvColIdx(idx - 1);
          return true;
        }
        if (event.key === 'right' && idx < seeAllItems.length - 1) {
          setTvColIdx(idx + 1);
          return true;
        }
        if (event.key === 'up') {
          if (idx <= 0) onFocusTopNav?.();
          else setTvColIdx(Math.max(0, idx - 4));
          return true;
        }
        if (event.key === 'down' && idx < seeAllItems.length - 1) {
          setTvColIdx(Math.min(seeAllItems.length - 1, idx + 4));
          return true;
        }
        if (event.key === 'select' && idx >= 0) {
          const item = seeAllItems[idx];
          if (!item) return false;
          if (seeAll.kind === 'downloaded-series') {
            onSelectSeriesGroup(item.id);
            setTvRowIdx(0);
          } else {
            onPressCard(item);
          }
          return true;
        }
        return false;
      }

      if (event.kind === 'press' && event.key === 'back') {
        if (tvZone === 'content') {
          setTvZone('tabs');
          return true;
        }
        onFocusTopNav?.();
        return true;
      }

      if (tvZone === 'tabs') {
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
        if (event.key === 'down' && navRails.length > 0) {
          setTvZone('content');
          setTvRowIdx(0);
          setTvColIdx(0);
          return true;
        }
        return false;
      }

      const rail = navRails[clampedRowIdx];
      if (!rail) return false;
      const railLen =
        rail.kind === 'active-download'
          ? 1
          : rail.kind === 'downloaded-series'
            ? (rail.seriesGroups?.length ?? 0)
            : (rail.items?.length ?? 0);
      const col = railLen === 0 ? 0 : Math.min(Math.max(0, tvColIdx), railLen - 1);

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
          if (item) onOpenVodMenu(item);
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
        if (clampedRowIdx <= 0) {
          setTvZone('tabs');
          return true;
        }
        setTvRowIdx(clampedRowIdx - 1);
        setTvColIdx(0);
        return true;
      }
      if (event.key === 'down') {
        if (clampedRowIdx < navRails.length - 1) {
          setTvRowIdx(clampedRowIdx + 1);
          setTvColIdx(0);
        }
        return true;
      }
      if (event.key === 'left' && col > 0) {
        setTvColIdx(col - 1);
        return true;
      }
      if (event.key === 'right' && col < railLen - 1) {
        setTvColIdx(col + 1);
        return true;
      }
      if (event.key === 'select') {
        if (rail.kind === 'active-download' && rail.activeRecord) {
          onTogglePauseResume(rail.activeRecord);
          return true;
        }
        if (rail.kind === 'downloaded-series') {
          const group = rail.seriesGroups?.[col];
          if (group) {
            onSelectSeriesGroup(group.groupId);
            setTvRowIdx(0);
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
      clampedRowIdx,
      navRails,
      onCloseSeeAll,
      onFocusTopNav,
      onOpenActiveMenu,
      onOpenDownloadedMenu,
      onOpenLiveMenu,
      onOpenVodMenu,
      onPlayOfflineEpisode,
      onPressCard,
      onSelectSeriesGroup,
      onSelectTab,
      onTogglePauseResume,
      seeAll,
      seeAllItems,
      selectedSeriesGroup,
      tvColIdx,
      tvRowIdx,
      tvZone,
    ],
  );

  return {
    tvZone,
    tvRowIdx,
    tvColIdx,
    clampedRowIdx,
    resetFocus,
    setTvRowIdx,
    handleTvKey,
  };
}
