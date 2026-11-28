import type { CatalogService } from '@elv/data';
import {
  filterBySourceId,
  isKeyFromExcludedSource,
  mergeParentalOpts,
  type ProfileCatalogScope,
  resolveExcludedSourceIds,
} from './profile-scoped-source-filter';

function mergeExcludedSources(
  callerExcluded: readonly string[] | undefined,
  profileExcluded: ReadonlySet<string>,
): readonly string[] | undefined {
  if (profileExcluded.size === 0) return callerExcluded;
  return Array.from(new Set([...(callerExcluded ?? []), ...profileExcluded]));
}

/** Builds profile-, exclusion-, and fail-closed-scoped ELV metadata methods for `createProfileScopedCatalog`. */
export function createProfileScopedElvMethods(
  c: CatalogService,
  getScope: () => ProfileCatalogScope,
): Partial<CatalogService> {
  const searchElvItemKeysByAlias = c.searchElvItemKeysByAlias?.bind(c);
  const listElvImdbGenres = c.listElvImdbGenres?.bind(c);
  const listElvItemsByImdbGenre = c.listElvItemsByImdbGenre?.bind(c);
  const getElvRecommendations = c.getElvRecommendations?.bind(c);
  const listElvFranchiseItems = c.listElvFranchiseItems?.bind(c);
  const listElvPersonLibraryItems = c.listElvPersonLibraryItems?.bind(c);
  const excludedFor = (effectivePid: string, scope: ProfileCatalogScope) =>
    resolveExcludedSourceIds(c, effectivePid, scope);

  return {
    ...(c.getVodEnrichment ? { getVodEnrichment: c.getVodEnrichment.bind(c) } : {}),
    ...(c.enrichVodItem ? { enrichVodItem: c.enrichVodItem.bind(c) } : {}),
    ...(c.getElvEnrichmentForKeys
      ? { getElvEnrichmentForKeys: c.getElvEnrichmentForKeys.bind(c) }
      : {}),
    ...(c.getElvTitleDetail ? { getElvTitleDetail: c.getElvTitleDetail.bind(c) } : {}),
    ...(c.enrichElvPriorityKeys ? { enrichElvPriorityKeys: c.enrichElvPriorityKeys.bind(c) } : {}),
    ...(c.runElvBackgroundMatching
      ? { runElvBackgroundMatching: c.runElvBackgroundMatching.bind(c) }
      : {}),
    ...(c.recordPlaybackQuality ? { recordPlaybackQuality: c.recordPlaybackQuality.bind(c) } : {}),
    ...(c.recordPlaybackVariantFailure
      ? { recordPlaybackVariantFailure: c.recordPlaybackVariantFailure.bind(c) }
      : {}),
    ...(c.setElvManualMatch ? { setElvManualMatch: c.setElvManualMatch.bind(c) } : {}),
    ...(c.wipeElvEnrichment ? { wipeElvEnrichment: c.wipeElvEnrichment.bind(c) } : {}),
    ...(searchElvItemKeysByAlias
      ? {
          searchElvItemKeysByAlias: async (query, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const excluded = await excludedFor(scope.profileId, scope);
            const mergedExcluded = mergeExcludedSources(opts?.excludedSourceIds, excluded);
            const nextOpts =
              mergedExcluded !== undefined ? { ...opts, excludedSourceIds: mergedExcluded } : opts;
            const keys = await searchElvItemKeysByAlias(query, nextOpts);
            return excluded.size === 0
              ? keys
              : keys.filter((k) => !isKeyFromExcludedSource(k, excluded));
          },
        }
      : {}),
    ...(listElvImdbGenres
      ? {
          listElvImdbGenres: async (kind, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const merged = mergeParentalOpts(opts, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            const mergedExcluded = mergeExcludedSources(opts?.excludedSourceIds, excluded);
            const nextOpts =
              mergedExcluded !== undefined
                ? { ...merged, excludedSourceIds: mergedExcluded }
                : merged;
            return listElvImdbGenres(kind, nextOpts);
          },
        }
      : {}),
    ...(listElvItemsByImdbGenre
      ? {
          listElvItemsByImdbGenre: async (kind, genre, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const merged = mergeParentalOpts(opts, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            const mergedExcluded = mergeExcludedSources(opts?.excludedSourceIds, excluded);
            const nextOpts =
              mergedExcluded !== undefined
                ? { ...merged, excludedSourceIds: mergedExcluded }
                : merged;
            return filterBySourceId(await listElvItemsByImdbGenre(kind, genre, nextOpts), excluded);
          },
        }
      : {}),
    ...(getElvRecommendations
      ? {
          getElvRecommendations: async (opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const merged = mergeParentalOpts(opts, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            const mergedExcluded = mergeExcludedSources(opts.excludedSourceIds, excluded);
            const nextOpts =
              mergedExcluded !== undefined
                ? { ...merged, excludedSourceIds: mergedExcluded }
                : merged;
            const entries = await getElvRecommendations(nextOpts);
            return excluded.size === 0
              ? entries
              : entries.filter((entry) => !excluded.has(entry.item.sourceId));
          },
        }
      : {}),
    ...(c.refreshElvFeeds ? { refreshElvFeeds: c.refreshElvFeeds.bind(c) } : {}),
    ...(listElvFranchiseItems
      ? {
          listElvFranchiseItems: async (imdbId, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const merged = mergeParentalOpts(opts, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            const mergedExcluded = mergeExcludedSources(opts?.excludedSourceIds, excluded);
            const nextOpts =
              mergedExcluded !== undefined
                ? { ...merged, excludedSourceIds: mergedExcluded }
                : merged;
            const entries = await listElvFranchiseItems(imdbId, nextOpts);
            return excluded.size === 0
              ? entries
              : entries.filter((entry) => !excluded.has(entry.item.sourceId));
          },
        }
      : {}),
    ...(listElvPersonLibraryItems
      ? {
          listElvPersonLibraryItems: async (person, opts) => {
            const scope = getScope();
            if (scope.parentalLoadError) return [];
            const merged = mergeParentalOpts(opts, scope);
            const excluded = await excludedFor(merged.profileId ?? scope.profileId, scope);
            const mergedExcluded = mergeExcludedSources(opts?.excludedSourceIds, excluded);
            const nextOpts =
              mergedExcluded !== undefined
                ? { ...merged, excludedSourceIds: mergedExcluded }
                : merged;
            const entries = await listElvPersonLibraryItems(person, nextOpts);
            return excluded.size === 0
              ? entries
              : entries.filter((entry) => !excluded.has(entry.item.sourceId));
          },
        }
      : {}),
    ...(c.searchElvMatchCandidates
      ? { searchElvMatchCandidates: c.searchElvMatchCandidates.bind(c) }
      : {}),
    ...(c.applyElvFixMatch ? { applyElvFixMatch: c.applyElvFixMatch.bind(c) } : {}),
  };
}
