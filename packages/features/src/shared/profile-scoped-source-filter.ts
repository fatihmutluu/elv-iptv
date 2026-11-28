import {
  type AlphabetBucket,
  type CatalogService,
  type ParentalQueryOptions,
  parseCategoryId,
  type SourceRow,
  sourceOfKey,
} from '@elv/data';
import { elvError, err, ok } from '@elv/domain';

/** Dynamic active profile and parental-unlock context read at query time. */
export interface ProfileCatalogScope {
  readonly profileId: string;
  readonly parentalUnlocked: boolean;
  /** Optional pre-computed excluded source IDs for `profileId`; derived from `listSources()` when omitted. */
  readonly excludedSourceIds?: ReadonlySet<string>;
  /** When `true`, parental storage reads failed and all catalog reads/streams fail closed. */
  readonly parentalLoadError?: boolean;
}

const failClosedStreamError = () =>
  err(elvError('auth', 'parental-locked', 'Parental controls could not be loaded'));

/** @internal Merges active profile & parental unlock defaults into query options. */
export function mergeParentalOpts<T extends ParentalQueryOptions | undefined>(
  opts: T,
  scope: ProfileCatalogScope,
): T extends undefined ? ParentalQueryOptions : T & ParentalQueryOptions {
  return {
    ...opts,
    profileId: opts?.profileId ?? scope.profileId,
    parentalUnlocked: scope.parentalLoadError
      ? false
      : (opts?.parentalUnlocked ?? scope.parentalUnlocked),
  } as T extends undefined ? ParentalQueryOptions : T & ParentalQueryOptions;
}

const EMPTY_SOURCE_SET: ReadonlySet<string> = new Set();

/** Filters `sources` to only those visible to `profileId` (not listed in `excludedProfileIds`). */
export function filterSourcesForProfile(
  sources: readonly SourceRow[],
  profileId: string,
): SourceRow[] {
  if (profileId === '') return [...sources];
  return sources.filter((source) => !source.excludedProfileIds?.includes(profileId));
}

/** Returns `true` when `key` belongs to a source ID in `excluded`. */
export function isKeyFromExcludedSource(key: string, excluded: ReadonlySet<string>): boolean {
  if (excluded.size === 0) return false;
  const sid = sourceOfKey(key);
  return sid !== undefined && excluded.has(sid);
}

