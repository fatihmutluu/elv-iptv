import { resolveAccountPoolKey, type SourceRow, type StreamRequest } from '@elv/data';
import {
  type DnsFamilyPreference,
  elvError,
  err,
  type FetchLike,
  type HttpRequestOptions,
  ok,
  type Result,
} from '@elv/domain';
import { type ConnectionTracker, createConnectionTracker } from '@elv/playback';
import {
  type CatalogClientMessage,
  type CatalogRpcMethodCall,
  isCatalogWorkerMessage,
} from '../../shared/catalog-ipc.ts';
import {
  createDesktopHttpClient,
  type DesktopHttpClientOptions,
} from '../../utility/legacy-tls-http.ts';
import type { CatalogCoordinator } from '../catalog/coordinator.ts';
import type { ResolvedDownloadStream } from './download-manager.ts';

/** Subset of Electron's `MessagePortMain` used by {@link createDesktopDownloadDeps}. */
interface DownloadCatalogPortLike {
  on(event: 'message', listener: (messageEvent: { readonly data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  off(event: 'message', listener: (messageEvent: { readonly data: unknown }) => void): unknown;
  off(event: 'close', listener: () => void): unknown;
  postMessage(message: CatalogClientMessage): void;
  start(): void;
  close(): void;
}

/** Minimal coordinator subset required by {@link createDesktopDownloadDeps}. */
type DownloadCatalogCoordinatorLike = Pick<
  CatalogCoordinator<DownloadCatalogPortLike>,
  'connectClient' | 'disconnectClient'
> &
  Partial<Pick<CatalogCoordinator<DownloadCatalogPortLike>, 'onUnexpectedExit'>>;

/** Collaborators for {@link createDesktopDownloadDeps}. */
interface DesktopDownloadDepsOptions {
  readonly getCoordinator: () => DownloadCatalogCoordinatorLike | undefined;
  readonly connectionTracker?: ConnectionTracker;
  readonly fetch?: typeof globalThis.fetch;
  readonly httpClientOptions?: DesktopHttpClientOptions;
  readonly rpcTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

interface SourceTransportEntry {
  readonly allowLegacyTls: boolean;
  readonly dnsFamily?: DnsFamilyPreference;
  readonly hostOverride?: string;
  readonly cachedAt: number;
}

const SOURCE_CACHE_TTL_MS = 60_000;
const CUSTOM_TRANSPORT_IDLE_MS = 600_000;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;

interface PendingRpcEntry {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly cleanup: () => void;
}

function createPortCaller(
  port: DownloadCatalogPortLike,
  rpcTimeoutMs: number,
): {
  call<T>(rpc: CatalogRpcMethodCall, signal?: AbortSignal): Promise<T>;
  failAll(reason: Error): void;
  dispose(): void;
} {
  let nextReqId = 0;
  let closed = false;
  const pending = new Map<number, PendingRpcEntry>();

  const failAll = (reason: Error): void => {
    for (const entry of [...pending.values()]) {
      entry.cleanup();
      entry.reject(reason);
    }
    pending.clear();
  };

  const onMessage = (event: { readonly data: unknown }): void => {
    const raw = event.data;
    if (!isCatalogWorkerMessage(raw) || raw.type === 'progress') return;
    const entry = pending.get(raw.reqId);
    if (!entry) return;
    pending.delete(raw.reqId);
    entry.cleanup();
    if (raw.type === 'result') {
      entry.resolve(raw.value);
    } else {
      entry.reject(new Error(`catalog worker fault: ${raw.error.category}/${raw.error.code}`));
    }
  };

  const onClose = (): void => {
    closed = true;
    failAll(new Error('desktop download catalog port closed'));
  };

  port.on('message', onMessage);
  port.on('close', onClose);
  port.start();

  return {
    call<T>(rpc: CatalogRpcMethodCall, signal?: AbortSignal): Promise<T> {
      if (closed) {
        return Promise.reject(new Error('desktop download catalog port closed'));
      }
      if (signal?.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
      }
      const reqId = ++nextReqId;
      return new Promise<T>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = (): void => {
          if (!pending.delete(reqId)) return;
          cleanup();
          reject(new DOMException('Aborted', 'AbortError'));
        };
        const cleanup = (): void => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          signal?.removeEventListener('abort', onAbort);
        };
        timer = setTimeout(() => {
          if (!pending.delete(reqId)) return;
          cleanup();
          reject(new Error('desktop download catalog rpc timeout'));
        }, rpcTimeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        pending.set(reqId, {
          resolve: (val) => resolve(val as T),
          reject,
          cleanup,
        });
        try {
          port.postMessage({ type: 'call', reqId, call: rpc });
        } catch (error) {
          if (pending.delete(reqId)) {
            cleanup();
            reject(error instanceof Error ? error : new Error('catalog port postMessage failed'));
          }
        }
      });
    },
    failAll,
    dispose(): void {
      closed = true;
      port.off('message', onMessage);
      port.off('close', onClose);
      failAll(new Error('desktop download catalog port disposed'));
      port.close();
    },
  };
}

function connectClientBounded(
  coordinator: DownloadCatalogCoordinatorLike,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ clientId: number; rendererPort: DownloadCatalogPortLike }> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  let abandoned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const connectPromise = coordinator.connectClient().then((conn) => {
    if (abandoned) {
      try {
        conn.rendererPort.close();
      } catch {
        // Ignore teardown races.
      }
      coordinator.disconnectClient(conn.clientId);
    }
    return conn;
  });
  connectPromise.catch(() => undefined);

  const guardPromise = new Promise<never>((_, reject) => {
    onAbort = () => {
      abandoned = true;
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      abandoned = true;
      reject(new Error('desktop download catalog connect timeout'));
    }, timeoutMs);
  });

