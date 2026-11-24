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
  executeMultiGuide,
  type MultiGuideOutcome,
  resolveEnabledGuideSources,
  serializeGuideValidator,
} from './guide-multi';
import {
  type ClampedBatch,
  closeOpenProgrammes,
  closeOpenProgrammesBatch,
  flushOpenProgrammes,
  type ProgrammeStageRow,
} from './guide-programmes';
import { listEnabledGuideSourcesRaw } from './guide-sources-repo';
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
import { importStalkerGuide } from './import-stalker-guide';
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
const MAX_CATCHUP_RETENTION_DAYS = 30;
/** Upper bound on XMLTV elements parsed per event-loop turn so large `batchSize` runs stay responsive (`#25`). */
const MAX_GUIDE_SCAN_SLICE = 500;
/** Upper bound on staged programme rows written per SQLite WAL transaction (`#25`). */
const MAX_GUIDE_WRITE_BATCH = 2_500;

type GuideOutcome =
  | { kind: 'imported'; slot: string; state: GuideState; validator: HttpCacheValidator | undefined }
  | { kind: 'not-modified'; slot: string; validator: HttpCacheValidator | undefined }
  | MultiGuideOutcome;

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
        ...(ch.lcn !== undefined && ch.lcn !== '' ? { lcn: ch.lcn } : {}),
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
      if (
        (existing.lcn === undefined || existing.lcn === '') &&
        ch.lcn !== undefined &&
        ch.lcn !== ''
      ) {
        existing.lcn = ch.lcn;
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
    st.channelRows.push([
      c.sourceId,
      ch.id,
      name,
      foldText(name),
      ch.icon ?? null,
      c.runId,
      ch.lcn ?? null,
    ]);
  }
  st.channelNameFolds = st.index.nameFoldByKey;
}

async function flushPendingProgrammes(c: RunCtx, pending: ProgrammeStageRow[]): Promise<void> {
  if (pending.length === 0) return;
  const writeLimit = Math.min(c.batchSize, MAX_GUIDE_WRITE_BATCH);
  for (let i = 0; i < pending.length; i += writeLimit) {
    checkAbort(c);
    await c.db.batch(STAGE_PROGRAMME_SQL, pending.slice(i, i + writeLimit));
    await c.deps.scheduler.yieldNow();
  }
  pending.length = 0;
}

function recordStagedProgrammes(
  st: GuideState,
  pending: ProgrammeStageRow[],
  batch: ClampedBatch,
): void {
  const { rows, reupserts } = batch;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] as ProgrammeStageRow;
    pending.push(row);
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
    catchup_days: number | null;
  }>('SELECT key, guide_id, name, name_fold, num, catchup_days FROM live WHERE source_id = ?', [
    c.sourceId,
  ]);
  let rawMaxCatchup = 0;
  for (const ch of live) {
    if (
      ch.catchup_days !== null &&
      Number.isFinite(ch.catchup_days) &&
      ch.catchup_days > rawMaxCatchup
    ) {
      rawMaxCatchup = ch.catchup_days;
    }
  }
  const maxCatchupDays = Math.min(
    MAX_CATCHUP_RETENTION_DAYS,
    Math.max(0, Math.floor(rawMaxCatchup)),
  );
  const window = source.settings.guideWindow ?? DEFAULT_WINDOW;
  const effectiveDaysBack = Math.max(window.daysBack, maxCatchupDays);
  const retentionFloorMs = now - effectiveDaysBack * DAY_MS;
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
  let bytesRead = 0;
  const body =
    opened.contentLength === undefined
      ? opened.body
      : trackBodyBytes(opened.body, (n) => {
          bytesRead = n;
        });
  const scan = scanXmltv(body, {
    batchSize: Math.min(c.batchSize, MAX_GUIDE_SCAN_SLICE),
    from: retentionFloorMs,
    to: now + window.daysForward * DAY_MS,
    ...(c.deps.decompressor === undefined ? {} : { decompressor: c.deps.decompressor }),
    ...(source.settings.xmltvTimezone ? { defaultTimeZone: source.settings.xmltvTimezone } : {}),
  });
  const writeLimit = Math.min(c.batchSize, MAX_GUIDE_WRITE_BATCH);
  const pendingRows: ProgrammeStageRow[] = [];
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
      recordStagedProgrammes(
        st,
        pendingRows,
        closeOpenProgrammesBatch(c, st.open, batch.programmes, st.lastByChannel),
      );
      if (pendingRows.length >= writeLimit) {
        await flushPendingProgrammes(c, pendingRows);
      }
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
  recordStagedProgrammes(st, pendingRows, flushOpenProgrammes(c, st.open, st.lastByChannel));
  await flushPendingProgrammes(c, pendingRows);
  if (maxCatchupDays > 0) {
    st.retentionFloorMs = retentionFloorMs;
    st.preserveBeforeMs = now;
  }
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
  if (source.kind !== 'xtream' && source.kind !== 'm3u' && source.kind !== 'stalker') {
    return err(elvError('source-format', 'unsupported-source'));
  }
  const enabledGuidesRaw = await listEnabledGuideSourcesRaw(deps.db, source.id);
  if (
    source.kind === 'stalker' &&
    enabledGuidesRaw.length === 0 &&
    (source.settings.guideUrl === undefined || source.settings.guideUrl === '')
  ) {
    return importStalkerGuide(source, deps, opts);
  }
  const resolvedGuides =
    enabledGuidesRaw.length > 0
      ? await resolveEnabledGuideSources(source.id, enabledGuidesRaw, deps)
      : [];
  let candidates: GuideCandidate[] = [];
  if (enabledGuidesRaw.length > 0) {
    if (resolvedGuides.length === 0) return err(elvError('source-format', 'no-guide-url'));
  } else {
    const legacy = await candidateGuideUrls(source, deps);
    if (!legacy.ok) return legacy;
    if (legacy.value.length === 0) return err(elvError('source-format', 'no-guide-url'));
    candidates = legacy.value;
  }
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
      outcome =
        resolvedGuides.length > 0
          ? await executeMultiGuide(c, source, resolvedGuides, now, retryDelayMs, meter)
          : await execute(c, source, candidates, now, retryDelayMs, meter);
    },
    beforeCleanup: async (tx, c) => {
      if (outcome === undefined) return;
      if (outcome.kind === 'not-modified-multi') {
        const notMod = outcome;
        const prevRow = enabledGuidesRaw.find((r) => r.id === notMod.guideId);
        let prevValidator: HttpCacheValidator | undefined;
        if (prevRow?.http_cache_json) {
          try {
            prevValidator = JSON.parse(prevRow.http_cache_json) as HttpCacheValidator;
          } catch {
            prevValidator = undefined;
          }
        }
        const merged = merge304Validator(prevValidator, notMod.validator);
        await tx.run(
          'UPDATE guide_sources SET last_sync_at = ?, http_cache_json = ? WHERE source_id = ? AND id = ?',
          [notMod.syncedAt, serializeGuideValidator(merged), source.id, notMod.guideId],
        );
        return;
      }
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
      if (outcome.kind === 'imported-multi') return;
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
