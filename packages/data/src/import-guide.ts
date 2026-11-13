import {
  type ElvError,
  elvError,
  err,
  type HttpResponse,
  ok,
  type Result,
  type SqlDriver,
  transportHeaders,
} from '@elv/domain';
import { scanXmltv, type XmltvChannel, type XmltvProgramme } from '@elv/sources';
import { foldText } from './fold';
import { buildChannelIndex, type ChannelIndex, matchGuideChannel } from './guide-match';
import { readUrlVars } from './import-m3u';
import { checkAbort, performRun, type RunCtx, Stop } from './import-run';
import type { ImportDeps, ImportOptions, ImportSummary } from './import-types';
import { openClient } from './import-xtream';
import { getSource, type SourceRecord } from './sources';
import { resolveTemplate } from './templates';

const REQUEST_TIMEOUT_MS = 60_000;
const DAY_MS = 86_400_000;
const DEFAULT_WINDOW = { daysBack: 1, daysForward: 7 };
/** Length given to a programme with no `stop` when no later programme of its channel closes it. */
const OPEN_END_MS = 30 * 60_000;

function classify(status: number): ElvError {
  if (status === 401 || status === 403) return elvError('auth', 'unauthorized');
  if (status >= 500) return elvError('network', 'server-error');
  return elvError('network', 'http-status');
}

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
    miss(classify(status));
  }
  throw new Stop(first ?? elvError('source-format', 'no-guide-url'));
}

const GUIDE_CHANNEL_SQL = `INSERT INTO guide_channels (source_id, guide_id, name, name_fold, icon, run_id)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, guide_id) DO UPDATE SET name = excluded.name, name_fold = excluded.name_fold,
    icon = excluded.icon, run_id = excluded.run_id`;

const PROGRAMME_SQL = `INSERT INTO programmes_next (source_id, guide_id, start, stop, title, sub_title, description,
    categories_json, episode_num, icon, run_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, guide_id, start) DO UPDATE SET stop = excluded.stop, title = excluded.title,
    sub_title = excluded.sub_title, description = excluded.description, categories_json = excluded.categories_json,
    episode_num = excluded.episode_num, icon = excluded.icon, run_id = excluded.run_id`;

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

interface GuideState {
  index: ChannelIndex;
  /** Guide ids of mapped channels; the scanner consults it per programme, so it grows as channels arrive. */
  mapped: Set<string>;
  /** Guide channel rows, written with the cleanup transaction. */
  channelRows: Row[];
  /** Programmes without `stop`, waiting for the next programme of their channel. */
  open: Map<string, XmltvProgramme>;
  /** `[channelKey, guideId]` pairs, written with the cleanup transaction. */
  mappings: [string, string][];
  channels: number;
  mappedChannels: number;
  programmes: number;
  seenProgrammes: number;
}

async function writeChannels(
  c: RunCtx,
  st: GuideState,
  channels: readonly XmltvChannel[],
): Promise<void> {
  const rows: Row[] = [];
  for (const ch of channels) {
    const keys = matchGuideChannel(st.index, ch);
    if (keys.length > 0) st.mapped.add(ch.id);
    else st.mapped.delete(ch.id);
    if (keys.length > 0) st.mappedChannels++;
    for (const key of keys) st.mappings.push([key, ch.id]);
    const name = ch.names[0] ?? ch.id;
    rows.push([c.sourceId, ch.id, name, foldText(name), ch.icon ?? null, c.runId]);
  }
  st.channels += channels.length;
  st.channelRows.push(...rows);
}

const SWAP_PROGRAMMES = `INSERT INTO programmes SELECT * FROM programmes_next WHERE source_id = ? AND run_id = ?`;

/** Clears the staged programmes of a source; a failure here must not hide the error that ended the run. */
async function dropStaging(db: SqlDriver, sourceId: string): Promise<void> {
  try {
    await db.run('DELETE FROM programmes_next WHERE source_id = ?', [sourceId]);
  } catch {
    // the next guide run clears leftovers before it starts
  }
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
    await c.db.batch(PROGRAMME_SQL, rows.slice(i, i + c.batchSize));
    await c.deps.scheduler.yieldNow();
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
    mappings: [],
    channels: 0,
    mappedChannels: 0,
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
      await writeChannels(c, st, batch.channels);
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
  c.counts.mapped = st.mappedChannels;
  c.counts.programmes = st.programmes;
  return st;
}

/**
 * Imports the XMLTV guide of a source: streams it, matches guide channels to live channels (guide id first, then a
 * unique folded name), stores the programmes of mapped channels inside the time window (default one day back, seven
 * forward, relative to `opts.now`) and replaces the previous guide in one cleanup transaction. The first guide URL
 * that answers 2xx wins: the user override, then the Xtream guide or the playlist's discovered URLs. URLs are resolved
 * in memory only. A document without channels and programmes fails with `source-format/not-a-guide`; failure and
 * cancel keep the previous guide.
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
  const result = await performRun(source, deps, opts, {
    kind: 'guide',
    staleTables: ['guide_channels'],
    requireItems: false,
    execute: async (c) => {
      state = await execute(c, source, urls.value, now);
    },
    beforeCleanup: async (tx, c) => {
      await tx.run('DELETE FROM programmes WHERE source_id = ?', [c.sourceId]);
      await tx.run(SWAP_PROGRAMMES, [c.sourceId, c.runId]);
      await tx.run('DELETE FROM programmes_next WHERE source_id = ?', [c.sourceId]);
      if (state !== undefined) {
        for (let i = 0; i < state.channelRows.length; i += c.batchSize) {
          await tx.batch(GUIDE_CHANNEL_SQL, state.channelRows.slice(i, i + c.batchSize));
        }
      }
      await tx.run('DELETE FROM channel_guide WHERE source_id = ?', [c.sourceId]);
      if (state === undefined || state.mappings.length === 0) return;
      await tx.batch(
        'INSERT OR IGNORE INTO channel_guide (source_id, channel_key, guide_id) VALUES (?, ?, ?)',
        state.mappings.map(([key, guideId]) => [c.sourceId, key, guideId]),
      );
    },
  });
  const busy =
    !result.ok && result.error.category === 'storage' && result.error.code === 'import-in-progress';
  if (!result.ok && !busy) await dropStaging(deps.db, source.id);
  return result;
}
