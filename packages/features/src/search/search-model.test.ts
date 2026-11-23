import type {
  ItemRow,
  SearchEpisodeHit,
  SearchProgrammeHit,
  SearchResults,
  WatchProgressRow,
} from '@elv/data';
import { describe, expect, it } from 'vitest';
import {
  addRecentSearch,
  buildEpgSearchPlayTarget,
  buildEpisodeSearchPlayTarget,
  buildLiveSearchPlayTarget,
  buildSearchNavRows,
  computeSearchProgressRatio,
  countScopeResults,
  EMPTY_SEARCH_RESULTS,
  formatSearchProgrammeTime,
  MAX_RECENT_SEARCHES,
  MAX_SEARCH_QUERY_CHARS,
  SEARCH_DEBOUNCE_MS,
  SEARCH_RESULT_LIMIT,
  SEARCH_SCOPES,
  SEARCH_SUGGESTIONS_LIMIT,
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

function makeProgrammeHit(
  index: number,
  overrides: Partial<SearchProgrammeHit> = {},
): SearchProgrammeHit {
  return {
    sourceId: 'src-1',
    guideId: `g-${index + 1}`,
    channelKey: `live:s1:${index + 1}`,
    channelName: `Channel ${index + 1}`,
    channelLogoUrl: `https://art.example.test/ch-${index + 1}.png`,
    title: `Programme ${index + 1}`,
    description: `Description ${index + 1}`,
    start: 1_700_000_000_000,
    stop: 1_700_003_600_000,
    category: 'Sports',
    isLiveNow: true,
    ...overrides,
  };
}

function makeEpisodeHit(
  index: number,
  overrides: Partial<SearchEpisodeHit> = {},
): SearchEpisodeHit {
  return {
    sourceId: 'src-1',
    itemKey: `episode:s1:${index + 1}`,
    seriesKey: 'series:s1:1',
    seriesName: 'Sample Show',
    season: 2,
    episode: index + 1,
    title: `Episode ${index + 1}`,
    posterUrl: 'https://art.example.test/series-1.png',
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
  it('exposes canonical constants and empty search snapshot (#397)', () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(150);
    expect(MAX_RECENT_SEARCHES).toBe(8);
    expect(SEARCH_SUGGESTIONS_LIMIT).toBe(8);
    expect(SEARCH_RESULT_LIMIT).toBe(40);
    expect(MAX_SEARCH_QUERY_CHARS).toBe(256);
    expect(SEARCH_SCOPES).toEqual(['all', 'live', 'epg', 'movie', 'series', 'episode']);
    expect(EMPTY_SEARCH_RESULTS).toEqual({
      live: [],
      epg: [],
      movies: [],
      series: [],
      episodes: [],
    });
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

    it('deduplicates locale-independently (including Turkish İ/ı) and moves existing term to the front', () => {
      const next = addRecentSearch(['Pitch', 'İstanbul', 'Cinema'], '  istanbul ');
      expect(next).toEqual(['istanbul', 'Pitch', 'Cinema']);
      expect(addRecentSearch(['Işık', 'Drama'], 'ISIK')).toEqual(['ISIK', 'Drama']);
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
      epg: [makeProgrammeHit(0), makeProgrammeHit(1), makeProgrammeHit(2), makeProgrammeHit(3)],
      movies: [makeItem('movie', 0), makeItem('movie', 1), makeItem('movie', 2)],
      series: [makeItem('series', 0)],
      episodes: [makeEpisodeHit(0), makeEpisodeHit(1)],
    };

    it('counts total matches for all and per-kind scopes including epg and episode (#397)', () => {
      expect(countScopeResults(sample, 'all')).toBe(12);
      expect(countScopeResults(sample, 'live')).toBe(2);
      expect(countScopeResults(sample, 'epg')).toBe(4);
      expect(countScopeResults(sample, 'movie')).toBe(3);
      expect(countScopeResults(sample, 'series')).toBe(1);
      expect(countScopeResults(sample, 'episode')).toBe(2);
      expect(countScopeResults(EMPTY_SEARCH_RESULTS, 'all')).toBe(0);
    });
  });

  describe('buildLiveSearchPlayTarget, buildEpgSearchPlayTarget & buildEpisodeSearchPlayTarget', () => {
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

    it('builds live PlayTarget from EPG programme hit and VOD PlayTarget from episode hit (#397)', () => {
      const prog = makeProgrammeHit(0, {
        channelKey: 'live:s1:9',
        channelName: 'TRT 1',
        title: 'Gece Bülteni',
      });
      expect(buildEpgSearchPlayTarget(prog)).toEqual({
        itemKey: 'live:s1:9',
        sourceId: 'src-1',
        title: 'TRT 1',
        subtitle: 'Gece Bülteni',
        kind: 'live',
        logo: prog.channelLogoUrl,
        itemKind: 'live',
      });

      const ep = makeEpisodeHit(2, {
        itemKey: 'ep:s1:303',
        seriesKey: 'series:s1:10',
        seriesName: 'Kuzey Rüzgarı',
        season: 3,
        episode: 4,
        title: 'Fırtına',
      });
      expect(
        buildEpisodeSearchPlayTarget(ep, makeProgress({ positionMs: 125_000, watched: false })),
      ).toEqual({
        itemKey: 'ep:s1:303',
        sourceId: 'src-1',
        title: 'Kuzey Rüzgarı — Fırtına',
        subtitle: 'S3 E4 · Fırtına',
        kind: 'vod',
        itemKind: 'episode',
        seriesKey: 'series:s1:10',
        season: 3,
        episode: 4,
        logo: ep.posterUrl,
        startPositionMs: 120_000,
      });

      const untitledEp = makeEpisodeHit(0, { title: '   ' });
      expect(buildEpisodeSearchPlayTarget(untitledEp)).toEqual(
        expect.objectContaining({
          title: 'Sample Show — S2 E1',
          subtitle: 'S2 E1',
        }),
      );

      expect(buildEpisodeSearchPlayTarget(ep, undefined, 'S3 B4')).toEqual(
        expect.objectContaining({
          title: 'Kuzey Rüzgarı — Fırtına',
          subtitle: 'S3 B4 · Fırtına',
        }),
      );
      expect(buildEpisodeSearchPlayTarget(untitledEp, undefined, 'S2 B1')).toEqual(
        expect.objectContaining({
          title: 'Sample Show — S2 B1',
          subtitle: 'S2 B1',
        }),
      );
    });

    it('formats programme timestamps as HH:MM and guards non-finite input', () => {
      expect(formatSearchProgrammeTime(Number.NaN)).toBe('--:--');
      expect(formatSearchProgrammeTime(1_700_000_000_000)).toMatch(/^\d{2}:\d{2}$/);
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
    it('builds input, scopes, recent, and suggestions rows when query is empty (#397)', () => {
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
        { id: 'scopes', count: 6 },
      ]);

      expect(
        buildSearchNavRows({
          hasQuery: false,
          hasClearButton: true,
          scope: 'all',
          recentCount: 2,
          suggestionCount: 5,
          liveCount: 0,
          movieCount: 0,
          seriesCount: 0,
          searching: false,
          hasSearched: false,
        }),
      ).toEqual([
        { id: 'input', count: 2 },
        { id: 'scopes', count: 6 },
        { id: 'recent', count: 3 },
        { id: 'suggestions', count: 5 },
      ]);
    });

    it('includes clear button on input row and filters visible result sections across all 6 scopes (#397)', () => {
      expect(
        buildSearchNavRows({
          hasQuery: true,
          scope: 'all',
          recentCount: 2,
          liveCount: 4,
          epgCount: 3,
          movieCount: 6,
          seriesCount: 2,
          episodeCount: 5,
          liveColumns: 3,
          epgColumns: 3,
          vodColumns: 5,
          episodeColumns: 3,
          searching: false,
          hasSearched: true,
        }),
      ).toEqual([
        { id: 'input', count: 2 },
        { id: 'scopes', count: 6 },
        { id: 'live', count: 4, columns: 3 },
        { id: 'epg', count: 3, columns: 3 },
        { id: 'movies', count: 6, columns: 5 },
        { id: 'series', count: 2, columns: 5 },
        { id: 'episodes', count: 5, columns: 3 },
      ]);

      expect(
        buildSearchNavRows({
          hasQuery: true,
          scope: 'epg',
          recentCount: 0,
          liveCount: 4,
          epgCount: 3,
          movieCount: 6,
          seriesCount: 2,
          episodeCount: 5,
          epgColumns: 3,
          searching: false,
          hasSearched: true,
        }),
      ).toEqual([
        { id: 'input', count: 2 },
        { id: 'scopes', count: 6 },
        { id: 'epg', count: 3, columns: 3 },
      ]);

      expect(
        buildSearchNavRows({
          hasQuery: true,
          scope: 'episode',
          recentCount: 0,
          liveCount: 4,
          epgCount: 3,
          movieCount: 6,
          seriesCount: 2,
          episodeCount: 5,
          episodeColumns: 3,
          searching: false,
          hasSearched: true,
        }),
      ).toEqual([
        { id: 'input', count: 2 },
        { id: 'scopes', count: 6 },
        { id: 'episodes', count: 5, columns: 3 },
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
        { id: 'scopes', count: 6 },
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
        { id: 'scopes', count: 6 },
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
