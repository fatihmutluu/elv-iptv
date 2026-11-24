import { type ElvError, elvError, ok, type SqlValue } from '@elv/domain';
import { scanXmltv, type XmltvChannel, type XmltvProgramme } from '@elv/sources';
import { foldText } from './fold';
import { type GuideResult, STAGE_PROGRAMME_SQL } from './guide-commit';
import { openGuide } from './guide-fetch';
import { buildChannelIndex, matchGuideChannel, resolveMappings, stripFeedId } from './guide-match';
import {
  type ClampedBatch,
  closeOpenProgrammesBatch,
  flushOpenProgrammes,
  type ProgrammeStageRow,
} from './guide-programmes';
import type { RawGuideSourceRow } from './guide-sources-repo';
import { hasStoredProgrammes, sanitizeValidator } from './http-cache';
import { type StreamProgressMeter, trackBodyBytes } from './import-progress';
import { checkAbort, type RunCtx, Stop } from './import-run';
import type { HttpCacheValidator, SourceRecord } from './sources';
import { resolveTemplate } from './templates';
import { readUrlVars } from './urlvars-store';

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW = { daysBack: 1, daysForward: 7 };
const MAX_CATCHUP_RETENTION_DAYS = 30;
const MAX_GUIDE_SCAN_SLICE = 500;
const MAX_GUIDE_WRITE_BATCH = 2_500;

/** @internal Resolved enabled `guide_sources` entry ready for priority-ordered ingestion. */
export interface ResolvedGuideSource {
  readonly id: string;
  readonly url: string;
  readonly validator: HttpCacheValidator | undefined;
}

/** @internal Outcome returned by {@link executeMultiGuide}. */
export type MultiGuideOutcome =
  | { kind: 'imported-multi'; state: GuideResult }
  | {
      kind: 'not-modified-multi';
      guideId: string;
      validator: HttpCacheValidator | undefined;
      syncedAt: number;
    };

function parseStoredValidator(raw: string | null): HttpCacheValidator | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  try {
    const parsed = JSON.parse(raw) as HttpCacheValidator | null;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return sanitizeValidator(parsed);
  } catch {
    return undefined;
  }
}

/** @internal Serializes a sanitized validator to JSON or `null` for `guide_sources.http_cache_json`. */
export function serializeGuideValidator(validator: HttpCacheValidator | undefined): string | null {
  const clean = sanitizeValidator(validator);
  return clean === undefined ? null : JSON.stringify(clean);
}

/** @internal Resolves enabled `guide_sources` templates against `source.<id>.urlvars` in priority order. */
export async function resolveEnabledGuideSources(
  sourceId: string,
  rows: readonly RawGuideSourceRow[],
  deps: { secrets: RunCtx['deps']['secrets'] },
): Promise<ResolvedGuideSource[]> {
  if (rows.length === 0) return [];
  const vars = await readUrlVars(deps, sourceId);
  const resolved: ResolvedGuideSource[] = [];
  for (const row of rows) {
    const url = resolveTemplate(row.url_template, vars).trim();
    if (url === '' || url.includes('{{')) continue;
    resolved.push({
      id: row.id,
      url,
      validator: parseStoredValidator(row.http_cache_json),
    });
  }
  return resolved;
}

function mergeChannelMap(
  target: Map<string, XmltvChannel>,
  channels: readonly XmltvChannel[],
): void {
  for (const ch of channels) {
    const existing = target.get(ch.id);
    if (existing === undefined) {
      const names: string[] = [];
      for (const n of ch.names) {
        if (!names.includes(n)) names.push(n);
      }
      target.set(ch.id, {
        id: ch.id,
        names,
        ...(ch.icon !== undefined && ch.icon !== '' ? { icon: ch.icon } : {}),
        ...(ch.lcn !== undefined && ch.lcn !== '' ? { lcn: ch.lcn } : {}),
      });
    } else {
      for (const n of ch.names) {
        if (!existing.names.includes(n)) existing.names.push(n);
      }
      if ((existing.icon === undefined || existing.icon === '') && ch.icon) existing.icon = ch.icon;
      if ((existing.lcn === undefined || existing.lcn === '') && ch.lcn) existing.lcn = ch.lcn;
    }
  }
}

