import type { Scheduler, SqlDriver } from '@elv/domain';
import type {
  ElvEnrichmentStore,
  ElvMediaType,
  UpsertElvMatchInput,
  UpsertElvTitleInput,
} from './elv-enrichment-repo';
import type { ElvMatchBatchRequestItem, ElvMetadataClient } from './elv-http-client';
import { cleanVodTitle } from './vod-title-cleaner';
import { normalizeCatalogImdbId, normalizeCatalogTmdbId } from './writers';

export {
  createElvHttpClient,
  type ElvFeedsPayload,
  type ElvHttpClientOptions,
  type ElvMatchBatchHit,
  type ElvMatchBatchRequestItem,
  type ElvMatchBatchResult,
  type ElvMetadataClient,
  type ElvSearchCandidate,
} from './elv-http-client';

/** Maximum visible cards matched immediately by {@link ElvCatalogMatcher.enrichPriorityKeys}. */
export const MAX_ELV_PRIORITY_KEYS = 40;

/** Default batch size for {@link ElvCatalogMatcher.runBackgroundMatching}. */
export const DEFAULT_ELV_MATCH_BATCH_SIZE = 500;

const MAX_ELV_MATCH_BATCH_SIZE = 500;

/** Progress event emitted between batches of {@link ElvCatalogMatcher.runBackgroundMatching}. */
export interface ElvMatchingProgress {
  readonly scanned: number;
  readonly layer1Matched: number;
  readonly remoteMatched: number;
  readonly skipped: number;
  readonly done: boolean;
}

/** Final summary returned by priority and background ELV matching runs. */
export interface ElvMatchingSummary {
  readonly scanned: number;
  readonly layer1Matched: number;
  readonly remoteMatched: number;
  readonly skipped: number;
  readonly aborted: boolean;
}

/** Options for {@link ElvCatalogMatcher.enrichPriorityKeys}. */
export interface ElvPriorityMatchOptions {
  readonly lang?: string;
  readonly signal?: AbortSignal;
}

/** Options for {@link ElvCatalogMatcher.runBackgroundMatching}. */
export interface ElvBackgroundMatchOptions {
  readonly lang?: string;
  readonly batchSize?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ElvMatchingProgress) => void;
}

/** Dependencies for {@link createElvCatalogMatcher}. */
export interface ElvCatalogMatcherDeps {
  readonly catalogDb: SqlDriver;
  readonly enrichmentStore: ElvEnrichmentStore;
  readonly client?: ElvMetadataClient | undefined;
  readonly getClient?: (() => ElvMetadataClient | undefined) | undefined;
  readonly now?: () => number;
  readonly scheduler?: Scheduler;
}

/** 3-layer zero-wait catalog matcher over `catalog.db` (read-only) and `elv-enrichment.db` (`#511`). */
export interface ElvCatalogMatcher {
  enrichPriorityKeys(
    itemKeys: readonly string[],
    opts?: ElvPriorityMatchOptions,
  ): Promise<ElvMatchingSummary>;
  runBackgroundMatching(opts?: ElvBackgroundMatchOptions): Promise<ElvMatchingSummary>;
}

interface CatalogCandidateRow {
  readonly id: number;
  readonly source_id: string;
  readonly key: string;
  readonly name: string;
  readonly year: number | null;
  readonly provider_imdb_id: string | null;
  readonly provider_tmdb_id: string | null;
  readonly mediaType: ElvMediaType;
}

