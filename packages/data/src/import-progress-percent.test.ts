import { elvError, err, type HttpClient, type HttpResponse, ok, type Result } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { importGuide } from './import-guide';
import { channelXml, HOUR, NOW, programmeXml, setupGuide, tv } from './import-guide-test-helpers';
import {
  createMonotonicProgressMeter,
  createStreamProgressMeter,
  parseContentLength,
} from './import-progress';
import {
  count,
  extinf,
  sampleCatalog,
  setupM3u,
  setup as setupXtream,
} from './import-test-helpers';
import type { ImportProgress } from './import-types';
import { importCatalog } from './import-xtream';

const enc = (s: string) => new TextEncoder().encode(s);

function assertMonotonicPercent(events: readonly ImportProgress[]): void {
  expect(events.length).toBeGreaterThan(0);
  let prevPercent = 0;
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    expect(typeof ev?.percent).toBe('number');
    const p = ev?.percent as number;
    expect(Number.isInteger(p)).toBe(true);
    expect(p).toBeGreaterThanOrEqual(prevPercent);
    expect(p).toBeLessThanOrEqual(100);
    if (i < events.length - 1) {
      expect(p).toBeLessThan(100);
    }
    prevPercent = p;
  }
  expect(events.at(-1)?.percent).toBe(100);
}

