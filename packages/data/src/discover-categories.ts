import {
  type ContentKind,
  elvError,
  err,
  httpStatusError,
  ok,
  openAsyncIterator,
  type Result,
  transportHeaders,
} from '@elv/domain';
import { scanM3u, type XtreamCategory } from '@elv/sources';
import { runParallelFailFast } from './import-progress';
import { checkAbort, Stop, unwrap } from './import-run';
import { discoverStalkerCategories } from './import-stalker';
import { DEFAULT_BATCH_SIZE, type ImportDeps } from './import-types';
import { openClient } from './import-xtream';
import { isPlaceholderLiveChannel } from './placeholder-filter';
import type { BrowseKind } from './queries';
import { getSource, type SourceRecord, secretKey } from './sources';

const REQUEST_TIMEOUT_MS = 180_000;
const XTREAM_UNCATEGORIZED = 'Uncategorized';
const M3U_UNGROUPED = 'Ungrouped';

/** Category metadata with streamed item count returned by {@link discoverSourceCategories} (`#39`). */
export interface DiscoveredCategory {
  readonly id: string;
  readonly name: string;
  readonly kind: BrowseKind;
  readonly itemCount: number;
}

const isTooLarge = (e: { category: string; code: string }) =>
  e.category === 'source-format' && e.code === 'too-large';

async function countXtreamKind<T extends { id: number; categoryIds: string[]; name?: string }>(
  categories: readonly XtreamCategory[],
  stream: (
    categoryId?: string,
    opts?: { signal?: AbortSignal; batchSize?: number },
  ) => AsyncGenerator<T[], Result<void>>,
  signal: AbortSignal | undefined,
  skip?: (item: T) => boolean,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const c of categories) counts.set(c.id, 0);

  const consume = async (categoryId?: string): Promise<Result<void>> => {
    const gen = stream(categoryId, {
      ...(signal === undefined ? {} : { signal }),
      batchSize: DEFAULT_BATCH_SIZE,
    });
    try {
      for (;;) {
        checkAbort({ signal });
        const step = await gen.next();
        if (step.done) return step.value;
        for (const item of step.value) {
          if (skip?.(item)) continue;
          const cats =
            categoryId !== undefined
              ? [categoryId]
              : item.categoryIds.length > 0
                ? item.categoryIds
                : [XTREAM_UNCATEGORIZED];
          for (const cid of cats) {
            counts.set(cid, (counts.get(cid) ?? 0) + 1);
          }
        }
      }
    } finally {
      await gen.return(ok(undefined));
    }
  };

  const whole = await consume();
  if (!whole.ok) {
    if (!isTooLarge(whole.error)) throw new Stop(whole.error);
    for (const c of categories) counts.set(c.id, 0);
    for (const c of categories) {
      checkAbort({ signal });
      unwrap(await consume(c.id));
    }
  }
  return counts;
}

async function discoverXtream(
  source: SourceRecord,
  deps: ImportDeps,
  signal: AbortSignal | undefined,
): Promise<Result<readonly DiscoveredCategory[]>> {
  const opened = await openClient(source, deps);
  if (!opened.ok) return opened;
  const client = opened.value;
  const includePlaceholders = source.settings.includePlaceholderChannels === true;
  const skipLive = includePlaceholders
    ? undefined
    : (i: { name?: string; id: number }) =>
        isPlaceholderLiveChannel({ name: i.name ?? '', streamId: i.id });

  try {
    const [liveCats, movieCats, seriesCats] = await runParallelFailFast(signal, [
      async (sig) => unwrap(await client.categories('live', { signal: sig })),
      async (sig) => unwrap(await client.categories('movie', { signal: sig })),
      async (sig) => unwrap(await client.categories('series', { signal: sig })),
    ]);

    const [liveCounts, movieCounts, seriesCounts] = await runParallelFailFast(signal, [
      (sig) => countXtreamKind(liveCats, (id, o) => client.streamLiveStreams(id, o), sig, skipLive),
      (sig) => countXtreamKind(movieCats, (id, o) => client.streamVodStreams(id, o), sig),
      (sig) => countXtreamKind(seriesCats, (id, o) => client.streamSeries(id, o), sig),
    ]);

    const out: DiscoveredCategory[] = [];
    const append = (
      kind: BrowseKind,
      cats: readonly XtreamCategory[],
      counts: Map<string, number>,
    ): void => {
      const seen = new Set<string>();
      for (const c of cats) {
        seen.add(c.id);
        out.push({ id: c.id, name: c.name, kind, itemCount: counts.get(c.id) ?? 0 });
      }
      const uncat = counts.get(XTREAM_UNCATEGORIZED) ?? 0;
      if (uncat > 0 && !seen.has(XTREAM_UNCATEGORIZED)) {
        out.push({
          id: XTREAM_UNCATEGORIZED,
          name: XTREAM_UNCATEGORIZED,
          kind,
          itemCount: uncat,
        });
      }
    };

    append('live', liveCats, liveCounts);
    append('movie', movieCats, movieCounts);
    append('series', seriesCats, seriesCounts);
    return ok(out);
  } catch (e) {
    if (signal?.aborted) return err(elvError('network', 'aborted'));
    return err(e instanceof Stop ? e.error : elvError('storage', 'import-failed'));
  }
}

