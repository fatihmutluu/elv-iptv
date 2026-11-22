import {
  type ContentKind,
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
import { fingerprintM3uCredentials } from './credential-fingerprint';
import { foldText } from './fold';
import {
  clearDiscoveredGuideValidators,
  conditionalHeaders,
  discoveredGuidesChanged,
  extractValidators,
  hasStoredCatalog,
  merge304Validator,
  sameValidator,
  sanitizeValidator,
  withPlaylistValidator,
} from './http-cache';
import { checkAbort, performRun, type RunCtx, Stop, unwrap } from './import-run';
import type { ImportDeps, ImportOptions, ImportSummary } from './import-types';
import {
  createM3uImportState,
  finishM3uRun,
  type M3uBrowseKind,
  M3uEntryGate,
  type M3uImportState,
  placeM3uEntry,
  type StagedM3u,
  stableM3uKey,
} from './m3u-gate';
import { entryHeaders, templated } from './m3u-headers';
import { MAX_URLVARS_BYTES, SAMPLE_SIZE } from './m3u-templating';
import { isPlaceholderLiveChannel } from './placeholder-filter';
import {
  getSource,
  type HttpCacheValidator,
  type SourceRecord,
  type SourceSettings,
  secretKey,
  updateSourceSettings,
} from './sources';
import { keyTemplate, type UrlVars } from './templates';
import { deleteUrlVars, partitionUrlVars, readUrlVars, writeUrlVars } from './urlvars-store';
import { writeCategories, writePlacements } from './writers';
import {
  type M3uLiveRow,
  type M3uRow,
  writeM3uEpisodes,
  writeM3uLive,
  writeM3uMovies,
  writeM3uSeries,
} from './writers-m3u';

const REQUEST_TIMEOUT_MS = 180_000;
const UNGROUPED = 'Ungrouped';

type PlaylistOpen =
  | {
      kind: 'body';
      body: AsyncIterable<Uint8Array>;
      validator: HttpCacheValidator | undefined;
      finalUrl: string;
    }
  | { kind: 'not-modified'; validator: HttpCacheValidator | undefined };

type M3uOutcome =
  | {
      kind: 'imported';
      staged: StagedM3u;
      validator: HttpCacheValidator | undefined;
      credentialFingerprint: string | undefined;
    }
  | { kind: 'not-modified'; validator: HttpCacheValidator | undefined };

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
  allowConditional: boolean,
): Promise<PlaylistOpen> {
  const sent = allowConditional
    ? sanitizeValidator(source.settings.httpCache?.playlist)
    : undefined;
  let response: Awaited<ReturnType<ImportDeps['http']['get']>>;
  try {
    response = await deps.http.get(url, {
      headers: conditionalHeaders(transportHeaders(source.settings.transport), sent),
      timeoutMs: REQUEST_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new Stop(elvError('network', signal?.aborted ? 'aborted' : 'request-failed'));
  }
  const { status, body, headers, finalUrl } = unwrap(response);
  const validator = extractValidators(headers);
  if (status === 304 && sent !== undefined) {
    await discard(body);
    return { kind: 'not-modified', validator };
  }
  if (status >= 200 && status < 300) {
    return { kind: 'body', body, validator, finalUrl: finalUrl ?? url };
  }
  await discard(body);
  throw new Stop(httpStatusError(status));
}

const groupsOf = (entry: M3uEntry): readonly string[] =>
  entry.groups.length === 0 ? [UNGROUPED] : entry.groups;

async function processBatch(
  c: RunCtx,
  st: M3uImportState,
  entries: readonly M3uEntry[],
): Promise<void> {
  const vod = st.settings.vodPlaylist === true;
  const filterPlaceholders = st.settings.includePlaceholderChannels !== true;
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
    const kind: ContentKind =
      vod || entry.kindHint === 'movie'
        ? 'movie'
        : entry.kindHint === 'episode'
          ? 'episode'
          : 'live';
    if (kind === 'live' && filterPlaceholders && isPlaceholderLiveChannel({ name: entry.name })) {
      c.counts.skippedPlaceholders = (c.counts.skippedPlaceholders ?? 0) + 1;
      continue;
    }
    const template = templated(st, entry.url);
    const legacyKey = m3uKey(c.sourceId, keyTemplate(template), entry.name);
    const backupUrlsJson =
      entry.backupUrls !== undefined && entry.backupUrls.length > 0
        ? JSON.stringify(entry.backupUrls.map((b) => templated(st, b)))
        : null;
    const row: M3uRow = {
      key: stableM3uKey(st, c.sourceId, kind, entry, legacyKey),
      legacyKey,
      name: entry.name,
      logo: entry.tvgLogo === undefined ? null : templated(st, entry.tvgLogo),
      template,
      headersJson: entryHeaders(st, entry),
      backupUrlsJson,
    };
    if (st.book.byteLength > MAX_URLVARS_BYTES) {
      throw new Stop(elvError('source-format', 'urlvars-too-large'));
    }
    if (kind === 'movie') {
      movies.push(row);
      st.written.movies += 1;
      placeM3uEntry(st, 'movie', row.key, groupsOf(entry), fresh, links);
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
        placeM3uEntry(st, 'series', seriesKey, freshGroups, fresh, links);
        for (const g of freshGroups) st.placedSeries.add(`${seriesKey}\n${g}`);
      }
    } else {
      live.push({
        ...row,
        num: entry.chno ?? null,
        guideId: entry.tvgId ?? null,
        catchupDays: entry.catchup?.days ?? entry.timeshiftDays ?? null,
        epgShiftMs:
          entry.shiftHours !== undefined && Number.isFinite(entry.shiftHours)
            ? Math.round(entry.shiftHours * 3_600_000)
            : null,
      });
      st.written.live += 1;
      placeM3uEntry(st, 'live', row.key, groupsOf(entry), fresh, links);
    }
  }
  for (const kind of ['live', 'movie', 'series'] as const) {
    const names = fresh.get(kind) ?? [];
    await writeCategories(
      c.db,
      c.sourceId,
      kind,
      c.runId,
      names.map((name) => ({ id: name, name })),
      st.categories[kind].size - names.length,
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
): Promise<M3uOutcome> {
  const allowConditional = await hasStoredCatalog(c.db, c.sourceId);
  const opened = await openPlaylist(source, playlistUrl, c.deps, c.signal, allowConditional);
  if (opened.kind === 'not-modified') {
    c.unchanged = true;
    c.counts.unchanged = 1;
    return { kind: 'not-modified', validator: opened.validator };
  }
  const scan = scanM3u(opened.body, {
    batchSize: c.batchSize,
    baseUrl: opened.finalUrl,
    ...(c.deps.decompressor === undefined ? {} : { decompressor: c.deps.decompressor }),
  });
  const buffered: M3uEntry[] = [];
  let st: M3uImportState | undefined;
  let gate: M3uEntryGate | undefined;
  let total = 0;
  let guideUrls: string[] = [];
  let present = false;
  let credentialFingerprint: string | undefined;
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
        const sample = buffered.slice(0, SAMPLE_SIZE);
        credentialFingerprint = fingerprintM3uCredentials(
          playlistUrl,
          sample.map((entry) => entry.url),
        );
        st = createM3uImportState(source, playlistUrl, sample);
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
  const staged = finishM3uRun(c, st, oldVars, guideUrls);
  return { kind: 'imported', staged, validator: opened.validator, credentialFingerprint };
}

/**
 * Imports an M3U source: streams entries into `*_next` staging tables with credential-free templates,
 * URL-free stable keys, and `urlvars` secrets, then atomically commits via {@link performRun} (or keeps
 * the stored catalog untouched on conditional HTTP 304 Not Modified).
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
  const oldVars = await readUrlVars(deps, source.id);
  let outcome: M3uOutcome | undefined;
  let secretsStaged = false;
  let stagedMerged = false;
  return performRun(source, deps, opts, {
    execute: async (c) => {
      outcome = await execute(c, source, playlistUrl, oldVars);
    },
    beforeCommit: async () => {
      if (outcome?.kind !== 'imported') return;
      const merged: UrlVars = { ...oldVars, ...outcome.staged.vars };
      const toStage = partitionUrlVars(merged) !== undefined ? merged : outcome.staged.vars;
      stagedMerged = toStage === merged;
      secretsStaged = true;
      const written = await writeUrlVars(deps.secrets, source.id, toStage);
      if (!written.ok) throw new Stop(written.error);
    },
    beforeCleanup: async (tx, c) => {
      if (outcome === undefined) return;
      const current = (await getSource(tx, source.id))?.settings ?? source.settings;
      if (outcome.kind === 'not-modified') {
        const prev = current.httpCache?.playlist;
        const merged = merge304Validator(prev, outcome.validator);
        if (!sameValidator(prev, merged)) {
          await updateSourceSettings(tx, source.id, withPlaylistValidator(current, merged));
        }
        return;
      }
      const { staged } = outcome;
      for (const table of ['live', 'movies', 'series', 'episodes'] as const) {
        const r = await tx.all<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${table}_next WHERE source_id = ? AND run_id = ?`,
          [c.sourceId, c.runId],
        );
        c.counts[table] = r[0]?.n ?? 0;
      }
      let settings: SourceSettings = { ...current };
      if (staged.rules.length > 0) settings.segmentRules = staged.rules;
      else delete settings.segmentRules;
      if (staged.discovered === undefined) delete settings.discoveredGuideUrls;
      else settings.discoveredGuideUrls = staged.discovered;
      if (outcome.credentialFingerprint !== undefined)
        settings.credentialFingerprint = outcome.credentialFingerprint;
      else delete settings.credentialFingerprint;
      if (
        discoveredGuidesChanged(
          current.discoveredGuideUrls,
          staged.discovered,
          oldVars,
          staged.vars,
        )
      ) {
        settings = clearDiscoveredGuideValidators(settings);
      }
      await updateSourceSettings(tx, source.id, withPlaylistValidator(settings, outcome.validator));
    },
    afterCommit: async () => {
      if (outcome?.kind !== 'imported') return;
      const vars = outcome.staged.vars;
      if (stagedMerged && Object.keys(oldVars).some((k) => !Object.hasOwn(vars, k))) {
        await writeUrlVars(deps.secrets, source.id, vars).catch(() => undefined);
      }
    },
    onAbortOrFail: async (_c, outcomeKind) => {
      if (!secretsStaged) return;
      if (outcomeKind === 'source-removed') {
        await deleteUrlVars(deps.secrets, source.id).catch(() => undefined);
      } else {
        await writeUrlVars(deps.secrets, source.id, oldVars).catch(() => undefined);
      }
    },
  });
}
