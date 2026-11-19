import {
  elvError,
  err,
  type HttpResponse,
  httpStatusError,
  m3uKey,
  ok,
  openAsyncIterator,
  type Result,
  transportHeaders,
} from '@elv/domain';
import { type M3uEntry, scanM3u } from '@elv/sources';
import { foldText } from './fold';
import { checkAbort, performRun, type RunCtx, Stop, unwrap } from './import-run';
import type { ImportDeps, ImportOptions, ImportSummary } from './import-types';
import {
  createM3uImportState,
  finishM3uRun,
  type M3uBrowseKind,
  M3uEntryGate,
  type M3uImportState,
  type StagedM3u,
} from './m3u-gate';
import { entryHeaders, templated } from './m3u-headers';
import { MAX_URLVARS_BYTES, SAMPLE_SIZE } from './m3u-templating';
import {
  getSource,
  type SourceRecord,
  type SourceSettings,
  secretKey,
  updateSourceSettings,
} from './sources';
import { readUrlVars } from './stream-resolver';
import { keyTemplate, type UrlVars } from './templates';
import { writeCategories, writePlacements } from './writers';
import {
  type M3uLiveRow,
  type M3uRow,
  rollbackUnresolvedM3uRows,
  writeM3uEpisodes,
  writeM3uLive,
  writeM3uMovies,
  writeM3uSeries,
} from './writers-m3u';

const REQUEST_TIMEOUT_MS = 60_000;
const UNGROUPED = 'Ungrouped';

async function discard(body: HttpResponse['body']): Promise<void> {
  try {
    await openAsyncIterator(body).return?.();
  } catch {
    // the response is already classified by its status
  }
}

