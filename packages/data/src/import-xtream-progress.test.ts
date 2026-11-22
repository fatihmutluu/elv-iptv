import {
  elvError,
  err,
  type HttpClient,
  type HttpResponse,
  httpStatusError,
  ok,
  type Result,
} from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createMonotonicProgressMeter } from './import-progress';
import { count, emptyPanel, sampleCatalog, setup } from './import-test-helpers';
import type { ImportProgress } from './import-types';
import { importCatalog } from './import-xtream';

const enc = (s: string) => new TextEncoder().encode(s);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createMonotonicProgressMeter (#197)', () => {
  it('computes weighted stage fractions with asymptotic streaming progress and monotonic clamping', () => {
    const meter = createMonotonicProgressMeter();
    expect(meter.fraction()).toBe(0);

    const cat1 = meter.report('categories', 5, 10);
    expect(cat1).toMatchObject({ phase: 'categories', done: 5, total: 10 });
    expect(cat1.fraction).toBeCloseTo(0.05, 5);

    const catDone = meter.complete('categories', 10);
    expect(catDone.fraction).toBeCloseTo(0.1, 5);

    // Streaming unknown-total live progress grows asymptotically, never hitting full stage weight until complete
    const l1 = meter.report('live', 200);
    const l2 = meter.report('live', 2000);
    expect(l1.fraction).toBeGreaterThan(0.1);
    expect(l2.fraction).toBeGreaterThan(l1.fraction ?? 0);
    expect(l2.fraction).toBeLessThan(0.4);

    // Out-of-order concurrent completion: series finishes before live & movies
    const sDone = meter.complete('series', 50);
    expect(sDone.fraction).toBeGreaterThan(l2.fraction ?? 0);

    // Regressing done or switching to total must NEVER decrease done or overall fraction
    const lRegress = meter.report('live', 100);
    expect(lRegress.done).toBe(2000);
    expect(lRegress.fraction).toBeGreaterThanOrEqual(sDone.fraction ?? 0);

    meter.complete('live', 3000);
    meter.markComplete('movies');
    const cleanStart = meter.report('cleanup', 0);
    expect(cleanStart.fraction).toBeCloseTo(0.95, 5);

    const cleanEnd = meter.complete('cleanup', 12);
    expect(cleanEnd).toMatchObject({ phase: 'cleanup', done: 12, fraction: 1 });
  });
});