async function discoverM3u(
  source: SourceRecord,
  deps: ImportDeps,
  signal: AbortSignal | undefined,
): Promise<Result<readonly DiscoveredCategory[]>> {
  let body: AsyncIterable<Uint8Array>;
  let baseUrl: string | undefined;

  if (source.settings.isLocalPlaylist === true) {
    if (deps.localPlaylistStore === undefined) {
      return err(elvError('storage', 'local-playlist-unsupported'));
    }
    const localBody = await deps.localPlaylistStore.openRead(source.id);
    if (localBody === undefined) return err(elvError('storage', 'local-playlist-missing'));
    body = localBody;
  } else {
    const playlistUrl = await deps.secrets
      .get(secretKey(source.id, 'playlist'))
      .catch(() => undefined);
    if (playlistUrl === undefined) return err(elvError('storage', 'secret-missing'));
    let response: Awaited<ReturnType<ImportDeps['http']['get']>>;
    try {
      const transport = source.settings.transport;
      response = await deps.http.get(playlistUrl, {
        headers: transportHeaders(transport),
        timeoutMs: REQUEST_TIMEOUT_MS,
        ...(transport?.allowLegacyTls ? { allowLegacyTls: true } : {}),
        ...(transport?.dnsFamily !== undefined ? { dnsFamily: transport.dnsFamily } : {}),
        ...(transport?.hostOverride !== undefined ? { hostOverride: transport.hostOverride } : {}),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      return err(elvError('network', signal?.aborted ? 'aborted' : 'request-failed'));
    }
    if (!response.ok) return response;
    if (response.value.status < 200 || response.value.status >= 300) {
      try {
        await openAsyncIterator(response.value.body).return?.();
      } catch {
        // ignore discard error
      }
      return err(httpStatusError(response.value.status));
    }
    body = response.value.body;
    baseUrl = response.value.finalUrl ?? playlistUrl;
  }

  const vod = source.settings.vodPlaylist === true;
  const filterPlaceholders = source.settings.includePlaceholderChannels !== true;
  const counts: Record<BrowseKind, Map<string, number>> = {
    live: new Map(),
    movie: new Map(),
    series: new Map(),
  };

  const scan = scanM3u(body, {
    batchSize: DEFAULT_BATCH_SIZE,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(deps.decompressor === undefined ? {} : { decompressor: deps.decompressor }),
  });

  try {
    for (;;) {
      if (signal?.aborted) return err(elvError('network', 'aborted'));
      const step = await scan.next();
      if (step.done) {
        if (!step.value.ok) return step.value;
        break;
      }
      for (const entry of step.value.entries) {
        const contentKind: ContentKind =
          vod || entry.kindHint === 'movie'
            ? 'movie'
            : entry.kindHint === 'episode'
              ? 'episode'
              : 'live';
        if (
          contentKind === 'live' &&
          filterPlaceholders &&
          isPlaceholderLiveChannel({ name: entry.name })
        ) {
          continue;
        }
        const browseKind: BrowseKind = contentKind === 'episode' ? 'series' : contentKind;
        const groups = entry.groups.length === 0 ? [M3U_UNGROUPED] : entry.groups;
        const map = counts[browseKind];
        for (const group of groups) {
          map.set(group, (map.get(group) ?? 0) + 1);
        }
      }
    }
  } finally {
    await scan.return(ok(undefined));
  }

  const out: DiscoveredCategory[] = [];
  for (const kind of ['live', 'movie', 'series'] as const) {
    for (const [name, itemCount] of counts[kind]) {
      out.push({ id: name, name, kind, itemCount });
    }
  }
  return ok(out);
}

/**
 * Streams category metadata and item counts for a saved source without writing to SQLite (`#39`).
 * Supports Xtream panels (including `Uncategorized`) and remote or local M3U playlists (including `Ungrouped`).
 */
export async function discoverSourceCategories(
  sourceId: string,
  deps: ImportDeps,
  opts?: { signal?: AbortSignal },
): Promise<Result<readonly DiscoveredCategory[]>> {
  const source = await getSource(deps.db, sourceId);
  if (source === undefined) return err(elvError('storage', 'source-not-found'));
  if (source.kind === 'xtream') return discoverXtream(source, deps, opts?.signal);
  if (source.kind === 'm3u') return discoverM3u(source, deps, opts?.signal);
  if (source.kind === 'stalker') return discoverStalkerCategories(source, deps, opts?.signal);
  return err(elvError('source-format', 'unsupported-source'));
}
