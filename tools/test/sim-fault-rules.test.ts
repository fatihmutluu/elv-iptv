import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNTS } from '../src/sim/accounts.ts';
import { FaultRules } from '../src/sim/fault-rules.ts';
import { findFfmpeg, MEDIA_SKIP_MARKER } from '../src/sim/media.ts';
import { type SimHandle, startSim } from '../src/sim/server.ts';

const CLOCK = new Date('2026-01-01T12:00:00Z');
const open: SimHandle[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
});

async function sim(ffmpegPath: string | null = null, cacheDir?: string): Promise<SimHandle> {
  const handle = await startSim({
    port: 0,
    clock: CLOCK,
    ffmpegPath,
    mediaSeconds: 4,
    ...(cacheDir === undefined ? {} : { cacheDir }),
  });
  open.push(handle);
  return handle;
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/_sim/faults`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function rulesOf(url: string): Promise<unknown> {
  return (await fetch(`${url}/_sim/faults`)).json();
}

async function status(url: string, init?: RequestInit): Promise<number> {
  const res = await fetch(url, init);
  await res.text();
  return res.status;
}

describe('FaultRules', () => {
  it('takes the newest matching rule and counts it down', () => {
    const rules = new FaultRules();
    expect(rules.add({ account: 'demo', stream: '*', spec: 'status=500' })).toEqual({
      ok: true,
      id: 'r1',
    });
    expect(rules.add({ account: 'demo', stream: 1001, spec: 'status=403', count: 1 })).toEqual({
      ok: true,
      id: 'r2',
    });
    expect(rules.take('demo', 1001)).toEqual({ id: 'r2', spec: 'status=403' });
    expect(rules.take('demo', 1001)).toEqual({ id: 'r1', spec: 'status=500' });
    expect(rules.take('quirks', 1001)).toBeNull();
    expect(rules.list()).toEqual([
      { id: 'r1', account: 'demo', stream: '*', spec: 'status=500', remaining: null },
    ]);
    rules.clear();
    expect(rules.list()).toEqual([]);
    expect(rules.add({ account: 'demo', stream: '7', spec: 'drop@1s' })).toEqual({
      ok: true,
      id: 'r3',
    });
  });

  it.each([
    [null, 'body is not a JSON object'],
    [[1], 'body is not a JSON object'],
    [{ account: 'nobody', stream: '*', spec: 'status=403' }, 'unknown account "nobody"'],
    [{ account: 'demo', stream: 'x', spec: 'status=403' }, 'stream must be "*" or a stream id'],
    [{ account: 'demo', stream: -1, spec: 'status=403' }, 'stream must be "*" or a stream id'],
    [{ account: 'demo', stream: '*', spec: '' }, 'spec must be a non-empty fault spec'],
    [{ account: 'demo', stream: '*', spec: 'explode' }, 'unknown or malformed fault "explode"'],
    [
      { account: 'demo', stream: '*', spec: 'status=403', count: 0 },
      'count must be a positive integer',
    ],
    [
      { account: 'demo', stream: '*', spec: 'status=403', count: 1.5 },
      'count must be a positive integer',
    ],
  ])('rejects %j', (input, error) => {
    expect(new FaultRules().add(input)).toEqual({ ok: false, error });
  });
});

describe('runtime fault rules over HTTP', () => {
  it('adds, lists and clears rules over HTTP', async () => {
    const { url } = await sim();
    const added = await post(url, { account: 'demo', stream: '1001', spec: 'status=403' });
    expect(added.status).toBe(201);
    expect(added.headers.get('content-type')).toContain('application/json');
    expect(await added.json()).toEqual({ id: 'r1' });
    expect(await rulesOf(url)).toEqual([
      { id: 'r1', account: 'demo', stream: '1001', spec: 'status=403', remaining: null },
    ]);
    expect((await fetch(`${url}/_sim/faults`, { method: 'DELETE' })).status).toBe(204);
    expect(await rulesOf(url)).toEqual([]);
  });

  it('answers 400 with the reason and 413 for a large body', async () => {
    const { url } = await sim();
    const bad = await post(url, 'not json');
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe('body is not a JSON object');
    const unknown = await post(url, { account: 'demo', stream: '*', spec: 'explode' });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain('explode');
    expect((await post(url, 'x'.repeat(65_537))).status).toBe(413);
  });

  it('applies a 403 rule to an Xtream live stream id and logs it', async () => {
    const handle = await sim();
    await post(handle.url, { account: 'demo', stream: '1001', spec: 'status=403' });
    expect(await status(`${handle.url}/live/demo/demo/1001.ts`)).toBe(403);
    expect(handle.requests().at(-1)).toMatchObject({
      streamId: 1001,
      fault: 'status=403',
      faultRule: 'r1',
    });
  });

  it('expires a counted rule', async () => {
    const handle = await sim();
    const stream = `${handle.url}/live/demo/demo/1001.ts`;
    await post(handle.url, { account: 'demo', stream: '1001', spec: 'status=429', count: 2 });
    expect(await status(stream)).toBe(429);
    expect(await rulesOf(handle.url)).toMatchObject([{ remaining: 1 }]);
    expect(await status(stream)).toBe(429);
    expect(await rulesOf(handle.url)).toEqual([]);
    expect(await status(stream)).toBe(503);
    expect(handle.requests().at(-1)).toMatchObject({ fault: null, faultRule: null });
  });

  it('prefers the query, then the newest rule, then the catalog fault', async () => {
    const handle = await sim();
    const stream = `${handle.url}/live/demo/demo/1013.ts`;
    await post(handle.url, { account: 'demo', stream: '1013', spec: 'status=404' });
    expect(await status(stream)).toBe(404);
    expect(await status(`${stream}?fault=status=418`)).toBe(418);
    expect(handle.requests().at(-1)).toMatchObject({ faultRule: null });
    expect(await rulesOf(handle.url)).toHaveLength(1);
    await post(handle.url, { account: 'demo', stream: '*', spec: 'status=410' });
    expect(await status(stream)).toBe(410);
  });

  it('a rule for demo leaves quirks untouched', async () => {
    const handle = await sim();
    await post(handle.url, { account: 'demo', stream: '*', spec: 'status=403' });
    const quirks = ACCOUNTS.find((a) => a.username === 'quirks');
    if (!quirks) throw new Error('quirks account missing');
    const path = `/live/${quirks.username}/${quirks.password}/1001.ts`;
    expect(await status(`${handle.url}${path}`)).toBe(503);
    expect(handle.requests().at(-1)).toMatchObject({ faultRule: null });
  });

  it('a counted rule is consumed once under parallel requests', async () => {
    const { url } = await sim();
    await post(url, { account: 'demo', stream: '1001', spec: 'status=429', count: 1 });
    const stream = `${url}/live/demo/demo/1001.ts`;
    const codes = await Promise.all([status(stream), status(stream)]);
    expect(codes.sort()).toEqual([429, 503]);
  });

  it('HEAD consumes a counted rule', async () => {
    const { url } = await sim();
    await post(url, { account: 'demo', stream: '1001', spec: 'status=429', count: 1 });
    const stream = `${url}/live/demo/demo/1001.ts`;
    expect(await status(stream, { method: 'HEAD' })).toBe(429);
    expect(await status(stream)).toBe(503);
  });

  it('never matches HLS segments or catch-up', async () => {
    const { url } = await sim();
    await post(url, { account: 'demo', stream: '*', spec: 'status=429', count: 1 });
    expect(await status(`${url}/hls/h264-aac-720p25/0.ts`)).toBe(503);
    expect(await status(`${url}/timeshift/demo/demo/60/2026-01-01:12-00/1001.ts`)).toBe(503);
    expect(await rulesOf(url)).toMatchObject([{ remaining: 1 }]);
  });

  it('resets with DELETE /_sim/requests and clear()', async () => {
    const handle = await sim();
    await post(handle.url, { account: 'demo', stream: '*', spec: 'status=403' });
    await fetch(`${handle.url}/_sim/requests`, { method: 'DELETE' });
    expect(await rulesOf(handle.url)).toEqual([]);
    await post(handle.url, { account: 'demo', stream: '*', spec: 'status=403' });
    handle.clear();
    expect(await rulesOf(handle.url)).toEqual([]);
  });
});

const ffmpeg = findFfmpeg();
if (ffmpeg === null && process.env.CI === 'true') {
  throw new Error('ffmpeg is required in CI');
}
const withFfmpeg = ffmpeg === null ? describe.skip : describe;
if (ffmpeg === null) process.stderr.write(`sim-fault-rules: ${MEDIA_SKIP_MARKER}\n`);

withFfmpeg('rules on live streams', () => {
  const cacheDir = ffmpeg === null ? '' : mkdtempSync(join(tmpdir(), 'sim-rules-'));
  afterAll(() => rm(cacheDir, { recursive: true, force: true, maxRetries: 25, retryDelay: 400 }));

  it('drops a live stream by rule', async () => {
    const handle = await sim(ffmpeg, cacheDir);
    await post(handle.url, { account: 'demo', stream: '1001', spec: 'drop@1s' });
    const res = await fetch(`${handle.url}/live/demo/demo/1001.ts`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    const first = performance.now();
    try {
      for (;;) if ((await reader.read()).done) break;
    } catch {
      // the drop resets the connection
    }
    const ms = performance.now() - first;
    expect(ms).toBeGreaterThanOrEqual(900);
    expect(ms).toBeLessThanOrEqual(3000);
    await vi.waitFor(() =>
      expect(handle.requests().at(-1)).toMatchObject({ fault: 'drop@1s', faultRule: 'r1' }),
    );
  }, 60_000);

  it('stalls a live stream by rule', async () => {
    const handle = await sim(ffmpeg, cacheDir);
    await post(handle.url, { account: 'demo', stream: '1001', spec: 'stall2s@1s' });
    const abort = new AbortController();
    const res = await fetch(`${handle.url}/live/demo/demo/1001.ts`, { signal: abort.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const started = performance.now();
    let last = started;
    let gap = 0;
    try {
      while (performance.now() - started < 4500) {
        const timer = setTimeout(
          () => abort.abort(),
          Math.max(1, 4500 - (performance.now() - started)),
        );
        const chunk = await reader.read();
        clearTimeout(timer);
        if (chunk.done) break;
        const now = performance.now();
        gap = Math.max(gap, now - last);
        last = now;
      }
    } catch {
      // aborted after the observation window
    }
    abort.abort();
    expect(Math.max(gap, performance.now() - last)).toBeGreaterThanOrEqual(1800);
  }, 60_000);
});
