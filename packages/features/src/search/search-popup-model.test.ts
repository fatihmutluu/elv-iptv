import type { ItemRow, SearchResults } from '@elv/data';
import { describe, expect, it } from 'vitest';
import {
  buildSearchPopupNavRows,
  buildSearchPopupSuggestions,
  SEARCH_POPUP_RAIL_LIMIT,
  SEARCH_POPUP_SUGGESTION_LIMIT,
  stepSearchPopupFocus,
} from './search-popup-model';

function makeItem(kind: ItemRow['kind'], index: number, name: string): ItemRow {
  return {
    id: index,
    key: `${kind}:s1:${index}`,
    kind,
    sourceId: 'src-1',
    providerId: String(index),
    name,
    logo: null,
    rating: kind === 'live' ? null : 8.1,
    year: kind === 'live' ? null : 2024,
    num: kind === 'live' ? index : null,
  };
}

function makeResults(partial: Partial<SearchResults>): SearchResults {
  return {
    live: partial.live ?? [],
    epg: partial.epg ?? [],
    movies: partial.movies ?? [],
    series: partial.series ?? [],
    episodes: partial.episodes ?? [],
  };
}

describe('search-popup-model', () => {
  it('exposes bounded popup suggestion and rail constants', () => {
    expect(SEARCH_POPUP_SUGGESTION_LIMIT).toBe(3);
    expect(SEARCH_POPUP_RAIL_LIMIT).toBeGreaterThanOrEqual(8);
  });

  describe('buildSearchPopupSuggestions', () => {
    it('returns empty list for blank or whitespace-only queries', () => {
      const results = makeResults({ movies: [makeItem('movie', 1, 'Inception')] });
      expect(buildSearchPopupSuggestions(results, '')).toEqual([]);
      expect(buildSearchPopupSuggestions(results, '   ')).toEqual([]);
      expect(buildSearchPopupSuggestions(results, 'inc', 0)).toEqual([]);
    });

    it('prioritizes prefix matches, deduplicates Turkish-folded titles, and caps at 3', () => {
      const results = makeResults({
        movies: [
          makeItem('movie', 1, 'Beyond Istanbul'),
          makeItem('movie', 2, 'İstanbul Hatırası'),
          makeItem('movie', 3, 'istanbul hatirasi'),
          makeItem('movie', 4, 'İstanbullu Gelin'),
        ],
        series: [makeItem('series', 5, 'İstasyon 19')],
        live: [makeItem('live', 6, 'İstanbul TV')],
      });

      const suggestions = buildSearchPopupSuggestions(results, 'ist');
      expect(suggestions).toHaveLength(3);
      expect(suggestions.map((s) => s.title)).toEqual([
        'İstanbul Hatırası',
        'İstanbullu Gelin',
        'İstasyon 19',
      ]);
      expect(suggestions.map((s) => s.kind)).toEqual(['movie', 'movie', 'series']);
    });

    it('falls back to substring and alias hits when fewer than 3 prefix matches exist', () => {
      const results = makeResults({
        movies: [makeItem('movie', 1, 'Aliens'), makeItem('movie', 2, 'Director Cut Special')],
        series: [makeItem('series', 3, 'Star Trek')],
        live: [makeItem('live', 4, 'Star News Live')],
      });

      const suggestions = buildSearchPopupSuggestions(results, 'star', 3);
      expect(suggestions.map((s) => s.title)).toEqual(['Star Trek', 'Star News Live', 'Aliens']);
    });
  });

  describe('buildSearchPopupNavRows & stepSearchPopupFocus', () => {
    it('builds only non-empty rows in strict Movies -> Series -> Live -> View all order', () => {
      const rows = buildSearchPopupNavRows({
        hasClear: true,
        suggestionCount: 2,
        movieCount: 3,
        seriesCount: 0,
        liveCount: 2,
        hasViewAll: true,
      });

      expect(rows).toEqual([
        { id: 'input', count: 2 },
        { id: 'suggestions', count: 2 },
        { id: 'movies', count: 3 },
        { id: 'live', count: 2 },
        { id: 'viewAll', count: 1 },
      ]);
    });

    it('steps cleanly across 2D rows, clamps column indices, and reports edgeTop on Up at row 0', () => {
      const rows = buildSearchPopupNavRows({
        hasClear: true,
        suggestionCount: 3,
        movieCount: 2,
        seriesCount: 4,
        liveCount: 1,
        hasViewAll: true,
      });

      expect(stepSearchPopupFocus(rows, { rowId: 'input', col: 0 }, 'up')).toEqual({
        position: null,
        edgeTop: true,
      });
      expect(stepSearchPopupFocus(rows, { rowId: 'input', col: 0 }, 'right')).toEqual({
        position: { rowId: 'input', col: 1 },
        edgeTop: false,
      });
      expect(stepSearchPopupFocus(rows, { rowId: 'series', col: 3 }, 'down')).toEqual({
        position: { rowId: 'live', col: 0 },
        edgeTop: false,
      });
      expect(stepSearchPopupFocus(rows, { rowId: 'live', col: 0 }, 'down')).toEqual({
        position: { rowId: 'viewAll', col: 0 },
        edgeTop: false,
      });
      expect(stepSearchPopupFocus(rows, { rowId: 'viewAll', col: 0 }, 'up')).toEqual({
        position: { rowId: 'live', col: 0 },
        edgeTop: false,
      });
    });
  });
});