async function flushRows(c: RunCtx, pending: ProgrammeStageRow[]): Promise<void> {
  if (pending.length === 0) return;
  const writeLimit = Math.min(c.batchSize, MAX_GUIDE_WRITE_BATCH);
  for (let i = 0; i < pending.length; i += writeLimit) {
    checkAbort(c);
    await c.db.batch(STAGE_PROGRAMME_SQL, pending.slice(i, i + writeLimit));
    await c.deps.scheduler.yieldNow();
  }
  pending.length = 0;
}

function appendUnclaimedBatch(
  batch: ClampedBatch,
  claimedGuideIds: ReadonlySet<string>,
  pending: ProgrammeStageRow[],
  gsStaged: Map<string, number>,
): number {
  let kept = 0;
  for (let i = 0; i < batch.rows.length; i += 1) {
    const row = batch.rows[i] as ProgrammeStageRow;
    const guideId = row[1] as string;
    if (claimedGuideIds.has(guideId)) continue;
    pending.push(row);
    gsStaged.set(guideId, (gsStaged.get(guideId) ?? 0) + 1);
    kept += 1;
  }
  return Math.max(0, kept - batch.reupserts);
}

interface LiveRow {
  key: string;
  guide_id: string | null;
  name: string;
  name_fold: string;
  num: number | null;
  catchup_days: number | null;
}

function matchGuideChannelsToLive(
  channelsById: ReadonlyMap<string, XmltvChannel>,
  unclaimedLive: readonly LiveRow[],
): [string, string][] {
  if (unclaimedLive.length === 0 || channelsById.size === 0) return [];
  const index = buildChannelIndex(unclaimedLive);
  const byId: [string, string][] = [];
  const byCiId: [string, string][] = [];
  const byBaseId: [string, string][] = [];
  const byName: [string, string][] = [];
  const byNormalizedName: [string, string][] = [];
  const byNum: [string, string][] = [];

  for (const ch of channelsById.values()) {
    const exactKeys = index.byGuideId.get(ch.id);
    const ciKeys = index.byGuideIdFold.get(ch.id.toLowerCase());
    const baseId = stripFeedId(ch.id).toLowerCase();
    const baseKeys = baseId === '' ? undefined : index.byBaseGuideId.get(baseId);
    let matchedId = false;
    if (exactKeys !== undefined) {
      matchedId = true;
      for (const key of exactKeys) byId.push([key, ch.id]);
    }
    if (ciKeys !== undefined) {
      matchedId = true;
      for (const key of ciKeys) byCiId.push([key, ch.id]);
    }
    if (baseKeys !== undefined) {
      matchedId = true;
      for (const key of baseKeys) byBaseId.push([key, ch.id]);
    }
    if (!matchedId) {
      const match = matchGuideChannel(index, ch);
      const bucket =
        match.tier === 'name'
          ? byName
          : match.tier === 'normalized-name'
            ? byNormalizedName
            : byNum;
      for (const key of match.keys) bucket.push([key, ch.id]);
    }
  }

  return resolveMappings(byId, byName, byNum, byNormalizedName, {
    byCiId,
    byBaseId,
    channelNameFolds: index.nameFoldByKey,
  });
}

/**
 * @internal Priority-ordered multi-guide ingestion (`#30`): processes enabled `guide_sources` in
 * ascending `priority` order, honors Tier-0 manual overrides (`channel_guide_overrides WHERE
 * is_manual = 1`), claims matched channels and their `guide_id`s from highest-priority guides
 * first, and lets lower-priority guides fill only remaining unmatched channels without collisions.
 */
