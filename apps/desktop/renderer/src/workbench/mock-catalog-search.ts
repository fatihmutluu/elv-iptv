import {
  type AlphabetBucket,
  type AlphabetIndexInput,
  type BrowseKind,
  cleanDisplayTitle,
  DEFAULT_PROFILE_ID,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SEARCH_SUGGESTIONS_LIMIT,
  type FavoriteRow,
  foldText,
  type ItemRow,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_SUGGESTIONS_LIMIT,
  MAX_SEARCH_TOKENS,
  type SearchEpisodeHit,
  type SearchItemHit,
  type SearchMatchedBy,
  type SearchOptions,
  type SearchProgrammeHit,
  type SearchResults,
  type SearchSuggestion,
  type SearchSuggestionsOptions,
  type SourceRow,
  sortTitleKey,
  type WatchProgressRow,
} from '@elv/data';
import type { ContentKind } from '@elv/domain';
import {
  DEMO_SOURCE_ID,
  makeWorkbenchEpisodes,
  WORKBENCH_CATEGORIES,
  WORKBENCH_CREDITS,
  WORKBENCH_ITEMS_BY_CATEGORY,
  WORKBENCH_ITEMS_BY_KEY,
} from './mock-catalog-data.ts';
import { buildWorkbenchEpgWindow } from './mock-catalog-epg.ts';

const EPG_SEARCH_SPAN_MS = 6 * 3_600_000;
const BUCKET_ORDER = [
  '#',
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
  'P',
  'Q',
  'R',
  'S',
  'T',
  'U',
  'V',
  'W',
  'X',
  'Y',
  'Z',
  '…',
] as const;

export const normWorkbenchProfile = (profileId?: string): string => {
  const t = profileId?.trim();
  return t && t.length > 0 ? t : DEFAULT_PROFILE_ID;
};

export const clampWorkbenchLimit = (
  limit: number | undefined,
  fallback: number,
  max: number,
): number => {
  const n = limit === undefined || !Number.isFinite(limit) ? fallback : Math.floor(limit);
  return Math.min(max, Math.max(0, n));
};

export function workbenchItemSortKey(name: string): string {
  return sortTitleKey(cleanDisplayTitle(name));
}

function bucketLetterForName(name: string): string {
  const first = workbenchItemSortKey(name).charAt(0);
  if (first < 'a') return '#';
  if (first <= 'z') return first.toUpperCase();
  return '…';
}

const toWords = (raw: string | undefined): readonly string[] =>
  raw ? foldText(raw).split(/\s+/).filter(Boolean) : [];

const WORKBENCH_SEARCH_INDEX: readonly {
  readonly row: ItemRow;
  readonly titleWords: readonly string[];
  readonly castWords: readonly string[];
  readonly directorWords: readonly string[];
}[] = [...WORKBENCH_ITEMS_BY_KEY.values()].map((row) => {
  const credits = WORKBENCH_CREDITS[row.key];
  return {
    row,
    titleWords: toWords(row.name),
    castWords: toWords(credits?.cast),
    directorWords: toWords(credits?.director),
  };
});

const WORKBENCH_EPISODE_SEARCH_INDEX: readonly {
  readonly hit: SearchEpisodeHit;
  readonly words: readonly string[];
}[] = [...WORKBENCH_ITEMS_BY_KEY.values()]
  .filter((row) => row.kind === 'series')
  .flatMap((series) =>
    [1, 2].flatMap((season) =>
      makeWorkbenchEpisodes(series.id, season).map((ep) => {
        const title = ep.title ?? '';
        return {
          hit: {
            sourceId: DEMO_SOURCE_ID,
            itemKey: ep.key,
            seriesKey: series.key,
            seriesName: series.name,
            season: ep.season,
            episode: ep.episode ?? 1,
            title,
            posterUrl: series.logo,
          },
          words: toWords(`${series.name} ${title}`),
        };
      }),
    ),
  );

function matchesTokens(words: readonly string[], tokens: readonly string[]): boolean {
  return words.length > 0 && tokens.every((tok) => words.some((w) => w.startsWith(tok)));
}

function matchItemHit(
  entry: (typeof WORKBENCH_SEARCH_INDEX)[number],
  tokens: readonly string[],
): SearchMatchedBy | undefined {
  const hasCredits = entry.row.kind === 'movie' || entry.row.kind === 'series';
  if (matchesTokens(entry.titleWords, tokens)) {
    return 'title';
  }
  if (!hasCredits) return undefined;
  const combined = [...entry.titleWords, ...entry.castWords, ...entry.directorWords];
  if (!matchesTokens(combined, tokens)) return undefined;
  if (matchesTokens(entry.castWords, tokens)) return 'cast';
  if (matchesTokens(entry.directorWords, tokens)) return 'director';
  if (tokens.some((tok) => entry.castWords.some((w) => w.startsWith(tok)))) return 'cast';
  return 'director';
}

