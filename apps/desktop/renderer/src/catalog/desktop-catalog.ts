import type { CatalogService, DeviceImportOptions } from '@elv/data';
import { type ElvError, elvError, err } from '@elv/domain';
import type { CatalogBridge } from '../../../src/shared/catalog-ipc.ts';

/** The catalog utility process could not open or migrate SQLite; `error` carries the typed cause (no secrets). */
export class CatalogOpenError extends Error {
  constructor(readonly error: ElvError) {
    super(`catalog open failed: ${error.category}/${error.code}`);
  }
}

let instance: Promise<CatalogService> | undefined;

function sanitizeDisplayText(text: string): string {
  let out = '';
  let lastSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      if (!lastSpace) {
        out += ' ';
        lastSpace = true;
      }
    } else {
      out += text[i];
      lastSpace = code === 0x20;
    }
  }
  return out.trim();
}

/**
 * Adapts the preload's {@link CatalogBridge} into `@elv/data`'s {@link CatalogService}, mapping
 * `AbortSignal` cancellations onto `cancelImport(reqId)` and isolating progress callback throws.
 */
export function createDesktopCatalogFromBridge(
  bridge: CatalogBridge,
  onClose?: () => void,
): CatalogService {
  return {
    addSource: (input) => bridge.addSource(input),
    addSourceFromLink: (input) => bridge.addSourceFromLink(input),
    removeSource: (id) => bridge.removeSource(id),
    async importSource(id, opts?: DeviceImportOptions) {
      if (opts?.signal?.aborted) {
        return err(elvError('network', 'aborted'));
      }
      const handle = bridge.startImport(id, {
        ...(opts?.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
        ...(opts?.maxBodyBytes === undefined ? {} : { maxBodyBytes: opts.maxBodyBytes }),
        ...(opts?.onProgress === undefined
          ? {}
          : {
              onProgress: (progress) => {
                try {
                  opts.onProgress?.(progress);
                } catch {
                  // isolate caller callback errors
                }
              },
            }),
      });
      if (!opts?.signal) {
        return handle.result;
      }
      const onAbort = (): void => {
        bridge.cancelImport(handle.reqId);
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      try {
        return await handle.result;
      } finally {
        opts.signal.removeEventListener('abort', onAbort);
      }
    },
    listSources: () => bridge.listSources(),
    categories: (sourceId, kind) => bridge.categories(sourceId, kind),
    items: (categoryId, offset, limit) => bridge.items(categoryId, offset, limit),
    seasons: (seriesId) => bridge.seasons(seriesId),
    episodes: (seriesId, season) => bridge.episodes(seriesId, season),
    resolveStream: (itemKey) => bridge.resolveStream(itemKey),
    saveProgress: (input) =>
      bridge.saveProgress({
        ...input,
        title: sanitizeDisplayText(input.title),
        ...(typeof input.subtitle === 'string'
          ? { subtitle: sanitizeDisplayText(input.subtitle) }
          : {}),
      }),
    setWatched: (itemKey, watched, profileId) => bridge.setWatched(itemKey, watched, profileId),
    getProgress: (itemKey, profileId) => bridge.getProgress(itemKey, profileId),
    listContinueWatching: (limit, profileId) => bridge.listContinueWatching(limit, profileId),
    listProgressByKeys: (itemKeys, profileId) => bridge.listProgressByKeys(itemKeys, profileId),
    clearProgress: (itemKey, profileId) => bridge.clearProgress(itemKey, profileId),
    toggleFavorite: (input) =>
      bridge.toggleFavorite({ ...input, title: sanitizeDisplayText(input.title) }),
    listFavorites: (limit, profileId) => bridge.listFavorites(limit, profileId),
    listFavoriteKeys: (profileId) => bridge.listFavoriteKeys(profileId),
    async close() {
      onClose?.();
      await bridge.close();
    },
  };
}

async function open(): Promise<CatalogService> {
  const bridge = typeof window === 'undefined' ? undefined : window.elv?.catalog;
  if (!bridge) {
    throw new CatalogOpenError(elvError('storage', 'bridge-unavailable'));
  }
  const opened = await bridge.open();
  if (!opened.ok) {
    throw new CatalogOpenError(opened.error);
  }
  return createDesktopCatalogFromBridge(bridge, () => {
    instance = undefined;
  });
}

/**
 * The singleton desktop catalog of this renderer window, backed by the Electron catalog
 * `utilityProcess` over `MessagePort`. A failed open is not cached so the next call retries.
 */
export function createDesktopCatalog(): Promise<CatalogService> {
  instance ??= open().catch((e: unknown) => {
    instance = undefined;
    throw e;
  });
  return instance;
}