export async function executeMultiGuide(
  c: RunCtx,
  source: SourceRecord,
  guides: readonly ResolvedGuideSource[],
  now: number,
  retryDelayMs: (attempt: number) => number,
  meter: StreamProgressMeter,
): Promise<MultiGuideOutcome> {
  const allowConditional = guides.length === 1 && (await hasStoredProgrammes(c.db, c.sourceId));
  await c.db.run('DELETE FROM programmes_next WHERE source_id = ?', [c.sourceId]);

  const [live, manualRows] = await Promise.all([
    c.db.all<LiveRow>(
      'SELECT key, guide_id, name, name_fold, num, catchup_days FROM live WHERE source_id = ?',
      [c.sourceId],
    ),
    c.db.all<{ channel_key: string; guide_source_id: string | null; guide_id: string }>(
      `SELECT channel_key, guide_source_id, guide_id
         FROM channel_guide_overrides
        WHERE source_id = ? AND is_manual = 1 AND guide_id IS NOT NULL AND guide_id != ''`,
      [c.sourceId],
    ),
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

  const mergedMappings = new Map<string, string>();
  const claimedChannels = new Set<string>();
  const claimedGuideIds = new Set<string>();
  const winningGuideSourceByChannel = new Map<string, string>();
  for (const m of manualRows) {
    mergedMappings.set(m.channel_key, m.guide_id);
    claimedChannels.add(m.channel_key);
  }

  const mergedChannelsById = new Map<string, XmltvChannel>();
  const mergedStaged = new Map<string, number>();
  const syncedGuideSources: { id: string; lastSyncAt: number; httpCacheJson: string | null }[] = [];
  let succeededCount = 0;
  let totalSeenProgrammes = 0;
  let totalStagedProgrammes = 0;
  let firstError: ElvError | undefined;
  c.counts.guideUrlFallbacks = 0;

  for (const gs of guides) {
    checkAbort(c);
    let opened: Awaited<ReturnType<typeof openGuide>>;
    try {
      opened = await openGuide(
        [{ slot: gs.id, url: gs.url, validator: gs.validator }],
        source,
        c.deps,
        c.signal,
        allowConditional,
        retryDelayMs,
      );
    } catch (error) {
      if (error instanceof Stop && error.error.code === 'aborted') throw error;
      const errObj = error instanceof Stop ? error.error : elvError('network', 'request-failed');
      firstError ??= errObj;
      c.warningCodes.push(`${errObj.category}/${errObj.code}`);
      c.warnings += 1;
      c.counts.guideUrlFallbacks = (c.counts.guideUrlFallbacks ?? 0) + 1;
      continue;
    }

    if (opened.kind === 'not-modified') {
      c.unchanged = true;
      c.keepTables.add('guide_channels');
      c.counts.unchanged = 1;
      meter.completeStream();
      return {
        kind: 'not-modified-multi',
        guideId: gs.id,
        validator: opened.validator,
        syncedAt: now,
      };
    }

    const gsChannelsById = new Map<string, XmltvChannel>();
    const openProgs = new Map<string, XmltvProgramme>();
    const lastByChannel = new Map<string, ProgrammeStageRow>();
    const gsStaged = new Map<string, number>();
    const pendingRows: ProgrammeStageRow[] = [];
    const writeLimit = Math.min(c.batchSize, MAX_GUIDE_WRITE_BATCH);
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

    let gsSeen = 0;
    let gsProgrammes = 0;
    let parseError: ElvError | undefined;
    try {
      for (;;) {
        checkAbort(c);
        const step = await scan.next();
        if (step.done) {
          if (!step.value.ok) {
            parseError = elvError(step.value.error.category, step.value.error.code);
          }
          break;
        }
        const batch = step.value;
        mergeChannelMap(gsChannelsById, batch.channels);
        gsSeen += batch.programmes.length;
        gsProgrammes += appendUnclaimedBatch(
          closeOpenProgrammesBatch(c, openProgs, batch.programmes, lastByChannel),
          claimedGuideIds,
          pendingRows,
          gsStaged,
        );
        if (pendingRows.length >= writeLimit) {
          await flushRows(c, pendingRows);
        }
        const streamDone =
          opened.contentLength !== undefined
            ? bytesRead
            : mergedChannelsById.size + gsChannelsById.size + totalSeenProgrammes + gsSeen;
        c.progress(
          meter.reportStream(
            'guide-channels',
            mergedChannelsById.size + gsChannelsById.size,
            streamDone,
            guides.length === 1 ? opened.contentLength : undefined,
          ),
        );
        c.progress(
          meter.reportStream(
            'programmes',
            totalStagedProgrammes + gsProgrammes,
            streamDone,
            guides.length === 1 ? opened.contentLength : undefined,
          ),
        );
        await c.deps.scheduler.yieldNow();
      }
    } finally {
      await scan.return(ok(undefined));
    }

    if (parseError !== undefined) {
      firstError ??= parseError;
      c.warningCodes.push(`${parseError.category}/${parseError.code}`);
      c.warnings += 1;
      const dirtyIds = [...gsStaged.keys()];
      for (let i = 0; i < dirtyIds.length; i += c.batchSize) {
        await c.db.batch(
          'DELETE FROM programmes_next WHERE source_id = ? AND run_id = ? AND guide_id = ?',
          dirtyIds.slice(i, i + c.batchSize).map((id) => [c.sourceId, c.runId, id]),
        );
      }
      continue;
    }

    gsProgrammes += appendUnclaimedBatch(
      flushOpenProgrammes(c, openProgs, lastByChannel),
      claimedGuideIds,
      pendingRows,
      gsStaged,
    );
    await flushRows(c, pendingRows);

    succeededCount += 1;
    totalSeenProgrammes += gsSeen;
    totalStagedProgrammes += gsProgrammes;

    const unclaimedLive = live.filter((ch) => !claimedChannels.has(ch.key));
    const newlyMatched = matchGuideChannelsToLive(gsChannelsById, unclaimedLive);
    for (const [channelKey, guideId] of newlyMatched) {
      if (claimedChannels.has(channelKey)) continue;
      mergedMappings.set(channelKey, guideId);
      claimedChannels.add(channelKey);
      claimedGuideIds.add(guideId);
      winningGuideSourceByChannel.set(channelKey, gs.id);
    }

    for (const m of manualRows) {
      if (claimedGuideIds.has(m.guide_id)) continue;
      if (m.guide_source_id !== null && m.guide_source_id !== gs.id) continue;
      if (gsStaged.has(m.guide_id) || gsChannelsById.has(m.guide_id)) {
        claimedGuideIds.add(m.guide_id);
      }
    }

    const unclaimedGuideIds = [...gsStaged.keys()].filter((id) => !claimedGuideIds.has(id));
    for (let i = 0; i < unclaimedGuideIds.length; i += c.batchSize) {
      await c.db.batch(
        'DELETE FROM programmes_next WHERE source_id = ? AND run_id = ? AND guide_id = ?',
        unclaimedGuideIds.slice(i, i + c.batchSize).map((id) => [c.sourceId, c.runId, id]),
      );
    }

    for (const [guideId, count] of gsStaged) {
      if (claimedGuideIds.has(guideId) && !mergedStaged.has(guideId)) {
        mergedStaged.set(guideId, count);
      }
    }
    for (const ch of gsChannelsById.values()) {
      if (!mergedChannelsById.has(ch.id)) {
        mergedChannelsById.set(ch.id, ch);
      }
    }

    syncedGuideSources.push({
      id: gs.id,
      lastSyncAt: now,
      httpCacheJson: serializeGuideValidator(opened.validator),
    });
  }

  if (succeededCount === 0) {
    throw new Stop(firstError ?? elvError('source-format', 'no-guide-url'));
  }
  if (mergedChannelsById.size === 0 && totalSeenProgrammes === 0) {
    throw new Stop(elvError('source-format', 'not-a-guide'));
  }

  const channelRows: SqlValue[][] = [];
  for (const ch of mergedChannelsById.values()) {
    const name = ch.names[0] ?? ch.id;
    channelRows.push([
      c.sourceId,
      ch.id,
      name,
      foldText(name),
      ch.icon ?? null,
      c.runId,
      ch.lcn ?? null,
    ]);
  }

  const state: GuideResult = {
    channelRows,
    byId: [],
    byName: [],
    byNum: [],
    staged: mergedStaged,
    preResolvedMappings: [...mergedMappings],
    winningGuideSourceByChannel,
    syncedGuideSources,
    syncedAt: now,
    ...(maxCatchupDays > 0 ? { retentionFloorMs, preserveBeforeMs: now } : {}),
  };

  meter.completeStream();
  c.counts.guideChannels = mergedChannelsById.size;
  c.counts.programmes = totalStagedProgrammes;
  return { kind: 'imported-multi', state };
}
