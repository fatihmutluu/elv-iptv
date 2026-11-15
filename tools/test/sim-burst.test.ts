import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, type Account } from '../src/sim/accounts.ts';
import { buildCatalog } from '../src/sim/catalog.ts';
import { activeChildren, ensureRecipe, findFfmpeg, MEDIA_SKIP_MARKER } from '../src/sim/media.ts';
import { type SimHandle, startSim } from '../src/sim/server.ts';
import { removeCache } from './media-cache.ts';

const ffmpeg = findFfmpeg();
if (ffmpeg === null && process.env.CI === 'true') {
  throw new Error('ffmpeg is required in CI');
}
const withFfmpeg = ffmpeg === null ? describe.skip : describe;
if (ffmpeg === null) process.stderr.write(`sim-burst: ${MEDIA_SKIP_MARKER}\n`);

const MEDIA_SECONDS = 10;
const WINDOW_MS = 2000;

function account(name: string): Account {
  const found = ACCOUNTS.find((a) => a.username === name);
  if (!found) throw new Error(`account ${name} missing`);
  return found;
}
const demoAccount = account('demo');
const demo = `${demoAccount.username}/${demoAccount.password}`;

interface Sample {
  status: number;
  /** Body bytes within `WINDOW_MS` of the first body byte. */
  early: number;
  /** Milliseconds from the first body byte to the end of the body (error or end), or null if it ran on. */
  endedAfter: number | null;
}

/** Reads a streaming response for `totalMs` after its first body byte. */
async function sample(url: string, totalMs: number): Promise<Sample> {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no body');
  let first: number | null = null;
  let early = 0;
  let endedAfter: number | null = null;
  try {
    for (;;) {
      const left = first === null ? 30_000 : first + totalMs - Date.now();
      if (left <= 0) break;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), left);
      });
      const next = await Promise.race([reader.read(), timeout]).catch(() => 'failed' as const);
      clearTimeout(timer);
      if (next === 'timeout') break;
      const now = Date.now();
      if (next === 'failed' || next.done) {
        endedAfter = first === null ? 0 : now - first;
        break;
      }
      first ??= now;
      if (now - first <= WINDOW_MS) early += next.value.length;
    }
  } finally {
    controller.abort();
  }
  return { status: res.status, early, endedAfter };
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

withFfmpeg('live burst', () => {
  let cacheDir = '';
  let sixSeconds = 0;
  let sim: SimHandle;
  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'sim-burst-'));
    const channel = buildCatalog(demoAccount.profile, 1).live.find((c) => c.id === 1001);
    if (!channel) throw new Error('channel 1001 missing');
    const files = await ensureRecipe(channel.recipe, {
      ffmpeg: ffmpeg as string,
      cacheDir,
      seconds: MEDIA_SECONDS,
    });
    sixSeconds = (statSync(files.loopTs).size * 6) / MEDIA_SECONDS;
    sim = await startSim({ port: 0, mediaSeconds: MEDIA_SECONDS, cacheDir, ffmpegPath: ffmpeg });
  }, 120_000);
  afterEach(() => waitFor(() => activeChildren() === 0));
  afterAll(async () => {
    await sim?.close();
    await removeCache(cacheDir);
  });

  it('a burst of 8 s arrives within 2 s', async () => {
    const got = await sample(`${sim.url}/live/${demo}/1001.ts?fault=burst=8`, WINDOW_MS + 200);
    expect(got.status).toBe(200);
    expect(got.endedAfter).toBeNull();
    expect(got.early).toBeGreaterThanOrEqual(sixSeconds);
  }, 30_000);

  it('without a burst the stream stays real time', async () => {
    const got = await sample(`${sim.url}/live/${demo}/1001.ts`, WINDOW_MS + 200);
    expect(got.status).toBe(200);
    expect(got.early).toBeGreaterThan(0);
    expect(got.early).toBeLessThan(sixSeconds);
  }, 30_000);

  it('combines with a drop', async () => {
    const got = await sample(`${sim.url}/live/${demo}/1001.ts?fault=drop@5s,burst=8`, 9000);
    expect(got.status).toBe(200);
    expect(got.early).toBeGreaterThanOrEqual(sixSeconds);
    expect(got.endedAfter).not.toBeNull();
    expect(got.endedAfter).toBeGreaterThanOrEqual(4500);
    expect(got.endedAfter).toBeLessThan(8000);
  }, 30_000);

  it('a runtime rule carries the burst to live TS', async () => {
    const added = await fetch(`${sim.url}/_sim/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'demo', stream: '1001', spec: 'burst=8', count: 1 }),
    });
    expect(added.status).toBe(201);
    const got = await sample(`${sim.url}/live/${demo}/1001.ts`, WINDOW_MS + 200);
    expect(got.status).toBe(200);
    expect(got.early).toBeGreaterThanOrEqual(sixSeconds);
    await waitFor(() => sim.requests().some((r) => r.faultRule !== null));
  }, 30_000);

  it('playlists and movies ignore the burst', async () => {
    const playlist = await fetch(`${sim.url}/live/${demo}/1001.m3u8?fault=burst=8`);
    expect(playlist.status).toBe(200);
    expect(await playlist.text()).toContain('#EXTM3U');
    const movie = await fetch(`${sim.url}/movie/${demo}/200001.mp4?fault=burst=8`, {
      headers: { range: 'bytes=0-15' },
    });
    expect(movie.status).toBe(206);
    expect((await movie.arrayBuffer()).byteLength).toBe(16);
  }, 60_000);
});
