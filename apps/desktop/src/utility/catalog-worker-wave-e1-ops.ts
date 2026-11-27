import { dirname, join } from 'node:path';
import {
  type CatalogService,
  createElvHttpClient,
  createSyncSqlDriver,
  type ElvEnrichmentStore,
  type ElvItemEnrichment,
  type ElvMatchingSummary,
  type ElvMetadataClient,
  openElvEnrichmentStore,
  type SyncDatabase,
} from '@elv/data';
import type { FetchLike } from '@elv/domain';
import {
  type CatalogWaveE1OpsRpcCall,
  WAVE_E1_RPC_METHODS,
} from '../shared/catalog-ipc-wave-e1-guards.ts';

const EMPTY_ELV_SUMMARY: ElvMatchingSummary = {
  scanned: 0,
  layer1Matched: 0,
  remoteMatched: 0,
  skipped: 0,
  aborted: false,
};

/** Opened isolated ELV enrichment store and optional `/v1/elv/*` metadata client for the desktop catalog worker (`#511`). */
export interface WorkerElvContext {
  readonly enrichmentStore?: ElvEnrichmentStore;
  readonly elvClient?: ElvMetadataClient;
}

/** Builds a validated ELV metadata HTTP client when `elvServerUrl` is configured, else returns `undefined`. */
export function createWorkerElvClient(deps: {
  readonly elvServerUrl?: string;
  readonly fetchImpl: FetchLike;
}): ElvMetadataClient | undefined {
  const rawUrl = deps.elvServerUrl?.trim() ?? '';
  if (rawUrl === '') return undefined;
  try {
    return createElvHttpClient({
      baseUrl: rawUrl,
      fetchFn: deps.fetchImpl as unknown as typeof globalThis.fetch,
      allowInsecureLocalhost:
        process.env['VITEST'] === 'true' || process.env['NODE_ENV'] !== 'production',
    });
  } catch {
    return undefined;
  }
}

/**
 * Opens the isolated `elv-enrichment.db` SQLite database beside `catalog.db` and constructs an
 * optional strict HTTPS (or loopback in non-production/Vitest) `/v1/elv/*` client when `elvServerUrl` is valid.
 * Failures opening or migrating `elv-enrichment.db` log a warning and degrade gracefully to `enrichmentStore: undefined`
 * so `catalog.db` startup is never blocked.
 */
export async function openWorkerElvContext(deps: {
  readonly dbPath: string;
  readonly elvServerUrl?: string;
  readonly openDatabase: (filePath: string) => SyncDatabase;
  readonly fetchImpl: FetchLike;
  readonly clock: () => number;
  readonly log?: (line: string) => void;
}): Promise<WorkerElvContext> {
  const elvDbPath =
    deps.dbPath === ':memory:' ? ':memory:' : join(dirname(deps.dbPath), 'elv-enrichment.db');
  let elvDb: ReturnType<typeof createSyncSqlDriver> | undefined;
  let enrichmentStore: ElvEnrichmentStore | undefined;
  try {
    elvDb = createSyncSqlDriver(deps.openDatabase(elvDbPath));
    enrichmentStore = await openElvEnrichmentStore(elvDb, { clock: deps.clock });
  } catch {
    await elvDb?.close?.().catch(() => undefined);
    const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
    log('catalog worker: elv-enrichment.db unavailable; falling back without ELV enrichment store');
    enrichmentStore = undefined;
  }

  const elvClient = createWorkerElvClient({
    fetchImpl: deps.fetchImpl,
    ...(deps.elvServerUrl === undefined ? {} : { elvServerUrl: deps.elvServerUrl }),
  });
  return {
    ...(enrichmentStore !== undefined ? { enrichmentStore } : {}),
    ...(elvClient !== undefined ? { elvClient } : {}),
  };
}

/** Narrowing type guard for Wave E1 ELV Mode RPC calls inside the catalog worker runtime. */
export function isWaveE1RpcCall(call: { method: string }): call is CatalogWaveE1OpsRpcCall {
  return WAVE_E1_RPC_METHODS.has(call.method);
}

/** Dispatches all Wave E1 ELV Mode RPC calls to {@link CatalogService} (`#511`). */
export async function executeWaveE1OpsRpcCall(
  service: CatalogService,
  call: CatalogWaveE1OpsRpcCall,
): Promise<unknown> {
  switch (call.method) {
    case 'getElvEnrichmentForKeys': {
      if (!service.getElvEnrichmentForKeys) return {};
      const map = await service.getElvEnrichmentForKeys(call.itemKeys);
      const record: Record<string, ElvItemEnrichment> = {};
      for (const [k, v] of map) record[k] = v;
      return record;
    }
    case 'getElvTitleDetail':
      return service.getElvTitleDetail ? service.getElvTitleDetail(call.imdbId, call.opts) : null;
    case 'listMergedVodVersions':
      return service.listMergedVodVersions
        ? service.listMergedVodVersions(call.itemKey, call.opts)
        : [];
    case 'enrichElvPriorityKeys':
      return service.enrichElvPriorityKeys
        ? service.enrichElvPriorityKeys(call.itemKeys, call.opts)
        : EMPTY_ELV_SUMMARY;
    case 'runElvBackgroundMatching':
      return service.runElvBackgroundMatching
        ? service.runElvBackgroundMatching(call.opts)
        : EMPTY_ELV_SUMMARY;
    case 'recordPlaybackQuality':
      return service.recordPlaybackQuality ? service.recordPlaybackQuality(call.input) : null;
    case 'recordPlaybackVariantFailure':
      return service.recordPlaybackVariantFailure
        ? service.recordPlaybackVariantFailure(call.itemKey)
        : null;
    case 'setElvManualMatch':
      if (service.setElvManualMatch) {
        await service.setElvManualMatch(call.itemKey, call.sourceId, call.mediaType, call.imdbId);
      }
      return undefined;
    case 'wipeElvEnrichment':
      if (service.wipeElvEnrichment) await service.wipeElvEnrichment();
      return undefined;
    case 'searchElvItemKeysByAlias':
      return service.searchElvItemKeysByAlias
        ? service.searchElvItemKeysByAlias(call.query, call.opts)
        : [];
    case 'listLiveVariants':
      return service.listLiveVariants
        ? service.listLiveVariants(call.itemKey, call.categoryId, call.opts)
        : service.liveVariants
          ? service.liveVariants(call.itemKey, call.categoryId, call.opts)
          : [];
    case 'findGuideChannelByCleanName':
      return service.findGuideChannelByCleanName
        ? service.findGuideChannelByCleanName(call.sourceId, call.channelName, call.opts)
        : null;
  }
}