  return Promise.race([connectPromise, guardPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  });
}

function normalizeHeadersInit(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      out[key] = value;
    }
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function asyncIterableToReadableStream(
  iterable: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  let iterator: AsyncIterator<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (iterator === null) iterator = iterable[Symbol.asyncIterator]();
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      if (iterator === null) iterator = iterable[Symbol.asyncIterator]();
      await iterator.return?.().catch(() => undefined);
      iterator = null;
    },
  });
}

function isResultStreamRequest(raw: unknown): raw is Result<StreamRequest> {
  if (typeof raw !== 'object' || raw === null || !('ok' in raw)) return false;
  return typeof (raw as { ok: unknown }).ok === 'boolean';
}

/**
 * Wires main-process lazy `resolveStream`, per-source transport routing (`allowLegacyTls`,
 * `dnsFamily`, `hostOverride`), and `ConnectionTracker` leases into `createDesktopDownloadManager`.
 */
export function createDesktopDownloadDeps(deps: DesktopDownloadDepsOptions): {
  readonly resolveStream: (
    itemKey: string,
    sourceId: string,
    signal?: AbortSignal,
  ) => Promise<Result<ResolvedDownloadStream>>;
  readonly fetchForSource: (sourceId: string, url: string, init: RequestInit) => Promise<Response>;
  readonly acquireConnection: (
    sourceId: string,
    signal?: AbortSignal,
  ) => Promise<{ release(): void }>;
} {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const tracker = deps.connectionTracker ?? createConnectionTracker();
  const rpcTimeoutMs =
    typeof deps.rpcTimeoutMs === 'number' &&
    Number.isFinite(deps.rpcTimeoutMs) &&
    deps.rpcTimeoutMs > 0
      ? deps.rpcTimeoutMs
      : DEFAULT_RPC_TIMEOUT_MS;
  const desktopHttp = createDesktopHttpClient(
    ((url, init) =>
      fetchImpl(url, {
        ...(init.headers !== undefined ? { headers: init.headers } : {}),
        ...(init.signal !== undefined ? { signal: init.signal } : {}),
        ...(init.redirect !== undefined ? { redirect: init.redirect } : {}),
      })) as FetchLike,
    deps.httpClientOptions,
  );

  const sourceTransport = new Map<string, SourceTransportEntry>();
  const sourceAccountKeys = new Map<string, string>();
  let leaseSeq = 0;

  const withCatalogPort = async <T>(
    run: (
      call: <R>(rpc: CatalogRpcMethodCall, callSignal?: AbortSignal) => Promise<R>,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | undefined> => {
    const coordinator = deps.getCoordinator();
    if (coordinator === undefined) return undefined;
    const { clientId, rendererPort } = await connectClientBounded(
      coordinator,
      rpcTimeoutMs,
      signal,
    );
    const caller = createPortCaller(rendererPort, rpcTimeoutMs);
    const offExit = coordinator.onUnexpectedExit?.(() => {
      caller.failAll(new Error('catalog utility process exited unexpectedly'));
    });
    try {
      return await run((rpc, callSignal) => caller.call(rpc, callSignal ?? signal));
    } finally {
      offExit?.();
      caller.dispose();
      coordinator.disconnectClient(clientId);
    }
  };

  const refreshSourceMetadata = async (
    sourceId: string,
    signal?: AbortSignal,
  ): Promise<SourceTransportEntry | null> => {
    const cached = sourceTransport.get(sourceId);
    if (
      cached !== undefined &&
      sourceAccountKeys.has(sourceId) &&
      Date.now() - cached.cachedAt < SOURCE_CACHE_TTL_MS
    ) {
      return cached;
    }
    try {
      const list = await withCatalogPort(
        (call) => call<unknown>({ method: 'listSources' }, signal),
        signal,
      );
      if (!Array.isArray(list)) return cached ?? null;
      const nowMs = Date.now();
      for (const row of list as readonly SourceRow[]) {
        if (typeof row?.id !== 'string') continue;
        sourceTransport.set(row.id, {
          allowLegacyTls: row.allowLegacyTls === true,
          ...(row.dnsFamily !== undefined ? { dnsFamily: row.dnsFamily } : {}),
          ...(row.hostOverride !== undefined ? { hostOverride: row.hostOverride } : {}),
          cachedAt: nowMs,
        });
        sourceAccountKeys.set(row.id, resolveAccountPoolKey(row));
      }
      return sourceTransport.get(sourceId) ?? null;
    } catch {
      deps.log?.('downloads: failed to refresh source transport settings');
      return cached ?? null;
    }
  };

  return {
    async resolveStream(
      itemKey: string,
      sourceId: string,
      signal?: AbortSignal,
    ): Promise<Result<ResolvedDownloadStream>> {
      try {
        const raw = await withCatalogPort(
          (call) => call<unknown>({ method: 'resolveStream', itemKey }, signal),
          signal,
        );
        if (raw === undefined) {
          return err(elvError('storage', 'catalog-unavailable', 'catalog worker unavailable'));
        }
        if (!isResultStreamRequest(raw)) {
          return err(elvError('playback', 'download-resolve-failed', 'unexpected resolve reply'));
        }
        if (!raw.ok) return raw;
        const stream = raw.value;
        sourceTransport.set(sourceId, {
          allowLegacyTls: stream.allowLegacyTls === true,
          ...(stream.dnsFamily !== undefined ? { dnsFamily: stream.dnsFamily } : {}),
          ...(stream.hostOverride !== undefined ? { hostOverride: stream.hostOverride } : {}),
          cachedAt: Date.now(),
        });
        if (stream.accountKey && stream.accountKey.length > 0) {
          sourceAccountKeys.set(sourceId, stream.accountKey);
        }
        return ok({
          url: stream.url,
          headers: stream.headers,
        });
      } catch {
        return err(elvError('playback', 'download-resolve-failed', 'stream resolution failed'));
      }
    },

    async fetchForSource(sourceId: string, url: string, init: RequestInit): Promise<Response> {
      const transport = await refreshSourceMetadata(sourceId, init.signal ?? undefined);
      const hasCustomTransport =
        transport !== null &&
        (transport.allowLegacyTls ||
          (transport.dnsFamily !== undefined && transport.dnsFamily !== 'system') ||
          (transport.hostOverride !== undefined && transport.hostOverride.length > 0));

      if (!hasCustomTransport) {
        return fetchImpl(url, init);
      }

      const headers = normalizeHeadersInit(init.headers);
      const reqOpts: HttpRequestOptions = {
        headers,
        redirect: 'follow',
        idleTimeoutMs: CUSTOM_TRANSPORT_IDLE_MS,
        ...(init.signal !== null && init.signal !== undefined ? { signal: init.signal } : {}),
        ...(transport.allowLegacyTls ? { allowLegacyTls: true } : {}),
        ...(transport.dnsFamily !== undefined ? { dnsFamily: transport.dnsFamily } : {}),
        ...(transport.hostOverride !== undefined ? { hostOverride: transport.hostOverride } : {}),
      };
      const res = await desktopHttp.get(url, reqOpts);
      if (!res.ok) {
        const httpMatch = /^http-(\d{3})$/.exec(res.error.code);
        if (httpMatch?.[1]) {
          return new Response(null, { status: Number(httpMatch[1]) });
        }
        if (res.error.code === 'aborted') {
          throw new DOMException('Aborted', 'AbortError');
        }
        throw new Error(res.error.code);
      }
      const stream = asyncIterableToReadableStream(res.value.body);
      const response = new Response(stream, {
        status: res.value.status,
        headers: res.value.headers,
      });
      if (res.value.finalUrl) {
        Object.defineProperty(response, 'url', { value: res.value.finalUrl, configurable: true });
      }
      return response;
    },

    async acquireConnection(sourceId: string, signal?: AbortSignal): Promise<{ release(): void }> {
      if (!sourceAccountKeys.has(sourceId)) {
        await refreshSourceMetadata(sourceId, signal);
      }
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const accountKey = sourceAccountKeys.get(sourceId) ?? sourceId;
      leaseSeq += 1;
      const streamId = `download:${leaseSeq}:${sourceId}`;
      tracker.acquire(accountKey, streamId);
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          tracker.release(streamId);
        },
      };
    },
  };
}
