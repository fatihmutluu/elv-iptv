import {
  type ElvError,
  elvError,
  err,
  type HttpResponse,
  ok,
  type Result,
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

/**
 * The `channels` filter handed to the scanner. A channel it has not decided yet passes, so the scanner reports the
 * channel and the importer can match it; once decided, only mapped guide channels pass and the scanner drops the
 * programmes of the others without building them.
 */
class MappedChannels extends Set<string> {
  private readonly decided = new Set<string>();

  decide(id: string, mapped: boolean): void {
    this.decided.add(id);
    if (mapped) this.add(id);
    else this.delete(id);
  }

  /** True once the guide channel was matched to a live channel. */
  isMapped(id: string): boolean {
    return super.has(id);
  }

  override has(id: string): boolean {
    return this.decided.has(id) ? super.has(id) : true;
  }
}

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
  if (source.kind === 'xtream') {
    const own = source.settings.guideUrl;
    if (own !== undefined && own !== '') urls.push(own);
    const client = await openClient(source, deps);
    if (!client.ok) return client;
    urls.push(client.value.guideUrl());
  } else {
    const vars = await readUrlVars(deps, source.id);
    const templates = [
      ...(source.settings.guideUrl === undefined ? [] : [source.settings.guideUrl]),
      ...(source.settings.discoveredGuideUrls ?? []),
    ];
    for (const t of templates) urls.push(resolveTemplate(t, vars));
  }
  return ok(urls.filter((u) => u !== '' && !u.includes('{{')));
}

async function openGuide(
  urls: readonly string[],
  source: SourceRecord,
  deps: ImportDeps,
  signal: AbortSignal | undefined,
): Promise<AsyncIterable<Uint8Array>> {
  let first: ElvError | undefined;
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
      first ??= elvError('network', 'request-failed');
      continue;
    }
    if (!response.ok) {
      first ??= elvError(response.error.category, response.error.code);
      continue;
    }
    const { status, body } = response.value;
    if (status >= 200 && status < 300) return body;
    await discard(body);
    first ??= classify(status);
  }
  throw new Stop(first ?? elvError('source-format', 'no-guide-url'));
}

const GUIDE_CHANNEL_SQL = `INSERT INTO guide_channels (source_id, guide_id, name, name_fold, icon, run_id)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, guide_id) DO UPDATE SET name = excluded.name, name_fold = excluded.name_fold,
    icon = excluded.icon, run_id = excluded.run_id`;

const PROGRAMME_SQL = `INSERT INTO programmes (source_id, guide_id, start, stop, title, sub_title, description,
    categories_json, episode_num, icon, run_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, guide_id, start) DO UPDATE SET stop = excluded.stop, title = excluded.title,
    sub_title = excluded.sub_title, description = excluded.description, categories_json = excluded.categories_json,
    episode_num = excluded.episode_num, icon = excluded.icon, run_id = excluded.run_id`;

const programmeRow = (sourceId: string, runId: number, p: XmltvProgramme) => [
  sourceId,
  p.channel,
  p.start,
  p.stop ?? p.start,
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
  filter: MappedChannels;
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
  const rows: (string | number | null)[][] = [];
  for (const ch of channels) {
    const keys = matchGuideChannel(st.index, ch);
    st.filter.decide(ch.id, keys.length > 0);
    if (keys.length > 0) st.mappedChannels++;
    for (const key of keys) st.mappings.push([key, ch.id]);
    const name = ch.names[0] ?? ch.id;
    rows.push([c.sourceId, ch.id, name, foldText(name), ch.icon ?? null, c.runId]);
  }
  st.channels += channels.length;
  if (rows.length > 0) await c.db.batch(GUIDE_CHANNEL_SQL, rows);
}

async function execute(
  c: RunCtx,
  source: SourceRecord,
  urls: readonly string[],
  now: number,
): Promise<GuideState> {
  const live = await c.db.all<{ key: string; guide_id: string | null; name_fold: string }>(
    'SELECT key, guide_id, name_fold FROM live WHERE source_id = ?',
    [c.sourceId],
  );
  const st: GuideState = {
    index: buildChannelIndex(live),
    filter: new MappedChannels(),
    mappings: [],
    channels: 0,
    mappedChannels: 0,
    programmes: 0,
    seenProgrammes: 0,
  };
  const window = source.settings.guideWindow ?? DEFAULT_WINDOW;
  const body = await openGuide(urls, source, c.deps, c.signal);
  const scan = scanXmltv(body, {
    batchSize: c.batchSize,
    channels: st.filter,
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
      const mapped = batch.programmes.filter((p) => st.filter.isMapped(p.channel));
      if (mapped.length > 0) {
        await c.db.batch(
          PROGRAMME_SQL,
          mapped.map((p) => programmeRow(c.sourceId, c.runId, p)),
        );
      }
      st.programmes += mapped.length;
      c.progress({ phase: 'guide-channels', done: st.channels });
      c.progress({ phase: 'programmes', done: st.programmes });
      await c.deps.scheduler.yieldNow();
    }
  } finally {
    await scan.return(ok(undefined));
  }
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
  return performRun(source, deps, opts, {
    kind: 'guide',
    staleTables: ['guide_channels', 'programmes'],
    requireItems: false,
    execute: async (c) => {
      state = await execute(c, source, urls.value, now);
    },
    beforeCleanup: async (tx, c) => {
      await tx.run('DELETE FROM channel_guide WHERE source_id = ?', [c.sourceId]);
      if (state === undefined || state.mappings.length === 0) return;
      await tx.batch(
        'INSERT OR IGNORE INTO channel_guide (source_id, channel_key, guide_id) VALUES (?, ?, ?)',
        state.mappings.map(([key, guideId]) => [c.sourceId, key, guideId]),
      );
    },
  });
}
