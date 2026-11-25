import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { EngineEvent } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  errors,
  live,
  loadfiles,
  playing,
  type SetupOptions,
  setupEngineTest,
  URL_A,
  URL_VOD,
  VOD,
} from './engine-test-helpers.ts';
import { type FakeMpvScript, fakeHttpError } from './mpv/fake-mpv.ts';
import { resolveVodCacheRoot } from './mpv/vod-cache.ts';

const GIB = 1024 * 1024 * 1024;
const URL_VOD_2 = 'http://sim.test/movie/demo/demo/200002.mp4';
const URL_VOD_THROTTLE = 'http://sim.test/movie/demo/demo/200003.mp4';

const VOD_WITH_CACHE: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  { afterMs: 3, event: 'file-loaded' },
  { afterMs: 3, property: 'duration', value: 600 },
  {
    afterMs: 4,
    property: 'demuxer-cache-state',
    value: { 'seekable-ranges': [{ start: 2, end: 72.5 }] },
  },
  { afterMs: 4, property: 'video-params', value: { w: 1280, h: 720 } },
  { afterMs: 6, property: 'time-pos', value: 12.5 },
  { afterMs: 6, event: 'playback-restart' },
];

const cleanups: Array<() => Promise<void>> = [];
const tempDirs: string[] = [];

function makeCacheRoot(): string {
  const base = mkdtempSync(join(tmpdir(), 'elv-f10-engine-test-'));
  tempDirs.push(base);
  return resolveVodCacheRoot(base);
}

afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanups.splice(0)) await c();
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

const setup = (o: SetupOptions = {}) => setupEngineTest(cleanups, o);

function loadOptsAt(fake: Parameters<typeof loadfiles>[0], index: number): Record<string, string> {
  const opts = loadfiles(fake)[index]?.[4];
  if (typeof opts !== 'object' || opts === null) throw new Error(`missing loadfile[${index}] opts`);
  return opts as Record<string, string>;
}

function requireDir(value: string | undefined, label: string): string {
  if (!value) throw new Error(`missing ${label}`);
  return value;
}

