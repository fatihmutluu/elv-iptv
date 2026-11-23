import {
  computeResumePositionMs,
  foldText,
  type ItemRow,
  type SearchEpisodeHit,
  type SearchProgrammeHit,
  type SearchResults,
  type SearchScope,
  type WatchProgressRow,
} from '@elv/data';
import type { PlayTarget } from '../ports/play-target';

/** Debounce interval (ms) before firing a catalog FTS5 search after typing. */
export const SEARCH_DEBOUNCE_MS = 150;

/** Maximum number of recent search queries retained in history. */
export const MAX_RECENT_SEARCHES = 8;

/** Default number of on-device idle search suggestions loaded by `SearchScreen` (`#397`). */
export const SEARCH_SUGGESTIONS_LIMIT = 8;

/** Per-kind FTS5 result limit requested by `SearchScreen`. */
export const SEARCH_RESULT_LIMIT = 40;

/** Maximum character length accepted for a single catalog search query. */
export const MAX_SEARCH_QUERY_CHARS = 256;

/** Ordered Cinema Quietude search scope tabs (`#397`). */
export const SEARCH_SCOPES: readonly SearchScope[] = [
  'all',
  'live',
  'epg',
  'movie',
  'series',
  'episode',
];

/** Shared empty search result snapshot (`#397`). */
export const EMPTY_SEARCH_RESULTS: SearchResults = {
  live: [],
  epg: [],
  movies: [],
  series: [],
  episodes: [],
};

/** Focusable 10-ft TV navigation rows inside `SearchScreen` (`#397`). */
export type SearchNavRowId =
  | 'input'
  | 'scopes'
  | 'recent'
  | 'suggestions'
  | 'live'
  | 'epg'
  | 'movies'
  | 'series'
  | 'episodes'
  | 'clearEmpty';

/** Focused result section identifier used for TV scroll alignment (`#397`). */
export type SearchResultSectionId = 'live' | 'epg' | 'movies' | 'series' | 'episodes';

/** Descriptor of one focusable horizontal row or wrapped multi-column section in `SearchScreen`. */
export interface SearchNavRowDescriptor {
  readonly id: SearchNavRowId;
  readonly count: number;
  readonly columns?: number;
}

/** Input parameters for {@link buildSearchNavRows}. */
export interface BuildSearchNavRowsInput {
  readonly hasQuery: boolean;
  /** True when the clear icon button is rendered (defaults to `hasQuery`). */
  readonly hasClearButton?: boolean;
  readonly scope: SearchScope;
  readonly recentCount: number;
  readonly suggestionCount?: number;
  readonly liveCount: number;
  readonly epgCount?: number;
  readonly movieCount: number;
  readonly seriesCount: number;
  readonly episodeCount?: number;
  readonly liveColumns?: number;
  readonly epgColumns?: number;
  readonly vodColumns?: number;
  readonly episodeColumns?: number;
  readonly searching: boolean;
  readonly hasSearched: boolean;
}

/** Active 2D TV focus coordinate inside `SearchScreen`. */
export interface SearchFocusPosition {
  readonly rowId: SearchNavRowId;
  readonly col: number;
}

/** Directional D-pad movement supported by {@link stepSearchFocus}. */
export type SearchNavDirection = 'up' | 'down' | 'left' | 'right';

/** Outcome of one {@link stepSearchFocus} navigation step. */
export interface SearchFocusStepResult {
  readonly position: SearchFocusPosition | null;
  readonly edgeTop: boolean;
}

/**
 * Normalizes a raw user search input before dispatching to `CatalogService.search`: replaces any
 * ASCII control character (`< 0x20` or `0x7f`) with a single space, trims, and caps at
 * {@link MAX_SEARCH_QUERY_CHARS}.
 */
export function sanitizeSearchQuery(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? ' ' : raw[i];
  }
  return out.trim().slice(0, MAX_SEARCH_QUERY_CHARS);
}

/**
 * Normalizes and records `rawQuery` at the front of `recent` history: trims whitespace, ignores
 * blank queries, deduplicates locale-independently via `foldText` (handling Turkish `İ`/`ı` and
 * diacritics cleanly), and caps at {@link MAX_RECENT_SEARCHES}.
 */
export function addRecentSearch(recent: readonly string[], rawQuery: string): string[] {
  const trimmed = rawQuery.trim();
  if (trimmed === '') return recent.slice(0, MAX_RECENT_SEARCHES);
  const key = foldText(trimmed) || trimmed.toLowerCase();
  const deduped = recent.filter((entry) => {
    const entryKey = foldText(entry) || entry.trim().toLowerCase();
    return entryKey !== key;
  });
  return [trimmed, ...deduped].slice(0, MAX_RECENT_SEARCHES);
}

