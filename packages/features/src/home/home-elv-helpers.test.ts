import type { ElvItemEnrichment, ElvRecommendedItem, ItemRow, RatingValue } from '@elv/data';
import { DEFAULT_ELV_MODE_PREFERENCES, type ElvModePreferences } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { describe, expect, it } from 'vitest';
import {
  buildElvShowcaseEntries,
  filterOutDislikedItems,
  formatHomeElvReason,
} from './home-elv-helpers';

function makeItem(key: string, kind: 'movie' | 'series' = 'movie', name = 'Raw Title'): ItemRow {
  return {
    id: 1,
    key,
    sourceId: 'src-1',
    providerId: '1',
    kind,
    name,
    logo: 'https://raw.example.test/poster.jpg',
    num: null,
    year: 2020,
    rating: 7.0,
  };
}

function makeEnrichment(item: ItemRow, cleanTitle: string, posterUrl: string): ElvItemEnrichment {
  return {
    itemKey: item.key,
    sourceId: item.sourceId,
    mediaType: item.kind === 'series' ? 'series' : 'movie',
    imdbId: 'tt1375666',
    confidence: 0.99,
    manualLock: false,
    title: {
      imdbId: 'tt1375666',
      mediaType: item.kind === 'series' ? 'series' : 'movie',
      originalTitle: cleanTitle,
      englishTitle: cleanTitle,
      localizedTitles: {},
      year: 2010,
      rating: 8.8,
      votes: 2_500_000,
      runtimeMin: 148,
      genres: ['Sci-Fi'],
      posterUrl,
      backdropUrl: 'https://imdb.example.test/backdrop.jpg',
      synopses: {},
      director: 'Christopher Nolan',
      cast: [],
      trailerStreamUrl: null,
      trailerYoutubeId: null,
      mltImdbIds: [],
      franchiseKey: null,
      franchiseName: null,
      franchiseOrder: null,
      detailFetchedAt: 100,
      updatedAt: 100,
    },
  };
}

describe('home-elv-helpers (#512)', () => {
  it('filters out disliked items while preserving liked and unrated items', () => {
    const items = [makeItem('m:1'), makeItem('m:2'), makeItem('m:3')];
    const ratingByKey = new Map<string, RatingValue>([
      ['m:1', 'like'],
      ['m:2', 'dislike'],
    ]);
    const filtered = filterOutDislikedItems(items, ratingByKey);
    expect(filtered.map((i) => i.key)).toEqual(['m:1', 'm:3']);
  });

  it('builds mixed Movie + Series ELV showcase entries with localized reason badges and ELV enrichment', () => {
    const en = createAppI18n('en');
    const movie = makeItem('m:1', 'movie', 'INCEPTION [4K]');
    const series = makeItem('s:1', 'series', 'DARK [TR]');
    const disliked = makeItem('m:bad', 'movie', 'Disliked Film');

    const recs: readonly ElvRecommendedItem[] = [
      {
        item: movie,
        enrichment: makeEnrichment(movie, 'Inception', 'https://imdb.example.test/inception.jpg'),
        score: 0.95,
        reason: 'trending',
      },
      {
        item: series,
        enrichment: makeEnrichment(series, 'Dark', 'https://imdb.example.test/dark.jpg'),
        score: 0.9,
        reason: 'upcoming_tv',
      },
      {
        item: disliked,
        enrichment: makeEnrichment(disliked, 'Disliked Film', 'https://imdb.example.test/bad.jpg'),
        score: 0.8,
        reason: 'top_picks',
      },
    ];

    const prefs: ElvModePreferences = {
      ...DEFAULT_ELV_MODE_PREFERENCES,
      elvModeEnabled: true,
      elvEnrichMetadata: true,
      elvSmartRecommendations: true,
    };

    const entries = buildElvShowcaseEntries(recs, {
      elvPrefs: prefs,
      locale: 'en',
      t: en.t,
      progressByKey: new Map(),
      ratingByKey: new Map([['m:bad', 'dislike']]),
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      itemKey: 'm:1',
      kind: 'movie',
      title: 'Inception',
      posterUri: 'https://imdb.example.test/inception.jpg',
      backdropUri: 'https://imdb.example.test/backdrop.jpg',
      rating: 8.8,
      year: 2010,
      badgeLabel: 'Trending now',
    });
    const noBackdropEnrichment = makeEnrichment(
      series,
      'Dark',
      'https://imdb.example.test/dark.jpg',
    );
    const entriesNoBackdrop = buildElvShowcaseEntries(
      [
        {
          item: series,
          enrichment: {
            ...noBackdropEnrichment,
            title: noBackdropEnrichment.title
              ? { ...noBackdropEnrichment.title, backdropUrl: null }
              : null,
          },
          score: 0.9,
          reason: 'upcoming_tv',
        },
      ],
      {
        elvPrefs: prefs,
        locale: 'en',
        t: en.t,
        progressByKey: new Map(),
        ratingByKey: new Map(),
      },
    );
    expect(entriesNoBackdrop[0]?.posterUri).toBe('https://imdb.example.test/dark.jpg');
    expect(entriesNoBackdrop[0]?.backdropUri).toBeNull();
    expect(entries[1]).toMatchObject({
      itemKey: 's:1',
      kind: 'series',
      title: 'Dark',
      posterUri: 'https://imdb.example.test/dark.jpg',
      badgeLabel: 'Current & upcoming',
    });

    expect(formatHomeElvReason('more_like_this', en.t)).toBe('Because of your likes');
    expect(formatHomeElvReason('genre_match', en.t)).toBe('Your favorite genre');
    expect(formatHomeElvReason('cast_match', en.t)).toBe('Cast you follow');
    expect(formatHomeElvReason('top_picks', en.t)).toBe('Top pick');
  });
});
