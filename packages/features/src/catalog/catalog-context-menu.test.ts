import type { ItemRow, RatingValue } from '@elv/data';
import { describe, expect, it, vi } from 'vitest';
import { buildCatalogPosterContextMenuItems } from './catalog-context-menu';

const i18n = { t: (key: string) => key };

function makeItem(kind: ItemRow['kind']): ItemRow {
  return {
    id: 1,
    key: `x:s1:${kind}:1`,
    sourceId: 's1',
    providerId: '1',
    kind,
    name: 'Test Title',
    logo: null,
    num: null,
    year: 2025,
    rating: 8.1,
  };
}

describe('buildCatalogPosterContextMenuItems — Like/Dislike ratings', () => {
  it('exposes Like and Dislike for Movie and Series cards and reflects active icons & clear labels', () => {
    const onQuickToggleRating = vi.fn();
    const movieItems = buildCatalogPosterContextMenuItems({
      item: makeItem('movie'),
      isFavorite: false,
      isWatched: false,
      currentRating: 'like',
      i18n,
      onOpenDetail: vi.fn(),
      onQuickToggleRating,
    });
    const likeAction = movieItems.find((a) => a.id === 'like');
    const dislikeAction = movieItems.find((a) => a.id === 'dislike');
    expect(likeAction).toMatchObject({ icon: 'likeFilled', label: 'rating.clearLike' });
    expect(dislikeAction).toMatchObject({ icon: 'dislike', label: 'rating.dislike' });
    likeAction?.onSelect();
    dislikeAction?.onSelect();
    expect(onQuickToggleRating).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: 'movie' }),
      'like',
    );
    expect(onQuickToggleRating).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: 'movie' }),
      'dislike',
    );

    const seriesItems = buildCatalogPosterContextMenuItems({
      item: makeItem('series'),
      isFavorite: true,
      isWatched: false,
      currentRating: 'dislike' as RatingValue,
      i18n,
      onOpenDetail: vi.fn(),
      onQuickToggleRating,
    });
    expect(seriesItems.find((a) => a.id === 'like')).toMatchObject({
      icon: 'like',
      label: 'rating.like',
    });
    expect(seriesItems.find((a) => a.id === 'dislike')).toMatchObject({
      icon: 'dislikeFilled',
      label: 'rating.clearDislike',
    });
  });

  it('never exposes Like or Dislike on Live items', () => {
    const liveItems = buildCatalogPosterContextMenuItems({
      item: makeItem('live'),
      isFavorite: false,
      isWatched: false,
      i18n,
      onOpenDetail: vi.fn(),
      onQuickToggleRating: vi.fn(),
    });
    expect(liveItems.some((a) => a.id === 'like' || a.id === 'dislike')).toBe(false);
  });
});
