import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS } from '../src/sim/accounts.ts';
import { buildCatalog } from '../src/sim/catalog.ts';
import { masterPlaylist, vodPlaylist } from '../src/sim/hls.ts';
import {
  ENCODER_SKIP_MARKER,
  ensureRecipe,
  findFfmpeg,
  MEDIA_SKIP_MARKER,
  missingEncoders,
} from '../src/sim/media.ts';
import { firstVideoPts } from '../src/sim/mpegts.ts';
import type { RecipeName } from '../src/sim/recipes.ts';
import { type SimHandle, startSim } from '../src/sim/server.ts';
import { streamLines } from './ffmpeg-probe.ts';

const ffmpeg = findFfmpeg();
if (ffmpeg === null && process.env.CI === 'true') throw new Error('ffmpeg is required in CI');
const withFfmpeg = ffmpeg === null ? describe.skip : describe;
if (ffmpeg === null) process.stderr.write(`sim-hls: ${MEDIA_SKIP_MARKER}\n`);

const corpus = ACCOUNTS.find((a) => a.username === 'corpus');
if (!corpus) throw new Error('corpus account missing');
const pair = `${corpus.username}/${corpus.password}`;
const r: RecipeName = 'h264-2audio-subs-720p25';
const PLAYLIST_TYPE = 'application/vnd.apple.mpegurl';

const open: SimHandle[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
});

const number = (text: string, tag: string): number =>
  Number(new RegExp(`#EXT-X-${tag}:(\\d+)`).exec(text)?.[1]);

/** Milliseconds of a WebVTT `hh:mm:ss.mmm` timestamp. */
function ms(stamp: string): number {
  const [h, m, s] = stamp.split(':').map(Number) as [number, number, number];
  return Math.round(((h * 60 + m) * 60 + s) * 1000);
}

describe('hls routes without media', () => {
  const start = async (): Promise<SimHandle> => {
    const sim = await startSim({ port: 0, ffmpegPath: null });
    open.push(sim);
    return sim;
  };

  it('answers 404 for unknown recipes and languages', async () => {
    const sim = await start();
    for (const path of [
      '/hls/nope/live.m3u8',
      '/hls/nope/vod.m3u8',
      '/hls/h264-aac-720p25/subs/tur/live.m3u8',
      `/hls/${r}/subs/deu/0.vtt`,
      `/hls/${r}/subs/deu/vod.m3u8`,
    ]) {
      expect((await fetch(`${sim.url}${path}`)).status, path).toBe(404);
    }
    for (const path of [`/hls/${r}/live.m3u8`, `/hls/${r}/subs/tur/0.vtt`]) {
      expect((await fetch(`${sim.url}${path}`)).status, path).toBe(503);
    }
  });

  it('applies rules and query faults to the VOD playlist', async () => {
    const sim = await start();
    await fetch(`${sim.url}/_sim/faults`, {
      method: 'POST',
      body: JSON.stringify({ account: corpus.username, stream: '200001', spec: 'status=404' }),
    });
    expect((await fetch(`${sim.url}/movie/${pair}/200001.m3u8`)).status).toBe(404);
    expect(sim.requests().at(-1)).toMatchObject({ faultRule: 'r1', streamId: 200001 });
    const teapot = await fetch(`${sim.url}/movie/${pair}/200002.m3u8?fault=status=418`);
    expect(teapot.status).toBe(418);
    expect((await fetch(`${sim.url}/series/${pair}/400001.m3u8`)).status).toBe(503);
    expect((await fetch(`${sim.url}/movie/${corpus.username}/x/200001.m3u8`)).status).toBe(401);
    expect((await fetch(`${sim.url}/movie/${pair}/999999.m3u8`)).status).toBe(404);
  });
});

