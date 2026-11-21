import {
  type ElvError,
  elvError,
  err,
  type HttpResponse,
  httpStatusError,
  ok,
  openAsyncIterator,
  type Result,
  transportHeaders,
} from '@elv/domain';
import { scanXmltv, type XmltvChannel, type XmltvProgramme } from '@elv/sources';
import { foldText } from './fold';
import { commitGuide, dropStaging, type GuideResult, STAGE_PROGRAMME_SQL } from './guide-commit';
import { buildChannelIndex, type ChannelIndex, matchGuideChannel } from './guide-match';
import {
  conditionalHeaders,
  extractValidators,
  hasStoredProgrammes,
  merge304Validator,
  replaceGuideValidator,
  sameGuideCache,
  sameValidator,
  sanitizeValidator,
  withGuideValidator,
} from './http-cache';
import { checkAbort, performRun, type RunCtx, Stop, warn } from './import-run';
import type { ImportDeps, ImportOptions, ImportSummary } from './import-types';
import { openClient } from './import-xtream';
import {
  getSource,
  type HttpCacheValidator,
  type SourceRecord,
  updateSourceSettings,
} from './sources';
import { readUrlVars } from './stream-resolver';
import { resolveTemplate } from './templates';

const REQUEST_TIMEOUT_MS = 60_000;
const DAY_MS = 86_400_000;
const DEFAULT_WINDOW = { daysBack: 1, daysForward: 7 };
/** Length given to a programme with no `stop` when no later programme of its channel closes it. */
const OPEN_END_MS = 30 * 60_000;

interface GuideCandidate {
  slot: string;
  url: string;
}

type GuideOpen =
  | {
      kind: 'body';
      slot: string;
      body: AsyncIterable<Uint8Array>;
      validator: HttpCacheValidator | undefined;
      failed: ElvError[];
    }
  | {
      kind: 'not-modified';
      slot: string;
      validator: HttpCacheValidator | undefined;
      failed: ElvError[];
    };

type GuideOutcome =
  | { kind: 'imported'; slot: string; state: GuideState; validator: HttpCacheValidator | undefined }
  | { kind: 'not-modified'; slot: string; validator: HttpCacheValidator | undefined };

async function discard(body: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    await openAsyncIterator(body).return?.();
  } catch {
    // the response is already classified by its status
  }
}

/** Guide candidates to try, in order, resolved in memory only; unresolved placeholders are dropped. */
async function candidateUrls(
  source: SourceRecord,
  deps: ImportDeps,
): Promise<Result<GuideCandidate[]>> {
  const candidates: GuideCandidate[] = [];
  const vars = await readUrlVars(deps, source.id);
  if (source.kind === 'xtream') {
    const own = source.settings.guideUrl;
    if (own !== undefined && own !== '') {
      candidates.push({ slot: 'override', url: resolveTemplate(own, vars) });
    }
    const client = await openClient(source, deps);
    if (!client.ok) return client;
    candidates.push({ slot: 'xtream', url: client.value.guideUrl() });
  } else {
    if (source.settings.guideUrl !== undefined && source.settings.guideUrl !== '') {
      candidates.push({ slot: 'override', url: resolveTemplate(source.settings.guideUrl, vars) });
    }
    for (const [i, t] of (source.settings.discoveredGuideUrls ?? []).entries()) {
      candidates.push({ slot: `discovered:${i}`, url: resolveTemplate(t, vars) });
    }
  }
  return ok(candidates.filter((c) => c.url !== '' && !c.url.includes('{{')));
}

