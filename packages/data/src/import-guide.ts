import {
  type ElvError,
  elvError,
  err,
  type HttpResponse,
  httpStatusError,
  ok,
  type Result,
  transportHeaders,
} from '@elv/domain';
import { scanXmltv, type XmltvChannel, type XmltvProgramme } from '@elv/sources';
import { foldText } from './fold';
import { commitGuide, dropStaging, type GuideResult, STAGE_PROGRAMME_SQL } from './guide-commit';
import { buildChannelIndex, type ChannelIndex, matchGuideChannel } from './guide-match';
import { checkAbort, performRun, type RunCtx, Stop } from './import-run';
import type { ImportDeps, ImportOptions, ImportSummary } from './import-types';
import { openClient } from './import-xtream';
import { getSource, type SourceRecord } from './sources';
import { readUrlVars } from './stream-resolver';
import { resolveTemplate } from './templates';

const REQUEST_TIMEOUT_MS = 60_000;
const DAY_MS = 86_400_000;
const DEFAULT_WINDOW = { daysBack: 1, daysForward: 7 };
/** Length given to a programme with no `stop` when no later programme of its channel closes it. */
const OPEN_END_MS = 30 * 60_000;

async function discard(body: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    await body[Symbol.asyncIterator]().return?.();
  } catch {
    // the response is already classified by its status
  }
}

/** Guide URLs to try, in order, resolved in memory only; candidates with unresolved placeholders are dropped. */
async function candidateUrls(source: SourceRecord, deps: ImportDeps): Promise<Result<string[]>> {
  const urls: string[] = [];
  const vars = await readUrlVars(deps, source.id);
  if (source.kind === 'xtream') {
    const own = source.settings.guideUrl;
    if (own !== undefined && own !== '') urls.push(resolveTemplate(own, vars));
    const client = await openClient(source, deps);
    if (!client.ok) return client;
    urls.push(client.value.guideUrl());
  } else {
    const templates = [
      ...(source.settings.guideUrl === undefined ? [] : [source.settings.guideUrl]),
      ...(source.settings.discoveredGuideUrls ?? []),
    ];
    for (const t of templates) urls.push(resolveTemplate(t, vars));
  }
  return ok(urls.filter((u) => u !== '' && !u.includes('{{')));
}

