import type { ItemRow, SearchResults, WatchProgressRow } from '@elv/data';
import { describe, expect, it } from 'vitest';
import {
  addRecentSearch,
  buildLiveSearchPlayTarget,
  buildSearchNavRows,
  computeSearchProgressRatio,
  countScopeResults,
  EMPTY_SEARCH_RESULTS,
  MAX_RECENT_SEARCHES,
  MAX_SEARCH_QUERY_CHARS,
  SEARCH_DEBOUNCE_MS,
  SEARCH_RESULT_LIMIT,
  SEARCH_SCOPES,
  sanitizeSearchQuery,
  stepSearchFocus,
} from './search-model';

function makeItem(kind: ItemRow['kind'], index: number, overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: index + 1,
    key: `${kind}:s1:${index + 1}`,
    kind,
    sourceId: 'src-1',
    providerId: String(index + 1),
    name: `${kind} ${index + 1}`,
    logo: `https://art.example.test/${kind}-${index + 1}.png`,
    rating: kind === 'live' ? null : 8.2,
    year: kind === 'live' ? null : 2024,
    num: kind === 'live' ? index + 1 : null,
    ...overrides,
  };
}

function makeProgress(overrides: Partial<WatchProgressRow> = {}): WatchProgressRow {
  return {
    profileId: 'default',
    sourceId: 'src-1',
    itemKey: 'movie:s1:1',
    kind: 'movie',
    title: 'Sample',
    subtitle: null,
    logo: null,
    seriesKey: null,
    season: null,
    episode: null,
    positionMs: 900_000,
    durationMs: 3_600_000,
    watched: false,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('search-model', () => {
  it('exposes canonical constants and empty search snapshot', () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(150);
    expect(MAX_RECENT_SEARCHES).toBe(8);
    expect(SEARCH_RESULT_LIMIT).toBe(40);
    expect(MAX_SEARCH_QUERY_CHARS).toBe(256);
    expect(SEARCH_SCOPES).toEqual(['all', 'live', 'movie', 'series']);
    expect(EMPTY_SEARCH_RESULTS).toEqual({ live: [], movies: [], series: [] });
  });

  describe('sanitizeSearchQuery', () => {
    it('replaces ASCII control chars (< 0x20 and 0x7f) with spaces, trims, and caps at 256 chars', () => {
      expect(sanitizeSearchQuery('  İstanbul\t\nSpor\r\x7fHD  ')).toBe('İstanbul  Spor  HD');
      expect(sanitizeSearchQuery('\x00\x07\t\n\x7f')).toBe('');
      const longQuery = `${'a'.repeat(300)}`;
      expect(sanitizeSearchQuery(longQuery)).toHaveLength(MAX_SEARCH_QUERY_CHARS);
    });
  });

  describe('addRecentSearch', () => {
    it('trims input, prepends most recent, and ignores blank or whitespace-only queries', () => {
      expect(addRecentSearch(['News'], '')).toEqual(['News']);
      expect(addRecentSearch(['News'], '   \t\n ')).toEqual(['News']);
      expect(addRecentSearch(['News'], '  Şampiyonlar  ')).toEqual(['Şampiyonlar', 'News']);
    });

    it('deduplicates case-insensitively and moves existing term to the front', () => {
      const next = addRecentSearch(['BeIN', 'İstanbul', 'Cinema'], '  istanbul ');
      expect(next).toEqual(['istanbul', 'BeIN', 'Cinema']);
    });

    it('caps history at MAX_RECENT_SEARCHES (8)', () => {
      const existing = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'];
      const next = addRecentSearch(existing, 'q9');
      expect(next).toHaveLength(MAX_RECENT_SEARCHES);
      expect(next[0]).toBe('q9');
      expect(next[MAX_RECENT_SEARCHES - 1]).toBe('q7');
      expect(next).not.toContain('q8');
    });
  });

  describe('countScopeResults', () => {
    const sample: SearchResults = {
      live: [makeItem('live', 0), makeItem('live', 1)],
      movies: [makeItem('movie', 0), makeItem('movie', 1), makeItem('movie', 2)],
      series: [makeItem('series', 0)],
    };

    it('counts total matches for all and per-kind scopes', () => {
      expect(countScopeResults(sample, 'all')).toBe(6);
      expect(countScopeResults(sample, 'live')).toBe(2);
      expect(countScopeResults(sample, 'movie')).toBe(3);
      expect(countScopeResults(sample, 'series')).toBe(1);
      expect(countScopeResults(EMPTY_SEARCH_RESULTS, 'all')).toBe(0);
    });
  });

  describe('buildLiveSearchPlayTarget', () => {
    it('prefixes channel number when present and omits it when null', () => {
      const numbered = makeItem('live', 4, { name: 'TRT Spor', num: 5 });
      expect(buildLiveSearchPlayTarget(numbered)).toEqual({
        itemKey: numbered.key,
        sourceId: numbered.sourceId,
        title: '5. TRT Spor',
        kind: 'live',
        logo: numbered.logo,
        itemKind: 'live',
      });

      const unnumbered = makeItem('live', 2, { name: 'Haber Global', num: null, logo: null });
      expect(buildLiveSearchPlayTarget(unnumbered)).toEqual({
        itemKey: unnumbered.key,
        sourceId: unnumbered.sourceId,
        title: 'Haber Global',
        kind: 'live',
        logo: null,
        itemKind: 'live',
      });
    });
  });

  describe('computeSearchProgressRatio', () => {
    it('returns clamped [0, 1] ratio for unwatched in-progress items and undefined otherwise', () => {
      expect(computeSearchProgressRatio(undefined)).toBeUndefined();
      expect(computeSearchProgressRatio(makeProgress({ watched: true }))).toBeUndefined();
      expect(computeSearchProgressRatio(makeProgress({ positionMs: 0 }))).toBeUndefined();
      expect(computeSearchProgressRatio(makeProgress({ durationMs: 0 }))).toBeUndefined();
      expect(computeSearchProgressRatio(makeProgress({ durationMs: Number.NaN }))).toBeUndefined();
      expect(
        computeSearchProgressRatio(makeProgress({ positionMs: 900_000, durationMs: 3_600_000 })),
      ).toBe(0.25);
      expect(
        computeSearchProgressRatio(makeProgress({ positionMs: 5_000_000, durationMs: 3_600_000 })),
      ).toBe(1);
    });
  });

  describe('buildSearchNavRows', () => {
    it('builds input, scopes, and recent rows when query is empty', () => {
      expect(
        buildSearchNavRows({
          hasQuery: false,
          scope: 'all',
          recentCount: 0,
          liveCount: 0,
          movieCount: 0,
          seriesCount: 0,
          searching: false,
          hasSearched: false,
        }),
      ).toEqual([
        { id: 'input', count: 1 },
        { id: 'scopes', count: 4 },
      ]);

      expect(
        buildSearchNavRows({
          hasQuery: false,
          hasClearButton: true,
          scope: 'all',
          recentCount: 0,
          liveCount: 0,
          movieCount: 0,
          seriesCount: 0,
          searching: false,
          hasSearched: false,
        }),
      ).toEqual([
        { id: 'input', count: 2 },
        { id: 'scopes', count: 4 },
      ]);

      expect(
        buildSearchNavRows({
          hasQuery: false,
          scope: 'all',
          recentCount: 3,
          liveCount: 0,
          movieCount: 0,
          seriesCount: 0,
          searching: false,
          hasSearched: false,
        }),
      ).toEqual([
        { id: 'input', count: 1 },
        { id: 'scopes', count: 4 },
        { id: 'recent', count: 4 },
      ]);
    });

    it('includes clear button on input row and filters visible result sections by active scope', () => {
      expect(
        buildSearchNavRows({
          hasQuery: true,
          scope: 'all',
          recentCount: 2,
          liveCount: 4,
          movieCount: 6,
          seriesCount: 2,
          liveColumns: 3,
          vodColumns: 5,
          searching: false,
          hasSearched: true,
        }),
      ).toEqual([
        { id: 'input', count: 2 },
        { id: 'scopes', count: 4 },
        { id: 'live', count: 4, columns: 3 },
        { id: 'movies', count: 6, columns: 5 },
        { id: 'series', count: 2, columns: 5 },
      ]);

      expect(
        buildSearchNavRows({
          hasQuery: true,
          scope: 'movie',
          recentCount: 2,
          liveCount: 4,
          movieCount: 6,
          seriesCount: 2,
          vodColumns: 5,
          searching: false,
          hasSearched: true,
        }),
      ).toEqual([
        { id: 'input', count: 2 },
        { id: 'scopes', count: 4 },
        { id: 'movies', count: 6, columns: 5 },
      ]);
    });

    it('emits clearEmpty when settled with zero matches in active scope, and omits during initial skeleton', () => {
      expect(
        buildSearchNavRows({
          hasQuery: true,
          scope: 'series',
          recentCount: 0,
          liveCount: 2,
          movieCount: 1,
          seriesCount: 0,
          searching: false,
          hasSearched: true,
        }),
      ).toEqual([
        { id: 'input', count: 2 },
        { id: 'scopes', count: 4 },
        { id: 'clearEmpty', count: 1 },
      ]);

      expect(
        buildSearchNavRows({
          hasQuery: true,
          scope: 'all',
          recentCount: 0,
          liveCount: 0,
          movieCount: 0,
          seriesCount: 0,
          searching: true,
          hasSearched: false,
        }),
      ).toEqual([
        { id: 'input', count: 2 },
        { id: 'scopes', count: 4 },
      ]);
    });
  });

  describe('stepSearchFocus', () => {
    const rows = buildSearchNavRows({
      hasQuery: true,
      scope: 'all',
      recentCount: 0,
      liveCount: 4,
      movieCount: 7,
      seriesCount: 2,
      liveColumns: 3,
      vodColumns: 5,
      searching: false,
      hasSearched: true,
    });

    it('signals edgeTop when pressing up on the first row and steps vertically across rows', () => {
      expect(stepSearchFocus(rows, { rowId: 'input', col: 0 }, 'up')).toEqual({
        position: { rowId: 'input', col: 0 },
        edgeTop: true,
      });

      expect(stepSearchFocus(rows, { rowId: 'input', col: 0 }, 'right')).toEqual({
        position: { rowId: 'input', col: 1 },
        edgeTop: false,
      });

      expect(stepSearchFocus(rows, { rowId: 'input', col: 1 }, 'down')).toEqual({
        position: { rowId: 'scopes', col: 1 },
        edgeTop: false,
      });
    });

    it('traverses multi-row wrapped result grids in 2D and clamps partial last rows', () => {
      // live has 4 items in 3 columns: row0=[0,1,2], row1=[3]
      expect(stepSearchFocus(rows, { rowId: 'live', col: 2 }, 'down')).toEqual({
        position: { rowId: 'live', col: 3 },
        edgeTop: false,
      });
      // Down from last visual row of live advances to movies
      expect(stepSearchFocus(rows, { rowId: 'live', col: 3 }, 'down')).toEqual({
        position: { rowId: 'movies', col: 0 },
        edgeTop: false,
      });
      // Up from movies row 1 (col 6 in 5-col grid) moves to movies row 0 (col 1)
      expect(stepSearchFocus(rows, { rowId: 'movies', col: 6 }, 'up')).toEqual({
        position: { rowId: 'movies', col: 1 },
        edgeTop: false,
      });
      // Up from movies row 0 moves to last visual row of live (col 3)
      expect(stepSearchFocus(rows, { rowId: 'movies', col: 1 }, 'up')).toEqual({
        position: { rowId: 'live', col: 3 },
        edgeTop: false,
      });
      // Left/right stay clamped at boundaries
      expect(stepSearchFocus(rows, { rowId: 'series', col: 0 }, 'left')).toEqual({
        position: { rowId: 'series', col: 0 },
        edgeTop: false,
      });
      expect(stepSearchFocus(rows, { rowId: 'series', col: 1 }, 'right')).toEqual({
        position: { rowId: 'series', col: 1 },
        edgeTop: false,
      });
      expect(stepSearchFocus(rows, { rowId: 'series', col: 1 }, 'down')).toEqual({
        position: { rowId: 'series', col: 1 },
        edgeTop: false,
      });
    });

    it('recovers gracefully when current row is missing or rows list is empty', () => {
      expect(stepSearchFocus([], { rowId: 'input', col: 0 }, 'up')).toEqual({
        position: null,
        edgeTop: true,
      });
      expect(stepSearchFocus(rows, { rowId: 'recent', col: 0 }, 'down')).toEqual({
        position: { rowId: 'input', col: 0 },
        edgeTop: false,
      });
    });
  });
});
