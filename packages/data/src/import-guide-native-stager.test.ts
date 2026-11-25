import type { SqlDriver, SqlValue } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { foldText } from './fold';
import { STAGE_PROGRAMME_SQL } from './guide-commit';
import { importGuide } from './import-guide';
import {
  GUIDE_URL,
  HOUR,
  NOW,
  ready,
  rows,
  SECOND_URL,
  settings,
  titles,
} from './import-guide-test-helpers';
import type { NativeGuideStageRequest, NativeGuideStager } from './import-types';
import { querySearch } from './search';
import { updateSourceSettings } from './sources';

async function stageRow(
  db: SqlDriver,
  req: NativeGuideStageRequest,
  guideId: string,
  start: number,
  stop: number,
  title: string,
  desc: string | null = null,
): Promise<void> {
  await db.batch(STAGE_PROGRAMME_SQL, [
    [
      req.sourceId,
      guideId,
      start,
      stop,
      title,
      null,
      desc,
      JSON.stringify(['News']),
      null,
      null,
      req.runId,
      'news',
      1,
      null,
      null,
      foldText(title),
      desc === null ? '' : foldText(desc),
    ],
  ]);
}

describe('importGuide native stager (#478)', () => {
  it('stages programmes off-thread via nativeGuideStager without calling JS http.get, saves validator, and indexes FTS5', async () => {
    const e = await ready();
    const httpGet = vi.spyOn(e.deps.http, 'get');
    const requests: NativeGuideStageRequest[] = [];
    const nativeGuideStager: NativeGuideStager = {
      async stage(req) {
        requests.push(req);
        await stageRow(
          e.db,
          req,
          'haber1.tr',
          NOW - HOUR,
          NOW + HOUR,
          'İstanbul Akşam Haberleri',
          'Canlı yayın',
        );
        await stageRow(e.db, req, 'cagri', NOW, NOW + HOUR, 'Named Native Show');
        return {
          kind: 'staged',
          channels: [
            { id: 'haber1.tr', names: ['Haber 1'], icon: 'https://cdn.example/h1.png', lcn: '1' },
            { id: 'cagri', names: ['Çağrı TV'] },
          ],
          stagedCounts: { 'haber1.tr': 1, cagri: 1 },
          seenProgrammes: 2,
          stagedProgrammes: 2,
          warnings: 1,
          warningCodes: ['programme-bad-time'],
          etag: '"native-v1"',
        };
      },
    };

    const r = await importGuide(
      e.sourceId,
      { ...e.deps, nativeGuideStager },
      { now: NOW, retryDelayMs: () => 0 },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));

    expect(httpGet).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: GUIDE_URL,
      sourceId: e.sourceId,
      runId: r.value.runId,
    });
    expect(await titles(e)).toEqual(['İstanbul Akşam Haberleri', 'Named Native Show']);
    expect(r.value.counts).toMatchObject({ guideChannels: 2, mapped: 2, programmes: 2 });
    expect(r.value.warnings).toBe(1);
    expect(r.value.warningCodes).toContain('programme-bad-time');

    const storedSettings = await settings(e);
    expect(storedSettings.httpCache?.guide?.override).toEqual({ etag: '"native-v1"' });

    const search = await querySearch(e.db, 'istanbul', { scope: 'epg', nowMs: NOW });
    expect(search.epg.map((h) => h.channelName).sort()).toEqual(['Haber Bir', 'Haber Bir HD']);
    expect(search.epg.every((h) => h.title === 'İstanbul Akşam Haberleri')).toBe(true);
  });

  it('handles 304 not-modified from nativeGuideStager while preserving programmes and merging validators', async () => {
    const e = await ready();
    let call = 0;
    const seenConditional: { ifNoneMatch?: string; ifModifiedSince?: string }[] = [];
    const nativeGuideStager: NativeGuideStager = {
      async stage(req) {
        call += 1;
        seenConditional.push({
          ...(req.ifNoneMatch === undefined ? {} : { ifNoneMatch: req.ifNoneMatch }),
          ...(req.ifModifiedSince === undefined ? {} : { ifModifiedSince: req.ifModifiedSince }),
        });
        if (call === 1) {
          await stageRow(e.db, req, 'haber1.tr', NOW, NOW + HOUR, 'Kept Show');
          return {
            kind: 'staged',
            channels: [{ id: 'haber1.tr', names: ['Haber 1'] }],
            stagedCounts: { 'haber1.tr': 1 },
            seenProgrammes: 1,
            stagedProgrammes: 1,
            warnings: 0,
            warningCodes: [],
            etag: '"etag-1"',
          };
        }
        return {
          kind: 'not-modified',
          lastModified: 'Wed, 25 Nov 2026 10:00:00 GMT',
        };
      },
    };

    const first = await importGuide(e.sourceId, { ...e.deps, nativeGuideStager }, { now: NOW });
    expect(first.ok).toBe(true);
    const second = await importGuide(
      e.sourceId,
      { ...e.deps, nativeGuideStager },
      { now: NOW + 1000 },
    );
    if (!second.ok) throw new Error(JSON.stringify(second.error));

    expect(second.value.unchanged).toBe(true);
    expect(seenConditional).toEqual([{}, { ifNoneMatch: '"etag-1"' }]);
    expect(await titles(e)).toEqual(['Kept Show']);
    const stored = await settings(e);
    expect(stored.httpCache?.guide?.override).toEqual({
      etag: '"etag-1"',
      lastModified: 'Wed, 25 Nov 2026 10:00:00 GMT',
    });
  });

  it('retries transient native http-errors and falls back to the second candidate URL', async () => {
    const e = await ready();
    await updateSourceSettings(e.db, e.sourceId, {
      ...(await settings(e)),
      guideUrl: SECOND_URL,
      discoveredGuideUrls: [GUIDE_URL],
    });
    const attemptedUrls: string[] = [];
    const nativeGuideStager: NativeGuideStager = {
      async stage(req) {
        attemptedUrls.push(req.url);
        if (req.url === SECOND_URL) {
          // Transient 503 exhausted across 3 attempts (0, 1, 2)
          return { kind: 'http-error', status: 503, retryable: true, code: 'http-503' };
        }
        // Fallback candidate succeeds on attempt 2 after one transient 502
        if (attemptedUrls.filter((u) => u === GUIDE_URL).length === 1) {
          return { kind: 'http-error', status: 502, retryable: true, code: 'http-502' };
        }
        await stageRow(e.db, req, 'haber1.tr', NOW, NOW + HOUR, 'Recovered Show');
        return {
          kind: 'staged',
          channels: [{ id: 'haber1.tr', names: ['Haber 1'] }],
          stagedCounts: { 'haber1.tr': 1 },
          seenProgrammes: 1,
          stagedProgrammes: 1,
          warnings: 0,
          warningCodes: [],
        };
      },
    };

    const r = await importGuide(
      e.sourceId,
      { ...e.deps, nativeGuideStager },
      { now: NOW, retryDelayMs: () => 0 },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(attemptedUrls).toEqual([SECOND_URL, SECOND_URL, SECOND_URL, GUIDE_URL, GUIDE_URL]);
    expect(r.value.counts.guideUrlFallbacks).toBe(1);
    expect(r.value.warningCodes).toContain('network/http-503');
    expect(await titles(e)).toEqual(['Recovered Show']);
  });

  it('cancels in-flight native staging when AbortSignal fires', async () => {
    const e = await ready();
    const controller = new AbortController();
    const cancelledJobs: string[] = [];
    const nativeGuideStager: NativeGuideStager = {
      stage(req) {
        return new Promise((resolve) => {
          controller.signal.addEventListener(
            'abort',
            () => {
              resolve({ kind: 'http-error', status: 0, retryable: false, code: 'aborted' });
            },
            { once: true },
          );
          queueMicrotask(() => controller.abort());
          expect(req.jobId).toContain(e.sourceId);
        });
      },
      cancel(jobId) {
        cancelledJobs.push(jobId);
      },
    };

    const r = await importGuide(
      e.sourceId,
      { ...e.deps, nativeGuideStager },
      { now: NOW, signal: controller.signal },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ category: 'network', code: 'aborted' });
    expect(cancelledJobs).toHaveLength(1);
  });

  it('chunks channel_guide, guide_channels, and programmes_fts with scheduler.yieldNow() for >250 channels', async () => {
    const e = await ready();
    const totalChannels = 520;
    const liveRows: SqlValue[][] = [];
    for (let i = 0; i < totalChannels; i += 1) {
      const id = `bulk-${i}`;
      liveRows.push([
        e.sourceId,
        `live:${id}`,
        `p-${i}`,
        i + 100,
        `Bulk Channel ${i}`,
        `bulk channel ${i}`,
        null,
        id,
        null,
        null,
        null,
        1,
      ]);
    }
    await e.db.batch(
      `INSERT INTO live (source_id, key, provider_id, num, name, name_fold, logo, guide_id, catchup_days, url_template, headers_json, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      liveRows,
    );

    const ftsStatements: string[] = [];
    const maxBatchSeen: number[] = [];
    let yields = 0;
    const wrapTx = (tx: SqlDriver): SqlDriver => ({
      exec: (sql) => tx.exec(sql),
      all: (sql, params) => tx.all(sql, params),
      run: (sql, params) => {
        if (sql.includes('INSERT INTO programmes_fts')) ftsStatements.push(sql);
        return tx.run(sql, params);
      },
      batch: (sql, batchRows) => {
        if (sql.includes('channel_guide') || sql.includes('guide_channels')) {
          maxBatchSeen.push(batchRows.length);
        }
        return tx.batch(sql, batchRows);
      },
      transaction: (fn) => tx.transaction(fn),
    });
    const instrumentedDb: SqlDriver = {
      ...e.db,
      transaction: (fn) => e.db.transaction((tx) => fn(wrapTx(tx))),
    };
    const scheduler = {
      yieldNow: async () => {
        yields += 1;
      },
    };

    const nativeGuideStager: NativeGuideStager = {
      async stage(req) {
        const stagedCounts: Record<string, number> = {};
        const channels: { id: string; names: string[] }[] = [];
        const stageRows: SqlValue[][] = [];
        for (let i = 0; i < totalChannels; i += 1) {
          const id = `bulk-${i}`;
          const title = `Chunked Program ${i}`;
          channels.push({ id, names: [`Bulk Channel ${i}`] });
          stagedCounts[id] = 1;
          stageRows.push([
            req.sourceId,
            id,
            NOW,
            NOW + HOUR,
            title,
            null,
            null,
            null,
            null,
            null,
            req.runId,
            null,
            0,
            null,
            null,
            foldText(title),
            '',
          ]);
        }
        await e.db.batch(STAGE_PROGRAMME_SQL, stageRows);
        return {
          kind: 'staged',
          channels,
          stagedCounts,
          seenProgrammes: totalChannels,
          stagedProgrammes: totalChannels,
          warnings: 0,
          warningCodes: [],
        };
      },
    };

    const r = await importGuide(
      e.sourceId,
      { ...e.deps, db: instrumentedDb, scheduler, nativeGuideStager },
      { now: NOW, batchSize: 5_000 },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));

    // 520 channels -> 3 FTS chunks (250 + 250 + 20)
    expect(ftsStatements).toHaveLength(3);
    // Commit batch sizes capped at <= 500 even though batchSize=5_000
    expect(Math.max(...maxBatchSeen)).toBeLessThanOrEqual(500);
    // Yields happened during mergeChannels, finalizeChannels, commit batches, and FTS chunks
    expect(yields).toBeGreaterThanOrEqual(5);

    const ftsCount = await rows(e, 'SELECT COUNT(*) AS n FROM programmes_fts WHERE source_id = ?', [
      e.sourceId,
    ]);
    expect(ftsCount[0]?.n).toBe(totalChannels);

    const tailHit = await querySearch(e.db, 'chunked program 519', { scope: 'epg', nowMs: NOW });
    expect(tailHit.epg.map((h) => h.title)).toContain('Chunked Program 519');
  });

  it('falls back transparently to JS scanXmltv when nativeGuideStager is absent', async () => {
    const e = await ready();
    const httpGet = vi.spyOn(e.deps.http, 'get');
    const r = await importGuide(e.sourceId, e.deps, { now: NOW });
    expect(r.ok).toBe(true);
    expect(httpGet).toHaveBeenCalledTimes(1);
    expect(await titles(e)).toEqual(['Ended', 'Running', 'Later', 'Named Match', 'Next Week']);
  });
});