/** The body of the first URL that answers 2xx, plus the errors of the URLs tried before it (codes only). */
async function openGuide(
  urls: readonly string[],
  source: SourceRecord,
  deps: ImportDeps,
  signal: AbortSignal | undefined,
): Promise<{ body: AsyncIterable<Uint8Array>; failed: ElvError[] }> {
  let first: ElvError | undefined;
  const failed: ElvError[] = [];
  const miss = (e: ElvError) => {
    failed.push(elvError(e.category, e.code));
    first ??= failed[0];
  };
  for (const url of urls) {
    checkAbort({ signal });
    let response: Result<HttpResponse>;
    try {
      response = await deps.http.get(url, {
        headers: transportHeaders(source.settings.transport),
        timeoutMs: REQUEST_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      miss(elvError('network', 'request-failed'));
      continue;
    }
    if (!response.ok) {
      miss(response.error);
      continue;
    }
    const { status, body } = response.value;
    if (status >= 200 && status < 300) return { body, failed };
    await discard(body);
    miss(httpStatusError(status));
  }
  throw new Stop(first ?? elvError('source-format', 'no-guide-url'));
}

const programmeRow = (sourceId: string, runId: number, p: XmltvProgramme, stop: number): Row => [
  sourceId,
  p.channel,
  p.start,
  stop,
  p.title,
  p.subTitle ?? null,
  p.desc ?? null,
  p.categories.length === 0 ? null : JSON.stringify(p.categories),
  p.episodeNum ?? null,
  p.icon ?? null,
  runId,
];

interface GuideState extends GuideResult {
  index: ChannelIndex;
  /** Guide ids of matched channels; the scanner consults it per programme, so it grows as channels arrive. */
  mapped: Set<string>;
  /** Programmes without `stop`, waiting for the next programme of their channel. */
  open: Map<string, XmltvProgramme>;
  channels: number;
  programmes: number;
  seenProgrammes: number;
}

function writeChannels(c: RunCtx, st: GuideState, channels: readonly XmltvChannel[]): void {
  for (const ch of channels) {
    const match = matchGuideChannel(st.index, ch);
    if (match.keys.length > 0) st.mapped.add(ch.id);
    else st.mapped.delete(ch.id);
    for (const key of match.keys) (match.byId ? st.byId : st.byName).push([key, ch.id]);
    const name = ch.names[0] ?? ch.id;
    st.channelRows.push([c.sourceId, ch.id, name, foldText(name), ch.icon ?? null, c.runId]);
  }
  st.channels += channels.length;
}

type Row = (string | number | null)[];

/** Turns a batch into rows; a programme without `stop` ends where the next one of its channel starts. */
function closeOpen(c: RunCtx, st: GuideState, programmes: readonly XmltvProgramme[]): Row[] {
  const rows: Row[] = [];
  for (const p of programmes) {
    const prev = st.open.get(p.channel);
    if (prev !== undefined) {
      st.open.delete(p.channel);
      const stop = p.start > prev.start ? p.start : prev.start + OPEN_END_MS;
      rows.push(programmeRow(c.sourceId, c.runId, prev, stop));
    }
    if (p.stop === undefined) st.open.set(p.channel, p);
    else rows.push(programmeRow(c.sourceId, c.runId, p, p.stop));
  }
  return rows;
}

/** At the end of the scan the programmes still open get a fixed length. */
function flushOpen(c: RunCtx, st: GuideState): Row[] {
  const rows = [...st.open.values()].map((p) =>
    programmeRow(c.sourceId, c.runId, p, p.start + OPEN_END_MS),
  );
  st.open.clear();
  return rows;
}

async function writeProgrammes(c: RunCtx, st: GuideState, rows: Row[]): Promise<void> {
  for (let i = 0; i < rows.length; i += c.batchSize) {
    await c.db.batch(STAGE_PROGRAMME_SQL, rows.slice(i, i + c.batchSize));
    await c.deps.scheduler.yieldNow();
  }
  for (const row of rows) {
    const guideId = row[1] as string;
    st.staged.set(guideId, (st.staged.get(guideId) ?? 0) + 1);
  }
  st.programmes += rows.length;
}

async function execute(
  c: RunCtx,
  source: SourceRecord,
  urls: readonly string[],
  now: number,
): Promise<GuideState> {
  await c.db.run('DELETE FROM programmes_next WHERE source_id = ?', [c.sourceId]);
  const live = await c.db.all<{ key: string; guide_id: string | null; name_fold: string }>(
    'SELECT key, guide_id, name_fold FROM live WHERE source_id = ?',
    [c.sourceId],
  );
  const st: GuideState = {
    index: buildChannelIndex(live),
    mapped: new Set(),
    channelRows: [],
    open: new Map(),
    byId: [],
    byName: [],
    staged: new Map(),
    channels: 0,
    programmes: 0,
    seenProgrammes: 0,
  };
  const window = source.settings.guideWindow ?? DEFAULT_WINDOW;
  const { body, failed } = await openGuide(urls, source, c.deps, c.signal);
  for (const f of failed) c.warningCodes.push(`${f.category}/${f.code}`);
  c.warnings += failed.length;
  c.counts.guideUrlFallbacks = failed.length;
  const scan = scanXmltv(body, {
    batchSize: c.batchSize,
    programmeChannels: st.mapped,
    from: now - window.daysBack * DAY_MS,
    to: now + window.daysForward * DAY_MS,
    ...(c.deps.decompressor === undefined ? {} : { decompressor: c.deps.decompressor }),
  });
  try {
    for (;;) {
      checkAbort(c);
      const step = await scan.next();
      if (step.done) {
        if (!step.value.ok) {
          throw new Stop(elvError(step.value.error.category, step.value.error.code));
        }
        break;
      }
      const batch = step.value;
      writeChannels(c, st, batch.channels);
      st.seenProgrammes += batch.programmes.length;
      await writeProgrammes(c, st, closeOpen(c, st, batch.programmes));
      c.progress({ phase: 'guide-channels', done: st.channels });
      c.progress({ phase: 'programmes', done: st.programmes });
      await c.deps.scheduler.yieldNow();
    }
  } finally {
    await scan.return(ok(undefined));
  }
  await writeProgrammes(c, st, flushOpen(c, st));
  if (st.channels === 0 && st.seenProgrammes === 0) {
    throw new Stop(elvError('source-format', 'not-a-guide'));
  }
  c.counts.guideChannels = st.channels;
  c.counts.programmes = st.programmes;
  return st;
}

/**
 * Folds the write-ahead log back into the database and truncates it. A guide swap rewrites every programme of a
 * source, so without this the log would keep the size of the whole guide. Advisory: a busy reader only delays it.
 */
async function checkpoint(deps: ImportDeps): Promise<void> {
  try {
    await deps.db.all('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // the next checkpoint (automatic or after the next swap) catches up
  }
}

/**
 * Imports the XMLTV guide of a source: streams it, matches guide channels to live channels (a guide id always wins; a
 * folded name maps a channel without an id match only when it is unique both ways), stores the programmes of mapped
 * guide channels inside the time window (default one day back, seven
 * forward, relative to `opts.now`) and replaces the previous guide in one cleanup transaction. The first guide URL
 * that answers 2xx wins: the user override, then the Xtream guide or the playlist's discovered URLs. URLs are resolved
 * in memory only. A document without channels and programmes fails with `source-format/not-a-guide`; failure and
 * cancel keep the previous guide. After a successful swap the write-ahead log is checkpointed and truncated.
 */
export async function importGuide(
  sourceId: string,
  deps: ImportDeps,
  opts: ImportOptions & { now?: number } = {},
): Promise<Result<ImportSummary>> {
  const source = await getSource(deps.db, sourceId);
  if (source === undefined) return err(elvError('storage', 'source-not-found'));
  if (source.kind !== 'xtream' && source.kind !== 'm3u') {
    return err(elvError('source-format', 'unsupported-source'));
  }
  const urls = await candidateUrls(source, deps);
  if (!urls.ok) return urls;
  if (urls.value.length === 0) return err(elvError('source-format', 'no-guide-url'));
  const now = opts.now ?? deps.clock();
  let state: GuideState | undefined;
  let runId: number | undefined;
  const result = await performRun(source, deps, opts, {
    kind: 'guide',
    staleTables: ['guide_channels'],
    requireItems: false,
    execute: async (c) => {
      runId = c.runId;
      state = await execute(c, source, urls.value, now);
    },
    beforeCleanup: async (tx, c) => {
      if (state !== undefined) await commitGuide(tx, c, state);
    },
  });
  if (!result.ok && runId !== undefined) await dropStaging(deps.db, source.id, runId);
  if (result.ok) await checkpoint(deps);
  return result;
}