/** Counts total search matches visible under `scope` (`#397`). */
export function countScopeResults(results: SearchResults, scope: SearchScope): number {
  const epgCount = results.epg?.length ?? 0;
  const episodeCount = results.episodes?.length ?? 0;
  if (scope === 'live') return results.live.length;
  if (scope === 'epg') return epgCount;
  if (scope === 'movie') return results.movies.length;
  if (scope === 'series') return results.series.length;
  if (scope === 'episode') return episodeCount;
  return (
    results.live.length + epgCount + results.movies.length + results.series.length + episodeCount
  );
}

/** Builds a playback-ready live {@link PlayTarget} from a searched live channel {@link ItemRow}. */
export function buildLiveSearchPlayTarget(item: ItemRow): PlayTarget {
  return {
    itemKey: item.key,
    sourceId: item.sourceId,
    title: item.num !== null ? `${item.num}. ${item.name}` : item.name,
    kind: 'live',
    logo: item.logo,
    itemKind: 'live',
  };
}

/** Builds a playback-ready live {@link PlayTarget} from a searched EPG programme hit (`#397`). */
export function buildEpgSearchPlayTarget(hit: SearchProgrammeHit): PlayTarget {
  return {
    itemKey: hit.channelKey,
    sourceId: hit.sourceId,
    title: hit.channelName,
    subtitle: hit.title,
    kind: 'live',
    logo: hit.channelLogoUrl,
    itemKind: 'live',
  };
}

/** Builds a playback-ready VOD episode {@link PlayTarget} from a searched episode hit (`#397`). */
export function buildEpisodeSearchPlayTarget(
  hit: SearchEpisodeHit,
  progress?: WatchProgressRow,
  episodeLabel?: string,
): PlayTarget {
  const trimmedTitle = hit.title.trim();
  const code = episodeLabel?.trim() || `S${hit.season} E${hit.episode}`;
  const subtitle = trimmedTitle.length > 0 ? `${code} · ${trimmedTitle}` : code;
  const title =
    trimmedTitle.length > 0 ? `${hit.seriesName} — ${trimmedTitle}` : `${hit.seriesName} — ${code}`;
  const startPositionMs = progress !== undefined ? computeResumePositionMs(progress) : 0;
  return {
    itemKey: hit.itemKey,
    sourceId: hit.sourceId,
    title,
    subtitle,
    kind: 'vod',
    itemKind: 'episode',
    seriesKey: hit.seriesKey,
    season: hit.season,
    episode: hit.episode,
    logo: hit.posterUrl,
    ...(startPositionMs > 0 ? { startPositionMs } : {}),
  };
}

