import type { RatingValue } from '@elv/data';
import type { AppI18n } from '@elv/i18n';
import type { ContextMenuItem } from '@elv/ui-kit';

/** Builds right-click / long-press context menu actions for a followed Live TV channel card. */
export function buildLibraryLiveMenuItems(params: {
  readonly t: AppI18n['t'];
  readonly onPlay: () => void;
  readonly onOpenMultiView?: (() => void) | undefined;
  readonly onOpenPopout?: (() => void) | undefined;
  readonly onRemoveFavorite: () => void;
}): ContextMenuItem[] {
  const { t, onPlay, onOpenMultiView, onOpenPopout, onRemoveFavorite } = params;
  const items: ContextMenuItem[] = [
    {
      id: 'play',
      label: t('context.play'),
      icon: 'play',
      testID: 'library-context-play',
      onSelect: onPlay,
    },
  ];
  if (onOpenMultiView !== undefined) {
    items.push({
      id: 'open-multiview',
      label: t('context.openMultiView'),
      icon: 'multiview',
      testID: 'library-context-multiview',
      onSelect: onOpenMultiView,
    });
  }
  if (onOpenPopout !== undefined) {
    items.push({
      id: 'open-popout',
      label: t('context.openPopout'),
      icon: 'popout',
      testID: 'library-context-popout',
      onSelect: onOpenPopout,
    });
  }
  items.push({
    id: 'remove-favorite',
    label: t('context.removeFavorite'),
    icon: 'starFilled',
    destructive: true,
    testID: 'library-context-remove-favorite',
    onSelect: onRemoveFavorite,
  });
  return items;
}

/** Minimal collection descriptor passed to {@link buildLibraryVodMenuItems}. */
export interface LibraryMenuCollectionOption {
  readonly id: string;
  readonly name: string;
}

/** Builds right-click / long-press context menu actions for a Movie or Series card in Library. */
export function buildLibraryVodMenuItems(params: {
  readonly t: AppI18n['t'];
  readonly kind: 'movie' | 'series';
  readonly isFavorite: boolean;
  readonly ratingValue: RatingValue | null;
  readonly isWatched: boolean;
  readonly canDownload?: boolean;
  readonly collections?: readonly LibraryMenuCollectionOption[];
  readonly currentCollectionId?: string | null;
  readonly onPlay?: (() => void) | undefined;
  readonly onOpenDetail: () => void;
  readonly onToggleFavorite: () => void;
  readonly onToggleLike: () => void;
  readonly onToggleDislike: () => void;
  readonly onToggleWatched?: (() => void) | undefined;
  readonly onDownload?: (() => void) | undefined;
  readonly onMoveToCollection?: ((targetCollectionId: string) => void) | undefined;
  readonly onRemoveFromCollection?: ((collectionId: string) => void) | undefined;
}): ContextMenuItem[] {
  const {
    t,
    kind,
    isFavorite,
    ratingValue,
    isWatched,
    canDownload,
    collections,
    currentCollectionId,
    onPlay,
    onOpenDetail,
    onToggleFavorite,
    onToggleLike,
    onToggleDislike,
    onToggleWatched,
    onDownload,
    onMoveToCollection,
    onRemoveFromCollection,
  } = params;

  const items: ContextMenuItem[] = [];
  if (kind === 'movie' && onPlay !== undefined) {
    items.push({
      id: 'play',
      label: t('context.play'),
      icon: 'play',
      testID: 'library-context-play',
      onSelect: onPlay,
    });
  }
  items.push(
    {
      id: 'detail',
      label: t('context.goToDetails'),
      icon: 'info',
      testID: 'library-context-detail',
      onSelect: onOpenDetail,
    },
    {
      id: 'toggle-favorite',
      label: isFavorite ? t('context.removeFromMyList') : t('context.addToMyList'),
      icon: isFavorite ? 'check' : 'plus',
      testID: 'library-context-favorite',
      onSelect: onToggleFavorite,
    },
    {
      id: 'toggle-like',
      label: ratingValue === 'like' ? t('rating.clearLike') : t('rating.like'),
      icon: ratingValue === 'like' ? 'likeFilled' : 'like',
      testID: 'library-context-like',
      onSelect: onToggleLike,
    },
    {
      id: 'toggle-dislike',
      label: ratingValue === 'dislike' ? t('rating.clearDislike') : t('rating.dislike'),
      icon: ratingValue === 'dislike' ? 'dislikeFilled' : 'dislike',
      testID: 'library-context-dislike',
      onSelect: onToggleDislike,
    },
  );
  if (onToggleWatched !== undefined) {
    items.push({
      id: 'toggle-watched',
      label: isWatched ? t('context.markUnwatched') : t('context.markWatched'),
      icon: 'check',
      testID: 'library-context-watched',
      onSelect: onToggleWatched,
    });
  }
  if (kind === 'movie' && canDownload === true && onDownload !== undefined) {
    items.push({
      id: 'download',
      label: t('context.download'),
      icon: 'download',
      testID: 'library-context-download',
      onSelect: onDownload,
    });
  }
  if (collections !== undefined && onMoveToCollection !== undefined) {
    for (const col of collections) {
      if (col.id === currentCollectionId) continue;
      items.push({
        id: `move-to-collection-${col.id}`,
        label: t('library.collections.moveToNamed', { name: col.name }),
        icon: 'list',
        testID: `library-context-move-collection-${col.id}`,
        onSelect: () => onMoveToCollection(col.id),
      });
    }
  }
  if (
    currentCollectionId !== undefined &&
    currentCollectionId !== null &&
    currentCollectionId.length > 0 &&
    onRemoveFromCollection !== undefined
  ) {
    items.push({
      id: 'remove-from-collection',
      label: t('library.collections.removeFrom'),
      icon: 'close',
      destructive: true,
      testID: 'library-context-remove-collection',
      onSelect: () => onRemoveFromCollection(currentCollectionId),
    });
  }
  return items;
}

