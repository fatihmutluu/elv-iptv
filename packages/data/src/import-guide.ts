import { elvError, err, ok, type Result } from '@elv/domain';
import { scanXmltv, type XmltvChannel, type XmltvProgramme } from '@elv/sources';
import { foldText } from './fold';
import { commitGuide, dropStaging, type GuideResult, STAGE_PROGRAMME_SQL } from './guide-commit';
import {
  candidateGuideUrls,
  defaultGuideRetryDelayMs,
  type GuideCandidate,
  openGuide,
} from './guide-fetch';
import {
  buildChannelIndex,
  type ChannelIndex,
  matchGuideChannel,
  stripFeedId,
} from './guide-match';
import {
  type ClampedBatch,
  closeOpenProgrammes,
  closeOpenProgrammesBatch,
  flushOpenProgrammes,
  type ProgrammeStageRow,
} from './guide-programmes';
import {
  hasStoredProgrammes,
  merge304Validator,
  replaceGuideValidator,
  sameGuideCache,
  sameValidator,
  withGuideValidator,
} from './http-cache';
import {
  createStreamProgressMeter,
  type StreamProgressMeter,
  trackBodyBytes,
  wrapCleanupProgress,
} from './import-progress';
import { checkAbort, notify, performRun, type RunCtx, Stop } from './import-run';
import type { ImportDeps, ImportOptions, ImportSummary } from './import-types';
import {
  getSource,
  type HttpCacheValidator,
  type SourceRecord,
  updateSourceSettings,
} from './sources';

export { closeOpenProgrammes };

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW = { daysBack: 1, daysForward: 7 };

type GuideOutcome =
  | { kind: 'imported'; slot: string; state: GuideState; validator: HttpCacheValidator | undefined }
  | { kind: 'not-modified'; slot: string; validator: HttpCacheValidator | undefined };

interface GuideState extends GuideResult {
  index: ChannelIndex;
  /** Merged XMLTV channel declarations keyed by `channel.id` so duplicate blocks accumulate cleanly. */
  channelsById: Map<string, XmltvChannel>;
  /** Programmes without `stop`, waiting for the next programme of their channel. */
  open: Map<string, XmltvProgramme>;
  /** Latest emitted row per channel across batches for overlap/duplicate clamping. */
  lastByChannel: Map<string, ProgrammeStageRow>;
  byCiId: [string, string][];
  byBaseId: [string, string][];
  byNormalizedName: [string, string][];
  channels: number;
  programmes: number;
  seenProgrammes: number;
}

function mergeChannels(st: GuideState, channels: readonly XmltvChannel[]): void {
  for (const ch of channels) {
    const existing = st.channelsById.get(ch.id);
    if (existing === undefined) {
      const names: string[] = [];
      for (const n of ch.names) {
        if (!names.includes(n)) names.push(n);
      }
      st.channelsById.set(ch.id, {
        id: ch.id,
        names,
        ...(ch.icon !== undefined && ch.icon !== '' ? { icon: ch.icon } : {}),
      });
    } else {
      for (const n of ch.names) {
        if (!existing.names.includes(n)) existing.names.push(n);
      }
      if (
        (existing.icon === undefined || existing.icon === '') &&
        ch.icon !== undefined &&
        ch.icon !== ''
      ) {
        existing.icon = ch.icon;
      }
    }
  }
  st.channels = st.channelsById.size;
}

function finalizeChannels(c: RunCtx, st: GuideState): void {
  for (const ch of st.channelsById.values()) {
    const exactKeys = st.index.byGuideId.get(ch.id);
    const ciKeys = st.index.byGuideIdFold.get(ch.id.toLowerCase());
    const baseId = stripFeedId(ch.id).toLowerCase();
    const baseKeys = baseId === '' ? undefined : st.index.byBaseGuideId.get(baseId);
    let matchedId = false;
    if (exactKeys !== undefined) {
      matchedId = true;
      for (const key of exactKeys) st.byId.push([key, ch.id]);
    }
    if (ciKeys !== undefined) {
      matchedId = true;
      for (const key of ciKeys) st.byCiId.push([key, ch.id]);
    }
    if (baseKeys !== undefined) {
      matchedId = true;
      for (const key of baseKeys) st.byBaseId.push([key, ch.id]);
    }
    if (!matchedId) {
      const match = matchGuideChannel(st.index, ch);
      const bucket =
        match.tier === 'name'
          ? st.byName
          : match.tier === 'normalized-name'
            ? st.byNormalizedName
            : st.byNum;
      for (const key of match.keys) bucket.push([key, ch.id]);
    }
    const name = ch.names[0] ?? ch.id;
    st.channelRows.push([c.sourceId, ch.id, name, foldText(name), ch.icon ?? null, c.runId]);
  }
  st.channelNameFolds = st.index.nameFoldByKey;
}

async function writeProgrammes(c: RunCtx, st: GuideState, batch: ClampedBatch): Promise<void> {
  const { rows, reupserts } = batch;
  for (let i = 0; i < rows.length; i += c.batchSize) {
    checkAbort(c);
    await c.db.batch(STAGE_PROGRAMME_SQL, rows.slice(i, i + c.batchSize));
    await c.deps.scheduler.yieldNow();
  }
  for (const row of rows) {
    const guideId = row[1] as string;
    st.staged.set(guideId, (st.staged.get(guideId) ?? 0) + 1);
  }
  st.programmes += Math.max(0, rows.length - reupserts);
}

