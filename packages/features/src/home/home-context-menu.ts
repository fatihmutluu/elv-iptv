import type { CatalogService, ItemRow, RatingValue } from '@elv/data';
import type { AppI18n } from '@elv/i18n';
import type { ContextMenuItem } from '@elv/ui-kit';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogUiCache } from '../shared';
import type { HomeRailId } from './HomeRail';
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

/** Input for {@link buildHomeCardContextMenuItems}. */
export interface BuildHomeCardContextMenuInput {
  readonly railId: HomeRailId;
  readonly entry: HomeRailEntry;
  readonly index: number;
  readonly isFavorite: boolean;
  readonly isWatched: boolean;
  readonly isRecent?: boolean;
  readonly currentRating?: RatingValue | null;
  readonly isDownloaded?: boolean;
  readonly t: AppI18n['t'];
  readonly onPlay: (entry: HomeRailEntry, index: number) => void;
  readonly onOpenDetail?: (entry: HomeRailEntry) => void;
  readonly onRemoveFromContinue?: (entry: HomeRailEntry) => void;
  readonly onRemoveFromRecent?: (entry: HomeRailEntry) => void;
  readonly onDismissNewEpisode?: (entry: HomeRailEntry) => void;
  readonly onMarkNewEpisodeWatched?: (entry: HomeRailEntry) => void;
  readonly onToggleFavorite?: (entry: HomeRailEntry) => void;
  readonly onToggleWatched?: (entry: HomeRailEntry, currentWatched: boolean) => void;
  readonly onToggleRating?: (entry: HomeRailEntry, next: RatingValue) => void;
  readonly onOpenMultiView?: (entry: HomeRailEntry, index: number) => void;
  readonly onOpenPopout?: (entry: HomeRailEntry, index: number) => void;
  readonly onDownload?: (entry: HomeRailEntry) => void;
  readonly onDeleteDownload?: (entry: HomeRailEntry) => void;
}

/**
 * Builds universal right-click / long-press context menu actions for a Home screen card
 * across Continue Watching, unified Live TV, My List, Movies, Series, and Collections rails.
 */