describe('Monotonic import progress percentage (#65)', () => {
  it('reports monotonic integer percent 0..99 during phases and 100 on completion for known and unknown totals', () => {
    const meter = createMonotonicProgressMeter();
    expect(meter.percent()).toBe(0);

    // Known total interpolation
    const c1 = meter.report('categories', 5, 10);
    expect(c1.percent).toBe(5);
    const c2 = meter.complete('categories', 10);
    expect(c2.percent).toBe(10);

    // Unknown total bounded asymptotic curve advances through 25,000 items without hitting 100
    let prev = c2.percent ?? 0;
    for (const n of [200, 1_000, 5_000, 10_000, 20_000, 25_000]) {
      const ev = meter.report('live', n);
      expect(ev.percent).toBeGreaterThanOrEqual(prev);
      expect(ev.percent).toBeLessThan(100);
      prev = ev.percent ?? prev;
    }
    expect(prev).toBeGreaterThan(30);

    meter.complete('live', 25_000);
    meter.complete('movies', 500);
    meter.complete('series', 100);
    const cleanupStart = meter.report('cleanup', 0);
    expect(cleanupStart.percent).toBe(95);

    const cleanupEnd = meter.complete('cleanup', 4);
    expect(cleanupEnd.percent).toBe(100);
    expect(meter.percent()).toBe(100);
  });

  it('tracks single-stream progress smoothly across 25,000 entries without total and accurately with Content-Length', () => {
    // Unknown total
    const unknownMeter = createStreamProgressMeter();
    const seenUnknown: number[] = [];
    for (const n of [200, 1_000, 5_000, 10_000, 15_000, 20_000, 25_000]) {
      const ev = unknownMeter.reportStream('live', n, n);
      seenUnknown.push(ev.percent ?? -1);
    }
    expect(seenUnknown[0]).toBeGreaterThan(0);
    expect(seenUnknown.at(-1)).toBeGreaterThan(80);
    expect(seenUnknown.at(-1)).toBeLessThan(95);
    for (let i = 1; i < seenUnknown.length; i += 1) {
      expect(seenUnknown[i]).toBeGreaterThan(seenUnknown[i - 1] ?? -1);
    }
    unknownMeter.completeStream();
    expect(unknownMeter.report('cleanup', 0).percent).toBe(95);
    expect(unknownMeter.complete('cleanup', 0).percent).toBe(100);

    // Known total (bytes) + regression guard + parseContentLength edge cases
    const knownMeter = createStreamProgressMeter();
    const p25 = knownMeter.reportStream('live', 100, 250, 1_000);
    const p50 = knownMeter.reportStream('live', 200, 500, 1_000);
    const pRegress = knownMeter.reportStream('live', 50, 100, 1_000);
    const p100 = knownMeter.reportStream('live', 400, 1_000, 1_000);
    expect(p25.percent).toBeGreaterThanOrEqual(20);
    expect(p50.percent).toBeGreaterThan(p25.percent ?? 0);
    expect(pRegress.done).toBe(200);
    expect(pRegress.percent).toBe(p50.percent);
    expect(p100.percent).toBeLessThanOrEqual(95);
    expect(knownMeter.fraction()).toBeLessThanOrEqual(0.95);
    expect(knownMeter.percent()).toBeLessThanOrEqual(95);
    knownMeter.completeStream();
    expect(knownMeter.report('cleanup', 0, 5)).toMatchObject({ total: 5, percent: 95 });
    expect(knownMeter.complete('cleanup').percent).toBe(100);

    expect(parseContentLength({ 'Content-Length': ' 4096 ' })).toBe(4096);
    expect(parseContentLength({ 'content-length': '0' })).toBeUndefined();
    expect(parseContentLength({ 'content-length': '-10' })).toBeUndefined();
    expect(parseContentLength({ 'content-length': 'abc' })).toBeUndefined();
    expect(parseContentLength({})).toBeUndefined();
  });

  it('emits monotonic percent across Xtream import and preserves prior catalog on AbortSignal cancel', async () => {
    const e = await setupXtream(sampleCatalog());
    const events: ImportProgress[] = [];
    const first = await importCatalog(e.sourceId, e.deps, {
      batchSize: 1,
      onProgress: (p) => events.push(p),
    });
    expect(first.ok).toBe(true);
    assertMonotonicPercent(events);
    const committedLive = await count(e.db, 'live');
    const committedMovies = await count(e.db, 'movies');
    expect(committedLive).toBeGreaterThan(0);

    // Second run cancelled mid-flight keeps committed catalog 100% intact
    const ctl = new AbortController();
    const cancelEvents: ImportProgress[] = [];
    const second = await importCatalog(e.sourceId, e.deps, {
      batchSize: 1,
      signal: ctl.signal,
      onProgress: (p) => {
        cancelEvents.push(p);
        if (p.phase === 'live') ctl.abort();
      },
    });
    expect(second).toMatchObject({ ok: false, error: { category: 'network', code: 'aborted' } });
    expect(cancelEvents.every((ev) => (ev.percent ?? 0) < 100)).toBe(true);
    expect(await count(e.db, 'live')).toBe(committedLive);
    expect(await count(e.db, 'movies')).toBe(committedMovies);
  });

  it('emits monotonic percent across M3U import with Content-Length, without Content-Length, and preserves prior catalog on abort', async () => {
    const lines = ['#EXTM3U'];
    for (let i = 1; i <= 400; i += 1) {
      lines.push(`#EXTINF:-1 group-title="Live",Channel ${i}`);
      lines.push(`http://m3u.example/live/${i}.ts`);
    }
    const bodyText = lines.join('\n');
    const bodyBytes = enc(bodyText);

    const makeChunkedHttp = (withContentLength: boolean): HttpClient => ({
      async get(_url, opts): Promise<Result<HttpResponse>> {
        if (opts?.signal?.aborted) return err(elvError('network', 'aborted'));
        const headers: Record<string, string> = withContentLength
          ? { 'content-length': String(bodyBytes.byteLength) }
          : {};
        const step = Math.ceil(bodyBytes.byteLength / 8);
        return ok({
          status: 200,
          headers,
          body: (async function* () {
            for (let off = 0; off < bodyBytes.byteLength; off += step) {
              if (opts?.signal?.aborted) {
                throw Object.assign(new Error('aborted'), { name: 'AbortError' });
              }
              yield bodyBytes.slice(off, off + step);
            }
          })(),
        });
      },
    });

    // 1) Known Content-Length
    const eKnown = await setupM3u(bodyText);
    const knownEvents: ImportProgress[] = [];
    const rKnown = await importCatalog(
      eKnown.sourceId,
      { ...eKnown.deps, http: makeChunkedHttp(true) },
      { batchSize: 50, onProgress: (p) => knownEvents.push(p) },
    );
    expect(rKnown.ok).toBe(true);
    assertMonotonicPercent(knownEvents);
    const midKnown = knownEvents.filter((ev) => ev.phase === 'live').map((ev) => ev.percent ?? 0);
    expect(Math.max(...midKnown)).toBeGreaterThan(20);

    // 2) Unknown Content-Length (asymptotic curve)
    const unknownEvents: ImportProgress[] = [];
    const rUnknown = await importCatalog(
      eKnown.sourceId,
      { ...eKnown.deps, http: makeChunkedHttp(false) },
      { batchSize: 50, onProgress: (p) => unknownEvents.push(p) },
    );
    expect(rUnknown.ok).toBe(true);
    assertMonotonicPercent(unknownEvents);
    const midUnknown = unknownEvents
      .filter((ev) => ev.phase === 'live')
      .map((ev) => ev.percent ?? 0);
    expect(Math.max(...midUnknown)).toBeGreaterThan(0);

    // 3) Abort mid-import leaves prior 400 committed channels 100% intact
    expect(await count(eKnown.db, 'live')).toBe(400);
    const ctl = new AbortController();
    const aborted = await importCatalog(
      eKnown.sourceId,
      { ...eKnown.deps, http: makeChunkedHttp(false) },
      {
        batchSize: 50,
        signal: ctl.signal,
        onProgress: (p) => {
          if (p.phase === 'live') ctl.abort();
        },
      },
    );
    expect(aborted).toMatchObject({ ok: false, error: { category: 'network', code: 'aborted' } });
    expect(await count(eKnown.db, 'live')).toBe(400);
  });

  it('emits monotonic percent across XMLTV guide import with and without Content-Length and keeps prior guide intact on abort', async () => {
    const programmes: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      programmes.push(programmeXml('ch1', i * HOUR, 1, `Show ${i}`));
    }
    const xmlBytes = enc(tv(channelXml('ch1', 'Haber Bir'), ...programmes));

    const makeGuideHttp = (withContentLength: boolean): HttpClient => ({
      async get(_url, opts): Promise<Result<HttpResponse>> {
        if (opts?.signal?.aborted) return err(elvError('network', 'aborted'));
        const headers: Record<string, string> = withContentLength
          ? { 'content-length': String(xmlBytes.byteLength) }
          : {};
        const step = Math.ceil(xmlBytes.byteLength / 6);
        return ok({
          status: 200,
          headers,
          body: (async function* () {
            for (let off = 0; off < xmlBytes.byteLength; off += step) {
              if (opts?.signal?.aborted) {
                throw Object.assign(new Error('aborted'), { name: 'AbortError' });
              }
              yield xmlBytes.slice(off, off + step);
            }
          })(),
        });
      },
    });

    const playlist = `#EXTM3U\n${extinf('Haber Bir', 'http://live.example/1.ts', 'tvg-id="ch1"')}`;
    const g = await setupGuide(playlist);
    expect((await importCatalog(g.sourceId, g.deps)).ok).toBe(true);

    // Known Content-Length
    const knownEvents: ImportProgress[] = [];
    const rKnown = await importGuide(
      g.sourceId,
      { ...g.deps, http: makeGuideHttp(true) },
      { now: NOW, batchSize: 10, onProgress: (p) => knownEvents.push(p) },
    );
    expect(rKnown.ok).toBe(true);
    assertMonotonicPercent(knownEvents);
    const committedProgrammes = await count(g.db, 'programmes');
    expect(committedProgrammes).toBe(60);

    // Unknown Content-Length
    const unknownEvents: ImportProgress[] = [];
    const rUnknown = await importGuide(
      g.sourceId,
      { ...g.deps, http: makeGuideHttp(false) },
      { now: NOW, batchSize: 10, onProgress: (p) => unknownEvents.push(p) },
    );
    expect(rUnknown.ok).toBe(true);
    assertMonotonicPercent(unknownEvents);

    // Abort mid-guide leaves prior committed programmes 100% intact
    const ctl = new AbortController();
    const aborted = await importGuide(
      g.sourceId,
      { ...g.deps, http: makeGuideHttp(false) },
      {
        now: NOW,
        batchSize: 10,
        signal: ctl.signal,
        onProgress: (p) => {
          if (p.phase === 'programmes') ctl.abort();
        },
      },
    );
    expect(aborted).toMatchObject({ ok: false, error: { category: 'network', code: 'aborted' } });
    expect(await count(g.db, 'programmes')).toBe(committedProgrammes);
  });
});
