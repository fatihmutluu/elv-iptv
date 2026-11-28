import type { ServerResponse } from 'node:http';
import {
  type AddSourceInput,
  type BrowseKind,
  type CatalogService,
  type CategoryQueryOptions,
  type LinkSourceInput,
  type ListItemsOptions,
  queryPlayable,
  resolveAccountPoolKey,
  type SaveProgressInput,
  type SearchOptions,
  type ToggleFavoriteInput,
} from '@elv/data';
import { elvError, err, ok, type SqlDriver } from '@elv/domain';
import {
  isAlphabetIndexInput,
  isCategoryQueryOptions,
  isListItemsOptions,
  isOptionalProfileId,
  isSearchOptions,
  isSearchSuggestionsOptions,
  isSeriesKeyList,
  isSourceIdList,
  isSourceSettingsPatch,
} from '../shared/catalog-ipc-guards.ts';

const PREVIEW_STREAM_URL = 'https://workbench.invalid/preview.m3u8';

/** Strict allowlist of `CatalogService` methods exposed over `POST /rpc`. */
export const ALLOWED_RPC_METHODS: ReadonlySet<string> = new Set([
  'addSource',
  'addSourceFromLink',
  'discoverSourceCategories',
  'updateSourceSettings',
  'removeSource',
  'importGuide',
  'listSources',
  'categories',
  'items',
  'liveVariants',
  'itemVersions',
  'allSourcesItems',
  'itemDetail',
  'search',
  'searchSuggestions',
  'alphabetIndex',
  'nowNext',
  'epgWindow',
  'channelByNumber',
  'seasons',
  'episodes',
  'queryNextEpisode',
  'resolveStream',
  'saveProgress',
  'setWatched',
  'setSeasonWatched',
  'setSeriesWatched',
  'getProgress',
  'listContinueWatching',
  'listProgressByKeys',
  'listSeriesUnplayedCounts',
  'clearProgress',
  'toggleFavorite',
  'listFavorites',
  'listFavoriteKeys',
]);

/** Collaborators used by {@link dispatchWorkbenchRpc}. */
export interface WorkbenchRpcContext {
  readonly db: SqlDriver;
  readonly service: CatalogService;
  readonly activeImports: Set<AbortController>;
  readonly checkpointWal: () => Promise<void>;
}

const optStr = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : String(v);
const optNum = (v: unknown): number | undefined =>
  v === undefined || v === null ? undefined : Number(v);

/** Validates a positive safe integer option (e.g. `batchSize`, `maxBodyBytes`). */
export function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

async function resolveRedactedStream(
  db: SqlDriver,
  service: CatalogService,
  itemKey: string,
): Promise<unknown> {
  const playable = await queryPlayable(db, itemKey);
  if (playable === undefined) return err(elvError('storage', 'item-not-found'));
  const matched = (await service.listSources()).find((s) => s.id === playable.sourceId);
  const accountKey = matched ? resolveAccountPoolKey(matched) : playable.sourceId;
  return ok({ url: PREVIEW_STREAM_URL, headers: {}, accountKey });
}

/**
 * Dispatches one allowlisted `POST /rpc` method against the local {@link CatalogService}.
 * `resolveStream` is always redacted to a synthetic preview URL with `accountKey` and zero secrets.
 */
