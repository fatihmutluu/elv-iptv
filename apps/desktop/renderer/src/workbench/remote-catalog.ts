import type {
  CatalogService,
  DeviceImportOptions,
  ImportOptions,
  ImportProgress,
  ImportSummary,
} from '@elv/data';
import { elvError, err, type Result } from '@elv/domain';

const TOKEN_HEADER = 'X-Elv-Workbench-Token';
const DEFAULT_PROBE_TIMEOUT_MS = 2_500;
const LOOPBACK_URL_RE = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)$/i;

/** Connection settings for the dev-only local Workbench live-data HTTP bridge. */
export interface WorkbenchBridgeConfig {
  readonly baseUrl: string;
  readonly token: string;
}

function readRuntimeEnvVar(getter: () => string | undefined): string | undefined {
  try {
    return getter();
  } catch {
    return undefined;
  }
}

/**
 * Reads and validates the loopback Workbench live-data bridge URL and auth token from
 * `EXPO_PUBLIC_ELV_WORKBENCH_BRIDGE_URL` and `EXPO_PUBLIC_ELV_WORKBENCH_BRIDGE_TOKEN`.
 * Returns `null` whenever either value is missing, blank, or points to a non-loopback host.
 */
export function readWorkbenchBridgeConfig(
  env?: Record<string, string | undefined>,
): WorkbenchBridgeConfig | null {
  const rawUrl =
    env !== undefined
      ? env.EXPO_PUBLIC_ELV_WORKBENCH_BRIDGE_URL
      : readRuntimeEnvVar(() => process.env.EXPO_PUBLIC_ELV_WORKBENCH_BRIDGE_URL);
  const rawToken =
    env !== undefined
      ? env.EXPO_PUBLIC_ELV_WORKBENCH_BRIDGE_TOKEN
      : readRuntimeEnvVar(() => process.env.EXPO_PUBLIC_ELV_WORKBENCH_BRIDGE_TOKEN);

  if (typeof rawUrl !== 'string' || typeof rawToken !== 'string') return null;

  const token = rawToken.trim();
  if (token.length === 0 || /[\r\n]/.test(token)) return null;

  const trimmedUrl = rawUrl.trim().replace(/\/+$/, '');
  const match = LOOPBACK_URL_RE.exec(trimmedUrl);
  if (match === null) return null;

  const host = match[1]?.toLowerCase();
  const port = Number(match[2]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return null;

  return { baseUrl: `http://${host}:${port}`, token };
}

/**
 * Probes `GET /health` on the local Workbench live-data bridge with an abort timeout.
 * Returns `true` only on HTTP 2xx with `{ ok: true }`; swallows all network/timeout errors.
 */
export async function probeWorkbenchBridge(
  config: WorkbenchBridgeConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetchImpl(`${config.baseUrl}/health`, {
      method: 'GET',
      headers: { [TOKEN_HEADER]: config.token },
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(caught: unknown): boolean {
  return (
    typeof caught === 'object' &&
    caught !== null &&
    (caught as { name?: unknown }).name === 'AbortError'
  );
}

function isResultShape(value: unknown): value is Result<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  );
}

function trimUndefinedArgs(args: unknown[]): unknown[] {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end -= 1;
  return args.slice(0, end);
}

function invokeProgressSafely(
  onProgress: ((p: ImportProgress) => void) | undefined,
  progress: ImportProgress,
): void {
  if (!onProgress) return;
  try {
    onProgress(progress);
  } catch {
    // Isolate caller callback errors so streaming completes cleanly.
  }
}

/**
 * Creates a browser-safe {@link CatalogService} backed by the local dev-only Workbench HTTP
 * bridge (`POST /rpc` for queries/mutations and streaming NDJSON `POST /rpc/import` for imports).
 */
export function createWorkbenchRemoteCatalog(
  config: WorkbenchBridgeConfig,
  fetchImpl: typeof fetch = fetch,
): CatalogService {
  const jsonHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    [TOKEN_HEADER]: config.token,
  };

  async function rpcQuery<T>(method: string, args: unknown[]): Promise<T> {
    const res = await fetchImpl(`${config.baseUrl}/rpc`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ method, args: trimUndefinedArgs(args) }),
    });
    if (!res.ok) {
      throw new Error(`workbench bridge ${method} failed with HTTP ${res.status}`);
    }
    const data: unknown = await res.json();
    if (typeof data !== 'object' || data === null || !('value' in data)) {
      throw new Error(`workbench bridge ${method} returned invalid payload`);
    }
    return (data as { value: T }).value;
  }

  async function rpcResult<T>(
    method: string,
    args: unknown[],
    signal?: AbortSignal,
  ): Promise<Result<T>> {
    if (signal?.aborted) {
      return err(elvError('network', 'aborted'));
    }
    try {
      const res = await fetchImpl(`${config.baseUrl}/rpc`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ method, args: trimUndefinedArgs(args) }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!res.ok) {
        return err(elvError('network', 'unreachable'));
      }
      const data: unknown = await res.json();
      if (typeof data !== 'object' || data === null || !('value' in data)) {
        return err(elvError('network', 'unreachable'));
      }
      const val = (data as { value: unknown }).value;
      if (!isResultShape(val)) {
        return err(elvError('network', 'unreachable'));
      }
      return val as Result<T>;
    } catch (caught) {
      if (signal?.aborted || isAbortError(caught)) {
        return err(elvError('network', 'aborted'));
      }
      return err(elvError('network', 'unreachable'));
    }
  }

  async function importSource(
    id: string,
    opts?: DeviceImportOptions,
  ): Promise<Result<ImportSummary>> {
    if (opts?.signal?.aborted) {
      return err(elvError('network', 'aborted'));
    }
    const payload: { id: string; batchSize?: number; maxBodyBytes?: number } = {
      id,
      ...(opts?.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
      ...(opts?.maxBodyBytes === undefined ? {} : { maxBodyBytes: opts.maxBodyBytes }),
    };

    let finalResult: Result<ImportSummary> | undefined;
    const processLine = (rawLine: string): void => {
      const line = rawLine.trim();
      if (line.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) return;
      const frame = parsed as { type?: unknown; progress?: unknown; result?: unknown };
      if (
        frame.type === 'progress' &&
        typeof frame.progress === 'object' &&
        frame.progress !== null
      ) {
        invokeProgressSafely(opts?.onProgress, frame.progress as ImportProgress);
      } else if (frame.type === 'result' && isResultShape(frame.result)) {
        finalResult = frame.result as Result<ImportSummary>;
      }
    };

    try {
      const res = await fetchImpl(`${config.baseUrl}/rpc/import`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(payload),
        ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
      });
      if (!res.ok) {
        return err(elvError('network', 'unreachable'));
      }

      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let nl = buffer.indexOf('\n');
            while (nl !== -1) {
              processLine(buffer.slice(0, nl));
              buffer = buffer.slice(nl + 1);
              nl = buffer.indexOf('\n');
            }
          }
          buffer += decoder.decode();
          if (buffer.trim().length > 0) processLine(buffer);
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // Lock already released on aborted/closed stream.
          }
        }
      } else {
        const text = await res.text();
        for (const line of text.split('\n')) {
          processLine(line);
        }
      }

      if (finalResult !== undefined) return finalResult;
      if (opts?.signal?.aborted) return err(elvError('network', 'aborted'));
      return err(elvError('network', 'unreachable'));
    } catch (caught) {
      if (opts?.signal?.aborted || isAbortError(caught)) {
        return err(elvError('network', 'aborted'));
      }
      return err(elvError('network', 'unreachable'));
    }
  }

  return {
    addSource: (input) => rpcResult('addSource', [input]),
    addSourceFromLink: (input) => rpcResult('addSourceFromLink', [input]),
    discoverSourceCategories: (sourceId, opts) =>
      rpcResult('discoverSourceCategories', [sourceId], opts?.signal),
    updateSourceSettings: (sourceId, patch) => rpcQuery('updateSourceSettings', [sourceId, patch]),
    removeSource: (id) => rpcResult('removeSource', [id]),
    importSource,
    importGuide: (sourceId: string, opts?: ImportOptions) =>
      rpcResult(
        'importGuide',
        opts?.batchSize === undefined ? [sourceId] : [sourceId, { batchSize: opts.batchSize }],
        opts?.signal,
      ),
    listSources: () => rpcQuery('listSources', []),
    categories: (sourceId, kind, opts) => rpcQuery('categories', [sourceId, kind, opts]),
    items: (categoryId, offset, limit, opts) =>
      rpcQuery('items', [categoryId, offset, limit, opts]),
    liveVariants: (itemKey, categoryId) => rpcQuery('liveVariants', [itemKey, categoryId]),
    itemVersions: (itemKey) => rpcQuery('itemVersions', [itemKey]),
    allSourcesItems: (kind, offset, limit, sourceIds, opts) =>
      rpcQuery('allSourcesItems', [kind, offset, limit, sourceIds, opts]),
    itemDetail: (itemKey) => rpcQuery('itemDetail', [itemKey]),
    search: (query, opts) => rpcQuery('search', [query, opts]),
    searchSuggestions: (options) => rpcQuery('searchSuggestions', [options]),
    alphabetIndex: (input) => rpcQuery('alphabetIndex', [input]),
    nowNext: (channelKeys, nowMs) => rpcQuery('nowNext', [channelKeys, nowMs]),
    epgWindow: (channelKeys, fromMs, toMs) => rpcQuery('epgWindow', [channelKeys, fromMs, toMs]),
    channelByNumber: (num, sourceId) => rpcQuery('channelByNumber', [num, sourceId]),
    seasons: (seriesId) => rpcResult('seasons', [seriesId]),
    episodes: (seriesId, season) => rpcQuery('episodes', [seriesId, season]),
    queryNextEpisode: (seriesKey, currentItemKey, profileId) =>
      rpcQuery('queryNextEpisode', [seriesKey, currentItemKey, profileId]),
    resolveStream: (itemKey) => rpcResult('resolveStream', [itemKey]),
    saveProgress: (input) => rpcResult('saveProgress', [input]),
    setWatched: (itemKey, watched, profileId) =>
      rpcResult('setWatched', [itemKey, watched, profileId]),
    setSeasonWatched: (seriesKey, season, watched, profileId) =>
      rpcResult('setSeasonWatched', [seriesKey, season, watched, profileId]),
    setSeriesWatched: (seriesKey, watched, profileId) =>
      rpcResult('setSeriesWatched', [seriesKey, watched, profileId]),
    getProgress: (itemKey, profileId) => rpcQuery('getProgress', [itemKey, profileId]),
    listContinueWatching: (limit, profileId) =>
      rpcQuery('listContinueWatching', [limit, profileId]),
    listProgressByKeys: (itemKeys, profileId) =>
      rpcQuery('listProgressByKeys', [itemKeys, profileId]),
    listSeriesUnplayedCounts: (seriesKeys, profileId) =>
      rpcQuery('listSeriesUnplayedCounts', [seriesKeys, profileId]),
    clearProgress: (itemKey, profileId) => rpcResult('clearProgress', [itemKey, profileId]),
    toggleFavorite: (input) => rpcResult('toggleFavorite', [input]),
    listFavorites: (limit, profileId) => rpcQuery('listFavorites', [limit, profileId]),
    listFavoriteKeys: (profileId) => rpcQuery('listFavoriteKeys', [profileId]),
    close: async () => undefined,
  };
}
