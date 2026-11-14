import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, findAccount } from '../src/sim/accounts.ts';
import { buildCatalog, createCatalog } from '../src/sim/catalog.ts';
import { findFfmpeg, MEDIA_SKIP_MARKER } from '../src/sim/media.ts';
import { ALL_RECIPES } from '../src/sim/recipes.ts';
import { type SimHandle, startSim } from '../src/sim/server.ts';
import { removeCache } from './media-cache.ts';

const ffmpeg = findFfmpeg();
if (ffmpeg === null && process.env.CI === 'true') throw new Error('ffmpeg is required in CI');
const withFfmpeg = ffmpeg === null ? describe.skip : describe;
if (ffmpeg === null) process.stderr.write(`sim-corpus: ${MEDIA_SKIP_MARKER}\n`);

const GROUPS = [
  'Video codecs',
  'Audio codecs',
  'Frame rates',
  'Tracks and subtitles',
  'Edge cases',
];
const c = buildCatalog('corpus', 1);
const account = ACCOUNTS.find((a) => a.username === 'corpus');
const pair = `${account?.username}/${account?.password}`;

const open: SimHandle[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
});

async function sim(): Promise<SimHandle> {
  const handle = await startSim({
    port: 0,
    clock: new Date('2026-01-01T12:00:00Z'),
    ffmpegPath: null,
  });
  open.push(handle);
  return handle;
}

const api = async (h: SimHandle, params: string): Promise<unknown> =>
  (
    await fetch(
      `${h.url}/player_api.php?username=${account?.username}&password=${account?.password}&${params}`,
    )
  ).json();

describe('corpus catalog', () => {
  it('has the documented shape', () => {
    expect(c.live.map((x) => x.id)).toEqual(Array.from({ length: 13 }, (_, i) => 1001 + i));
    expect(c.movies.map((m) => m.id)).toEqual(Array.from({ length: 12 }, (_, i) => 200001 + i));
    expect(c.series.map((s) => [s.id, s.name])).toEqual([[300001, 'Subtitle Series']]);
    const eps = c.series[0]?.episodes ?? [];
    expect(eps.map((e) => [e.id, e.season, e.episode, e.ext])).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => [400000 + n, n <= 3 ? 1 : 2, ((n - 1) % 3) + 1, 'mkv']),
    );
    expect(eps[0]?.title).toBe('Subtitle Series S01E01');
    expect(c.categories.map((x) => [x.id, x.kind, x.name])).toEqual([
      ...GROUPS.map((n, i) => [String(i + 1), 'live', n]),
      ...GROUPS.map((n, i) => [String(10001 + i), 'vod', n]),
      ['20001', 'series', 'Tracks and subtitles'],
    ]);
    expect(c.guideWindow).toEqual({ daysBack: 2, daysForward: 7 });
    expect(
      c.live.every((x) => x.epgId === `ch${x.id}` && x.logo === x.id % 16 && x.archiveDays === 0),
    ).toBe(true);
  });

  it('lists every recipe once among fault-free channels and as a movie', () => {
    expect(
      c.live
        .filter((x) => x.fault === null)
        .map((x) => x.recipe)
        .sort(),
    ).toEqual([...ALL_RECIPES].sort());
    expect(c.live.slice(11).map((x) => [x.name, x.recipe, x.fault])).toEqual([
      ['Stream labelled as a web page', 'h264-aac-720p25', 'type=text/html'],
      ['Redirect to HLS', 'h264-aac-720p25', 'redirect=hls'],
    ]);
    const subs = c.movies.filter((m) => m.recipe === 'h264-2audio-subs-720p25').map((m) => m.ext);
    expect(subs).toEqual(['mp4', 'mkv']);
    expect(c.movies.filter((m) => m.ext === 'mkv')).toHaveLength(6);
    expect(c.movies.find((m) => m.recipe === 'h264-mp2-576p25')?.ext).toBe('mkv');
    expect(c.movies[0]).toMatchObject({
      name: 'H.264 720p25 AAC (MP4)',
      durationSec: 600,
      added: 1_700_000_000,
    });
    expect([...c.live, ...c.movies].every((x) => /^[A-Za-z0-9 .()-]+$/.test(x.name))).toBe(true);
  });

  it('is deterministic and resolves the account', () => {
    expect(JSON.stringify(createCatalog('corpus', 1))).toBe(
      JSON.stringify(createCatalog('corpus', 1)),
    );
    expect(findAccount('corpus', 'corpus')).toMatchObject({
      profile: 'corpus',
      maxConnections: 1,
      limitPolicy: 'status-509',
      status: 'Active',
      quirks: false,
    });
  });
});

describe('corpus routes', () => {
  it('serves the corpus playlist, API and guide', async () => {
    const h = await sim();
    const get = await fetch(
      `${h.url}/get.php?username=${account?.username}&password=${account?.password}&type=m3u_plus&output=ts`,
    );
    const text = await get.text();
    expect(text.split('\n').filter((l) => l.startsWith('#EXTINF'))).toHaveLength(31);
    expect(text).toContain('group-title="Edge cases"');
    expect((await fetch(`${h.url}/playlists/corpus.m3u`)).status).toBe(200);
    expect(await (await fetch(`${h.url}/guides/corpus.xml`)).text()).toMatch(/^<\?xml/);
    const cats = (await api(h, 'action=get_live_categories')) as { category_name: string }[];
    expect(cats.map((x) => x.category_name)).toEqual(GROUPS);
    const vod = (await api(h, 'action=get_vod_info&vod_id=200001')) as {
      info: { duration_secs: number };
    };
    expect(vod.info.duration_secs).toBe(600);
    const series = (await api(h, 'action=get_series_info&series_id=300001')) as {
      seasons: { season_number: number }[];
    };
    expect(series.seasons.map((s) => s.season_number)).toEqual([1, 2]);
  });

  it('redirects the HLS edge channel', async () => {
    const h = await sim();
    const res = await fetch(`${h.url}/live/${pair}/1013.ts`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${h.url}/live/${pair}/1013.m3u8`);
    const next = await fetch(`${h.url}/live/${pair}/1013.m3u8`, { redirect: 'manual' });
    expect(next.status).toBe(503);
  });
});

withFfmpeg('corpus routes with media', () => {
  let cacheDir = '';
  beforeAll(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'sim-corpus-'));
  });
  afterAll(() => removeCache(cacheDir));

  it('labels the web-page edge channel as HTML', async () => {
    const h = await startSim({ port: 0, mediaSeconds: 4, cacheDir, ffmpegPath: ffmpeg });
    open.push(h);
    const res = await fetch(`${h.url}/live/${pair}/1012.ts`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    const reader = res.body?.getReader();
    const chunk = await reader?.read();
    await reader?.cancel();
    expect(chunk?.value?.[0]).toBe(0x47);
  }, 60_000);
});
