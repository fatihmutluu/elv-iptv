import {
  assembleBatchMatchEntries,
  buildStubTitleFromSuggestion,
  createSubrequestBudget,
  isRichSummaryComplete,
  lookupCachedTitlesByProviderTmdb,
  runWithConcurrency,
} from './elv-batch-helpers.ts';
import { selectBestImdbMatch } from './elv-imdb-client.ts';
import type {
  ElvBatchMatchEntry,
  ElvLocalizedSynopsisRecord,
  ElvMatchBatchInput,
  ElvMatchBatchItemInput,
  ElvMatchIndexRecord,
  ElvMediaType,
  ElvRichTitlePayload,
  ElvTitleRecord,
  ElvUpstreamClient,
} from './elv-types.ts';
import { buildMatchLookupKey, isEnglishLang } from './elv-validation.ts';
import type { SyncServerStorage } from './storage.ts';

const MAX_LEGACY_SUBREQUESTS_PER_BATCH = 25;
const MAX_TMDB_SUBREQUESTS_PER_BATCH = 20;
const BATCH_UPSTREAM_CONCURRENCY = 5;

/** Executes bounded hybrid matching + rich TMDB hydration + IMDb ratings overlay for `POST /v1/elv/match-batch`. */
export async function executeElvMatchBatch(params: {
  readonly input: ElvMatchBatchInput;
  readonly storage: SyncServerStorage;
  readonly upstream: ElvUpstreamClient;
  readonly hasTmdbApiKey: boolean;
  readonly currentMs: number;
}): Promise<{
  readonly matches: Record<string, ElvBatchMatchEntry>;
  readonly unmatchedKeys: string[];
  readonly pendingKeys: string[];
}> {
  const { input, storage, upstream, hasTmdbApiKey, currentMs } = params;
  const { items, lang } = input;
  const useRichTmdb = Boolean(
    upstream.isTmdbEnabled && upstream.searchRichMatch && upstream.fetchRichTitleByTmdbId,
  );
  const maxBatchSubrequests = useRichTmdb
    ? MAX_TMDB_SUBREQUESTS_PER_BATCH
    : MAX_LEGACY_SUBREQUESTS_PER_BATCH;

  const lookupKeysByItemKey = new Map<string, string | null>();
  const keysToLookupInCache: string[] = [];
  for (const item of items) {
    const lookupKey = buildMatchLookupKey(item.cleanTitle, item.mediaType, item.year);
    lookupKeysByItemKey.set(item.key, lookupKey);
    if (!item.providerImdbId && lookupKey !== null) {
      keysToLookupInCache.push(lookupKey);
    }
  }

  const [cachedMatches, cachedTmdbTitles] = await Promise.all([
    keysToLookupInCache.length > 0
      ? storage.getElvMatchesByKeys(keysToLookupInCache)
      : Promise.resolve(new Map<string, ElvMatchIndexRecord>()),
    lookupCachedTitlesByProviderTmdb(storage, items),
  ]);

  const resolvedByKey = new Map<
    string,
    { readonly imdbId: string; readonly tmdbId: string | null; readonly confidence: number }
  >();
  const unresolvedGroups = new Map<
    string,
    { readonly persistLookupKey: string | null; readonly items: ElvMatchBatchItemInput[] }
  >();
  const unmatchedKeys: string[] = [];
  const preloadedTitlesById = new Map<string, ElvTitleRecord>();

  for (const item of items) {
    if (item.providerImdbId) {
      resolvedByKey.set(item.key, {
        imdbId: item.providerImdbId,
        tmdbId: item.providerTmdbId,
        confidence: 1,
      });
      continue;
    }
    if (item.providerTmdbId) {
      const cachedTmdb = cachedTmdbTitles.get(`${item.mediaType}:${item.providerTmdbId}`);
      if (cachedTmdb) {
        preloadedTitlesById.set(cachedTmdb.imdbId, cachedTmdb);
        resolvedByKey.set(item.key, {
          imdbId: cachedTmdb.imdbId,
          tmdbId: cachedTmdb.tmdbId,
          confidence: 0.99,
        });
        continue;
      }
    }
    const lookupKey = lookupKeysByItemKey.get(item.key) ?? null;
    const cached = lookupKey !== null ? cachedMatches.get(lookupKey) : undefined;
    if (cached) {
      resolvedByKey.set(item.key, {
        imdbId: cached.imdbId,
        tmdbId: cached.tmdbId ?? item.providerTmdbId,
        confidence: cached.confidence,
      });
      continue;
    }
    if (lookupKey === null && !(hasTmdbApiKey && item.providerTmdbId)) {
      unmatchedKeys.push(item.key);
      continue;
    }
    const groupKey = lookupKey ?? `__tmdb__:${item.mediaType}:${item.providerTmdbId ?? item.key}`;
    const existingGroup = unresolvedGroups.get(groupKey);
    if (existingGroup) existingGroup.items.push(item);
    else unresolvedGroups.set(groupKey, { persistLookupKey: lookupKey, items: [item] });
  }

  const unresolvedEntries = [...unresolvedGroups.values()];
  const activeEntries = unresolvedEntries.slice(0, maxBatchSubrequests);
  const pendingKeys: string[] = [];
  for (const entry of unresolvedEntries.slice(maxBatchSubrequests)) {
    for (const item of entry.items) pendingKeys.push(item.key);
  }

  const budget = createSubrequestBudget(maxBatchSubrequests);
  const newMatchRecords: ElvMatchIndexRecord[] = [];
  const newTitleRecordsById = new Map<string, ElvTitleRecord>();
  const newLocalizedByImdbId = new Map<string, ElvLocalizedSynopsisRecord>();
  const triedTmdbImdbIds = new Set<string>();

  function recordRichPayload(payload: ElvRichTitlePayload): void {
    newTitleRecordsById.set(payload.record.imdbId, payload.record);
    triedTmdbImdbIds.add(payload.record.imdbId);
    if (!isEnglishLang(lang) && (payload.localizedTitle || payload.localizedSynopsis)) {
      newLocalizedByImdbId.set(payload.record.imdbId, {
        imdbId: payload.record.imdbId,
        lang,
        localizedTitle: payload.localizedTitle,
        synopsis: payload.localizedSynopsis ?? '',
        source: payload.localizedSynopsis ? 'tmdb' : 'fallback_en',
        updatedAt: currentMs,
      });
    }
  }

  const lookupTasks = activeEntries.map(({ persistLookupKey, items: group }) => async () => {
    const rep = group[0];
    if (!rep) return;

    let matchedImdbId: string | null = null;
    let matchedTmdbId: string | null = rep.providerTmdbId;
    let matchedConfidence = 0;
    let deferredToPending = false;

    if (useRichTmdb && upstream.fetchRichTitleByTmdbId && upstream.searchRichMatch) {
      if (rep.providerTmdbId) {
        if (budget.remaining() >= 1) {
          const tmdbRes = await upstream.fetchRichTitleByTmdbId(
            rep.providerTmdbId,
            rep.mediaType,
            lang,
            budget,
          );
          if (tmdbRes.payload) {
            matchedImdbId = tmdbRes.payload.record.imdbId;
            matchedTmdbId = tmdbRes.payload.record.tmdbId ?? rep.providerTmdbId;
            matchedConfidence = 0.99;
            recordRichPayload(tmdbRes.payload);
          } else if (tmdbRes.budgetExhausted) {
            deferredToPending = true;
          }
        } else {
          deferredToPending = true;
        }
      }

      if (!matchedImdbId && !deferredToPending && persistLookupKey !== null) {
        if (budget.remaining() < 2) {
          deferredToPending = true;
        } else {
          const searchRes = await upstream.searchRichMatch(
            rep.cleanTitle,
            rep.mediaType,
            rep.year,
            lang,
            budget,
          );
          if (searchRes.match) {
            matchedImdbId = searchRes.match.record.imdbId;
            matchedTmdbId = searchRes.match.record.tmdbId;
            matchedConfidence = searchRes.match.confidence;
            recordRichPayload(searchRes.match);
          } else if (searchRes.budgetExhausted) {
            deferredToPending = true;
          } else if (budget.tryConsume(1)) {
            const best = selectBestImdbMatch(
              { cleanTitle: rep.cleanTitle, year: rep.year, mediaType: rep.mediaType },
              await upstream.searchSuggestions(rep.cleanTitle),
            );
            if (best) {
              matchedImdbId = best.candidate.imdbId;
              matchedConfidence = best.confidence;
              triedTmdbImdbIds.add(matchedImdbId);
              if (!newTitleRecordsById.has(matchedImdbId)) {
                newTitleRecordsById.set(
                  matchedImdbId,
                  buildStubTitleFromSuggestion(best.candidate, currentMs),
                );
              }
            }
          } else {
            deferredToPending = true;
          }
        }
      }
    } else {
      if (hasTmdbApiKey && rep.providerTmdbId) {
        if (budget.tryConsume(1)) {
          const resolvedImdb = await upstream.resolveTmdbToImdb(rep.providerTmdbId, rep.mediaType);
          if (resolvedImdb) {
            matchedImdbId = resolvedImdb;
            matchedConfidence = 0.98;
          }
        } else {
          deferredToPending = true;
        }
      }
      if (!matchedImdbId && !deferredToPending && persistLookupKey !== null) {
        if (budget.tryConsume(1)) {
          const best = selectBestImdbMatch(
            { cleanTitle: rep.cleanTitle, year: rep.year, mediaType: rep.mediaType },
            await upstream.searchSuggestions(rep.cleanTitle),
          );
          if (best) {
            matchedImdbId = best.candidate.imdbId;
            matchedConfidence = best.confidence;
            if (!newTitleRecordsById.has(matchedImdbId)) {
              newTitleRecordsById.set(
                matchedImdbId,
                buildStubTitleFromSuggestion(best.candidate, currentMs),
              );
            }
          }
        } else {
          deferredToPending = true;
        }
      }
    }

    if (deferredToPending) {
      for (const item of group) pendingKeys.push(item.key);
      return;
    }
    if (!matchedImdbId) {
      for (const item of group) unmatchedKeys.push(item.key);
      return;
    }
    if (persistLookupKey !== null) {
      newMatchRecords.push({
        lookupKey: persistLookupKey,
        mediaType: rep.mediaType,
        year: rep.year,
        imdbId: matchedImdbId,
        tmdbId: matchedTmdbId,
        confidence: matchedConfidence,
        updatedAt: currentMs,
      });
    }
    for (const item of group) {
      resolvedByKey.set(item.key, {
        imdbId: matchedImdbId,
        tmdbId: matchedTmdbId,
        confidence: matchedConfidence,
      });
    }
  });

  await runWithConcurrency(lookupTasks, BATCH_UPSTREAM_CONCURRENCY);

  const orderedImdbIds: string[] = [];
  const metaByImdbId = new Map<
    string,
    { readonly tmdbId: string | null; readonly mediaType: ElvMediaType }
  >();
  for (const item of items) {
    const hit = resolvedByKey.get(item.key);
    if (!hit || metaByImdbId.has(hit.imdbId)) continue;
    orderedImdbIds.push(hit.imdbId);
    metaByImdbId.set(hit.imdbId, { tmdbId: hit.tmdbId, mediaType: item.mediaType });
  }

  const missingDbLookupIds = orderedImdbIds.filter(
    (id) => !preloadedTitlesById.has(id) && !newTitleRecordsById.has(id),
  );
  const titlesById =
    missingDbLookupIds.length > 0
      ? await storage.getElvTitlesByIds(missingDbLookupIds)
      : new Map<string, ElvTitleRecord>();
  for (const [id, rec] of preloadedTitlesById) titlesById.set(id, rec);
  for (const [id, rec] of newTitleRecordsById) titlesById.set(id, rec);

  const idsToHydrate = orderedImdbIds.filter((imdbId) => {
    const existing = titlesById.get(imdbId);
    if (!existing) return true;
    return (
      Boolean(upstream.isTmdbEnabled && upstream.fetchRichTitleByImdbId) &&
      !isRichSummaryComplete(existing) &&
      !triedTmdbImdbIds.has(imdbId)
    );
  });

  const deferredMissingImdbIds = new Set<string>();
  if (idsToHydrate.length > 0) {
    const hydrationTasks = idsToHydrate.map((imdbId) => async () => {
      const hadExisting = titlesById.has(imdbId);
      const hint = metaByImdbId.get(imdbId);
      const existingRec = titlesById.get(imdbId);
      const knownTmdbId = existingRec?.tmdbId ?? hint?.tmdbId ?? null;
      const knownMediaType = existingRec?.mediaType ?? hint?.mediaType ?? null;

      if (upstream.isTmdbEnabled && upstream.fetchRichTitleByImdbId) {
        const minNeeded = knownTmdbId && knownMediaType ? 1 : 2;
        if (budget.remaining() < minNeeded) {
          if (!hadExisting) deferredMissingImdbIds.add(imdbId);
          return;
        }
        const rich = await upstream.fetchRichTitleByImdbId(
          imdbId,
          lang,
          knownTmdbId,
          knownMediaType,
          budget,
        );
        if (rich.payload) {
          recordRichPayload(rich.payload);
          titlesById.set(imdbId, rich.payload.record);
          return;
        }
        if (rich.budgetExhausted) {
          if (!hadExisting) deferredMissingImdbIds.add(imdbId);
          return;
        }
      }

      if (hadExisting) return;
      if (!budget.tryConsume(1)) {
        deferredMissingImdbIds.add(imdbId);
        return;
      }
      const exact = (await upstream.searchSuggestions(imdbId)).find((c) => c.imdbId === imdbId);
      let hydrated: ElvTitleRecord | null = exact
        ? buildStubTitleFromSuggestion(exact, currentMs)
        : null;
      if (!hydrated && budget.tryConsume(1)) {
        hydrated = await upstream.fetchTitleDetail(imdbId, lang);
      }
      if (hydrated) {
        newTitleRecordsById.set(imdbId, hydrated);
        titlesById.set(imdbId, hydrated);
      }
    });
    await runWithConcurrency(hydrationTasks, BATCH_UPSTREAM_CONCURRENCY);
  }

  if (deferredMissingImdbIds.size > 0) {
    for (const item of items) {
      const hit = resolvedByKey.get(item.key);
      if (hit && deferredMissingImdbIds.has(hit.imdbId)) {
        resolvedByKey.delete(item.key);
        pendingKeys.push(item.key);
      }
    }
  }

  if (newMatchRecords.length > 0) await storage.upsertElvMatches(newMatchRecords);
  if (newTitleRecordsById.size > 0) {
    await storage.upsertElvTitlesBatch([...newTitleRecordsById.values()]);
  }
  if (newLocalizedByImdbId.size > 0) {
    await storage.upsertElvLocalizedSynopsesBatch([...newLocalizedByImdbId.values()]);
  }

  const matches = await assembleBatchMatchEntries({
    items,
    lang,
    storage,
    resolvedByKey,
    titlesById,
    newLocalizedByImdbId,
  });

  return { matches, unmatchedKeys, pendingKeys };
}