describe('Xtream parallel streaming import & progress (#76, #197)', () => {
  it('fetches categories in parallel and emits strictly monotonic overall fraction across out-of-order stream completion', async () => {
    const data = sampleCatalog();
    const e = await setup(data);

    const catArrivals: string[] = [];
    const catGate = deferred();
    const liveGate = deferred();
    const movieGate = deferred();
    const activeStreams: string[] = [];

    const http: HttpClient = {
      async get(url, options): Promise<Result<HttpResponse>> {
        const action = new URL(url).searchParams.get('action');
        if (options?.signal?.aborted) return err(elvError('network', 'aborted'));

        if (
          action === 'get_live_categories' ||
          action === 'get_vod_categories' ||
          action === 'get_series_categories'
        ) {
          catArrivals.push(action);
          if (catArrivals.length === 3) catGate.resolve();
          await catGate.promise;
          const payload =
            action === 'get_live_categories'
              ? data.liveCats
              : action === 'get_vod_categories'
                ? data.vodCats
                : data.seriesCats;
          return ok({
            status: 200,
            headers: {},
            body: (async function* () {
              yield enc(JSON.stringify(payload));
            })(),
          });
        }

        if (action === 'get_live_streams') {
          activeStreams.push(action);
          return ok({
            status: 200,
            headers: {},
            body: (async function* () {
              await liveGate.promise;
              yield enc(JSON.stringify(data.live));
            })(),
          });
        }
        if (action === 'get_vod_streams') {
          activeStreams.push(action);
          return ok({
            status: 200,
            headers: {},
            body: (async function* () {
              await movieGate.promise;
              yield enc(JSON.stringify(data.vod));
            })(),
          });
        }
        if (action === 'get_series') {
          activeStreams.push(action);
          return ok({
            status: 200,
            headers: {},
            body: (async function* () {
              yield enc(JSON.stringify(data.series));
              // Finish series first, then movies, then live (strictly out of order!)
              movieGate.resolve();
              setTimeout(() => liveGate.resolve(), 10);
            })(),
          });
        }
        return e.deps.http.get(url, options);
      },
    };

    const events: ImportProgress[] = [];
    const r = await importCatalog(
      e.sourceId,
      { ...e.deps, http },
      { batchSize: 2, onProgress: (p) => events.push(p) },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));

    expect(catArrivals).toHaveLength(3);
    expect(activeStreams.sort()).toEqual(['get_live_streams', 'get_series', 'get_vod_streams']);
    expect(events.length).toBeGreaterThan(0);

    // Overall fraction must be finite, in [0, 1], strictly non-decreasing, and end at 1
    let prevFraction = 0;
    const prevDoneByPhase = new Map<string, number>();
    for (const ev of events) {
      expect(typeof ev.fraction).toBe('number');
      const f = ev.fraction as number;
      expect(f).toBeGreaterThanOrEqual(prevFraction);
      expect(f).toBeLessThanOrEqual(1);
      prevFraction = f;

      const prevDone = prevDoneByPhase.get(ev.phase) ?? 0;
      expect(ev.done).toBeGreaterThanOrEqual(prevDone);
      prevDoneByPhase.set(ev.phase, ev.done);
    }
    expect(events.at(-1)?.phase).toBe('cleanup');
    expect(events.at(-1)?.fraction).toBe(1);
  });

  it('aborts sibling category and stream requests immediately via linked AbortController on first failure', async () => {
    const e = await setup(sampleCatalog());
    const siblingSignals: { action: string; signal: AbortSignal }[] = [];
    const bothPending = deferred();

    const http: HttpClient = {
      async get(url, options): Promise<Result<HttpResponse>> {
        const action = new URL(url).searchParams.get('action');
        if (action === 'get_vod_streams') {
          await bothPending.promise;
          return err(httpStatusError(500));
        }
        if (action === 'get_live_streams' || action === 'get_series') {
          const signal = options?.signal;
          if (signal) siblingSignals.push({ action, signal });
          if (siblingSignals.length === 2) bothPending.resolve();
          return ok({
            status: 200,
            headers: {},
            body: (async function* () {
              await new Promise<void>((resolve) => {
                if (signal?.aborted) resolve();
                else signal?.addEventListener('abort', () => resolve(), { once: true });
              });
              throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            })(),
          });
        }
        return e.deps.http.get(url, options);
      },
    };

    const r = await importCatalog(e.sourceId, { ...e.deps, http });
    expect(r).toMatchObject({ ok: false, error: { category: 'network', code: 'http-500' } });
    expect(siblingSignals).toHaveLength(2);
    for (const s of siblingSignals) {
      expect(s.signal.aborted).toBe(true);
    }
  });

  it('aborts sibling category requests immediately when one category request fails', async () => {
    const e = await setup(sampleCatalog());
    const catSignals: AbortSignal[] = [];
    const ready = deferred();

    const http: HttpClient = {
      async get(url, options): Promise<Result<HttpResponse>> {
        const action = new URL(url).searchParams.get('action');
        if (action === 'get_vod_categories') {
          await ready.promise;
          return err(httpStatusError(503));
        }
        if (action === 'get_live_categories' || action === 'get_series_categories') {
          const signal = options?.signal;
          if (signal) catSignals.push(signal);
          if (catSignals.length === 2) ready.resolve();
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          return err(elvError('network', 'aborted'));
        }
        return e.deps.http.get(url, options);
      },
    };

    const r = await importCatalog(e.sourceId, { ...e.deps, http });
    expect(r).toMatchObject({ ok: false, error: { category: 'network', code: 'http-503' } });
    expect(catSignals).toHaveLength(2);
    expect(catSignals.every((s) => s.aborted)).toBe(true);
  });

  it('yields to scheduler per streaming batch before EOF and merges cross-batch duplicate IDs first-wins', async () => {
    const data = emptyPanel();
    data.vodCats = [
      { category_id: '10', category_name: 'Drama' },
      { category_id: '11', category_name: 'Comedy' },
    ];
    data.liveCats = [{ category_id: '1', category_name: 'News' }];
    const e = await setup(data);

    let yieldsBeforeEof = 0;
    let streamEof = false;
    const scheduler = {
      yieldNow: async () => {
        if (!streamEof) yieldsBeforeEof++;
      },
    };

    const vodRows = [
      {
        stream_id: 200,
        name: 'Original Title',
        category_id: '10',
        rating: '8.5',
        container_extension: 'mkv',
      },
      { stream_id: 201, name: 'Second Movie', category_id: '10', container_extension: 'mp4' },
      // Duplicate ID 200 in later batch with conflicting metadata, same category 10 AND new category 11
      {
        stream_id: 200,
        name: 'Later Overwrite',
        category_ids: ['10', '11'],
        rating: '2.0',
        container_extension: 'avi',
      },
      // Duplicate ID 201 in later batch with empty category_id must NOT create a spurious Uncategorized placement
      { stream_id: 201, name: 'Second Movie Dup', category_id: '', container_extension: 'mp4' },
      { stream_id: 202, name: 'Third Movie', category_id: '11', container_extension: 'mp4' },
    ];
    const liveRows = [
      // First occurrence is a placeholder divider -> skipped; later duplicate ID must NOT resurrect it
      { stream_id: 901, name: '=== --- ===', category_id: '1' },
      { stream_id: 902, name: 'Real Channel', category_id: '1' },
      { stream_id: 901, name: 'Resurrected?', category_id: '1' },
    ];

    const http: HttpClient = {
      async get(url, options): Promise<Result<HttpResponse>> {
        const action = new URL(url).searchParams.get('action');
        if (action === 'get_vod_streams') {
          const raw = JSON.stringify(vodRows);
          const mid = Math.floor(raw.length / 2);
          return ok({
            status: 200,
            headers: {},
            body: (async function* () {
              yield enc(raw.slice(0, mid));
              yield enc(raw.slice(mid));
              streamEof = true;
            })(),
          });
        }
        if (action === 'get_live_streams') {
          return ok({
            status: 200,
            headers: {},
            body: (async function* () {
              yield enc(JSON.stringify(liveRows));
            })(),
          });
        }
        return e.deps.http.get(url, options);
      },
    };

    const r = await importCatalog(e.sourceId, { ...e.deps, http, scheduler }, { batchSize: 2 });
    if (!r.ok) throw new Error(JSON.stringify(r.error));

    expect(yieldsBeforeEof).toBeGreaterThanOrEqual(1);
    expect(r.value.counts).toMatchObject({ movies: 3, live: 1, skippedPlaceholders: 1 });

    // First-wins metadata preserved for movie 200
    const m200 = await e.db.all<Record<string, unknown>>(
      "SELECT name, rating, extension FROM movies WHERE provider_id = '200'",
    );
    expect(m200).toEqual([{ name: 'Original Title', rating: 8.5, extension: 'mkv' }]);

    // Placements unioned across batches without duplicate (200, '10')
    const placements = await e.db.all<Record<string, unknown>>(
      "SELECT category_id, item_key, position FROM placements WHERE kind = 'movie' ORDER BY category_id, position",
    );
    expect(placements).toEqual([
      { category_id: '10', item_key: 'x:s1:movie:200', position: 0 },
      { category_id: '10', item_key: 'x:s1:movie:201', position: 1 },
      { category_id: '11', item_key: 'x:s1:movie:200', position: 0 },
      { category_id: '11', item_key: 'x:s1:movie:202', position: 1 },
    ]);

    // Placeholder channel 901 was NOT resurrected, and duplicate 201 with empty category_id created no Uncategorized
    const live = await e.db.all<Record<string, unknown>>('SELECT provider_id FROM live');
    expect(live).toEqual([{ provider_id: '902' }]);
    const uncat = await e.db.all<Record<string, unknown>>(
      "SELECT * FROM categories WHERE provider_id = 'Uncategorized'",
    );
    expect(uncat).toEqual([]);
  });

  it('cleans partial streamed rows and synthetic Uncategorized before falling back to per-category on too-large', async () => {
    const data = sampleCatalog();
    const e = await setup(data);
    const maxBodyBytes = 300;
    const partialChunk = enc('[{"stream_id":999,"name":"Orphan Uncat","category_id":""},');
    const hugeTail = enc(`${' '.repeat(400)}]`);

    const http: HttpClient = {
      async get(url, options): Promise<Result<HttpResponse>> {
        const u = new URL(url);
        if (
          u.searchParams.get('action') === 'get_vod_streams' &&
          !u.searchParams.has('category_id')
        ) {
          return ok({
            status: 200,
            headers: {},
            body: (async function* () {
              yield partialChunk;
              yield hugeTail;
            })(),
          });
        }
        return e.deps.http.get(url, options);
      },
    };

    const r = await importCatalog(e.sourceId, { ...e.deps, http, maxBodyBytes }, { batchSize: 1 });
    if (!r.ok) throw new Error(JSON.stringify(r.error));

    expect(await count(e.db, 'movies')).toBe(3);
    const uncat = await e.db.all<Record<string, unknown>>(
      "SELECT * FROM categories WHERE provider_id = 'Uncategorized'",
    );
    expect(uncat).toEqual([]);
    const placements = await e.db.all<Record<string, unknown>>(
      "SELECT category_id, item_key, position FROM placements WHERE kind = 'movie' ORDER BY category_id, position",
    );
    expect(placements).toEqual([
      { category_id: '10', item_key: 'x:s1:movie:200', position: 0 },
      { category_id: '10', item_key: 'x:s1:movie:201', position: 1 },
      { category_id: '11', item_key: 'x:s1:movie:200', position: 0 },
      { category_id: '11', item_key: 'x:s1:movie:202', position: 1 },
    ]);
  });

  it('aborts all in-flight parallel streams immediately when caller signal cancels', async () => {
    const e = await setup(sampleCatalog());
    const ctl = new AbortController();
    const signals: AbortSignal[] = [];

    const http: HttpClient = {
      async get(url, options): Promise<Result<HttpResponse>> {
        const action = new URL(url).searchParams.get('action');
        if (
          action === 'get_live_streams' ||
          action === 'get_vod_streams' ||
          action === 'get_series'
        ) {
          const signal = options?.signal;
          if (signal) signals.push(signal);
          if (signals.length === 3) ctl.abort();
          return ok({
            status: 200,
            headers: {},
            body: (async function* () {
              await new Promise<void>((resolve) => {
                if (signal?.aborted) resolve();
                else signal?.addEventListener('abort', () => resolve(), { once: true });
              });
              throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            })(),
          });
        }
        return e.deps.http.get(url, options);
      },
    };

    const r = await importCatalog(e.sourceId, { ...e.deps, http }, { signal: ctl.signal });
    expect(r).toMatchObject({ ok: false, error: { category: 'network', code: 'aborted' } });
    expect(signals).toHaveLength(3);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });
});
