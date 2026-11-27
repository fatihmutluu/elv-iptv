import type { ItemRow, RatingValue, WatchProgressRow } from '@elv/data';
import type { ContextMenuItem } from '@elv/ui-kit';
import type { DetailTarget } from '../shared';
import { detailTargetFromItem } from '../shared';
import { detailTargetFromProgress } from './catalog-model';

/** Minimal translation signature required by catalog context-menu builders. */
interface CatalogContextMenuI18n {
  t(key: string): string;
}

/** Input for {@link buildCatalogPosterContextMenuItems}. */
export interface BuildCatalogPosterContextMenuInput {
  readonly item: ItemRow;
  readonly categoryId?: string;
  readonly isFavorite: boolean;
  readonly isWatched: boolean;
  readonly currentRating?: RatingValue | null;
  readonly isDownloaded?: boolean;
  readonly i18n: CatalogContextMenuI18n;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onQuickPlay?: (item: ItemRow, categoryId: string) => void;
  readonly onQuickToggleFavorite?: (item: ItemRow) => void;
  readonly onQuickToggleWatched?: (item: ItemRow, currentWatched: boolean) => void;
  readonly onQuickToggleRating?: (item: ItemRow, next: RatingValue) => void;
  readonly onDownload?: (item: ItemRow) => void;
  readonly onDeleteDownload?: (item: ItemRow) => void;
}

/** Builds universal right-click / long-press context menu actions for a Movie or Series poster card. */
export function buildCatalogPosterContextMenuItems({
  item,
  categoryId = '',
  isFavorite,
  isWatched,
  currentRating = null,
  isDownloaded = false,
  i18n,
  onOpenDetail,
  onQuickPlay,
  onQuickToggleFavorite,
  onQuickToggleWatched,
  onQuickToggleRating,
  onDownload,
  onDeleteDownload,
}: BuildCatalogPosterContextMenuInput): ContextMenuItem[] {
  const openDetail = () => {
    const target = detailTargetFromItem(item, categoryId || undefined);
    if (target) onOpenDetail(target);
  };

  const items: ContextMenuItem[] = [
    {
      id: 'play',
      label: i18n.t('context.play'),
      icon: 'play',
      testID: 'context-menu-play',
      onSelect: () => {
        if (onQuickPlay) onQuickPlay(item, categoryId);
        else openDetail();
      },
    },
    {
      id: 'details',
      label: i18n.t('context.goToDetails'),
      icon: 'info',
      testID: 'context-menu-details',
      onSelect: openDetail,
    },
  ];

  if (onQuickToggleFavorite) {
    items.push({
      id: 'favorite',
      label: i18n.t(isFavorite ? 'context.removeFromMyList' : 'context.addToMyList'),
      icon:
        item.kind === 'live' ? (isFavorite ? 'starFilled' : 'star') : isFavorite ? 'check' : 'plus',
      testID: 'context-menu-favorite',
      onSelect: () => onQuickToggleFavorite(item),
    });
  }

  if (onQuickToggleRating && (item.kind === 'movie' || item.kind === 'series')) {
    items.push(
      {
        id: 'like',
        label: i18n.t(currentRating === 'like' ? 'rating.clearLike' : 'rating.like'),
        icon: currentRating === 'like' ? 'likeFilled' : 'like',
        testID: 'context-menu-like',
        onSelect: () => onQuickToggleRating(item, 'like'),
      },
      {
        id: 'dislike',
        label: i18n.t(currentRating === 'dislike' ? 'rating.clearDislike' : 'rating.dislike'),
        icon: currentRating === 'dislike' ? 'dislikeFilled' : 'dislike',
        testID: 'context-menu-dislike',
        onSelect: () => onQuickToggleRating(item, 'dislike'),
      },
    );
  }

  if (onQuickToggleWatched) {
    items.push({
      id: 'watched',
      label: i18n.t(isWatched ? 'context.markUnwatched' : 'context.markWatched'),
      icon: 'check',
      testID: 'context-menu-watched',
      onSelect: () => onQuickToggleWatched(item, isWatched),
    });
  }

  if (item.kind === 'movie') {
    if (isDownloaded && onDeleteDownload) {
      items.push({
        id: 'deleteDownload',
        label: i18n.t('context.deleteDownload'),
        icon: 'trash',
        destructive: true,
        testID: 'context-menu-delete-download',
        onSelect: () => onDeleteDownload(item),
      });
    } else if (!isDownloaded && onDownload) {
      items.push({
        id: 'download',
        label: i18n.t('context.download'),
        icon: 'download',
        testID: 'context-menu-download',
        onSelect: () => onDownload(item),
      });
    }
  }

  return items;
}

/** Input for {@link buildContinueWatchingContextMenuItems}. */
export interface BuildContinueContextMenuInput {
  readonly kind: 'movie' | 'series';
  readonly row: WatchProgressRow;
  readonly i18n: CatalogContextMenuI18n;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onResume?: (row: WatchProgressRow) => void;
  readonly onHideContinue?: (row: WatchProgressRow) => void;
  readonly onMarkWatched?: (row: WatchProgressRow) => void;
}

/** Builds universal right-click / long-press context menu actions for a Continue Watching card. */
export function buildContinueWatchingContextMenuItems({
  kind,
  row,
  i18n,
  onOpenDetail,
  onResume,
  onHideContinue,
  onMarkWatched,
}: BuildContinueContextMenuInput): ContextMenuItem[] {
  const openDetail = () => onOpenDetail(detailTargetFromProgress(row, kind));

  const items: ContextMenuItem[] = [
    {
      id: 'resume',
      label: i18n.t(row.positionMs > 0 ? 'context.resume' : 'context.play'),
      icon: 'play',
      testID: 'context-menu-resume',
      onSelect: () => {
        if (onResume) onResume(row);
        else openDetail();
      },
    },
    {
      id: 'details',
      label: i18n.t('context.goToDetails'),
      icon: 'info',
      testID: 'context-menu-details',
      onSelect: openDetail,
    },
  ];

  if (onHideContinue) {
    items.push({
      id: 'hide',
      label: i18n.t('context.hideFromContinue'),
      icon: 'close',
      destructive: true,
      testID: 'context-menu-hide-continue',
      onSelect: () => onHideContinue(row),
    });
  }

  if (onMarkWatched) {
    items.push({
      id: 'watched',
      label: i18n.t('context.markWatched'),
      icon: 'check',
      testID: 'context-menu-mark-watched',
      onSelect: () => onMarkWatched(row),
    });
  }

  return items;
}
