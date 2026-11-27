import { describe, expect, it } from 'vitest';
import { createAppI18n, type MessageId } from './index';

describe('Wave Q2 i18n catalogs', () => {
  it('localizes My List (Listem) & 2x2 Likes/Dislikes rails without star wording on Library empty copy', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['library.tabFollowing', 'My List', 'Listem'],
      ['library.railLikedMovies', 'Liked Movies', 'Beğendiğim Filmler'],
      ['library.railLikedSeries', 'Liked Series', 'Beğendiğim Diziler'],
      ['library.railDislikedMovies', 'Disliked Movies', 'Beğenmediğim Filmler'],
      ['library.railDislikedSeries', 'Disliked Series', 'Beğenmediğim Diziler'],
    ];
    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }
    expect(tr.t('library.emptyFollowingBody')).not.toMatch(/yıldız/i);
    expect(en.t('library.emptyFollowingBody')).not.toMatch(/\bstar\b/i);
  });
});