describe('Wave F10 desktop mpv VOD cache & throttle integration (#350)', () => {
  it('enables ephemeral VOD disk cache, avoids live readahead clobber, emits bufferHealth, and cleans up across load/live/stop/release', async () => {
    const vodCacheRoot = makeCacheRoot();
    const { engine, fake, events } = await setup({
      scripts: { [URL_VOD]: VOD_WITH_CACHE, [URL_VOD_2]: VOD },
      vodCacheRoot,
      getDeviceRamBytes: () => 8 * GIB,
      readFreeDiskBytes: () => 20 * GIB,
    });

    engine.load({
      attempt: 1,
      url: URL_VOD,
      headers: {},
      kind: 'vod',
      options: { bufferPreset: 'large' },
    });
    await playing(events, 1);

    const vodLoad = loadOptsAt(fake, 0);
    expect(vodLoad['cache-on-disk']).toBe('yes');
    expect(vodLoad['demuxer-readahead-secs']).toBe('240');
    expect(vodLoad['demuxer-hysteresis-secs']).toBe('10');
    const dir1 = requireDir(vodLoad['demuxer-cache-dir'], 'dir1');
    expect(basename(dir1).startsWith('s-')).toBe(true);
    expect(existsSync(dir1)).toBe(true);

    // Live readahead controller must NOT clobber VOD demuxer-readahead-secs to 2s
    expect(
      fake.sent.some(
        (c) => c[0] === 'set_property' && c[1] === 'demuxer-readahead-secs' && c[2] === 2,
      ),
    ).toBe(false);

    // VOD ClockAnchor carries bufferHealth
    const vodClock = events.find(
      (e): e is Extract<EngineEvent, { type: 'clock' }> =>
        e.type === 'clock' && e.attempt === 1 && e.anchor.bufferHealth !== undefined,
    );
    expect(vodClock?.anchor.bufferHealth).toEqual({
      bufferedAheadMs: 60_000,
      bufferedBehindMs: 10_500,
    });

    // Loading a second VOD cleans up dir1 and allocates a fresh dir2
    engine.load({
      attempt: 2,
      url: URL_VOD_2,
      headers: {},
      kind: 'vod',
      options: { bufferPreset: 'auto' },
    });
    await playing(events, 2);
    const vodLoad2 = loadOptsAt(fake, 1);
    const dir2 = requireDir(vodLoad2['demuxer-cache-dir'], 'dir2');
    expect(dir2).not.toBe(dir1);
    expect(existsSync(dir1)).toBe(false);
    expect(existsSync(dir2)).toBe(true);

    // Switching to live cleans up dir2 and forces cache-on-disk=no
    engine.load(live(3, URL_A));
    await playing(events, 3);
    expect(existsSync(dir2)).toBe(false);
    const liveLoad = loadOptsAt(fake, 2);
    expect(liveLoad['cache-on-disk']).toBe('no');
    expect(liveLoad).not.toHaveProperty('demuxer-cache-dir');

    // Reload VOD then stop -> session dir purged
    engine.load({ attempt: 4, url: URL_VOD_2, headers: {}, kind: 'vod' });
    await playing(events, 4);
    const dir3 = requireDir(loadOptsAt(fake, 3)['demuxer-cache-dir'], 'dir3');
    expect(existsSync(dir3)).toBe(true);

    engine.stop(5);
    await vi.waitFor(() => expect(existsSync(dir3)).toBe(false), { interval: 5 });

    // Reload VOD then recreate -> session dir purged
    engine.load({ attempt: 6, url: URL_VOD_2, headers: {}, kind: 'vod' });
    await playing(events, 6);
    const dir4 = requireDir(loadOptsAt(fake, 4)['demuxer-cache-dir'], 'dir4');
    expect(existsSync(dir4)).toBe(true);

    engine.recreate(7);
    await vi.waitFor(() => expect(existsSync(dir4)).toBe(false), { interval: 5 });

    // Reload VOD then release -> session dir purged
    engine.load({ attempt: 8, url: URL_VOD_2, headers: {}, kind: 'vod' });
    await playing(events, 8);
    const dir5 = requireDir(loadOptsAt(fake, 5)['demuxer-cache-dir'], 'dir5');
    expect(existsSync(dir5)).toBe(true);

    engine.release();
    await vi.waitFor(() => expect(existsSync(dir5)).toBe(false), { interval: 5 });
    expect(readdirSync(vodCacheRoot)).toEqual([]);
  });

  it('escalates VOD throttle backoff on 429/509 errors and disables disk cache at level >= 2', async () => {
    const vodCacheRoot = makeCacheRoot();
    const { engine, fake, events } = await setup({
      scripts: { [URL_VOD_THROTTLE]: fakeHttpError(429, 'Too Many Requests') },
      vodCacheRoot,
      getDeviceRamBytes: () => 8 * GIB,
      readFreeDiskBytes: () => 20 * GIB,
    });

    // Attempt 1: initial VOD load has disk cache enabled, hits 429 -> backoff 0 -> 1
    engine.load({
      attempt: 1,
      url: URL_VOD_THROTTLE,
      headers: {},
      kind: 'vod',
      options: { bufferPreset: 'balanced' },
    });
    await vi.waitFor(() => expect(errors(events)).toHaveLength(1));
    const opts1 = loadOptsAt(fake, 0);
    expect(opts1['cache-on-disk']).toBe('yes');
    const secs1 = Number(opts1['demuxer-readahead-secs']);

    // Attempt 2 (retry): backoff 1 halves readahead secs, hits 429 again -> backoff 1 -> 2
    engine.retry(2);
    await vi.waitFor(() => expect(errors(events)).toHaveLength(2));
    const opts2 = loadOptsAt(fake, 1);
    expect(opts2['cache-on-disk']).toBe('yes');
    expect(Number(opts2['demuxer-readahead-secs'])).toBeLessThan(secs1);

    // Attempt 3 (retry): backoff 2 disables disk cache completely
    engine.retry(3);
    await vi.waitFor(() => expect(errors(events)).toHaveLength(3));
    const opts3 = loadOptsAt(fake, 2);
    expect(opts3['cache-on-disk']).toBe('no');
    expect(opts3).not.toHaveProperty('demuxer-cache-dir');
  });

  it('retires previous VOD cache dir without deleting before end-file and sweeps unconditionally when inactive (stop / zap)', async () => {
    const vodCacheRoot = makeCacheRoot();
    const { engine, fake, events } = await setup({
      scripts: { [URL_VOD]: VOD_WITH_CACHE, [URL_VOD_2]: VOD },
      vodCacheRoot,
      getDeviceRamBytes: () => 8 * GIB,
      readFreeDiskBytes: () => 20 * GIB,
    });

    engine.load({ attempt: 1, url: URL_VOD, headers: {}, kind: 'vod' });
    await playing(events, 1);
    const dir1 = requireDir(loadOptsAt(fake, 0)['demuxer-cache-dir'], 'dir1');
    expect(existsSync(dir1)).toBe(true);

    // Delay mpv's end-file so we can verify dir1 is NOT deleted while mpv still holds it open!
    fake.endDelayMs = 60;
    engine.load({ attempt: 2, url: URL_VOD_2, headers: {}, kind: 'vod' });
    await vi.waitFor(() => expect(loadfiles(fake)).toHaveLength(2), { interval: 5 });
    // Right when loadfile #2 was sent (before entry #1 emitted end-file), dir1 MUST still exist!
    expect(existsSync(dir1)).toBe(true);

    // Once entry #1 emits end-file (even though isActive is false because media is slot 2), dir1 is swept!
    await playing(events, 2);
    expect(existsSync(dir1)).toBe(false);
    const dir2 = requireDir(loadOptsAt(fake, 1)['demuxer-cache-dir'], 'dir2');
    expect(existsSync(dir2)).toBe(true);

    // Same invariant on stop(): dir2 must NOT be deleted before mpv emits end-file, then swept on end-file!
    const beforeStop = fake.sent.length;
    engine.stop(3);
    await vi.waitFor(() => expect(fake.sent.slice(beforeStop)).toContainEqual(['stop']), {
      interval: 5,
    });
    expect(existsSync(dir2)).toBe(true);
    await vi.waitFor(() => expect(existsSync(dir2)).toBe(false), { interval: 5 });
    expect(readdirSync(vodCacheRoot)).toEqual([]);
  });

  it('retires Episode 1 cache dir on gapless queueNext advance and passes VOD readahead to Episode 2', async () => {
    const ep1Eof: FakeMpvScript = [
      { afterMs: 0, event: 'start-file' },
      { afterMs: 3, event: 'file-loaded' },
      { afterMs: 4, property: 'duration', value: 600 },
      { afterMs: 5, property: 'video-params', value: { w: 1280, h: 720 } },
      { afterMs: 6, property: 'time-pos', value: 12.5 },
      { afterMs: 6, event: 'playback-restart' },
      { afterMs: 40, event: 'end-file', reason: 'eof' },
    ];
    const vodCacheRoot = makeCacheRoot();
    const { engine, fake, events } = await setup({
      scripts: { [URL_VOD]: ep1Eof, [URL_VOD_2]: VOD },
      vodCacheRoot,
      getDeviceRamBytes: () => 8 * GIB,
      readFreeDiskBytes: () => 20 * GIB,
    });

    // Run a live stream first so live readahead sets demuxer-readahead-secs=2 globally
    engine.load(live(1, URL_A));
    await playing(events, 1);

    const advanced: string[] = [];
    engine.onQueueAdvanced((k) => advanced.push(k));

    engine.load({
      attempt: 2,
      url: URL_VOD,
      headers: {},
      kind: 'vod',
      options: { bufferPreset: 'large' },
    });
    await playing(events, 2);
    const ep1Dir = requireDir(loadOptsAt(fake, 1)['demuxer-cache-dir'], 'ep1Dir');
    expect(existsSync(ep1Dir)).toBe(true);

    engine.queueNext({
      itemKey: 'series:ep2',
      stream: { url: URL_VOD_2, headers: {} },
    });

    await vi.waitFor(() => expect(advanced).toEqual(['series:ep2']), { interval: 5 });
    const ep2Opts = loadOptsAt(fake, 2);
    // Episode 2 must have explicit VOD demuxer-readahead-secs (NOT inherit live's 2s!)
    expect(ep2Opts['demuxer-readahead-secs']).toBe('240');
    // Episode 1 cache dir is retired and swept on Episode 1's end-file
    await vi.waitFor(() => expect(existsSync(ep1Dir)).toBe(false), { interval: 5 });

    // Stopping Episode 2 sweeps Episode 2's cache dir cleanly as well
    engine.stop(3);
    await vi.waitFor(() => expect(readdirSync(vodCacheRoot)).toEqual([]), { interval: 5 });
  });

  it('disables VOD disk caching and creates zero cache dirs in Multi-View (tileCount >= 2)', async () => {
    const vodCacheRoot = makeCacheRoot();
    let tileCount = 2;
    const { engine, fake, events } = await setup({
      scripts: { [URL_VOD]: VOD_WITH_CACHE, [URL_VOD_2]: VOD },
      vodCacheRoot,
      getDeviceRamBytes: () => 8 * GIB,
      readFreeDiskBytes: () => 20 * GIB,
      getMultiViewTileCount: () => tileCount,
    });

    engine.load({
      attempt: 1,
      url: URL_VOD,
      headers: {},
      kind: 'vod',
      options: { bufferPreset: 'large' },
    });
    await playing(events, 1);

    const mvOpts = loadOptsAt(fake, 0);
    expect(mvOpts['cache-on-disk']).toBe('no');
    expect(mvOpts).not.toHaveProperty('demuxer-cache-dir');
    expect(existsSync(vodCacheRoot)).toBe(false);

    // Exiting Multi-View (tileCount back to 1) re-enables disk caching on next VOD load
    tileCount = 1;
    engine.load({
      attempt: 2,
      url: URL_VOD_2,
      headers: {},
      kind: 'vod',
      options: { bufferPreset: 'large' },
    });
    await playing(events, 2);
    const singleOpts = loadOptsAt(fake, 1);
    expect(singleOpts['cache-on-disk']).toBe('yes');
    expect(existsSync(requireDir(singleOpts['demuxer-cache-dir'], 'singleDir'))).toBe(true);
  });

  it('decays throttle backoff after 120s of healthy VOD playback in MpvEngine and re-enables disk cache', async () => {
    const vodCacheRoot = makeCacheRoot();
    const urlRecovered = `${URL_VOD_THROTTLE}?recovered=1`;
    let clockMs = 1_000;
    const healthyScript: FakeMpvScript = [
      { afterMs: 0, event: 'start-file' },
      { afterMs: 3, event: 'file-loaded' },
      { afterMs: 4, property: 'duration', value: 600 },
      { afterMs: 5, property: 'video-params', value: { w: 1280, h: 720 } },
      { afterMs: 6, property: 'time-pos', value: 10 },
      { afterMs: 6, event: 'playback-restart' },
      { afterMs: 45, property: 'time-pos', value: 11 },
    ];
    const { engine, fake, events } = await setup({
      scripts: {
        [URL_VOD_THROTTLE]: fakeHttpError(429, 'Too Many Requests'),
        [urlRecovered]: healthyScript,
      },
      vodCacheRoot,
      now: () => clockMs,
      getDeviceRamBytes: () => 8 * GIB,
      readFreeDiskBytes: () => 20 * GIB,
    });

    // Two 429 failures push canonical stream fingerprint backoff to level 2
    engine.load({ attempt: 1, url: URL_VOD_THROTTLE, headers: {}, kind: 'vod' });
    await vi.waitFor(() => expect(errors(events)).toHaveLength(1));
    engine.retry(2);
    await vi.waitFor(() => expect(errors(events)).toHaveLength(2));

    // Attempt 3 on same canonical stream starts with disk cache disabled (backoff = 2)
    engine.load({ attempt: 3, url: urlRecovered, headers: {}, kind: 'vod' });
    await playing(events, 3);
    expect(loadOptsAt(fake, 2)['cache-on-disk']).toBe('no');

    // Advance monotonic clock past the 120s healthy decay window before the second time-pos arrives
    clockMs += 125_000;
    await vi.waitFor(
      () =>
        expect(
          events.filter((e) => e.type === 'clock' && e.attempt === 3).length,
        ).toBeGreaterThanOrEqual(2),
      { interval: 5 },
    );

    // Next load on the same stream sees decayed backoff (level 1) -> disk cache re-enabled!
    engine.load({ attempt: 4, url: urlRecovered, headers: {}, kind: 'vod' });
    await playing(events, 4);
    expect(loadOptsAt(fake, 3)['cache-on-disk']).toBe('yes');
    expect(loadOptsAt(fake, 3)['demuxer-cache-dir']).toBeTruthy();
  });
});
