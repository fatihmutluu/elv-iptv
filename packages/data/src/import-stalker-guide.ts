import { elvError, type Result, type SqlValue } from '@elv/domain';
import type { StalkerEpgEntry } from '@elv/sources';
import { foldText } from './fold';
import { commitGuide, dropStaging, type GuideResult, STAGE_PROGRAMME_SQL } from './guide-commit';
import { createStreamProgressMeter, wrapCleanupProgress } from './import-progress';
import { checkAbort, notify, performRun, type RunCtx, Stop, unwrap } from './import-run';
import type { ImportDeps, ImportOptions, ImportSummary } from './import-types';
import type { SourceRecord } from './sources';
import { openStalkerClient } from './stalker-secret';

const DAY_MS = 86_400_000;
const MAX_CATCHUP_RETENTION_DAYS = 30;
const DEFAULT_EPG_PERIOD_HOURS = 48;
const SHORT_EPG_FALLBACK_SIZE = 10;
const MAX_WRITE_BATCH = 2_500;

interface LiveRow {
  key: string;
  provider_id: string | null;
  name: string;
  catchup_days: number | null;
}

function normalizeChannelEntries(entries: readonly StalkerEpgEntry[]): StalkerEpgEntry[] {
  const valid = entries.filter(
    (e) =>
      Number.isFinite(e.start) &&
      Number.isFinite(e.stop) &&
      e.stop > e.start &&
      e.title.trim() !== '',
  );
  valid.sort((a, b) => a.start - b.start);
  const out: StalkerEpgEntry[] = [];
  for (const item of valid) {
    const prev = out[out.length - 1];
    if (prev !== undefined) {
      if (prev.start === item.start) {
        out[out.length - 1] = item;
        continue;
      }
      if (prev.stop > item.start) {
        out[out.length - 1] = { ...prev, stop: item.start };
      }
    }
    out.push(item);
  }
  return out;
}

/**
 * Imports Stalker/Ministra portal EPG (`epgInfo(48)`, falling back to `shortEpg` per channel when
 * `epgInfo` returns empty) into `programmes_next`, then swaps atomically via {@link commitGuide}.
 */
export async function importStalkerGuide(
  source: SourceRecord,
  deps: ImportDeps,
  opts: ImportOptions & { now?: number } = {},
): Promise<Result<ImportSummary>> {
  const opened = await openStalkerClient(source, deps);
  if (!opened.ok) return opened;
  const { client } = opened.value;

  const now = opts.now ?? deps.clock();
  const meter = createStreamProgressMeter();
  let guideState: GuideResult | undefined;
  let runId: number | undefined;

  const result = await performRun(source, deps, wrapCleanupProgress(opts, meter, notify), {
    kind: 'guide',
    staleTables: ['guide_channels'],
    requireItems: false,
    execute: async (c: RunCtx) => {
      runId = c.runId;
      await c.db.run('DELETE FROM programmes_next WHERE source_id = ?', [c.sourceId]);
      const live = await c.db.all<LiveRow>(
        'SELECT key, provider_id, name, catchup_days FROM live WHERE source_id = ?',
        [c.sourceId],
      );
      if (live.length === 0) {
        throw new Stop(elvError('source-format', 'not-a-guide'));
      }

      const call = c.signal === undefined ? undefined : { signal: c.signal };
      unwrap(await client.handshake(call));

      let epgMap: Record<string, StalkerEpgEntry[]> = {};
      const bulkRes = await client.epgInfo(DEFAULT_EPG_PERIOD_HOURS, call);
      if (bulkRes.ok) {
        epgMap = bulkRes.value;
      } else if (bulkRes.error.code === 'aborted' || bulkRes.error.category === 'auth') {
        throw new Stop(bulkRes.error);
      }

      if (Object.keys(epgMap).length === 0) {
        for (const ch of live) {
          checkAbort(c);
          if (ch.provider_id === null || ch.provider_id === '') continue;
          const shortRes = await client.shortEpg(ch.provider_id, SHORT_EPG_FALLBACK_SIZE, call);
          if (!shortRes.ok) {
            if (shortRes.error.code === 'aborted' || shortRes.error.category === 'auth') {
              throw new Stop(shortRes.error);
            }
            continue;
          }
          if (shortRes.value.length > 0) {
            epgMap[ch.provider_id] = shortRes.value;
          }
          await c.deps.scheduler.yieldNow();
        }
      }

      let rawMaxCatchup = 0;
      for (const ch of live) {
        if (ch.catchup_days !== null && Number.isFinite(ch.catchup_days)) {
          rawMaxCatchup = Math.max(rawMaxCatchup, ch.catchup_days);
        }
      }
      const maxCatchupDays = Math.min(
        MAX_CATCHUP_RETENTION_DAYS,
        Math.max(0, Math.floor(rawMaxCatchup)),
      );

      const channelRows: SqlValue[][] = [];
      const byId: [string, string][] = [];
      const staged = new Map<string, number>();
      const pendingRows: SqlValue[][] = [];
      const writeLimit = Math.min(c.batchSize, MAX_WRITE_BATCH);
      let totalProgrammes = 0;

      const flush = async () => {
        if (pendingRows.length === 0) return;
        for (let i = 0; i < pendingRows.length; i += writeLimit) {
          checkAbort(c);
          await c.db.batch(STAGE_PROGRAMME_SQL, pendingRows.slice(i, i + writeLimit));
          await c.deps.scheduler.yieldNow();
        }
        pendingRows.length = 0;
      };

      for (const ch of live) {
        checkAbort(c);
        const pid = ch.provider_id;
        if (pid === null || pid === '') continue;
        const entries = epgMap[pid];
        if (entries === undefined || entries.length === 0) continue;
        const normalized = normalizeChannelEntries(entries);
        if (normalized.length === 0) continue;

        byId.push([ch.key, pid]);
        channelRows.push([c.sourceId, pid, ch.name, foldText(ch.name), null, c.runId, null]);
        staged.set(pid, normalized.length);
        for (const p of normalized) {
          const title = p.title.trim();
          const desc = p.desc?.trim() || null;
          pendingRows.push([
            c.sourceId,
            pid,
            p.start,
            p.stop,
            title,
            null,
            desc,
            null,
            null,
            null,
            c.runId,
            null,
            0,
            null,
            null,
            foldText(title),
            desc !== null ? foldText(desc) : '',
          ]);
          totalProgrammes += 1;
        }
        if (pendingRows.length >= writeLimit) await flush();
      }
      await flush();

      if (channelRows.length === 0 && totalProgrammes === 0) {
        throw new Stop(elvError('source-format', 'not-a-guide'));
      }

      meter.completeStream();
      c.counts.guideChannels = channelRows.length;
      c.counts.programmes = totalProgrammes;
      guideState = {
        channelRows,
        byId,
        byName: [],
        byNum: [],
        staged,
        ...(maxCatchupDays > 0
          ? { retentionFloorMs: now - maxCatchupDays * DAY_MS, preserveBeforeMs: now }
          : {}),
      };
    },
    beforeCleanup: async (tx, c) => {
      if (guideState !== undefined) {
        await commitGuide(tx, c, guideState);
      }
    },
  });

  if (!result.ok && runId !== undefined) await dropStaging(deps.db, source.id, runId);
  return result;
}