async function openPlaylist(
  source: SourceRecord,
  url: string,
  deps: ImportDeps,
  signal: AbortSignal | undefined,
): Promise<AsyncIterable<Uint8Array>> {
  let response: Awaited<ReturnType<ImportDeps['http']['get']>>;
  try {
    response = await deps.http.get(url, {
      headers: transportHeaders(source.settings.transport),
      timeoutMs: REQUEST_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new Stop(elvError('network', signal?.aborted ? 'aborted' : 'request-failed'));
  }
  const { status, body } = unwrap(response);
  if (status >= 200 && status < 300) return body;
  await discard(body);
  throw new Stop(httpStatusError(status));
}

const groupsOf = (entry: M3uEntry): readonly string[] =>
  entry.groups.length === 0 ? [UNGROUPED] : entry.groups;

function place(
  st: M3uImportState,
  kind: M3uBrowseKind,
  key: string,
  groups: readonly string[],
  fresh: Map<M3uBrowseKind, string[]>,
  links: Record<M3uBrowseKind, [string, string, number][]>,
): void {
  const known = st.categories[kind];
  for (const group of groups) {
    if (!known.has(group)) {
      known.set(group, known.size);
      let list = fresh.get(kind);
      if (list === undefined) {
        list = [];
        fresh.set(kind, list);
      }
      list.push(group);
    }
    const slot = `${kind}\n${group}`;
    const position = st.positions.get(slot) ?? 0;
    st.positions.set(slot, position + 1);
    links[kind].push([key, group, position]);
  }
}

async function processBatch(
  c: RunCtx,
  st: M3uImportState,
  entries: readonly M3uEntry[],
): Promise<void> {
  const vod = st.settings.vodPlaylist === true;
  const live: M3uLiveRow[] = [];
  const movies: M3uRow[] = [];
  const episodes: (M3uRow & { seriesKey: string })[] = [];
  const series = new Map<string, string>();
  const fresh = new Map<M3uBrowseKind, string[]>();
  const links: Record<M3uBrowseKind, [string, string, number][]> = {
    live: [],
    movie: [],
    series: [],
  };
  for (const entry of entries) {
    const template = templated(st, entry.url);
    const row: M3uRow = {
      key: m3uKey(c.sourceId, keyTemplate(template), entry.name),
      name: entry.name,
      logo: entry.tvgLogo === undefined ? null : templated(st, entry.tvgLogo),
      template,
      headersJson: entryHeaders(st, entry),
    };
    if (st.book.byteLength > MAX_URLVARS_BYTES) {
      throw new Stop(elvError('source-format', 'urlvars-too-large'));
    }
    if (vod || entry.kindHint === 'movie') {
      movies.push(row);
      st.written.movies += 1;
      place(st, 'movie', row.key, groupsOf(entry), fresh, links);
    } else if (entry.kindHint === 'episode') {
      const group = entry.groups[0] ?? UNGROUPED;
      const folded = foldText(group);
      const seriesKey = `m:${c.sourceId}:series:${folded === '' ? 'ungrouped' : folded}`;
      episodes.push({ ...row, seriesKey });
      st.written.episodes += 1;
      if (!series.has(seriesKey)) series.set(seriesKey, group);
      const groups = groupsOf(entry);
      const freshGroups = groups.filter((g) => !st.placedSeries.has(`${seriesKey}\n${g}`));
      if (freshGroups.length > 0) {
        st.written.series += 1;
        place(st, 'series', seriesKey, freshGroups, fresh, links);
        for (const g of freshGroups) st.placedSeries.add(`${seriesKey}\n${g}`);
      }
    } else {
      live.push({
        ...row,
        num: entry.chno ?? null,
        guideId: entry.tvgId ?? null,
        catchupDays: entry.catchup?.days ?? entry.timeshiftDays ?? null,
      });
      st.written.live += 1;
      place(st, 'live', row.key, groupsOf(entry), fresh, links);
    }
  }
  for (const kind of ['live', 'movie', 'series'] as const) {
    const names = fresh.get(kind) ?? [];
    const first = st.categories[kind].size - names.length;
    await writeCategories(
      c.db,
      c.sourceId,
      kind,
      c.runId,
      names.map((name) => ({ id: name, name })),
      first,
    );
  }
  await writeM3uLive(c.db, c.sourceId, c.runId, live);
  await writeM3uMovies(c.db, c.sourceId, c.runId, movies);
  await writeM3uSeries(
    c.db,
    c.sourceId,
    c.runId,
    [...series].map(([key, name]) => ({ key, name })),
  );
  await writeM3uEpisodes(c.db, c.sourceId, c.runId, episodes);
  for (const kind of ['live', 'movie', 'series'] as const) {
    await writePlacements(c.db, c.sourceId, kind, c.runId, links[kind]);
  }
  for (const phase of ['live', 'movies', 'series', 'episodes'] as const) {
    if (st.written[phase] > 0) c.progress({ phase, done: st.written[phase] });
  }
  await c.deps.scheduler.yieldNow();
}

async function write(c: RunCtx, st: M3uImportState, entries: readonly M3uEntry[]): Promise<void> {
  for (let i = 0; i < entries.length; i += c.batchSize) {
    checkAbort(c);
    await processBatch(c, st, entries.slice(i, i + c.batchSize));
  }
}

async function execute(
  c: RunCtx,
  source: SourceRecord,
  playlistUrl: string,
  oldVars: UrlVars,
): Promise<StagedM3u> {
  const body = await openPlaylist(source, playlistUrl, c.deps, c.signal);
  const scan = scanM3u(body, { batchSize: c.batchSize, baseUrl: playlistUrl });
  const buffered: M3uEntry[] = [];
  let st: M3uImportState | undefined;
  let gate: M3uEntryGate | undefined;
  let total = 0;
  let guideUrls: string[] = [];
  let present = false;
  try {
    for (;;) {
      checkAbort(c);
      const next = await scan.next();
      if (next.done === true) {
        unwrap(next.value);
        break;
      }
      const batch = next.value;
      total += batch.entries.length;
      if (batch.header !== undefined) {
        present = batch.header.present;
        guideUrls = batch.header.guideUrls;
      }
      if (batch.stats !== undefined) c.warnings = batch.stats.warnings.length;
      if (st === undefined || gate === undefined) {
        buffered.push(...batch.entries);
        if (buffered.length < SAMPLE_SIZE && !batch.done) continue;
        if (batch.done && total === 0 && !present) {
          throw new Stop(elvError('source-format', 'not-a-playlist'));
        }
        st = createM3uImportState(source, playlistUrl, buffered.slice(0, SAMPLE_SIZE));
        gate = new M3uEntryGate(st);
        await write(c, st, gate.admit(buffered));
        buffered.length = 0;
      } else {
        await write(c, st, gate.admit(batch.entries));
      }
    }
  } finally {
    await scan.return(ok(undefined));
  }
  if (st === undefined || gate === undefined) throw new Stop(elvError('network', 'stream-failed'));
  await write(c, st, gate.release());
  return finishM3uRun(c, st, oldVars, guideUrls);
}

/**
 * Imports an M3U source: streams entries into catalog tables with credential-free templates and `urlvars` secrets.
 */
export async function importM3u(
  source: SourceRecord,
  deps: ImportDeps,
  opts: ImportOptions,
): Promise<Result<ImportSummary>> {
  const playlistUrl = await deps.secrets
    .get(secretKey(source.id, 'playlist'))
    .catch(() => undefined);
  if (playlistUrl === undefined) return err(elvError('storage', 'secret-missing'));
  const urlvarsKey = secretKey(source.id, 'urlvars');
  const oldVars = await readUrlVars(deps, source.id);
  let staged: StagedM3u | undefined;
  let secretsStaged = false;
  return performRun(source, deps, opts, {
    execute: async (c) => {
      staged = await execute(c, source, playlistUrl, oldVars);
    },
    beforeCommit: async () => {
      if (staged === undefined) return;
      const merged: UrlVars = { ...oldVars, ...staged.vars };
      try {
        await deps.secrets.set(urlvarsKey, JSON.stringify(merged));
        secretsStaged = true;
      } catch {
        throw new Stop(elvError('storage', 'secret-write-failed'));
      }
    },
    beforeCleanup: async (tx, c) => {
      if (staged === undefined) return;
      for (const [key, table] of [
        ['live', 'live'],
        ['movies', 'movies'],
        ['series', 'series'],
        ['episodes', 'episodes'],
      ] as const) {
        const r = await tx.all<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${table} WHERE source_id = ? AND run_id = ?`,
          [c.sourceId, c.runId],
        );
        c.counts[key] = r[0]?.n ?? 0;
      }
      const current = (await getSource(tx, source.id))?.settings ?? source.settings;
      const settings: SourceSettings = { ...current };
      if (staged.rules.length > 0) settings.segmentRules = staged.rules;
      else delete settings.segmentRules;
      if (staged.discovered === undefined) delete settings.discoveredGuideUrls;
      else settings.discoveredGuideUrls = staged.discovered;
      await updateSourceSettings(tx, source.id, settings);
    },
    afterCommit: async () => {
      if (staged === undefined) return;
      const vars = staged.vars;
      if (Object.keys(oldVars).some((k) => !Object.hasOwn(vars, k))) {
        await deps.secrets.set(urlvarsKey, JSON.stringify(vars)).catch(() => undefined);
      }
    },
    onAbortOrFail: async (c, outcome, error) => {
      if (outcome === 'source-removed') {
        if (secretsStaged) await deps.secrets.delete(urlvarsKey).catch(() => undefined);
        return;
      }
      if (secretsStaged) {
        await deps.secrets.set(urlvarsKey, JSON.stringify(oldVars)).catch(() => undefined);
      }
      if (error.code === 'urlvars-too-large' || error.code === 'secret-write-failed') {
        await rollbackUnresolvedM3uRows(deps.db, source.id, c.runId, oldVars);
      }
    },
  });
}