interface RemoteCandidateRow extends CatalogCandidateRow {
  readonly hydrateOnly?: boolean;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * Builds the 3-Layer Zero-Wait ELV Catalog Matcher (`#511`):
 * - Layer 1 (0 ms): direct `provider_imdb_id` matches (`confidence: 1.0`, zero network calls).
 * - Layer 2: priority viewport matching (up to 40 visible items) + keyset-paginated 500-item
 *   background batches (zero full-catalog RAM arrays).
 * - Layer 3: incremental skipping of every `item_key` already in `elv_item_matches` (or `manual_lock = 1`).
 */
export function createElvCatalogMatcher(deps: ElvCatalogMatcherDeps): ElvCatalogMatcher {
  const { catalogDb, enrichmentStore } = deps;
  const clock = deps.now ?? Date.now;
  const yieldNow = () => deps.scheduler?.yieldNow() ?? Promise.resolve();
  const resolveClient = (): ElvMetadataClient | undefined => deps.getClient?.() ?? deps.client;

  async function lookupLocalImdbByTmdb(
    rows: readonly {
      readonly mediaType: ElvMediaType;
      readonly provider_tmdb_id: string | null;
    }[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (enrichmentStore.getTitlesByTmdbIds === undefined) return out;
    const movieTmdbIds: string[] = [];
    const seriesTmdbIds: string[] = [];
    for (const row of rows) {
      const normalized = normalizeCatalogTmdbId(row.provider_tmdb_id);
      if (normalized === null) continue;
      if (row.mediaType === 'series') seriesTmdbIds.push(normalized);
      else movieTmdbIds.push(normalized);
    }
    const [movieTitles, seriesTitles] = await Promise.all([
      movieTmdbIds.length > 0
        ? enrichmentStore.getTitlesByTmdbIds(movieTmdbIds, 'movie')
        : Promise.resolve(new Map()),
      seriesTmdbIds.length > 0
        ? enrichmentStore.getTitlesByTmdbIds(seriesTmdbIds, 'series')
        : Promise.resolve(new Map()),
    ]);
    for (const [tmdbId, title] of movieTitles) {
      out.set(`movie:${tmdbId}`, title.imdbId);
    }
    for (const [tmdbId, title] of seriesTitles) {
      out.set(`series:${tmdbId}`, title.imdbId);
    }
    return out;
  }

  async function persistRemoteBatch(
    candidates: readonly RemoteCandidateRow[],
    lang: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<number> {
    const activeClient = resolveClient();
    if (activeClient === undefined || candidates.length === 0) return 0;
    const byKey = new Map<string, RemoteCandidateRow>();
    const requestItems: ElvMatchBatchRequestItem[] = [];

    for (const row of candidates) {
      const imdbId = normalizeCatalogImdbId(row.provider_imdb_id);
      const cleaned = cleanVodTitle(row.name, row.year);
      const cleanTitle =
        cleaned.cleanTitle !== ''
          ? cleaned.cleanTitle
          : imdbId !== null
            ? row.name.trim() || imdbId
            : '';
      if (cleanTitle === '') continue;
      byKey.set(row.key, row);
      const tmdbId = normalizeCatalogTmdbId(row.provider_tmdb_id);
      requestItems.push({
        key: row.key,
        cleanTitle,
        ...(cleaned.releaseYear !== null ? { year: cleaned.releaseYear } : {}),
        mediaType: row.mediaType,
        ...(imdbId !== null ? { providerImdbId: imdbId } : {}),
        ...(tmdbId !== null ? { providerTmdbId: tmdbId } : {}),
      });
    }
    if (requestItems.length === 0) return 0;

    const maxRounds = Math.ceil(requestItems.length / 20) + 2;
    let remainingItems = requestItems;
    let totalRemoteMatched = 0;

    for (let round = 0; round < maxRounds && remainingItems.length > 0; round += 1) {
      if (signal?.aborted) break;
      const response = await activeClient.matchBatch(remainingItems, lang, signal);
      const nowMs = clock();
      const matchInputs: UpsertElvMatchInput[] = [];
      const titleInputs: UpsertElvTitleInput[] = [];
      const resolvedKeys = new Set<string>();

      for (const hit of response.matches) {
        resolvedKeys.add(hit.key);
        const row = byKey.get(hit.key);
        if (row === undefined) continue;
        if (row.hydrateOnly !== true) {
          matchInputs.push({
            itemKey: row.key,
            sourceId: row.source_id,
            mediaType: row.mediaType,
            imdbId: hit.imdbId,
            confidence: hit.confidence,
            updatedAt: nowMs,
          });
        }
        if (hit.title !== null && hit.title !== undefined) {
          titleInputs.push(hit.title);
        }
      }

      if (titleInputs.length > 0) await enrichmentStore.upsertTitles(titleInputs);
      if (matchInputs.length > 0) {
        totalRemoteMatched += await enrichmentStore.upsertMatches(matchInputs);
      }

      if (response.pendingKeys.length === 0) break;
      const unmatchedSet = new Set(response.unmatchedKeys);
      const pendingSet = new Set<string>();
      for (const key of response.pendingKeys) {
        if (!resolvedKeys.has(key) && !unmatchedSet.has(key)) {
          pendingSet.add(key);
        }
      }
      const nextRemaining = remainingItems.filter((item) => pendingSet.has(item.key));
      if (nextRemaining.length === 0 || nextRemaining.length >= remainingItems.length) {
        break;
      }
      remainingItems = nextRemaining;
      await yieldNow();
    }

    return totalRemoteMatched;
  }

  return {
    async enrichPriorityKeys(itemKeys, opts) {
      if (opts?.signal?.aborted) {
        return { scanned: 0, layer1Matched: 0, remoteMatched: 0, skipped: 0, aborted: true };
      }
      const uniqueKeys: string[] = [];
      const seen = new Set<string>();
      for (const k of itemKeys) {
        const t = k.trim();
        if (t !== '' && !seen.has(t)) {
          seen.add(t);
          uniqueKeys.push(t);
          if (uniqueKeys.length >= MAX_ELV_PRIORITY_KEYS) break;
        }
      }
      if (uniqueKeys.length === 0) {
        return { scanned: 0, layer1Matched: 0, remoteMatched: 0, skipped: 0, aborted: false };
      }

      const existingEnrich = await enrichmentStore.getEnrichmentForKeys(uniqueKeys);
      const workKeys: string[] = [];
      let skipped = 0;
      for (const key of uniqueKeys) {
        const existing = existingEnrich.get(key);
        if (existing !== undefined && (existing.title !== null || existing.manualLock)) {
          skipped += 1;
        } else {
          workKeys.push(key);
        }
      }
      if (workKeys.length === 0) {
        return {
          scanned: uniqueKeys.length,
          layer1Matched: 0,
          remoteMatched: 0,
          skipped,
          aborted: false,
        };
      }

      const ph = placeholders(workKeys.length);
      const [movieRows, seriesRows] = await Promise.all([
        catalogDb.all<Omit<CatalogCandidateRow, 'mediaType'>>(
          `SELECT m.id, m.source_id, m.key, m.name, m.year, m.provider_imdb_id, m.provider_tmdb_id
             FROM movies m
            WHERE m.is_hidden = 0 AND m.key IN (${ph})
              AND EXISTS (SELECT 1 FROM sources s WHERE s.id = m.source_id AND s.deleting = 0)`,
          workKeys,
        ),
        catalogDb.all<Omit<CatalogCandidateRow, 'mediaType'>>(
          `SELECT sr.id, sr.source_id, sr.key, sr.name, sr.year, sr.provider_imdb_id, sr.provider_tmdb_id
             FROM series sr
            WHERE sr.is_hidden = 0 AND sr.key IN (${ph})
              AND EXISTS (SELECT 1 FROM sources s WHERE s.id = sr.source_id AND s.deleting = 0)`,
          workKeys,
        ),
      ]);

      const rows: CatalogCandidateRow[] = [
        ...movieRows.map((r) => ({ ...r, mediaType: 'movie' as const })),
        ...seriesRows.map((r) => ({ ...r, mediaType: 'series' as const })),
      ];

      const nowMs = clock();
      const layer1Inputs: UpsertElvMatchInput[] = [];
      const layer1Candidates: CatalogCandidateRow[] = [];
      const priorHydrationCandidates: RemoteCandidateRow[] = [];
      const remoteCandidates: RemoteCandidateRow[] = [];

      const localImdbByTmdb = await lookupLocalImdbByTmdb(
        rows.filter((r) => existingEnrich.get(r.key) === undefined && r.provider_imdb_id === null),
      );

      for (const row of rows) {
        const existing = existingEnrich.get(row.key);
        if (existing !== undefined) {
          const imdbId = normalizeCatalogImdbId(row.provider_imdb_id) ?? existing.imdbId;
          priorHydrationCandidates.push({
            ...row,
            provider_imdb_id: imdbId,
            hydrateOnly: true,
          });
          continue;
        }
        const directImdbId = normalizeCatalogImdbId(row.provider_imdb_id);
        const tmdbId = directImdbId === null ? normalizeCatalogTmdbId(row.provider_tmdb_id) : null;
        const localTmdbMatch =
          tmdbId !== null ? localImdbByTmdb.get(`${row.mediaType}:${tmdbId}`) : undefined;
        const matchedImdbId = directImdbId ?? localTmdbMatch ?? null;
        if (matchedImdbId !== null) {
          layer1Inputs.push({
            itemKey: row.key,
            sourceId: row.source_id,
            mediaType: row.mediaType,
            imdbId: matchedImdbId,
            confidence: directImdbId !== null ? 1 : 0.98,
            updatedAt: nowMs,
          });
          layer1Candidates.push({ ...row, provider_imdb_id: matchedImdbId });
        } else {
          remoteCandidates.push(row);
        }
      }

      const layer1Matched =
        layer1Inputs.length > 0 ? await enrichmentStore.upsertMatches(layer1Inputs) : 0;

      const queuedHydrationImdbIds = new Set<string>();
      const queueForHydration = (row: CatalogCandidateRow, imdbId: string | null) => {
        if (imdbId !== null) {
          if (queuedHydrationImdbIds.has(imdbId)) return;
          queuedHydrationImdbIds.add(imdbId);
        }
        remoteCandidates.push({
          ...row,
          ...(imdbId !== null ? { provider_imdb_id: imdbId } : {}),
          hydrateOnly: true,
        });
      };

      if (layer1Candidates.length > 0) {
        const postLayer1 = await enrichmentStore.getEnrichmentForKeys(
          layer1Candidates.map((r) => r.key),
        );
        for (const row of layer1Candidates) {
          const enr = postLayer1.get(row.key);
          if (enr !== undefined && enr.title !== null) continue;
          queueForHydration(row, normalizeCatalogImdbId(row.provider_imdb_id));
        }
      }
      for (const row of priorHydrationCandidates) {
        queueForHydration(row, normalizeCatalogImdbId(row.provider_imdb_id));
      }

      if (opts?.signal?.aborted) {
        return {
          scanned: uniqueKeys.length,
          layer1Matched,
          remoteMatched: 0,
          skipped,
          aborted: true,
        };
      }

      const remoteMatched = await persistRemoteBatch(remoteCandidates, opts?.lang, opts?.signal);
      return {
        scanned: uniqueKeys.length,
        layer1Matched,
        remoteMatched,
        skipped,
        aborted: opts?.signal?.aborted === true,
      };
    },

    async runBackgroundMatching(opts = {}) {
      const batchSize = Math.max(
        1,
        Math.min(
          MAX_ELV_MATCH_BATCH_SIZE,
          Math.floor(opts.batchSize ?? DEFAULT_ELV_MATCH_BATCH_SIZE),
        ),
      );
      let scanned = 0;
      let layer1Matched = 0;
      let remoteMatched = 0;
      let skipped = 0;

      const emit = (done: boolean) => {
        opts.onProgress?.({ scanned, layer1Matched, remoteMatched, skipped, done });
      };

      const tables: readonly { table: 'movies' | 'series'; mediaType: ElvMediaType }[] = [
        { table: 'movies', mediaType: 'movie' },
        { table: 'series', mediaType: 'series' },
      ];
      let layer1Scanned = 0;
      let layer1Skipped = 0;

      // Layer 1: 0 ms pass over rows with provider_imdb_id or cached local tmdb_id (keyset paginated)
      for (const { table, mediaType } of tables) {
        let lastId = 0;
        for (;;) {
          if (opts.signal?.aborted) {
            return { scanned, layer1Matched, remoteMatched, skipped, aborted: true };
          }
          const page = await catalogDb.all<{
            id: number;
            source_id: string;
            key: string;
            provider_imdb_id: string | null;
            provider_tmdb_id: string | null;
          }>(
            `SELECT t.id, t.source_id, t.key, t.provider_imdb_id, t.provider_tmdb_id
               FROM ${table} t
              WHERE t.id > ? AND t.is_hidden = 0
                AND (t.provider_imdb_id IS NOT NULL OR t.provider_tmdb_id IS NOT NULL)
                AND EXISTS (SELECT 1 FROM sources s WHERE s.id = t.source_id AND s.deleting = 0)
              ORDER BY t.id ASC
              LIMIT ?`,
            [lastId, batchSize],
          );
          if (page.length === 0) break;
          lastId = (page[page.length - 1] as { id: number }).id;
          layer1Scanned += page.length;

          const existing = await enrichmentStore.listMatchedKeysForSet(page.map((r) => r.key));
          const unmatchedRows = page.filter((r) => !existing.has(r.key));
          layer1Skipped += page.length - unmatchedRows.length;
          const localImdbByTmdb = await lookupLocalImdbByTmdb(
            unmatchedRows
              .filter((r) => r.provider_imdb_id === null)
              .map((r) => ({ mediaType, provider_tmdb_id: r.provider_tmdb_id })),
          );

          const nowMs = clock();
          const toInsert: UpsertElvMatchInput[] = [];
          for (const row of unmatchedRows) {
            const directImdb = normalizeCatalogImdbId(row.provider_imdb_id);
            const tmdbId =
              directImdb === null ? normalizeCatalogTmdbId(row.provider_tmdb_id) : null;
            const resolvedImdb =
              directImdb ??
              (tmdbId !== null ? localImdbByTmdb.get(`${mediaType}:${tmdbId}`) : undefined) ??
              null;
            if (resolvedImdb === null) continue;
            toInsert.push({
              itemKey: row.key,
              sourceId: row.source_id,
              mediaType,
              imdbId: resolvedImdb,
              confidence: directImdb !== null ? 1 : 0.98,
              updatedAt: nowMs,
            });
          }
          if (toInsert.length > 0) {
            layer1Matched += await enrichmentStore.upsertMatches(toInsert);
            emit(false);
          }
          await yieldNow();
        }
      }

      if (resolveClient() === undefined) {
        scanned = layer1Scanned;
        skipped = layer1Skipped;
        emit(true);
        return { scanned, layer1Matched, remoteMatched: 0, skipped, aborted: false };
      }

      // Layer 2 + Layer 3: keyset-paginated scan of unmatched rows and unhydrated Layer 1 titles
      let buffer: RemoteCandidateRow[] = [];
      const hydratedImdbIds = new Set<string>();
      const flushBuffer = async () => {
        if (buffer.length === 0) return;
        const chunk = buffer;
        buffer = [];
        remoteMatched += await persistRemoteBatch(chunk, opts.lang, opts.signal);
        emit(false);
        await yieldNow();
      };

      for (const { table, mediaType } of tables) {
        let lastId = 0;
        for (;;) {
          if (opts.signal?.aborted) {
            return { scanned, layer1Matched, remoteMatched, skipped, aborted: true };
          }
          const page = await catalogDb.all<Omit<CatalogCandidateRow, 'mediaType'>>(
            `SELECT t.id, t.source_id, t.key, t.name, t.year, t.provider_imdb_id, t.provider_tmdb_id
               FROM ${table} t
              WHERE t.id > ? AND t.is_hidden = 0
                AND EXISTS (SELECT 1 FROM sources s WHERE s.id = t.source_id AND s.deleting = 0)
              ORDER BY t.id ASC
              LIMIT ?`,
            [lastId, batchSize],
          );
          if (page.length === 0) break;
          lastId = (page[page.length - 1] as { id: number }).id;
          scanned += page.length;

          const existingEnrich = await enrichmentStore.getEnrichmentForKeys(page.map((r) => r.key));
          for (const row of page) {
            const existing = existingEnrich.get(row.key);
            if (existing !== undefined) {
              if (existing.title !== null || existing.manualLock) {
                skipped += 1;
                continue;
              }
              const imdbId = normalizeCatalogImdbId(row.provider_imdb_id) ?? existing.imdbId;
              if (hydratedImdbIds.has(imdbId)) {
                skipped += 1;
                continue;
              }
              hydratedImdbIds.add(imdbId);
              buffer.push({ ...row, provider_imdb_id: imdbId, mediaType, hydrateOnly: true });
            } else {
              buffer.push({ ...row, mediaType });
            }
            if (buffer.length >= batchSize) {
              await flushBuffer();
              if (opts.signal?.aborted) {
                return { scanned, layer1Matched, remoteMatched, skipped, aborted: true };
              }
            }
          }
          emit(false);
          await yieldNow();
        }
      }

      if (opts.signal?.aborted) {
        return { scanned, layer1Matched, remoteMatched, skipped, aborted: true };
      }
      await flushBuffer();
      emit(true);
      return { scanned, layer1Matched, remoteMatched, skipped, aborted: false };
    },
  };
}