export function buildHomeCardContextMenuItems({
  railId,
  entry,
  index,
  isFavorite,
  isWatched,
  isRecent = false,
  currentRating = null,
  isDownloaded = false,
  t,
  onPlay,
  onOpenDetail,
  onRemoveFromContinue,
  onRemoveFromRecent,
  onDismissNewEpisode,
  onMarkNewEpisodeWatched,
  onToggleFavorite,
  onToggleWatched,
  onToggleRating,
  onOpenMultiView,
  onOpenPopout,
  onDownload,
  onDeleteDownload,
}: BuildHomeCardContextMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  const pushRatingActions = () => {
    if (!onToggleRating || (entry.kind !== 'movie' && entry.kind !== 'series')) return;
    items.push(
      {
        id: 'like',
        label: t(currentRating === 'like' ? 'rating.clearLike' : 'rating.like'),
        icon: currentRating === 'like' ? 'likeFilled' : 'like',
        testID: 'home-context-like',
        onSelect: () => onToggleRating(entry, 'like'),
      },
      {
        id: 'dislike',
        label: t(currentRating === 'dislike' ? 'rating.clearDislike' : 'rating.dislike'),
        icon: currentRating === 'dislike' ? 'dislikeFilled' : 'dislike',
        testID: 'home-context-dislike',
        onSelect: () => onToggleRating(entry, 'dislike'),
      },
    );
  };
  const pushDownloadAction = () => {
    if (entry.kind !== 'movie') return;
    if (isDownloaded && onDeleteDownload) {
      items.push({
        id: 'deleteDownload',
        label: t('context.deleteDownload'),
        icon: 'trash',
        destructive: true,
        testID: 'home-context-delete-download',
        onSelect: () => onDeleteDownload(entry),
      });
    } else if (!isDownloaded && onDownload) {
      items.push({
        id: 'download',
        label: t('context.download'),
        icon: 'download',
        testID: 'home-context-download',
        onSelect: () => onDownload(entry),
      });
    }
  };

  if (railId === 'continue') {
    items.push({
      id: 'resume',
      label: entry.positionMs > 0 ? t('context.resume') : t('context.play'),
      icon: 'play',
      testID: 'home-context-resume',
      onSelect: () => onPlay(entry, index),
    });
    if (
      onOpenDetail &&
      (entry.kind === 'movie' ||
        entry.kind === 'series' ||
        (entry.kind === 'episode' && Boolean(entry.seriesKey)))
    ) {
      items.push({
        id: 'details',
        label: t('context.goToDetails'),
        icon: 'info',
        testID: 'home-context-details',
        onSelect: () => onOpenDetail(entry),
      });
    }
    if (onRemoveFromContinue) {
      items.push({
        id: 'hideFromContinue',
        label: t('context.hideFromContinue'),
        icon: 'close',
        destructive: true,
        testID: 'home-context-hide-continue',
        onSelect: () => onRemoveFromContinue(entry),
      });
    }
    if (onToggleWatched) {
      items.push({
        id: 'markWatched',
        label: t('context.markWatched'),
        icon: 'check',
        testID: 'home-context-mark-watched',
        onSelect: () => onToggleWatched(entry, false),
      });
    }
    pushRatingActions();
    pushDownloadAction();
    return items;
  }

  if (railId === 'newEpisodes') {
    items.push({
      id: 'play',
      label: t('context.play'),
      icon: 'play',
      testID: 'home-context-play',
      onSelect: () => onPlay(entry, index),
    });
    if (onOpenDetail && entry.seriesKey) {
      items.push({
        id: 'details',
        label: t('context.goToDetails'),
        icon: 'info',
        testID: 'home-context-details',
        onSelect: () => onOpenDetail(entry),
      });
    }
    if (onMarkNewEpisodeWatched) {
      items.push({
        id: 'markWatched',
        label: t('context.markWatched'),
        icon: 'check',
        testID: 'home-context-mark-watched',
        onSelect: () => onMarkNewEpisodeWatched(entry),
      });
    }
    if (onDismissNewEpisode) {
      items.push({
        id: 'dismissNewEpisode',
        label: t('context.dismissNewEpisode'),
        icon: 'close',
        destructive: true,
        testID: 'home-context-dismiss-new-episode',
        onSelect: () => onDismissNewEpisode(entry),
      });
    }
    return items;
  }

  if (railId === 'live' || entry.kind === 'live') {
    items.push({
      id: 'play',
      label: t('context.play'),
      icon: 'play',
      testID: 'home-context-play',
      onSelect: () => onPlay(entry, index),
    });
    if (onOpenMultiView) {
      items.push({
        id: 'multiview',
        label: t('context.openMultiView'),
        icon: 'multiview',
        testID: 'home-context-multiview',
        onSelect: () => onOpenMultiView(entry, index),
      });
    }
    if (onOpenPopout) {
      items.push({
        id: 'popout',
        label: t('context.openPopout'),
        icon: 'popout',
        testID: 'home-context-popout',
        onSelect: () => onOpenPopout(entry, index),
      });
    }
    if (onToggleFavorite) {
      items.push({
        id: 'favorite',
        label: t(isFavorite ? 'context.removeFavorite' : 'context.addFavorite'),
        icon: isFavorite ? 'starFilled' : 'star',
        testID: 'home-context-favorite',
        onSelect: () => onToggleFavorite(entry),
      });
    }
    if (isRecent && onRemoveFromRecent) {
      items.push({
        id: 'removeFromRecent',
        label: t('live.context.removeFromRecent'),
        icon: 'trash',
        destructive: true,
        testID: 'home-context-remove-recent',
        onSelect: () => onRemoveFromRecent(entry),
      });
    }
    return items;
  }

  items.push({
    id: 'play',
    label: t('context.play'),
    icon: 'play',
    testID: 'home-context-play',
    onSelect: () => onPlay(entry, index),
  });
  if (onOpenDetail && (entry.kind === 'movie' || entry.kind === 'series')) {
    items.push({
      id: 'details',
      label: t('context.goToDetails'),
      icon: 'info',
      testID: 'home-context-details',
      onSelect: () => onOpenDetail(entry),
    });
  }
  if (onToggleFavorite) {
    items.push({
      id: 'mylist',
      label: t(isFavorite ? 'context.removeFromMyList' : 'context.addToMyList'),
      icon: isFavorite ? 'check' : 'plus',
      testID: 'home-context-mylist',
      onSelect: () => onToggleFavorite(entry),
    });
  }
  pushRatingActions();
  if (onToggleWatched) {
    items.push({
      id: 'watched',
      label: t(isWatched ? 'context.markUnwatched' : 'context.markWatched'),
      icon: 'check',
      testID: 'home-context-watched',
      onSelect: () => onToggleWatched(entry, isWatched),
    });
  }
  pushDownloadAction();
  return items;
}
