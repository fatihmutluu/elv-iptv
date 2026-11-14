import { describe, expect, it } from 'vitest';
import { connectionStats, httpSimLog, type SimLogEntry, span } from '../src/gates/sim-log.ts';

const T0 = Date.parse('2026-11-14T10:00:00.000Z');
const entry = (over: Partial<SimLogEntry> & { start?: number } = {}): SimLogEntry => {
  const { start = 0, ...rest } = over;
  const ms = rest.ms ?? 1000;
  return {
    t: new Date(T0 + start + ms).toISOString(),
    path: '/live/demo/demo/1001.ts',
    query: {},
    status: 200,
    bytes: 500_000,
    ms,
    account: 'demo',
    streamId: 1001,
    ...rest,
  };
};

describe('span', () => {
  it('derives the start from the end time and the duration', () => {
    expect(span(entry({ start: 100, ms: 400 }))).toEqual({ start: T0 + 100, end: T0 + 500 });
  });
});

describe('connectionStats', () => {
  it('finds no overlap between sequential requests', () => {
    const list = [entry({ start: 0, ms: 1000 }), entry({ start: 1000, ms: 1000 })];
    expect(connectionStats(list, 'demo')).toEqual({ limitResponses: 0, overlapMs: 0 });
  });

  it('sums the overlap of two requests', () => {
    const list = [entry({ start: 0, ms: 1000 }), entry({ start: 970, ms: 1000 })];
    expect(connectionStats(list, 'demo').overlapMs).toBe(30);
  });

  it('sums every overlapping pair and counts a contained request fully', () => {
    const list = [
      entry({ start: 0, ms: 1000 }),
      entry({ start: 100, ms: 200 }),
      entry({ start: 900, ms: 300 }),
    ];
    expect(connectionStats(list, 'demo').overlapMs).toBe(200 + 100);
  });

  it('counts 509, 429 and notice answers as limit responses', () => {
    const list = [
      entry({ status: 509, bytes: 0, ms: 2 }),
      entry({ status: 429, bytes: 0, ms: 2 }),
      entry({ status: 200, bytes: 23, ms: 2 }),
      entry({ status: 404, bytes: 0, ms: 2 }),
      entry({ start: 5000 }),
    ];
    expect(connectionStats(list, 'demo').limitResponses).toBe(3);
  });

  it('does not count an answer forced by the request fault itself, but counts every other limit answer', () => {
    const list = [
      entry({ status: 509, bytes: 0, ms: 2, query: { fault: 'status=509' } }),
      entry({ status: 429, bytes: 0, ms: 2, query: { fault: 'drop@5s,status=429' } }),
      entry({ status: 200, bytes: 23, ms: 2, query: { fault: 'text-notice' } }),
      entry({ start: 3000, status: 509, bytes: 0, ms: 2, query: { fault: 'slow-start=3' } }),
      entry({ start: 6000, status: 200, bytes: 23, ms: 2, query: { fault: 'status=509' } }),
    ];
    expect(connectionStats(list, 'demo').limitResponses).toBe(2);
  });

  it('counts the lifetime of every stream request whatever its answer', () => {
    const list = [
      entry({ start: 0, ms: 3000, status: 509, bytes: 0, query: { fault: 'slow-start=3' } }),
      entry({ start: 1000, ms: 1000, status: 200, bytes: 23 }),
      entry({ start: 2500, ms: 1000 }),
      entry({ start: 2600, ms: 10, status: 404, bytes: 0, path: '/live/demo/demo/1002.ts' }),
    ];
    expect(connectionStats(list, 'demo').overlapMs).toBe(1000 + 500 + 10 + 10);
  });

  it('ignores HLS segments without an account and other accounts', () => {
    const list = [
      entry({ account: null, streamId: null, path: '/hls/news/3.ts', status: 509 }),
      entry({ account: 'large', status: 509 }),
      entry({ start: 0, ms: 1000, path: '/hls/news/4.ts', account: null }),
      entry({ start: 0, ms: 1000 }),
    ];
    expect(connectionStats(list, 'demo')).toEqual({ limitResponses: 0, overlapMs: 0 });
  });
});

describe('httpSimLog', () => {
  it('clears and reads the log over HTTP and reports failures', async () => {
    const calls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('bad')) return new Response('', { status: 500 });
      return init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify([entry()]));
    }) as typeof fetch;
    try {
      const log = httpSimLog('http://127.0.0.1:7878');
      await log.clear();
      expect(await log.entries()).toHaveLength(1);
      expect(calls).toEqual([
        'DELETE http://127.0.0.1:7878/_sim/requests',
        'GET http://127.0.0.1:7878/_sim/requests',
      ]);
      const bad = httpSimLog('http://bad');
      await expect(bad.clear()).rejects.toThrow(/clearing.*500/);
      await expect(bad.entries()).rejects.toThrow(/reading.*500/);
    } finally {
      globalThis.fetch = real;
    }
  });
});