const ALPHABET_BUCKET_ORDER = [
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

function mergeAlphabetBuckets(lists: readonly (readonly AlphabetBucket[])[]): AlphabetBucket[] {
  const counts = new Map<string, number>();
  for (const list of lists) {
    for (const bucket of list) {
      if (bucket.count > 0) {
        counts.set(bucket.letter, (counts.get(bucket.letter) ?? 0) + bucket.count);
      }
    }
  }
  const out: AlphabetBucket[] = [];
  const emitted = new Set<string>();
  let offset = 0;
  for (const letter of ALPHABET_BUCKET_ORDER) {
    const count = counts.get(letter) ?? 0;
    if (count <= 0) continue;
    out.push({ letter, offset, count });
    offset += count;
    emitted.add(letter);
  }
  for (const [letter, count] of counts) {
    if (emitted.has(letter) || count <= 0) continue;
    out.push({ letter, offset, count });
    offset += count;
  }
  return out;
}

function isCategoryFromExcludedSource(categoryId: string, excluded: ReadonlySet<string>): boolean {
  if (excluded.size === 0) return false;
  const parsed = parseCategoryId(categoryId);
  return parsed !== undefined && excluded.has(parsed.sourceId);
}

/** Filters rows carrying `sourceId` against `excluded`, returning the original array when empty. */
export function filterBySourceId<T extends { readonly sourceId: string }>(
  rows: readonly T[],
  excluded: ReadonlySet<string>,
): T[] {
  return excluded.size === 0 ? (rows as T[]) : rows.filter((r) => !excluded.has(r.sourceId));
}

/** Filters rows carrying `itemKey` against `excluded`. */
export function filterByItemKey<T extends { readonly itemKey: string }>(
  rows: readonly T[],
  excluded: ReadonlySet<string>,
): T[] {
  return excluded.size === 0
    ? (rows as T[])
    : rows.filter((r) => !isKeyFromExcludedSource(r.itemKey, excluded));
}

function filterByKey<T extends { readonly key: string }>(
  rows: readonly T[],
  excluded: ReadonlySet<string>,
): T[] {
  return excluded.size === 0
    ? (rows as T[])
    : rows.filter((r) => !isKeyFromExcludedSource(r.key, excluded));
}

/** Resolves the set of source IDs excluded for `effectiveProfileId`. */
export async function resolveExcludedSourceIds(
  catalog: Pick<CatalogService, 'listSources'>,
  effectiveProfileId: string,
  scope: ProfileCatalogScope,
): Promise<ReadonlySet<string>> {
  if (effectiveProfileId === '') return EMPTY_SOURCE_SET;
  if (scope.excludedSourceIds !== undefined && effectiveProfileId === scope.profileId) {
    return scope.excludedSourceIds;
  }
  const rows = await catalog.listSources();
  let set: Set<string> | undefined;
  for (const row of rows) {
    if (row.excludedProfileIds?.includes(effectiveProfileId)) {
      if (set === undefined) set = new Set();
      set.add(row.id);
    }
  }
  return set ?? EMPTY_SOURCE_SET;
}

/** Builds profile- and source-exclusion-scoped browse, search, EPG, and stream methods. */
export function createProfileScopedBrowseMethods(
  c: CatalogService,
  getScope: () => ProfileCatalogScope,
): Pick<
  CatalogService,
  | 'categories'
  | 'items'
  | 'liveVariants'
  | 'listLiveVariants'
  | 'itemVersions'
  | 'listMergedVodVersions'
  | 'findGuideChannelByCleanName'
  | 'allSourcesItems'
  | 'itemDetail'
  | 'search'
  | 'searchSuggestions'
  | 'alphabetIndex'
  | 'nowNext'
  | 'epgWindow'
  | 'epgSlice'
  | 'channelByNumber'
  | 'seasons'
  | 'episodes'
  | 'queryNextEpisode'
  | 'resolveStream'
  | 'resolveCatchupStream'
  | 'fetchChannelArchiveEpg'
> {
  const liveVariants = c.liveVariants?.bind(c);
  const listLiveVariants = c.listLiveVariants?.bind(c);
  const itemVersions = c.itemVersions?.bind(c);
  const listMergedVodVersions = c.listMergedVodVersions?.bind(c);
  const findGuideChannelByCleanName = c.findGuideChannelByCleanName?.bind(c);
  const allSourcesItems = c.allSourcesItems?.bind(c);
  const itemDetail = c.itemDetail?.bind(c);
  const search = c.search?.bind(c);
  const searchSuggestions = c.searchSuggestions?.bind(c);
  const alphabetIndex = c.alphabetIndex?.bind(c);
  const nowNext = c.nowNext?.bind(c);
  const epgWindow = c.epgWindow?.bind(c);
  const epgSlice = c.epgSlice?.bind(c);
  const channelByNumber = c.channelByNumber?.bind(c);
  const queryNextEpisode = c.queryNextEpisode?.bind(c);
  const resolveCatchupStream = c.resolveCatchupStream?.bind(c);
  const fetchChannelArchiveEpg = c.fetchChannelArchiveEpg?.bind(c);
  const excludedFor = (effectivePid: string, scope: ProfileCatalogScope) =>
    resolveExcludedSourceIds(c, effectivePid, scope);

  return {
    categories: async (sourceId, kind, opts) => {
      const scope = getScope();
      if (scope.parentalLoadError) return [];
      const merged = mergeParentalOpts(opts, scope);
      const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
      return excluded.has(sourceId) ? [] : c.categories(sourceId, kind, merged);
    },
    items: async (categoryId, offset, limit, opts) => {
      const scope = getScope();
      if (scope.parentalLoadError) return [];
      const merged = mergeParentalOpts(opts, scope);
      const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
      if (isCategoryFromExcludedSource(categoryId, excluded)) return [];
      return filterBySourceId(await c.items(categoryId, offset, limit, merged), excluded);
    },
    ...(liveVariants
      ? {
          liveVariants: async (itemKey, categoryId, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const merged = mergeParentalOpts(opts, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            if (isKeyFromExcludedSource(itemKey, excluded)) return [];
            return filterByKey(await liveVariants(itemKey, categoryId, merged), excluded);
          },
        }
      : {}),
    ...(listLiveVariants
      ? {
          listLiveVariants: async (itemKey, categoryId, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const merged = mergeParentalOpts(opts, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            if (isKeyFromExcludedSource(itemKey, excluded)) return [];
            return filterByKey(await listLiveVariants(itemKey, categoryId, merged), excluded);
          },
        }
      : {}),
    ...(itemVersions
      ? {
          itemVersions: async (itemKey, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const merged = mergeParentalOpts(opts, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            if (isKeyFromExcludedSource(itemKey, excluded)) return [];
            return filterByKey(await itemVersions(itemKey, merged), excluded);
          },
        }
      : {}),
    ...(listMergedVodVersions
      ? {
          listMergedVodVersions: async (itemKey, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const merged = mergeParentalOpts(opts, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            if (isKeyFromExcludedSource(itemKey, excluded)) return [];
            return filterBySourceId(await listMergedVodVersions(itemKey, merged), excluded);
          },
        }
      : {}),
    ...(findGuideChannelByCleanName
      ? {
          findGuideChannelByCleanName: async (sourceId, channelName, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return null;
            const excluded = await excludedFor(scope.profileId, scope);
            if (excluded.has(sourceId)) return null;
            const mergedExcluded =
              excluded.size > 0
                ? Array.from(new Set([...(opts?.excludedSourceIds ?? []), ...excluded]))
                : opts?.excludedSourceIds;
            const nextOpts =
              mergedExcluded !== undefined ? { ...opts, excludedSourceIds: mergedExcluded } : opts;
            const match = await findGuideChannelByCleanName(sourceId, channelName, nextOpts);
            if (match !== null && excluded.has(match.sourceId)) return null;
            return match;
          },
        }
      : {}),
    ...(allSourcesItems
      ? {
          allSourcesItems: async (kind, offset, limit, sourceIds, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const merged = mergeParentalOpts(opts, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            if (excluded.size === 0) return allSourcesItems(kind, offset, limit, sourceIds, merged);
            const allowed =
              sourceIds !== undefined
                ? sourceIds.filter((id) => !excluded.has(id))
                : (await c.listSources()).filter((s) => !excluded.has(s.id)).map((s) => s.id);
            return allowed.length === 0
              ? []
              : allSourcesItems(kind, offset, limit, allowed, merged);
          },
        }
      : {}),
    ...(itemDetail
      ? {
          itemDetail: async (itemKey, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return null;
            const merged = mergeParentalOpts(opts, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            if (isKeyFromExcludedSource(itemKey, excluded)) return null;
            const detail = await itemDetail(itemKey, merged);
            return detail !== null && excluded.has(detail.sourceId) ? null : detail;
          },
        }
      : {}),
    ...(search
      ? {
          search: async (query, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) {
              return { live: [], epg: [], movies: [], series: [], episodes: [] };
            }
            const merged = mergeParentalOpts(opts, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            if (opts?.sourceId !== undefined && excluded.has(opts.sourceId)) {
              return { live: [], epg: [], movies: [], series: [], episodes: [] };
            }
            const res = await search(query, merged);
            if (excluded.size === 0) return res;
            return {
              live: filterBySourceId(res.live, excluded),
              epg: filterBySourceId(res.epg, excluded),
              movies: filterBySourceId(res.movies, excluded),
              series: filterBySourceId(res.series, excluded),
              episodes: filterBySourceId(res.episodes, excluded),
            };
          },
        }
      : {}),
    ...(searchSuggestions
      ? {
          searchSuggestions: async (options) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const merged = mergeParentalOpts(options, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            if (options?.sourceId !== undefined && excluded.has(options.sourceId)) return [];
            const rows = await searchSuggestions(merged);
            if (excluded.size === 0) return rows;
            return rows.filter(
              (r) =>
                !(r.sourceId !== undefined && excluded.has(r.sourceId)) &&
                !(r.itemKey !== undefined && isKeyFromExcludedSource(r.itemKey, excluded)),
            );
          },
        }
      : {}),
    ...(alphabetIndex
      ? {
          alphabetIndex: async (input) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const merged = mergeParentalOpts(input, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            if (input.sourceId !== undefined && excluded.has(input.sourceId)) return [];
            if (
              input.categoryId !== undefined &&
              isCategoryFromExcludedSource(input.categoryId, excluded)
            ) {
              return [];
            }
            if (
              excluded.size > 0 &&
              input.sourceId === undefined &&
              (input.categoryId === undefined || input.categoryId.trim() === '')
            ) {
              const allowed = (await c.listSources())
                .filter((s) => !excluded.has(s.id))
                .map((s) => s.id);
              if (allowed.length === 0) return [];
              const perSource = await Promise.all(
                allowed.map((sid) => alphabetIndex({ ...merged, sourceId: sid })),
              );
              return mergeAlphabetBuckets(perSource);
            }
            return alphabetIndex(merged);
          },
        }
      : {}),
    ...(nowNext
      ? {
          nowNext: async (channelKeys, nowMs, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const merged = mergeParentalOpts(opts, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            if (excluded.size === 0) return nowNext(channelKeys, nowMs, merged);
            const allowedKeys = channelKeys.filter((k) => !isKeyFromExcludedSource(k, excluded));
            return allowedKeys.length === 0 ? [] : nowNext(allowedKeys, nowMs, merged);
          },
        }
      : {}),
    ...(epgWindow
      ? {
          epgWindow: async (channelKeys, fromMs, toMs, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return {};
            const merged = mergeParentalOpts(opts, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            if (excluded.size === 0) return epgWindow(channelKeys, fromMs, toMs, merged);
            const allowedKeys = channelKeys.filter((k) => !isKeyFromExcludedSource(k, excluded));
            return allowedKeys.length === 0 ? {} : epgWindow(allowedKeys, fromMs, toMs, merged);
          },
        }
      : {}),
    ...(epgSlice
      ? {
          epgSlice: async (sourceId, fromMs, toMs, limit, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const merged = mergeParentalOpts(opts, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            return excluded.has(sourceId) ? [] : epgSlice(sourceId, fromMs, toMs, limit, merged);
          },
        }
      : {}),
    ...(channelByNumber
      ? {
          channelByNumber: async (num, sourceId, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return null;
            const merged = mergeParentalOpts(opts, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            if (sourceId !== undefined) {
              return excluded.has(sourceId) ? null : channelByNumber(num, sourceId, merged);
            }
            if (excluded.size > 0) {
              const allowed = (await c.listSources()).filter((s) => !excluded.has(s.id));
              for (const source of allowed) {
                const hit = await channelByNumber(num, source.id, merged);
                if (hit !== null) return hit;
              }
              return null;
            }
            const row = await channelByNumber(num, undefined, merged);
            return row !== null && excluded.has(row.sourceId) ? null : row;
          },
        }
      : {}),
    seasons: async (seriesId, opts) => {
      const scope = getScope();
      if (scope.parentalLoadError) return ok([]);
      return c.seasons(seriesId, mergeParentalOpts(opts, scope));
    },
    episodes: async (seriesId, season, opts) => {
      const scope = getScope();
      if (scope.parentalLoadError) return [];
      return c.episodes(seriesId, season, mergeParentalOpts(opts, scope));
    },
    ...(queryNextEpisode
      ? {
          queryNextEpisode: async (seriesKey, currentItemKey, profileId, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return null;
            const effectivePid = profileId ?? scope.profileId;
            const excluded = await excludedFor(effectivePid, scope);
            if (isKeyFromExcludedSource(seriesKey, excluded)) return null;
            return queryNextEpisode(seriesKey, currentItemKey, effectivePid, {
              ...opts,
              parentalUnlocked: opts?.parentalUnlocked ?? scope.parentalUnlocked,
            });
          },
        }
      : {}),
    resolveStream: async (itemKey, opts) => {
      const scope = getScope();
      if (scope.parentalLoadError) return failClosedStreamError();
      const merged = mergeParentalOpts(opts, scope);
      const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
      if (isKeyFromExcludedSource(itemKey, excluded)) {
        return err(elvError('auth', 'source-excluded'));
      }
      return c.resolveStream(itemKey, merged);
    },
    ...(resolveCatchupStream
      ? {
          resolveCatchupStream: async (itemKey, programme, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return failClosedStreamError();
            const merged = mergeParentalOpts(opts, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            if (isKeyFromExcludedSource(itemKey, excluded)) {
              return err(elvError('auth', 'source-excluded'));
            }
            return resolveCatchupStream(itemKey, programme, merged);
          },
        }
      : {}),
    ...(fetchChannelArchiveEpg
      ? {
          fetchChannelArchiveEpg: async (itemKey, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return failClosedStreamError();
            const merged = mergeParentalOpts(opts, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            if (isKeyFromExcludedSource(itemKey, excluded)) {
              return err(elvError('auth', 'source-excluded'));
            }
            return fetchChannelArchiveEpg(itemKey, merged);
          },
        }
      : {}),
  };
}