withFfmpeg('hls with media', () => {
  let cacheDir = '';
  const opts = () => ({ ffmpeg: ffmpeg as string, cacheDir, seconds: 4 });
  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'sim-hls-'));
    await ensureRecipe(r, opts());
    await ensureRecipe('h264-aac-720p25', opts());
  }, 60_000);
  afterAll(() => rm(cacheDir, { recursive: true, force: true }));

  const start = async (): Promise<SimHandle> => {
    const sim = await startSim({
      port: 0,
      mediaSeconds: 4,
      cacheDir,
      ffmpegPath: ffmpeg,
      clock: new Date('2026-01-01T00:01:00Z'),
    });
    open.push(sim);
    return sim;
  };
  const text = async (sim: SimHandle, path: string): Promise<string> => {
    const res = await fetch(`${sim.url}${path}`);
    expect(res.status, path).toBe(200);
    return res.text();
  };
  const bytes = async (sim: SimHandle, path: string): Promise<Buffer> => {
    const res = await fetch(`${sim.url}${path}`);
    expect(res.status, path).toBe(200);
    return Buffer.from(await res.arrayBuffer());
  };
  const mpegtsOf = (vtt: string): number =>
    Number(/^X-TIMESTAMP-MAP=MPEGTS:(\d+),/m.exec(vtt)?.[1]);

  it('the subtitle recipe files carry both languages', async () => {
    const files = await ensureRecipe(r, opts());
    const lang = (line: string): string | undefined => /\((\w{3})\)/.exec(line)?.[1];
    const mkv = streamLines(ffmpeg as string, files.vodMkv);
    const audio = mkv.filter((l) => /Audio: aac/.test(l));
    const subs = mkv.filter((l) => /Subtitle: subrip/.test(l));
    expect(audio.map(lang)).toEqual(['tur', 'eng']);
    expect(subs.map(lang)).toEqual(['tur', 'eng']);
    expect(audio[0]).toContain('(default)');
    expect(audio[1]).not.toContain('(default)');
    expect(subs.some((l) => l.includes('(default)'))).toBe(false);
    const mp4 = streamLines(ffmpeg as string, files.vodMp4);
    expect(mp4.filter((l) => /Subtitle: mov_text/.test(l)).map(lang)).toEqual(['tur', 'eng']);
    for (const file of [files.vodMp4, files.vodMkv]) {
      const content = readFileSync(file).toString('latin1');
      expect(content).toContain('TUR 00:01');
      expect(content).toContain('ENG 00:01');
    }
    expect(readdirSync(dirname(files.loopTs)).filter((f) => f.endsWith('.srt'))).toEqual([]);
    expect(files.durations).toEqual([2, 2]);
  }, 60_000);

  it('the live channel and the movies answer master playlists', async () => {
    const catalog = buildCatalog('corpus', 1);
    expect(catalog.live.find((c) => c.id === 1010)?.recipe).toBe(r);
    expect(catalog.movies.find((m) => m.id === 200010)?.recipe).toBe(r);
    const sim = await start();
    const live = await fetch(`${sim.url}/live/${pair}/1010.m3u8`);
    expect(live.headers.get('content-type')).toBe(PLAYLIST_TYPE);
    expect(await live.text()).toBe(masterPlaylist(r, 'live'));
    for (const path of [`/movie/${pair}/200010.m3u8`, `/series/${pair}/400001.m3u8`]) {
      const res = await fetch(`${sim.url}${path}`);
      expect(res.headers.get('content-type'), path).toBe(PLAYLIST_TYPE);
      expect(await res.text(), path).toBe(masterPlaylist(r, 'vod'));
    }
    const html = await fetch(`${sim.url}/live/${pair}/1010.m3u8?fault=type=text/html`);
    expect(html.headers.get('content-type')).toBe('text/html');
    expect(await html.text()).toBe(masterPlaylist(r, 'live'));
    const plain = await fetch(`${sim.url}/movie/${pair}/200010.m3u8?fault=type=text/plain`);
    expect(plain.headers.get('content-type')).toBe('text/plain');
    expect(await plain.text()).toBe(masterPlaylist(r, 'vod'));
    expect(sim.requests().every((e) => e.openConnections === 0)).toBe(true);
  }, 60_000);

  it('subtitle playlists follow the video window', async () => {
    const sim = await start();
    const [video, subs] = await Promise.all([
      text(sim, `/hls/${r}/live.m3u8`),
      text(sim, `/hls/${r}/subs/tur/live.m3u8`),
    ]);
    expect(number(video, 'MEDIA-SEQUENCE')).toBe(30);
    expect(number(subs, 'MEDIA-SEQUENCE')).toBe(30);
    expect(number(subs, 'DISCONTINUITY-SEQUENCE')).toBe(number(video, 'DISCONTINUITY-SEQUENCE'));
    expect(video).toContain('#EXT-X-DISCONTINUITY\n');
    const videoLines = video.split('\n');
    const subLines = subs.split('\n');
    expect(subLines).toHaveLength(videoLines.length);
    for (const [i, line] of videoLines.entries()) {
      if (line.startsWith('#') || line === '') expect(subLines[i]).toBe(line);
      else expect(subLines[i]).toBe(line.replace(/\/(\d+)\.ts$/, '/subs/tur/$1.vtt'));
    }
    const [vodVideo, vodSubs] = await Promise.all([
      text(sim, `/hls/${r}/vod.m3u8`),
      text(sim, `/hls/${r}/subs/eng/vod.m3u8`),
    ]);
    const extinf = (t: string): string[] => t.split('\n').filter((l) => l.startsWith('#EXTINF'));
    expect(extinf(vodSubs)).toEqual(extinf(vodVideo));
    expect(extinf(vodVideo)).toHaveLength(2);
    expect(vodVideo.endsWith('#EXT-X-ENDLIST\n')).toBe(true);
    expect(vodSubs.endsWith('#EXT-X-ENDLIST\n')).toBe(true);
    expect(vodSubs).toContain(`\n/hls/${r}/subs/eng/1.vtt\n`);
  }, 60_000);

  it('cues line up with the video PTS', async () => {
    const sim = await start();
    const first = firstVideoPts(await bytes(sim, `/hls/${r}/0.ts`)) as number;
    for (const i of [0, 1]) {
      const res = await fetch(`${sim.url}/hls/${r}/subs/tur/${i}.vtt`);
      expect(res.headers.get('content-type')).toBe('text/vtt');
      const vtt = await res.text();
      const pts = firstVideoPts(await bytes(sim, `/hls/${r}/${i}.ts`)) as number;
      const local = /,LOCAL:(\S+)$/m.exec(vtt)?.[1] ?? '';
      const cue = /^(\S+) --> \S+\n(.+)$/m.exec(vtt);
      const mapped = mpegtsOf(vtt) + (ms(cue?.[1] ?? '') - ms(local)) * 90;
      expect(Math.abs(mapped - pts)).toBeLessThanOrEqual(9000);
      expect(Math.abs((pts - first) / 90 - 2000 * i)).toBeLessThanOrEqual(100);
      expect(cue?.[2]).toBe(`TUR 00:0${2 * i}`);
    }
  }, 60_000);

  it("subtitle segments past the loop reuse the wrapped segment's PTS", async () => {
    const sim = await start();
    const five = await text(sim, `/hls/${r}/subs/tur/5.vtt`);
    expect(five).toBe(await text(sim, `/hls/${r}/subs/tur/1.vtt`));
    expect(mpegtsOf(five)).toBe(firstVideoPts(await bytes(sim, `/hls/${r}/5.ts`)));
    expect(mpegtsOf(five)).not.toBe(firstVideoPts(await bytes(sim, `/hls/${r}/4.ts`)));
  }, 60_000);

  it('VOD playlists list every segment', async () => {
    const sim = await start();
    const files = await ensureRecipe('h264-aac-720p25', opts());
    const res = await fetch(`${sim.url}/movie/${pair}/200001.m3u8`);
    expect(res.headers.get('content-type')).toBe(PLAYLIST_TYPE);
    expect(await res.text()).toBe(
      vodPlaylist(files.durations, (i) => `/hls/h264-aac-720p25/${i}.ts`),
    );
    const mp3: RecipeName = 'h264-mp3-720p30';
    const missing = missingEncoders(ffmpeg as string, mp3);
    if (missing.length > 0) {
      if (process.env.CI === 'true') throw new Error(`FFmpeg lacks ${missing.join(' ')}`);
      process.stderr.write(`sim-hls: ${ENCODER_SKIP_MARKER}: ${mp3}\n`);
      return;
    }
    expect(await text(sim, `/hls/${mp3}/vod.m3u8`)).toContain('#EXTINF:2.002,');
    const mp3Files = await ensureRecipe(mp3, opts());
    expect(mp3Files.durations).toHaveLength(mp3Files.segmentCount);
    expect(mp3Files.durations[0]).toBe(2.002);
    expect(mp3Files.segmentSec).toBe(2);
    expect(await text(sim, `/hls/${mp3}/live.m3u8`)).not.toContain('2.002');
  }, 60_000);
});
