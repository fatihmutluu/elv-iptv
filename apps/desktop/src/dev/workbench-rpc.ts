import type { ServerResponse } from 'node:http';
import {
  type AddSourceInput,
  type BrowseKind,
  type CatalogService,
  type LinkSourceInput,
  queryPlayable,
  resolveAccountPoolKey,
  type SaveProgressInput,
  type SearchOptions,
  type ToggleFavoriteInput,
} from '@elv/data';
import { elvError, err, ok, type SqlDriver } from '@elv/domain';

const PREVIEW_STREAM_URL = 'https://workbench.invalid/preview.m3u8';

/** Strict allowlist of `CatalogService` methods exposed over `POST /rpc`. */
export const ALLOWED_RPC_METHODS: ReadonlySet<string> = new Set([
  'addSource',
  'addSourceFromLink',
  'removeSource',
  'importGuide',
  'listSources',
  'categories',
  'items',
  'itemDetail',
  'search',
  'nowNext',
  'epgWindow',
  'channelByNumber',
  'seasons',
  'episodes',
  'resolveStream',
  'saveProgress',
  'setWatched',
  'getProgress',
  'listContinueWatching',
  'listProgressByKeys',
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
    case 'categories':
      return service.categories(String(args[0] ?? ''), args[1] as BrowseKind);
    case 'items':
      return service.items(String(args[0] ?? ''), Number(args[1] ?? 0), Number(args[2] ?? 0));
    case 'itemDetail':
      return service.itemDetail?.(String(args[0] ?? '')) ?? null;
    case 'search':
      return (
        service.search?.(String(args[0] ?? ''), args[1] as SearchOptions | undefined) ?? {
          live: [],
          movies: [],
          series: [],
        }
      );
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
    case 'getProgress':
      return service.getProgress?.(String(args[0] ?? ''), optStr(args[1])) ?? null;
    case 'listContinueWatching':
      return service.listContinueWatching?.(optNum(args[0]), optStr(args[1])) ?? [];
    case 'listProgressByKeys':
      return service.listProgressByKeys?.(args[0] as readonly string[], optStr(args[1])) ?? [];
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