async function execute(
  c: RunCtx,
  source: SourceRecord,
  candidates: readonly GuideCandidate[],
  now: number,
  retryDelayMs: (attempt: number) => number,
  meter: StreamProgressMeter,
): Promise<GuideOutcome> {
  const allowConditional = await hasStoredProgrammes(c.db, c.sourceId);
  const opened = await openGuide(
    candidates,
    source,
    c.deps,
    c.signal,
    allowConditional,
    retryDelayMs,
  );
  for (const f of opened.failed) c.warningCodes.push(`${f.category}/${f.code}`);
  c.warnings += opened.failed.length;
  if (opened.kind === 'not-modified') {
    c.unchanged = true;
    c.keepTables.add('guide_channels');
    c.counts.unchanged = 1;
    if (opened.failed.length > 0) c.counts.guideUrlFallbacks = opened.failed.length;
    meter.completeStream();
    return { kind: 'not-modified', slot: opened.slot, validator: opened.validator };
  }
  c.counts.guideUrlFallbacks = opened.failed.length;
  await c.db.run('DELETE FROM programmes_next WHERE source_id = ?', [c.sourceId]);
  const live = await c.db.all<{
    key: string;
    guide_id: string | null;
    name: string;
    name_fold: string;
    num: number | null;
  }>('SELECT key, guide_id, name, name_fold, num FROM live WHERE source_id = ?', [c.sourceId]);
  const st: GuideState = {
    index: buildChannelIndex(live),
    channelsById: new Map(),
    channelRows: [],
    open: new Map(),
    lastByChannel: new Map(),
    byId: [],
    byCiId: [],
    byBaseId: [],
    byName: [],
    byNormalizedName: [],
    byNum: [],
    staged: new Map(),
    channels: 0,
    programmes: 0,
    seenProgrammes: 0,
  };
  const window = source.settings.guideWindow ?? DEFAULT_WINDOW;
  let bytesRead = 0;
  const body =
    opened.contentLength === undefined
      ? opened.body
      : trackBodyBytes(opened.body, (n) => {
          bytesRead = n;
        });
  const scan = scanXmltv(body, {
    batchSize: c.batchSize,
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
      mergeChannels(st, batch.channels);
      st.seenProgrammes += batch.programmes.length;
      await writeProgrammes(
        c,
        st,
        closeOpenProgrammesBatch(c, st.open, batch.programmes, st.lastByChannel),
      );
      const streamDone =
        opened.contentLength !== undefined ? bytesRead : st.channels + st.seenProgrammes;
      c.progress(
        meter.reportStream('guide-channels', st.channels, streamDone, opened.contentLength),
      );
      c.progress(meter.reportStream('programmes', st.programmes, streamDone, opened.contentLength));
      await c.deps.scheduler.yieldNow();
    }
  } finally {
    await scan.return(ok(undefined));
  }
  await writeProgrammes(c, st, flushOpenProgrammes(c, st.open, st.lastByChannel));
  finalizeChannels(c, st);
  if (st.channels === 0 && st.seenProgrammes === 0) {
    throw new Stop(elvError('source-format', 'not-a-guide'));
  }
  meter.completeStream();
  c.counts.guideChannels = st.channels;
  c.counts.programmes = st.programmes;
  return { kind: 'imported', slot: opened.slot, state: st, validator: opened.validator };
}

/**
 * Imports the XMLTV guide of a source: streams it (with up to 2 jittered transient retries per candidate URL),
 * merges duplicate `<channel id>` blocks, matches guide channels to live channels in strict 6-tier precedence,
 * normalizes out-of-order/overlapping programmes into strictly half-open `[start, stop)` intervals, and
 * atomically replaces the previous guide in one cleanup transaction.
 */
export async function importGuide(
  sourceId: string,
  deps: ImportDeps,
  opts: ImportOptions & { now?: number; retryDelayMs?: (attempt: number) => number } = {},
): Promise<Result<ImportSummary>> {
  const source = await getSource(deps.db, sourceId);
  if (source === undefined) return err(elvError('storage', 'source-not-found'));
  if (source.kind !== 'xtream' && source.kind !== 'm3u') {
    return err(elvError('source-format', 'unsupported-source'));
  }
  const candidates = await candidateGuideUrls(source, deps);
  if (!candidates.ok) return candidates;
  if (candidates.value.length === 0) return err(elvError('source-format', 'no-guide-url'));
  const now = opts.now ?? deps.clock();
  const retryDelayMs = opts.retryDelayMs ?? defaultGuideRetryDelayMs;
  const meter = createStreamProgressMeter();
  let outcome: GuideOutcome | undefined;
  let runId: number | undefined;
  const result = await performRun(source, deps, wrapCleanupProgress(opts, meter, notify), {
    kind: 'guide',
    staleTables: ['guide_channels'],
    requireItems: false,
    execute: async (c) => {
      runId = c.runId;
      outcome = await execute(c, source, candidates.value, now, retryDelayMs, meter);
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