/** Runs folded prefix search across workbench live, EPG, movies, series, and episodes (`#397`). */
export function runWorkbenchSearch(
  sources: readonly SourceRow[],
  query: string,
  opts?: SearchOptions,
): SearchResults {
  const empty: SearchResults = { live: [], epg: [], movies: [], series: [], episodes: [] };
  const limit = clampWorkbenchLimit(opts?.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const tokens = foldText(query).split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TOKENS);
  if (limit === 0 || tokens.length === 0) return empty;
  const scope = opts?.scope ?? 'all';
  const activeSources = sources.filter(
    (s) => !s.needsImport && (opts?.sourceId === undefined || s.id === opts.sourceId),
  );
  if (activeSources.length === 0) return empty;
  const sourceId = activeSources[0]?.id ?? DEMO_SOURCE_ID;
  const nowMs = opts?.nowMs !== undefined && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();

  const collectItems = (kind: BrowseKind): SearchItemHit[] => {
    if (scope !== 'all' && scope !== kind) return [];
    const hasCredits = kind === 'movie' || kind === 'series';
    const out: SearchItemHit[] = [];
    for (const entry of WORKBENCH_SEARCH_INDEX) {
      if (entry.row.kind !== kind) continue;
      const matchedBy = matchItemHit(entry, tokens);
      if (matchedBy === undefined) continue;
      out.push({
        ...entry.row,
        sourceId,
        ...(hasCredits ? { matchedBy } : {}),
      });
      if (out.length >= limit) break;
    }
    return out;
  };

  const collectEpg = (): SearchProgrammeHit[] => {
    if (scope !== 'all' && scope !== 'epg') return [];
    const liveChannels = [...WORKBENCH_ITEMS_BY_KEY.values()].filter((r) => r.kind === 'live');
    const win = buildWorkbenchEpgWindow(
      liveChannels.map((c) => c.key),
      Math.max(0, nowMs - 3_600_000),
      nowMs + EPG_SEARCH_SPAN_MS,
      sourceId,
    );
    const candidates: SearchProgrammeHit[] = [];
    for (const ch of liveChannels) {
      const progs = win[ch.key] ?? [];
      for (const prog of progs) {
        const words = toWords(`${prog.title} ${prog.description ?? ''} ${ch.name}`);
        if (!matchesTokens(words, tokens)) continue;
        candidates.push({
          sourceId,
          guideId: prog.guideId,
          channelKey: ch.key,
          channelName: ch.name,
          channelLogoUrl: ch.logo,
          title: prog.title,
          description: prog.description,
          start: prog.start,
          stop: prog.stop,
          category: prog.genre === 'other' ? null : prog.genre,
          isLiveNow: prog.start <= nowMs && prog.stop > nowMs,
        });
      }
    }
    candidates.sort((a, b) => {
      const aActiveOrFuture = a.stop >= nowMs ? 0 : 1;
      const bActiveOrFuture = b.stop >= nowMs ? 0 : 1;
      if (aActiveOrFuture !== bActiveOrFuture) return aActiveOrFuture - bActiveOrFuture;
      const aLive = a.isLiveNow ? 0 : 1;
      const bLive = b.isLiveNow ? 0 : 1;
      if (aLive !== bLive) return aLive - bLive;
      return a.start - b.start || a.channelName.localeCompare(b.channelName);
    });
    return candidates.slice(0, limit);
  };

  const collectEpisodes = (): SearchEpisodeHit[] => {
    if (scope !== 'all' && scope !== 'episode') return [];
    const out: SearchEpisodeHit[] = [];
    for (const entry of WORKBENCH_EPISODE_SEARCH_INDEX) {
      if (matchesTokens(entry.words, tokens)) {
        out.push({ ...entry.hit, sourceId });
        if (out.length >= limit) break;
      }
    }
    return out;
  };

  return {
    live: collectItems('live'),
    epg: collectEpg(),
    movies: collectItems('movie'),
    series: collectItems('series'),
    episodes: collectEpisodes(),
  };
}

