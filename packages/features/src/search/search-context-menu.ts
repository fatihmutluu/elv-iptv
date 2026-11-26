import type { ItemRow } from '@elv/data';
import type { ContextMenuItem } from '@elv/ui-kit';
import { type DetailTarget, detailTargetFromItem } from '../shared';

/** Minimal translation signature required by search context-menu builders. */
export interface SearchContextMenuI18n {
  t(key: string): string;
}

/** Builds context menu items for a Live channel result card in Search. */
export function buildSearchLiveContextMenuItems({
  item,
  isFavorite,
  i18n,
  onPlayLive,
  onToggleFavorite,
}: {
  readonly item: ItemRow;
  readonly isFavorite: boolean;
  readonly i18n: SearchContextMenuI18n;
  readonly onPlayLive: (item: ItemRow) => void;
  readonly onToggleFavorite?: (item: ItemRow) => void;
}): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      id: 'play',
      label: i18n.t('context.play'),
      icon: 'play',
      testID: 'context-menu-play',
      onSelect: () => onPlayLive(item),
    },
  ];

  if (onToggleFavorite) {
    items.push({
      id: 'favorite',
      label: i18n.t(isFavorite ? 'context.removeFromMyList' : 'context.addToMyList'),
      icon: isFavorite ? 'starFilled' : 'star',
      testID: 'context-menu-favorite',
      onSelect: () => onToggleFavorite(item),
    });
  }

  return items;
}

/** Builds context menu items for a Movie or Series poster result card in Search. */
export function buildSearchVodContextMenuItems({
  item,
  isFavorite,
  isWatched,
  i18n,
  onOpenDetail,
  onPlayVod,
  onToggleFavorite,
  onToggleWatched,
}: {
  readonly item: ItemRow;
  readonly isFavorite: boolean;
  readonly isWatched: boolean;
  readonly i18n: SearchContextMenuI18n;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onPlayVod?: (item: ItemRow) => void;
  readonly onToggleFavorite?: (item: ItemRow) => void;
  readonly onToggleWatched?: (item: ItemRow, currentWatched: boolean) => void;
}): ContextMenuItem[] {
  const openDetail = () => {
    const target = detailTargetFromItem(item);
    if (target) onOpenDetail(target);
  };

  const items: ContextMenuItem[] = [
    {
      id: 'play',
      label: i18n.t('context.play'),
      icon: 'play',
      testID: 'context-menu-play',
      onSelect: () => {
        if (onPlayVod) onPlayVod(item);
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

  if (onToggleFavorite) {
    items.push({
      id: 'favorite',
      label: i18n.t(isFavorite ? 'context.removeFromMyList' : 'context.addToMyList'),
      icon: isFavorite ? 'starFilled' : 'star',
      testID: 'context-menu-favorite',
      onSelect: () => onToggleFavorite(item),
    });
  }

  if (onToggleWatched) {
    items.push({
      id: 'watched',
      label: i18n.t(isWatched ? 'context.markUnwatched' : 'context.markWatched'),
      icon: 'check',
      testID: 'context-menu-watched',
      onSelect: () => onToggleWatched(item, isWatched),
    });
  }

  return items;
}