/** Formats an epoch timestamp in milliseconds as 24-hour `HH:MM` for EPG search cards (`#397`). */
export function formatSearchProgrammeTime(ms: number): string {
  if (!Number.isFinite(ms)) return '--:--';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Returns a clamped `[0, 1]` progress bar ratio for unwatched in-progress VOD items. */
export function computeSearchProgressRatio(
  progress: WatchProgressRow | undefined,
): number | undefined {
  if (progress === undefined || progress.watched) return undefined;
  if (
    !Number.isFinite(progress.positionMs) ||
    !Number.isFinite(progress.durationMs) ||
    progress.positionMs <= 0 ||
    progress.durationMs <= 0
  ) {
    return undefined;
  }
  return Math.min(1, Math.max(0, progress.positionMs / progress.durationMs));
}

function makeSectionRow(
  id: SearchResultSectionId,
  count: number,
  columns: number | undefined,
): SearchNavRowDescriptor {
  return columns !== undefined && columns > 0
    ? { id, count, columns: Math.floor(columns) }
    : { id, count };
}

/** Builds the ordered 10-ft TV focusable row/section descriptors for `SearchScreen` (`#397`). */
export function buildSearchNavRows(input: BuildSearchNavRowsInput): SearchNavRowDescriptor[] {
  const hasClearButton = input.hasClearButton ?? input.hasQuery;
  const rows: SearchNavRowDescriptor[] = [
    { id: 'input', count: hasClearButton ? 2 : 1 },
    { id: 'scopes', count: SEARCH_SCOPES.length },
  ];

  if (!input.hasQuery) {
    if (input.recentCount > 0) {
      rows.push({ id: 'recent', count: input.recentCount + 1 });
    }
    const suggestionCount = input.suggestionCount ?? 0;
    if (suggestionCount > 0) {
      rows.push({ id: 'suggestions', count: suggestionCount });
    }
    return rows;
  }

  if (input.searching && !input.hasSearched) {
    return rows;
  }

  const showLive = input.scope === 'all' || input.scope === 'live';
  const showEpg = input.scope === 'all' || input.scope === 'epg';
  const showMovies = input.scope === 'all' || input.scope === 'movie';
  const showSeries = input.scope === 'all' || input.scope === 'series';
  const showEpisodes = input.scope === 'all' || input.scope === 'episode';

  const epgCount = input.epgCount ?? 0;
  const episodeCount = input.episodeCount ?? 0;

  let visibleResults = 0;
  if (showLive && input.liveCount > 0) {
    rows.push(makeSectionRow('live', input.liveCount, input.liveColumns));
    visibleResults += input.liveCount;
  }
  if (showEpg && epgCount > 0) {
    rows.push(makeSectionRow('epg', epgCount, input.epgColumns ?? input.liveColumns));
    visibleResults += epgCount;
  }
  if (showMovies && input.movieCount > 0) {
    rows.push(makeSectionRow('movies', input.movieCount, input.vodColumns));
    visibleResults += input.movieCount;
  }
  if (showSeries && input.seriesCount > 0) {
    rows.push(makeSectionRow('series', input.seriesCount, input.vodColumns));
    visibleResults += input.seriesCount;
  }
  if (showEpisodes && episodeCount > 0) {
    rows.push(makeSectionRow('episodes', episodeCount, input.episodeColumns ?? input.liveColumns));
    visibleResults += episodeCount;
  }

  if (visibleResults === 0 && !input.searching) {
    rows.push({ id: 'clearEmpty', count: 1 });
  }
  return rows;
}

/**
 * Pure 2D D-pad focus transition across `SearchScreen` rows and multi-column wrapped result grids.
 * Sets `edgeTop: true` when pressing `up` from the top row so the caller can hand focus to the top nav.
 */
export function stepSearchFocus(
  rows: readonly SearchNavRowDescriptor[],
  current: SearchFocusPosition,
  direction: SearchNavDirection,
): SearchFocusStepResult {
  if (rows.length === 0) {
    return { position: null, edgeTop: direction === 'up' };
  }

  const rowIdx = rows.findIndex((r) => r.id === current.rowId);
  if (rowIdx === -1) {
    const first = rows[0];
    return { position: first ? { rowId: first.id, col: 0 } : null, edgeTop: false };
  }

  const row = rows[rowIdx];
  if (!row) return { position: null, edgeTop: false };

  const col = Math.min(Math.max(0, Math.floor(current.col)), row.count - 1);
  const cols = row.columns !== undefined && row.columns > 0 ? Math.floor(row.columns) : row.count;

  if (direction === 'left') {
    return { position: { rowId: row.id, col: Math.max(0, col - 1) }, edgeTop: false };
  }
  if (direction === 'right') {
    return {
      position: { rowId: row.id, col: Math.min(row.count - 1, col + 1) },
      edgeTop: false,
    };
  }

  const visualRow = Math.floor(col / cols);
  const visualCol = col % cols;

  if (direction === 'down') {
    const lastVisualRow = Math.floor((row.count - 1) / cols);
    if (visualRow < lastVisualRow) {
      return {
        position: { rowId: row.id, col: Math.min(row.count - 1, col + cols) },
        edgeTop: false,
      };
    }
    const nextRow = rows[rowIdx + 1];
    if (!nextRow) return { position: { rowId: row.id, col }, edgeTop: false };
    return {
      position: { rowId: nextRow.id, col: Math.min(nextRow.count - 1, visualCol) },
      edgeTop: false,
    };
  }

  if (visualRow > 0) {
    return {
      position: { rowId: row.id, col: Math.max(0, col - cols) },
      edgeTop: false,
    };
  }
  const prevRow = rows[rowIdx - 1];
  if (!prevRow) return { position: { rowId: row.id, col }, edgeTop: true };

  const prevCols =
    prevRow.columns !== undefined && prevRow.columns > 0
      ? Math.floor(prevRow.columns)
      : prevRow.count;
  const prevLastVisualRow = Math.floor((prevRow.count - 1) / prevCols);
  const targetCol = Math.min(
    prevRow.count - 1,
    prevLastVisualRow * prevCols + Math.min(visualCol, prevCols - 1),
  );
  return { position: { rowId: prevRow.id, col: targetCol }, edgeTop: false };
}