/** Builds deduplicated on-device idle search suggestions for the UI Workbench (`#397`). */
export function buildWorkbenchSearchSuggestions(
  sources: readonly SourceRow[],
  favorites: ReadonlyMap<string, FavoriteRow>,
  progress: ReadonlyMap<string, WatchProgressRow>,
  recentChannels: ReadonlyMap<
    string,
    { profileId: string; sourceId: string; itemKey: string; watchedAt: number }
  >,
  options?: SearchSuggestionsOptions,
): readonly SearchSuggestion[] {
  const limit = clampWorkbenchLimit(
    options?.limit,
    DEFAULT_SEARCH_SUGGESTIONS_LIMIT,
    MAX_SEARCH_SUGGESTIONS_LIMIT,
  );
  if (limit === 0) return [];
  const pid = normWorkbenchProfile(options?.profileId);
  const srcFilter = options?.sourceId?.trim() || undefined;
  const activeIds = new Set(
    sources
      .filter((s) => !s.needsImport && (srcFilter === undefined || s.id === srcFilter))
      .map((s) => s.id),
  );
  if (activeIds.size === 0) return [];
  const fallbackSourceId = [...activeIds][0] ?? DEMO_SOURCE_ID;

  const out: SearchSuggestion[] = [];
  const seenFolds = new Set<string>();
  const seenKeys = new Set<string>();
  const pushUnique = (suggestion: SearchSuggestion): void => {
    if (out.length >= limit) return;
    const label = suggestion.label.trim();
    if (label === '') return;
    const folded = foldText(label);
    if (folded === '' || seenFolds.has(folded)) return;
    if (suggestion.itemKey !== undefined && seenKeys.has(suggestion.itemKey)) return;
    seenFolds.add(folded);
    if (suggestion.itemKey !== undefined) seenKeys.add(suggestion.itemKey);
    out.push({ ...suggestion, label, query: suggestion.query.trim() || label });
  };

  const favRows = [...favorites.values()]
    .filter((f) => f.profileId === pid && activeIds.has(f.sourceId))
    .sort((a, b) => b.addedAt - a.addedAt);
  for (const fav of favRows) {
    if (fav.kind === 'episode') continue;
    pushUnique({
      kind: 'favorite',
      label: fav.title,
      query: fav.title,
      itemKind: fav.kind,
      sourceId: fav.sourceId,
      itemKey: fav.itemKey,
    });
  }

  const recentCandidates: Array<{ ts: number; suggestion: SearchSuggestion }> = [];
  for (const wp of progress.values()) {
    if (wp.profileId !== pid || !activeIds.has(wp.sourceId)) continue;
    const itemKind: ContentKind =
      wp.kind === 'live' ? 'live' : wp.kind === 'movie' ? 'movie' : 'series';
    const itemKey = wp.kind === 'episode' && wp.seriesKey ? wp.seriesKey : wp.itemKey;
    recentCandidates.push({
      ts: wp.updatedAt,
      suggestion: {
        kind: 'recent',
        label: wp.title,
        query: wp.title,
        itemKind,
        sourceId: wp.sourceId,
        itemKey,
      },
    });
  }
  for (const rc of recentChannels.values()) {
    if (rc.profileId !== pid || !activeIds.has(rc.sourceId)) continue;
    const ch = WORKBENCH_ITEMS_BY_KEY.get(rc.itemKey);
    if (ch?.kind !== 'live') continue;
    recentCandidates.push({
      ts: rc.watchedAt,
      suggestion: {
        kind: 'recent',
        label: ch.name,
        query: ch.name,
        itemKind: 'live',
        sourceId: rc.sourceId,
        itemKey: rc.itemKey,
      },
    });
  }
  recentCandidates.sort((a, b) => b.ts - a.ts);
  for (const entry of recentCandidates) {
    pushUnique(entry.suggestion);
  }

  const sortedCats = [...WORKBENCH_CATEGORIES].sort(
    (a, b) => b.itemCount - a.itemCount || a.position - b.position,
  );
  for (const cat of sortedCats) {
    pushUnique({
      kind: 'category',
      label: cat.name,
      query: cat.name,
      itemKind: cat.kind,
      sourceId: fallbackSourceId,
      categoryId: cat.id.replace(DEMO_SOURCE_ID, fallbackSourceId),
    });
  }

  return out;
}

/** Computes `#`, `A..Z` prefix buckets and cumulative offsets for the UI Workbench (`#407`). */
export function buildWorkbenchAlphabetIndex(
  sources: readonly SourceRow[],
  progress: ReadonlyMap<string, WatchProgressRow>,
  input: AlphabetIndexInput,
): readonly AlphabetBucket[] {
  const { kind } = input;
  if (kind !== 'live' && kind !== 'movie' && kind !== 'series') return [];
  const srcFilter = input.sourceId?.trim() || undefined;
  const activeSources = sources.filter(
    (s) => !s.needsImport && (srcFilter === undefined || s.id === srcFilter),
  );
  if (activeSources.length === 0) return [];

  let rows: ItemRow[];
  if (input.categoryId !== undefined && input.categoryId.trim() !== '') {
    const parts = input.categoryId.trim().split('|');
    const catKind = parts[1];
    if (catKind !== undefined && catKind !== kind) return [];
    const catSlug = parts.slice(2).join('|') || input.categoryId.trim();
    rows = [...(WORKBENCH_ITEMS_BY_CATEGORY[`${DEMO_SOURCE_ID}|${kind}|${catSlug}`] ?? [])];
  } else {
    rows = [...WORKBENCH_ITEMS_BY_KEY.values()].filter((r) => r.kind === kind);
  }

  if (input.excludeWatched === true) {
    const pid = normWorkbenchProfile(input.profileId);
    rows = rows.filter((r) => progress.get(`${pid}\0${r.key}`)?.watched !== true);
  }

  const counts = new Map<string, number>();
  for (const row of rows) {
    const letter = bucketLetterForName(row.name);
    counts.set(letter, (counts.get(letter) ?? 0) + 1);
  }
  const out: AlphabetBucket[] = [];
  let offset = 0;
  for (const letter of BUCKET_ORDER) {
    const count = counts.get(letter) ?? 0;
    if (count <= 0) continue;
    out.push({ letter, offset, count });
    offset += count;
  }
  return out;
}