/** Opens the first candidate URL that answers 2xx or conditional 304, plus code-only errors tried before it. */
async function openGuide(
  candidates: readonly GuideCandidate[],
  source: SourceRecord,
  deps: ImportDeps,
  signal: AbortSignal | undefined,
  allowConditional: boolean,
): Promise<GuideOpen> {
  let first: ElvError | undefined;
  const failed: ElvError[] = [];
  const miss = (e: ElvError) => {
    failed.push(elvError(e.category, e.code));
    first ??= failed[0];
  };
  const baseHeaders = transportHeaders(source.settings.transport);
  for (const { slot, url } of candidates) {
    checkAbort({ signal });
    const sent = allowConditional
      ? sanitizeValidator(source.settings.httpCache?.guide?.[slot])
      : undefined;
    let response: Result<HttpResponse>;
    try {
      response = await deps.http.get(url, {
        headers: conditionalHeaders(baseHeaders, sent),
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
    const { status, body, headers } = response.value;
    const validator = extractValidators(headers);
    if (status === 304 && sent !== undefined) {
      await discard(body);
      return { kind: 'not-modified', slot, validator, failed };
    }
    if (status >= 200 && status < 300) return { kind: 'body', slot, body, validator, failed };
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
    const bucket = match.tier === 'id' ? st.byId : match.tier === 'name' ? st.byName : st.byNum;
    for (const key of match.keys) bucket.push([key, ch.id]);
    const name = ch.names[0] ?? ch.id;
    st.channelRows.push([c.sourceId, ch.id, name, foldText(name), ch.icon ?? null, c.runId]);
  }
  st.channels += channels.length;
}

type Row = (string | number | null)[];

/**
 * Turns a batch into rows while guaranteeing `stop > start` for every row. A programme without `stop` ends where
 * the next strictly later programme of its channel starts; malformed rows with `stop <= start` are skipped with
 * warning `programme-bad-time`.
 */
export function closeOpenProgrammes(
  c: Pick<RunCtx, 'sourceId' | 'runId' | 'warnings' | 'warningCodes'>,
  open: Map<string, XmltvProgramme>,
  programmes: readonly XmltvProgramme[],
): Row[] {
  const rows: Row[] = [];
  for (const p of programmes) {
    if (
      !Number.isFinite(p.start) ||
      (p.stop !== undefined && (!Number.isFinite(p.stop) || p.stop <= p.start))
    ) {
      warn(c, 'programme-bad-time');
      continue;
    }
    const prev = open.get(p.channel);
    if (prev !== undefined) {
      if (p.start > prev.start) {
        open.delete(p.channel);
        rows.push(programmeRow(c.sourceId, c.runId, prev, p.start));
      } else if (p.start === prev.start) {
        open.delete(p.channel);
      } else if (p.stop === undefined) {
        rows.push(programmeRow(c.sourceId, c.runId, p, prev.start));
        continue;
      } else {
        rows.push(programmeRow(c.sourceId, c.runId, p, p.stop));
        continue;
      }
    }
    if (p.stop === undefined) open.set(p.channel, p);
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
    checkAbort(c);
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
  candidates: readonly GuideCandidate[],
  now: number,
): Promise<GuideOutcome> {
  const allowConditional = await hasStoredProgrammes(c.db, c.sourceId);
  const opened = await openGuide(candidates, source, c.deps, c.signal, allowConditional);
  for (const f of opened.failed) c.warningCodes.push(`${f.category}/${f.code}`);
  c.warnings += opened.failed.length;
  if (opened.kind === 'not-modified') {
    c.unchanged = true;
    c.keepTables.add('guide_channels');
    c.counts.unchanged = 1;
    if (opened.failed.length > 0) c.counts.guideUrlFallbacks = opened.failed.length;
    return { kind: 'not-modified', slot: opened.slot, validator: opened.validator };
  }
  c.counts.guideUrlFallbacks = opened.failed.length;
  await c.db.run('DELETE FROM programmes_next WHERE source_id = ?', [c.sourceId]);
  const live = await c.db.all<{
    key: string;
    guide_id: string | null;
    name_fold: string;
    num: number | null;
  }>('SELECT key, guide_id, name_fold, num FROM live WHERE source_id = ?', [c.sourceId]);
  const st: GuideState = {
    index: buildChannelIndex(live),
    mapped: new Set(),
    channelRows: [],
    open: new Map(),
    byId: [],
    byName: [],
    byNum: [],
    staged: new Map(),
    channels: 0,
    programmes: 0,
    seenProgrammes: 0,
  };
  const window = source.settings.guideWindow ?? DEFAULT_WINDOW;
  const scan = scanXmltv(opened.body, {
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
      await writeProgrammes(c, st, closeOpenProgrammes(c, st.open, batch.programmes));
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
  return { kind: 'imported', slot: opened.slot, state: st, validator: opened.validator };
}

/**
 * Imports the XMLTV guide of a source: streams it, matches guide channels to live channels in strict precedence
 * (exact guide id, then unambiguous folded display name, then unambiguous channel number fallback), stores the
 * programmes of mapped guide channels inside the time window (default one day back, seven forward, relative to
 * `opts.now`) and replaces the previous guide in one cleanup transaction. The first guide URL that answers 2xx
 * (or conditional 304 when programmes are already stored) wins: the user override, then the Xtream guide or the
 * playlist's discovered URLs. URLs are resolved in memory only; cache validators are keyed by opaque slot names.
 * A document without channels and programmes fails with `source-format/not-a-guide`; failure and cancel keep the
 * previous guide. After a successful swap the write-ahead log is checkpointed and truncated.
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
  const candidates = await candidateUrls(source, deps);
  if (!candidates.ok) return candidates;
  if (candidates.value.length === 0) return err(elvError('source-format', 'no-guide-url'));
  const now = opts.now ?? deps.clock();
  let outcome: GuideOutcome | undefined;
  let runId: number | undefined;
  const result = await performRun(source, deps, opts, {
    kind: 'guide',
    staleTables: ['guide_channels'],
    requireItems: false,
    execute: async (c) => {
      runId = c.runId;
      outcome = await execute(c, source, candidates.value, now);
    },
    beforeCleanup: async (tx, c) => {
      if (outcome === undefined) return;
      if (outcome.kind === 'not-modified') {
        const current = (await getSource(tx, source.id))?.settings ?? source.settings;
        const prev = current.httpCache?.guide?.[outcome.slot];
        const merged = merge304Validator(prev, outcome.validator);
        if (!sameValidator(prev, merged)) {
          await updateSourceSettings(
            tx,
            source.id,
            withGuideValidator(current, outcome.slot, merged),
          );
        }
        return;
      }
      await commitGuide(tx, c, outcome.state);
      if (c.warningCodes.includes('guide/empty')) return;
      const current = (await getSource(tx, source.id))?.settings ?? source.settings;
      const next = replaceGuideValidator(current, outcome.slot, outcome.validator);
      if (!sameGuideCache(current.httpCache?.guide, next.httpCache?.guide)) {
        await updateSourceSettings(tx, source.id, next);
      }
    },
  });
  if (!result.ok && runId !== undefined) await dropStaging(deps.db, source.id, runId);
  return result;
}
