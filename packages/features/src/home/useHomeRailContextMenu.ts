import type { CatalogService, ItemRow, RatingValue, SeriesUnplayedSummary } from '@elv/data';
import type { ContextMenuAnchor } from '@elv/ui-kit';
import { useContextMenu, useI18n } from '@elv/ui-kit';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogUiCache } from '../shared';
import { hasManagedDownload, useDownloads } from '../shared';
import type { HomeRailId } from './HomeRail';
import {
  type BuildHomeCardContextMenuInput,
  buildHomeCardContextMenuItems,
} from './home-context-menu';
import type { HomeRailEntry } from './home-model';

/**
 * Optimistic recent-channel removal state for `HomeScreen`'s unified Live TV rail (`Wave Q7-B`).
 */
export function useHomeRecentChannels(
  recentChannels: readonly ItemRow[] | undefined,
  catalog: CatalogService,
  uiCache: CatalogUiCache | null | undefined,
): {
  readonly visibleRecentChannels: readonly ItemRow[];
  readonly recentChannelKeys: ReadonlySet<string>;
  readonly handleRemoveFromRecent: (entry: HomeRailEntry) => void;
} {
  const [removedKeys, setRemovedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const prevRecentRef = useRef(recentChannels);
  useEffect(() => {
    if (prevRecentRef.current === recentChannels) return;
    prevRecentRef.current = recentChannels;
    setRemovedKeys((prev) => (prev.size === 0 ? prev : new Set()));
  }, [recentChannels]);

  const visibleRecentChannels = useMemo(
    () => (recentChannels ?? []).filter((ch) => !removedKeys.has(ch.key)),
    [recentChannels, removedKeys],
  );
  const recentChannelKeys = useMemo(
    () => new Set(visibleRecentChannels.map((ch) => ch.key)),
    [visibleRecentChannels],
  );

  const handleRemoveFromRecent = useCallback(
    (entry: HomeRailEntry) => {
      if (!catalog.removeRecentChannel) return;
      setRemovedKeys((prev) => new Set(prev).add(entry.itemKey));
      const revert = () =>
        setRemovedKeys((prev) => {
          const next = new Set(prev);
          next.delete(entry.itemKey);
          return next;
        });
      void catalog.removeRecentChannel(entry.itemKey).then((removed) => {
        if (removed) uiCache?.clearHome?.();
        else revert();
      }, revert);
    },
    [catalog, uiCache],
  );

  return { visibleRecentChannels, recentChannelKeys, handleRemoveFromRecent };
}

/** Optional managed-download callbacks used by Home rail context menus (`Wave P5`). */
function buildHomeCardDownloadCallbacks<R>(
  entry: HomeRailEntry,
  downloads: {
    readonly supported: boolean;
    readonly byItemKey: ReadonlyMap<string, R>;
    readonly enqueue: (input: {
      readonly sourceId: string;
      readonly itemKey: string;
      readonly kind: 'movie';
      readonly title: string;
      readonly poster: string | null;
    }) => Promise<unknown>;
    readonly remove: (itemKey: string) => Promise<unknown>;
  },
  hasDownload: (record: R | undefined) => boolean,
): Pick<BuildHomeCardContextMenuInput, 'isDownloaded' | 'onDownload' | 'onDeleteDownload'> {
  if (!downloads.supported || entry.kind !== 'movie') return {};
  return {
    isDownloaded: hasDownload(downloads.byItemKey.get(entry.itemKey)),
    onDownload: (e: HomeRailEntry) => {
      void downloads.enqueue({
        sourceId: e.sourceId,
        itemKey: e.itemKey,
        kind: 'movie',
        title: e.title,
        poster: e.posterUri ?? e.backdropUri ?? null,
      });
    },
    onDeleteDownload: (e: HomeRailEntry) => {
      void downloads.remove(e.itemKey);
    },
  };
}

/** Coordinates Home rail card context menu assembly & display without bloating `HomeScreen.tsx`. */
export function useHomeRailContextMenu(params: {
  readonly catalog: CatalogService;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly watchedOverrides: ReadonlyMap<string, boolean>;
  readonly unplayedBySeriesKey: ReadonlyMap<string, SeriesUnplayedSummary>;
  readonly ratingByKey: ReadonlyMap<string, RatingValue>;
  readonly recentChannelKeys: ReadonlySet<string>;
  readonly onPlay: (entry: HomeRailEntry, index: number) => void;
  readonly onOpenDetail?: (entry: HomeRailEntry) => void;
  readonly onRemoveFromContinue: (entry: HomeRailEntry) => void;
  readonly onRemoveFromRecent: (entry: HomeRailEntry) => void;
  readonly onDismissNewEpisode: (entry: HomeRailEntry) => void;
  readonly onMarkNewEpisodeWatched: (entry: HomeRailEntry) => void;
  readonly onToggleFavorite: (entry: HomeRailEntry) => void;
  readonly onToggleWatched: (entry: HomeRailEntry, currentWatched: boolean) => void;
  readonly onToggleRating: (entry: HomeRailEntry, next: RatingValue) => void;
  readonly onDismissRecommendation: (entry: HomeRailEntry) => void;
  readonly onOpenMultiView?: (entry: HomeRailEntry, index: number) => void;
  readonly onOpenPopout?: (entry: HomeRailEntry, index: number) => void;
}): (railId: HomeRailId, entry: HomeRailEntry, index: number, anchor?: ContextMenuAnchor) => void {
  const i18n = useI18n();
  const contextMenu = useContextMenu();
  const downloads = useDownloads();
  const {
    catalog,
    favoriteKeys,
    watchedOverrides,
    unplayedBySeriesKey,
    ratingByKey,
    recentChannelKeys,
    onPlay,
    onOpenDetail,
    onRemoveFromContinue,
    onRemoveFromRecent,
    onDismissNewEpisode,
    onMarkNewEpisodeWatched,
    onToggleFavorite,
    onToggleWatched,
    onToggleRating,
    onDismissRecommendation,
    onOpenMultiView,
    onOpenPopout,
  } = params;

  return useCallback(
    (railId: HomeRailId, entry: HomeRailEntry, index: number, anchor?: ContextMenuAnchor) => {
      const isFavorite = favoriteKeys.has(entry.itemKey);
      const isWatched =
        watchedOverrides.get(entry.itemKey) ??
        (entry.watched ||
          (entry.kind === 'series' && unplayedBySeriesKey.get(entry.itemKey)?.watched === true));
      const items = buildHomeCardContextMenuItems({
        railId,
        entry,
        index,
        isFavorite,
        isWatched,
        isRecent: recentChannelKeys.has(entry.itemKey),
        currentRating: ratingByKey.get(entry.itemKey) ?? null,
        t: i18n.t,
        onPlay,
        ...(onOpenDetail !== undefined ? { onOpenDetail } : {}),
        onRemoveFromContinue,
        ...(catalog.removeRecentChannel !== undefined ? { onRemoveFromRecent } : {}),
        onDismissNewEpisode,
        onMarkNewEpisodeWatched,
        onToggleFavorite,
        onToggleWatched,
        onToggleRating,
        onDismissRecommendation,
        ...(onOpenMultiView !== undefined ? { onOpenMultiView } : {}),
        ...(onOpenPopout !== undefined ? { onOpenPopout } : {}),
        ...buildHomeCardDownloadCallbacks(entry, downloads, hasManagedDownload),
      });
      if (items.length === 0) return;
      contextMenu.openContextMenu({
        title: entry.title,
        ...(entry.subtitle ? { subtitle: entry.subtitle } : {}),
        ...(anchor !== undefined ? { anchor } : {}),
        items,
      });
    },
    [
      catalog.removeRecentChannel,
      contextMenu,
      downloads,
      favoriteKeys,
      i18n.t,
      onDismissNewEpisode,
      onDismissRecommendation,
      onMarkNewEpisodeWatched,
      onOpenDetail,
      onOpenMultiView,
      onOpenPopout,
      onPlay,
      onRemoveFromContinue,
      onRemoveFromRecent,
      onToggleFavorite,
      onToggleRating,
      onToggleWatched,
      ratingByKey,
      recentChannelKeys,
      unplayedBySeriesKey,
      watchedOverrides,
    ],
  );
}