/** Builds right-click / long-press context menu actions for a completed offline movie or episode. */
export function buildDownloadedMediaMenuItems(params: {
  readonly t: AppI18n['t'];
  readonly onPlayOffline: () => void;
  readonly onOpenMultiView?: (() => void) | undefined;
  readonly onOpenDetail?: (() => void) | undefined;
  readonly onDelete: () => void;
}): ContextMenuItem[] {
  const { t, onPlayOffline, onOpenMultiView, onOpenDetail, onDelete } = params;
  const items: ContextMenuItem[] = [
    {
      id: 'play-offline',
      label: t('downloads.actionPlayOffline'),
      icon: 'play',
      testID: 'library-context-play-offline',
      onSelect: onPlayOffline,
    },
  ];
  if (onOpenMultiView !== undefined) {
    items.push({
      id: 'open-multiview',
      label: t('context.openMultiView'),
      icon: 'multiview',
      testID: 'library-context-multiview',
      onSelect: onOpenMultiView,
    });
  }
  if (onOpenDetail !== undefined) {
    items.push({
      id: 'detail',
      label: t('context.goToDetails'),
      icon: 'info',
      testID: 'library-context-detail',
      onSelect: onOpenDetail,
    });
  }
  items.push({
    id: 'delete-download',
    label: t('downloads.actionDelete'),
    icon: 'trash',
    destructive: true,
    testID: 'library-context-delete-download',
    onSelect: onDelete,
  });
  return items;
}

/** Builds right-click / long-press context menu actions for an active/failed download row. */
export function buildActiveDownloadMenuItems(params: {
  readonly t: AppI18n['t'];
  readonly isPausedOrFailed: boolean;
  readonly onTogglePauseResume: () => void;
  readonly onCancel: () => void;
}): ContextMenuItem[] {
  const { t, isPausedOrFailed, onTogglePauseResume, onCancel } = params;
  return [
    {
      id: isPausedOrFailed ? 'resume-download' : 'pause-download',
      label: isPausedOrFailed ? t('downloads.actionResume') : t('downloads.actionPause'),
      icon: isPausedOrFailed ? 'play' : 'pause',
      testID: 'library-context-toggle-download',
      onSelect: onTogglePauseResume,
    },
    {
      id: 'cancel-download',
      label: t('downloads.actionCancel'),
      icon: 'close',
      destructive: true,
      testID: 'library-context-cancel-download',
      onSelect: onCancel,
    },
  ];
}
