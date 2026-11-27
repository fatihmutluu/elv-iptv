import { createAppI18n } from '@elv/i18n';
import { describe, expect, it } from 'vitest';
import {
  buildImdbGenreDisplayCategories,
  formatElvGenreLabel,
  formatElvRecommendationReason,
  isElvImdbGenreCategoryId,
  resolveElvGenreMessageId,
  resolveElvRecommendationReasonMessageId,
} from './elv-genre-label';

describe('elv-genre-label (#512)', () => {
  it('maps all 20 canonical IMDb genres to i18n keys and falls back cleanly for unmapped genres', () => {
    const cases: readonly [string, string][] = [
      ['Action', 'elv.genre.Action'],
      ['Adventure', 'elv.genre.Adventure'],
      ['Animation', 'elv.genre.Animation'],
      ['Biography', 'elv.genre.Biography'],
      ['Comedy', 'elv.genre.Comedy'],
      ['Crime', 'elv.genre.Crime'],
      ['Documentary', 'elv.genre.Documentary'],
      ['Drama', 'elv.genre.Drama'],
      ['Family', 'elv.genre.Family'],
      ['Fantasy', 'elv.genre.Fantasy'],
      ['History', 'elv.genre.History'],
      ['Horror', 'elv.genre.Horror'],
      ['Music', 'elv.genre.Music'],
      ['Mystery', 'elv.genre.Mystery'],
      ['Romance', 'elv.genre.Romance'],
      ['Sci-Fi', 'elv.genre.SciFi'],
      ['Sport', 'elv.genre.Sport'],
      ['Thriller', 'elv.genre.Thriller'],
      ['War', 'elv.genre.War'],
      ['Western', 'elv.genre.Western'],
    ];

    for (const [genre, expectedKey] of cases) {
      expect(resolveElvGenreMessageId(genre)).toBe(expectedKey);
      expect(resolveElvGenreMessageId(`  ${genre.toLowerCase()}  `)).toBe(expectedKey);
    }

    expect(resolveElvGenreMessageId('Film-Noir')).toBeNull();

    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    expect(formatElvGenreLabel('Sci-Fi', en.t)).toBe('Sci-Fi');
    expect(formatElvGenreLabel('Action', tr.t)).not.toBe('Action');
    expect(formatElvGenreLabel('Film-Noir', en.t)).toBe('Film-Noir');
  });

  it('detects synthetic IMDb genre category IDs and builds DisplayCategory entries with counts', () => {
    const en = createAppI18n('en');
    expect(isElvImdbGenreCategoryId('imdb-genre:Sci-Fi')).toBe(true);
    expect(isElvImdbGenreCategoryId('src-1|movie|cat-0')).toBe(false);

    const display = buildImdbGenreDisplayCategories(
      [
        { id: 'imdb-genre:Sci-Fi', name: 'Sci-Fi', count: 14 },
        { id: 'imdb-genre:Film-Noir', name: 'Film-Noir', count: 2 },
      ],
      'movie',
      en.t,
    );
    expect(display).toEqual([
      {
        row: {
          id: 'imdb-genre:Sci-Fi',
          sourceId: 'elv-imdb',
          kind: 'movie',
          name: 'Sci-Fi',
          position: 0,
          itemCount: 14,
        },
        label: 'Sci-Fi',
      },
      {
        row: {
          id: 'imdb-genre:Film-Noir',
          sourceId: 'elv-imdb',
          kind: 'movie',
          name: 'Film-Noir',
          position: 1,
          itemCount: 2,
        },
        label: 'Film-Noir',
      },
    ]);
  });

  it('maps all 6 recommendation reasons to localized strings', () => {
    const en = createAppI18n('en');
    expect(resolveElvRecommendationReasonMessageId('more_like_this')).toBe(
      'elv.reason.moreLikeThis',
    );
    expect(resolveElvRecommendationReasonMessageId('trending')).toBe('elv.reason.trending');
    expect(resolveElvRecommendationReasonMessageId('top_picks')).toBe('elv.reason.topPicks');
    expect(resolveElvRecommendationReasonMessageId('upcoming_tv')).toBe('elv.reason.upcomingTv');
    expect(resolveElvRecommendationReasonMessageId('genre_match')).toBe('elv.reason.genreMatch');
    expect(resolveElvRecommendationReasonMessageId('cast_match')).toBe('elv.reason.castMatch');

    expect(formatElvRecommendationReason('more_like_this', en.t)).toBe('Because of your likes');
    expect(formatElvRecommendationReason('trending', en.t)).toBe('Trending now');
    expect(formatElvRecommendationReason('top_picks', en.t)).toBe('Top pick');
    expect(formatElvRecommendationReason('upcoming_tv', en.t)).toBe('Current & upcoming');
    expect(formatElvRecommendationReason('genre_match', en.t)).toBe('Your favorite genre');
    expect(formatElvRecommendationReason('cast_match', en.t)).toBe('Cast you follow');
  });
});