export async function dispatchWorkbenchRpc(
  ctx: WorkbenchRpcContext,
  method: string,
  args: unknown[],
  res: ServerResponse,
): Promise<unknown> {
  const { db, service, activeImports, checkpointWal } = ctx;
  switch (method) {
    case 'addSource':
      return service.addSource(args[0] as AddSourceInput);
    case 'addSourceFromLink':
      return service.addSourceFromLink(args[0] as LinkSourceInput);
    case 'discoverSourceCategories':
      return (
        service.discoverSourceCategories?.(String(args[0] ?? '')) ??
        err(elvError('storage', 'unsupported'))
      );
    case 'updateSourceSettings': {
      if (!service.updateSourceSettings || !isSourceSettingsPatch(args[1])) return undefined;
      await service.updateSourceSettings(String(args[0] ?? ''), args[1]);
      await checkpointWal();
      return undefined;
    }
    case 'removeSource': {
      const result = await service.removeSource(String(args[0] ?? ''));
      await checkpointWal();
      return result;
    }
    case 'importGuide': {
      if (!service.importGuide) return err(elvError('storage', 'unsupported'));
      const ctl = new AbortController();
      activeImports.add(ctl);
      const onClose = () => {
        if (!res.writableEnded) ctl.abort();
      };
      res.on('close', onClose);
      try {
        const raw =
          typeof args[1] === 'object' && args[1] !== null
            ? (args[1] as Record<string, unknown>)
            : {};
        const result = await service.importGuide(String(args[0] ?? ''), {
          ...(isPositiveSafeInt(raw.batchSize) ? { batchSize: raw.batchSize } : {}),
          signal: ctl.signal,
        });
        await checkpointWal();
        return result;
      } finally {
        res.off('close', onClose);
        activeImports.delete(ctl);
      }
    }
    case 'listSources':
      return service.listSources();
    case 'categories': {
      const opts: CategoryQueryOptions | undefined = isCategoryQueryOptions(args[2])
        ? args[2]
        : undefined;
      return service.categories(String(args[0] ?? ''), args[1] as BrowseKind, opts);
    }
    case 'items': {
      const opts: ListItemsOptions | undefined = isListItemsOptions(args[3]) ? args[3] : undefined;
      return service.items(String(args[0] ?? ''), Number(args[1] ?? 0), Number(args[2] ?? 0), opts);
    }
    case 'liveVariants':
      return service.liveVariants?.(String(args[0] ?? ''), optStr(args[1])) ?? [];
    case 'itemVersions':
      return service.itemVersions?.(String(args[0] ?? '')) ?? [];
    case 'allSourcesItems': {
      const rawKind = args[0];
      if (rawKind !== 'live' && rawKind !== 'movie' && rawKind !== 'series') return [];
      const sourceIds = isSourceIdList(args[3]) ? args[3] : undefined;
      const opts: ListItemsOptions | undefined = isListItemsOptions(args[4]) ? args[4] : undefined;
      return (
        service.allSourcesItems?.(
          rawKind,
          Number(args[1] ?? 0),
          Number(args[2] ?? 0),
          sourceIds,
          opts,
        ) ?? []
      );
    }
    case 'itemDetail':
      return service.itemDetail?.(String(args[0] ?? '')) ?? null;
    case 'search': {
      const opts: SearchOptions | undefined = isSearchOptions(args[1]) ? args[1] : undefined;
      return (
        service.search?.(String(args[0] ?? ''), opts) ?? {
          live: [],
          epg: [],
          movies: [],
          series: [],
          episodes: [],
        }
      );
    }
    case 'searchSuggestions': {
      if (args[0] !== undefined && args[0] !== null && !isSearchSuggestionsOptions(args[0])) {
        return [];
      }
      const options = isSearchSuggestionsOptions(args[0]) ? args[0] : undefined;
      return service.searchSuggestions?.(options) ?? [];
    }
    case 'alphabetIndex': {
      if (!isAlphabetIndexInput(args[0])) return [];
      return service.alphabetIndex?.(args[0]) ?? [];
    }
    case 'nowNext':
      return service.nowNext?.(args[0] as readonly string[], Number(args[1] ?? 0)) ?? [];
    case 'epgWindow':
      return (
        service.epgWindow?.(
          args[0] as readonly string[],
          Number(args[1] ?? 0),
          Number(args[2] ?? 0),
        ) ?? {}
      );
    case 'channelByNumber':
      return service.channelByNumber?.(Number(args[0] ?? 0), optStr(args[1])) ?? null;
    case 'seasons':
      return service.seasons(Number(args[0] ?? 0));
    case 'episodes':
      return service.episodes(Number(args[0] ?? 0), Number(args[1] ?? 0));
    case 'queryNextEpisode':
      return (
        service.queryNextEpisode?.(String(args[0] ?? ''), String(args[1] ?? ''), optStr(args[2])) ??
        null
      );
    case 'resolveStream':
      return resolveRedactedStream(db, service, String(args[0] ?? ''));
    case 'saveProgress':
      return (
        service.saveProgress?.(args[0] as SaveProgressInput) ??
        err(elvError('storage', 'unsupported'))
      );
    case 'setWatched':
      return (
        service.setWatched?.(String(args[0] ?? ''), Boolean(args[1]), optStr(args[2])) ??
        err(elvError('storage', 'unsupported'))
      );
    case 'setSeasonWatched': {
      const season = args[1];
      if (typeof season !== 'number' || !Number.isSafeInteger(season) || season < 0) {
        return err(elvError('source-format', 'invalid-series-watched'));
      }
      return (
        service.setSeasonWatched?.(
          String(args[0] ?? ''),
          season,
          Boolean(args[2]),
          optStr(args[3]),
        ) ?? err(elvError('storage', 'unsupported'))
      );
    }
    case 'setSeriesWatched':
      return (
        service.setSeriesWatched?.(String(args[0] ?? ''), Boolean(args[1]), optStr(args[2])) ??
        err(elvError('storage', 'unsupported'))
      );
    case 'getProgress':
      return service.getProgress?.(String(args[0] ?? ''), optStr(args[1])) ?? null;
    case 'listContinueWatching':
      return service.listContinueWatching?.(optNum(args[0]), optStr(args[1])) ?? [];
    case 'listProgressByKeys':
      return service.listProgressByKeys?.(args[0] as readonly string[], optStr(args[1])) ?? [];
    case 'listSeriesUnplayedCounts': {
      if (!isSeriesKeyList(args[0]) || !isOptionalProfileId(args[1])) return [];
      return service.listSeriesUnplayedCounts?.(args[0], optStr(args[1])) ?? [];
    }
    case 'clearProgress':
      return (
        service.clearProgress?.(String(args[0] ?? ''), optStr(args[1])) ??
        err(elvError('storage', 'unsupported'))
      );
    case 'toggleFavorite':
      return (
        service.toggleFavorite?.(args[0] as ToggleFavoriteInput) ??
        err(elvError('storage', 'unsupported'))
      );
    case 'listFavorites':
      return service.listFavorites?.(optNum(args[0]), optStr(args[1])) ?? [];
    case 'listFavoriteKeys':
      return service.listFavoriteKeys?.(optStr(args[0])) ?? [];
    default:
      return err(elvError('storage', 'unknown-method'));
  }
}
