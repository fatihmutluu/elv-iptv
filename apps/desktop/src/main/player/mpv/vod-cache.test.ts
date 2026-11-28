import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { computeVodBufferBudget, VOD_MAX_THROTTLE_BACKOFF } from '@elv/playback';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildVodMpvLoadOptions,
  createVodCacheCoordinator,
  createVodCacheSession,
  createVodThrottleTracker,
  purgeOrphanedVodCacheDirs,
  readFreeDiskBytes,
  resolveVodCacheRoot,
} from './vod-cache.ts';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elv-vod-cache-test-'));
  tempDirs.push(dir);
  return dir;
}

function parseMpvBytes(value: string | undefined): number {
  if (!value) return Number.NaN;
  const mib = /^(\d+)MiB$/.exec(value);
  if (mib) return Number(mib[1]) * MIB;
  const kib = /^(\d+)KiB$/.exec(value);
  if (kib) return Number(kib[1]) * 1024;
  return Number(value);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore test cleanup errors
    }
  }
});

describe('resolveVodCacheRoot', () => {
  it('joins provided sandbox-safe base dir with elv-vod-cache', () => {
    const base = makeTempDir();
    expect(resolveVodCacheRoot(base)).toBe(join(base, 'elv-vod-cache'));
  });

  it('falls back to os.tmpdir() when base dir is omitted or blank', () => {
    expect(resolveVodCacheRoot()).toBe(join(tmpdir(), 'elv-vod-cache'));
    expect(resolveVodCacheRoot('   ')).toBe(join(tmpdir(), 'elv-vod-cache'));
  });
});

describe('purgeOrphanedVodCacheDirs', () => {
  it('removes stale s-* session directories while preserving unrelated entries', () => {
    const base = makeTempDir();
    const cacheRoot = resolveVodCacheRoot(base);
    const orphan1 = join(cacheRoot, 's-11111111-1111-4111-8111-111111111111');
    const orphan2 = join(cacheRoot, 's-22222222-2222-4222-8222-222222222222');
    const keepDir = join(cacheRoot, 'keep-other');
    mkdirSync(orphan1, { recursive: true });
    mkdirSync(orphan2, { recursive: true });
    mkdirSync(keepDir, { recursive: true });
    writeFileSync(join(orphan1, 'cache.bin'), Buffer.alloc(64));
    writeFileSync(join(keepDir, 'marker.txt'), 'ok');

    const removed = purgeOrphanedVodCacheDirs(cacheRoot);

    expect(removed).toBe(2);
    expect(existsSync(orphan1)).toBe(false);
    expect(existsSync(orphan2)).toBe(false);
    expect(existsSync(keepDir)).toBe(true);
  });

  it('never throws when cacheRoot does not exist', () => {
    const missing = join(makeTempDir(), 'does-not-exist', 'elv-vod-cache');
    expect(() => purgeOrphanedVodCacheDirs(missing)).not.toThrow();
    expect(purgeOrphanedVodCacheDirs(missing)).toBe(0);
  });
});

describe('readFreeDiskBytes', () => {
  it('returns positive finite bytes for an existing directory and its not-yet-created child', () => {
    const base = makeTempDir();
    const direct = readFreeDiskBytes(base);
    expect(typeof direct).toBe('number');
    expect(direct).toBeGreaterThan(0);

    const child = resolveVodCacheRoot(base);
    expect(existsSync(child)).toBe(false);
    const viaParent = readFreeDiskBytes(child);
    expect(typeof viaParent).toBe('number');
    expect(viaParent).toBeGreaterThan(0);
  });

  it('returns undefined cleanly when statfs fails or path is invalid', () => {
    const missing = join(makeTempDir(), 'missing-a', 'missing-b');
    expect(readFreeDiskBytes(missing)).toBeUndefined();
    expect(
      readFreeDiskBytes(makeTempDir(), () => {
        throw new Error('EPERM');
      }),
    ).toBeUndefined();
  });
});

describe('createVodCacheSession', () => {
  it('returns null when budget disallows disk cache or maxDiskBytes is 0', () => {
    const cacheRoot = resolveVodCacheRoot(makeTempDir());
    const liveBudget = computeVodBufferBudget({
      kind: 'live',
      deviceRamBytes: 8 * GIB,
      freeDiskBytes: 20 * GIB,
    });
    expect(createVodCacheSession({ cacheRoot, budget: liveBudget })).toBeNull();

    const noDiskBudget = computeVodBufferBudget({
      kind: 'vod',
      deviceRamBytes: 8 * GIB,
      freeDiskBytes: 100 * MIB,
    });
    expect(createVodCacheSession({ cacheRoot, budget: noDiskBudget })).toBeNull();
  });

  it('creates an opaque s-* session dir, measures used bytes, and cleans up idempotently', () => {
    const cacheRoot = resolveVodCacheRoot(makeTempDir());
    const budget = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'auto',
      deviceRamBytes: 8 * GIB,
      freeDiskBytes: 20 * GIB,
    });
    const session = createVodCacheSession({
      cacheRoot,
      budget,
      sessionId: 'https://user:pass@secret.example/movie.mp4?token=abc',
    });
    expect(session).not.toBeNull();
    if (!session) return;

    const dirName = basename(session.dir);
    expect(dirName.startsWith('s-')).toBe(true);
    expect(session.dir).not.toContain('secret.example');
    expect(session.dir).not.toContain('pass');
    expect(session.dir).not.toContain('token');
    expect(existsSync(session.dir)).toBe(true);
    expect(session.maxDiskBytes).toBe(budget.maxDiskBytes);
    expect(session.readUsedBytes()).toBe(0);

    mkdirSync(join(session.dir, 'nested'), { recursive: true });
    writeFileSync(join(session.dir, 'chunk1.dat'), Buffer.alloc(1024));
    writeFileSync(join(session.dir, 'nested', 'chunk2.dat'), Buffer.alloc(512));
    expect(session.readUsedBytes()).toBe(1536);

    session.cleanup();
    expect(existsSync(session.dir)).toBe(false);
    expect(session.readUsedBytes()).toBe(0);
    expect(() => session.cleanup()).not.toThrow();
  });
});

describe('buildVodMpvLoadOptions', () => {
  it('never enables VOD disk cache on live streams even if cacheDir and free disk are provided', () => {
    const opts = buildVodMpvLoadOptions({
      kind: 'live',
      bufferPreset: 'large',
      deviceRamBytes: 16 * GIB,
      freeDiskBytes: 50 * GIB,
      cacheDir: '/some/cache/s-1234',
    });
    expect(opts).toEqual({
      'cache-on-disk': 'no',
      'demuxer-max-bytes': '32MiB',
      'demuxer-max-back-bytes': '128MiB',
    });
    expect(opts).not.toHaveProperty('demuxer-cache-dir');
  });

  it('enables disk cache and scales mpv options within budget for VOD when disk cache is allowed', () => {
    const cacheDir = join(makeTempDir(), 's-abc');
    const budget = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'large',
      deviceRamBytes: 8 * GIB,
      freeDiskBytes: 20 * GIB,
    });
    const opts = buildVodMpvLoadOptions({
      kind: 'vod',
      bufferPreset: 'large',
      deviceRamBytes: 8 * GIB,
      freeDiskBytes: 20 * GIB,
      cacheDir,
    });
    expect(opts['cache-on-disk']).toBe('yes');
    expect(opts['demuxer-cache-dir']).toBe(cacheDir);
    expect(opts['demuxer-hysteresis-secs']).toBe('10');
    expect(opts['demuxer-readahead-secs']).toBe(String(Math.round(budget.forwardTargetMs / 1000)));
    const forwardBytes = parseMpvBytes(opts['demuxer-max-bytes']);
    const backBytes = parseMpvBytes(opts['demuxer-max-back-bytes']);
    expect(forwardBytes).toBeGreaterThan(0);
    expect(backBytes).toBeGreaterThan(0);
    expect(forwardBytes + backBytes).toBeLessThanOrEqual(budget.maxDiskBytes);
    expect(Object.values(opts).every((v) => typeof v === 'string')).toBe(true);
  });

  it('disables disk cache and stays within RAM budget when freeDiskBytes is missing, low, or throttled', () => {
    const cacheDir = join(makeTempDir(), 's-no-disk');
    const missingDisk = buildVodMpvLoadOptions({
      kind: 'vod',
      bufferPreset: 'balanced',
      deviceRamBytes: 8 * GIB,
      cacheDir,
    });
    expect(missingDisk['cache-on-disk']).toBe('no');
    expect(missingDisk).not.toHaveProperty('demuxer-cache-dir');

    const lowRam = buildVodMpvLoadOptions({
      kind: 'vod',
      bufferPreset: 'large',
      deviceRamBytes: 1 * GIB,
      freeDiskBytes: 0,
      cacheDir,
    });
    expect(lowRam['cache-on-disk']).toBe('no');
    expect(lowRam).not.toHaveProperty('demuxer-cache-dir');
    expect(
      parseMpvBytes(lowRam['demuxer-max-bytes']) + parseMpvBytes(lowRam['demuxer-max-back-bytes']),
    ).toBeLessThanOrEqual(16 * MIB);

    const throttled = buildVodMpvLoadOptions({
      kind: 'vod',
      bufferPreset: 'large',
      deviceRamBytes: 8 * GIB,
      freeDiskBytes: 20 * GIB,
      throttleBackoffLevel: 2,
      cacheDir,
    });
    expect(throttled['cache-on-disk']).toBe('no');
    expect(throttled).not.toHaveProperty('demuxer-cache-dir');
  });

  it('defaults to RAM-first caching (160-192 MiB) on >= 8 GiB desktops unless bufferPreset is large or preferRamOnHighRam is false', () => {
    const cacheDir = join(makeTempDir(), 's-ram-first');
    const autoHighRam = buildVodMpvLoadOptions({
      kind: 'vod',
      bufferPreset: 'auto',
      deviceRamBytes: 8 * GIB,
      freeDiskBytes: 20 * GIB,
      cacheDir,
    });
    expect(autoHighRam['cache-on-disk']).toBe('no');
    expect(autoHighRam).not.toHaveProperty('demuxer-cache-dir');
    expect(
      parseMpvBytes(autoHighRam['demuxer-max-bytes']) +
        parseMpvBytes(autoHighRam['demuxer-max-back-bytes']),
    ).toBe(160 * MIB);

    const balancedHighRam = buildVodMpvLoadOptions({
      kind: 'vod',
      bufferPreset: 'balanced',
      deviceRamBytes: 16 * GIB,
      freeDiskBytes: 20 * GIB,
      cacheDir,
    });
    expect(balancedHighRam['cache-on-disk']).toBe('no');
    expect(balancedHighRam).not.toHaveProperty('demuxer-cache-dir');
    expect(
      parseMpvBytes(balancedHighRam['demuxer-max-bytes']) +
        parseMpvBytes(balancedHighRam['demuxer-max-back-bytes']),
    ).toBe(192 * MIB);

    // Explicit preferRamOnHighRam: false still allows disk caching for auto/balanced
    const diskOptIn = buildVodMpvLoadOptions({
      kind: 'vod',
      bufferPreset: 'balanced',
      deviceRamBytes: 8 * GIB,
      freeDiskBytes: 20 * GIB,
      cacheDir,
      preferRamOnHighRam: false,
    });
    expect(diskOptIn['cache-on-disk']).toBe('yes');
    expect(diskOptIn['demuxer-cache-dir']).toBe(cacheDir);

    // Hosts under 8 GiB still use disk cache with default preferRamOnHighRam
    const midRam = buildVodMpvLoadOptions({
      kind: 'vod',
      bufferPreset: 'balanced',
      deviceRamBytes: 4 * GIB,
      freeDiskBytes: 20 * GIB,
      cacheDir,
    });
    expect(midRam['cache-on-disk']).toBe('yes');
    expect(midRam['demuxer-cache-dir']).toBe(cacheDir);
  });
});

describe('createVodThrottleTracker', () => {
  it('escalates on 429/509 keyed by credential-free fingerprint, decays on healthy playback, and bounds LRU', () => {
    const tracker = createVodThrottleTracker({ maxEntries: 2 });
    const urlA1 = 'https://user1:pass1@vod.example/movie/42.mp4?token=aaa';
    const urlA2 = 'https://user2:pass2@vod.example/movie/42.mp4?token=bbb';
    const urlB = 'https://vod.example/movie/99.mp4';
    const urlC = 'https://vod.example/movie/100.mp4';

    expect(tracker.getBackoffLevel(urlA1)).toBe(0);
    expect(tracker.recordHttpStatus(urlA1, 404)).toBe(0);
    expect(tracker.recordHttpStatus(urlA1, 429)).toBe(1);
    // Same canonical host+path with different token shares backoff level
    expect(tracker.getBackoffLevel(urlA2)).toBe(1);
    expect(tracker.recordHttpStatus(urlA2, 509)).toBe(2);
    expect(tracker.recordHttpStatus(urlA1, 429)).toBe(VOD_MAX_THROTTLE_BACKOFF);
    expect(tracker.recordHttpStatus(urlA1, 429)).toBe(VOD_MAX_THROTTLE_BACKOFF);

    // Decay after 240s healthy playback drops level by 2 (3 -> 1)
    expect(tracker.recordHealthySeconds(urlA1, 240)).toBe(1);
    expect(tracker.getBackoffLevel(urlA1)).toBe(1);

    // Accumulates incremental 1s ticks across the 120s decay window (1 -> 0 on the 120th second)
    for (let i = 0; i < 119; i += 1) {
      expect(tracker.recordHealthySeconds(urlA1, 1)).toBe(1);
    }
    expect(tracker.recordHealthySeconds(urlA1, 1)).toBe(0);
    expect(tracker.getBackoffLevel(urlA1)).toBe(0);
    // Re-escalate so LRU check below still exercises urlA1
    expect(tracker.recordHttpStatus(urlA1, 429)).toBe(1);

    // LRU eviction with maxEntries = 2
    tracker.recordHttpStatus(urlB, 429);
    expect(tracker.size).toBe(2);
    tracker.recordHttpStatus(urlC, 429);
    expect(tracker.size).toBe(2);
    expect(tracker.getBackoffLevel(urlA1)).toBe(0);
    expect(tracker.getBackoffLevel(urlB)).toBe(1);
    expect(tracker.getBackoffLevel(urlC)).toBe(1);

    tracker.reset(urlB);
    expect(tracker.getBackoffLevel(urlB)).toBe(0);
    tracker.reset();
    expect(tracker.size).toBe(0);
  });
});

describe('createVodCacheCoordinator', () => {
  it('avoids temp disk dirs on >= 8 GiB desktops for auto/balanced by default, while allowing large preset or preferRamOnHighRam: false', () => {
    const cacheRoot = resolveVodCacheRoot(makeTempDir());
    const coord = createVodCacheCoordinator({
      cacheRoot,
      getDeviceRamBytes: () => 8 * GIB,
      readFreeDiskBytes: () => 20 * GIB,
    });

    const autoOpts = coord.prepareLoad({
      url: 'https://vod.example/ram-auto.mp4',
      kind: 'vod',
      bufferPreset: 'auto',
    });
    expect(autoOpts['cache-on-disk']).toBe('no');
    expect(autoOpts).not.toHaveProperty('demuxer-cache-dir');
    expect(existsSync(cacheRoot)).toBe(false);
    expect(
      parseMpvBytes(autoOpts['demuxer-max-bytes']) +
        parseMpvBytes(autoOpts['demuxer-max-back-bytes']),
    ).toBe(160 * MIB);

    const balancedOpts = coord.prepareLoad({
      url: 'https://vod.example/ram-balanced.mp4',
      kind: 'vod',
      bufferPreset: 'balanced',
    });
    expect(balancedOpts['cache-on-disk']).toBe('no');
    expect(balancedOpts).not.toHaveProperty('demuxer-cache-dir');
    expect(existsSync(cacheRoot)).toBe(false);
    expect(
      parseMpvBytes(balancedOpts['demuxer-max-bytes']) +
        parseMpvBytes(balancedOpts['demuxer-max-back-bytes']),
    ).toBe(192 * MIB);

    const largeOpts = coord.prepareLoad({
      url: 'https://vod.example/disk-large.mp4',
      kind: 'vod',
      bufferPreset: 'large',
    });
    expect(largeOpts['cache-on-disk']).toBe('yes');
    expect(largeOpts['demuxer-cache-dir']).toBeTruthy();
    coord.dispose();

    const optOutRoot = resolveVodCacheRoot(makeTempDir());
    const optOutCoord = createVodCacheCoordinator({
      cacheRoot: optOutRoot,
      getDeviceRamBytes: () => 8 * GIB,
      readFreeDiskBytes: () => 20 * GIB,
      preferRamOnHighRam: false,
    });
    const optOutOpts = optOutCoord.prepareLoad({
      url: 'https://vod.example/disk-balanced.mp4',
      kind: 'vod',
      bufferPreset: 'balanced',
    });
    expect(optOutOpts['cache-on-disk']).toBe('yes');
    expect(optOutOpts['demuxer-cache-dir']).toBeTruthy();
    optOutCoord.dispose();
  });

  it('manages session dir lifecycle across VOD/live loads, deduplicates per-attempt throttle errors, and disables disk cache at level >= 2', () => {
    const cacheRoot = resolveVodCacheRoot(makeTempDir());
    const coord = createVodCacheCoordinator({
      cacheRoot,
      getDeviceRamBytes: () => 4 * GIB,
      readFreeDiskBytes: () => 20 * GIB,
    });

    const vodUrl = 'https://vod.example/series/1.mkv?token=xyz';
    const first = coord.prepareLoad({ url: vodUrl, kind: 'vod', bufferPreset: 'balanced' });
    expect(first['cache-on-disk']).toBe('yes');
    const dir1 = first['demuxer-cache-dir'];
    if (!dir1) throw new Error('expected dir1');
    expect(existsSync(dir1)).toBe(true);

    // Recording both a log line and end-file error for attempt 1 only increments backoff once
    coord.recordThrottleForAttempt(1, vodUrl, 'vod', 429);
    coord.recordThrottleForAttempt(1, vodUrl, 'vod', 429);
    const second = coord.prepareLoad({ url: vodUrl, kind: 'vod', bufferPreset: 'balanced' });
    // Previous session dir is retired (NOT eagerly deleted before mpv closes the file handle)
    expect(existsSync(dir1)).toBe(true);
    coord.sweepRetired();
    expect(existsSync(dir1)).toBe(false);
    expect(second['cache-on-disk']).toBe('yes');
    expect(Number(second['demuxer-readahead-secs'])).toBeLessThan(
      Number(first['demuxer-readahead-secs']),
    );
    const dir2 = second['demuxer-cache-dir'];
    if (!dir2) throw new Error('expected dir2');
    expect(dir2).not.toBe(dir1);

    // Second throttle attempt pushes backoff to 2 -> disk cache disabled
    coord.recordThrottleForAttempt(2, vodUrl, 'vod', 509);
    const third = coord.prepareLoad({ url: vodUrl, kind: 'vod', bufferPreset: 'balanced' });
    expect(existsSync(dir2)).toBe(true);
    coord.sweepRetired();
    expect(existsSync(dir2)).toBe(false);
    expect(third['cache-on-disk']).toBe('no');
    expect(third).not.toHaveProperty('demuxer-cache-dir');

    // Live load always disables disk cache and retires any active session
    const liveOpts = coord.prepareLoad({
      url: 'https://live.example/1.ts',
      kind: 'live',
      bufferPreset: 'large',
    });
    expect(liveOpts).toEqual({
      'cache-on-disk': 'no',
      'demuxer-max-bytes': '32MiB',
      'demuxer-max-back-bytes': '128MiB',
    });

    coord.dispose();
  });

  it('keeps temporarily EBUSY retired dirs until a subsequent sweepRetired or dispose succeeds', () => {
    const cacheRoot = resolveVodCacheRoot(makeTempDir());
    let failNextRemove = true;
    const removedDirs: string[] = [];
    const coord = createVodCacheCoordinator({
      cacheRoot,
      getDeviceRamBytes: () => 8 * GIB,
      readFreeDiskBytes: () => 20 * GIB,
      removeDir: (dir) => {
        if (failNextRemove) {
          failNextRemove = false;
          throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        }
        removedDirs.push(dir);
        rmSync(dir, { recursive: true, force: true });
      },
    });

    const opts = coord.prepareLoad({
      url: 'https://vod.example/ebusy.mp4',
      kind: 'vod',
      bufferPreset: 'large',
    });
    const dir = opts['demuxer-cache-dir'];
    if (!dir) throw new Error('expected dir');
    coord.retireActiveSession();
    expect(existsSync(dir)).toBe(true);

    // First sweep hits EBUSY -> dir stays tracked in retiredDirs
    coord.sweepRetired();
    expect(existsSync(dir)).toBe(true);
    expect(removedDirs).toEqual([]);

    // Next sweep succeeds -> dir deleted
    coord.sweepRetired();
    expect(existsSync(dir)).toBe(false);
    expect(removedDirs).toEqual([dir]);
    coord.dispose();
  });

  it('tracks queued episode sessions with VOD readahead, promotes cleanly, and discards unused queued dirs', () => {
    const cacheRoot = resolveVodCacheRoot(makeTempDir());
    const coord = createVodCacheCoordinator({
      cacheRoot,
      getDeviceRamBytes: () => 8 * GIB,
      readFreeDiskBytes: () => 20 * GIB,
    });

    const ep1 = coord.prepareLoad({
      url: 'https://vod.example/ep1.mp4',
      kind: 'vod',
      bufferPreset: 'large',
    });
    const dir1 = ep1['demuxer-cache-dir'];
    if (!dir1) throw new Error('expected dir1');

    const ep2 = coord.prepareQueuedLoad({
      url: 'https://vod.example/ep2.mp4',
      kind: 'vod',
      bufferPreset: 'large',
    });
    expect(ep2['cache-on-disk']).toBe('yes');
    expect(ep2['demuxer-readahead-secs']).toBe('240');
    const dir2 = ep2['demuxer-cache-dir'];
    if (!dir2) throw new Error('expected dir2');
    expect(dir2).not.toBe(dir1);
    expect(existsSync(dir1)).toBe(true);
    expect(existsSync(dir2)).toBe(true);

    // Replacing queued ep2 with ep3 immediately discards unused dir2 without touching active dir1
    const ep3 = coord.prepareQueuedLoad({
      url: 'https://vod.example/ep3.mp4',
      kind: 'vod',
      bufferPreset: 'large',
    });
    const dir3 = ep3['demuxer-cache-dir'];
    if (!dir3) throw new Error('expected dir3');
    expect(existsSync(dir2)).toBe(false);
    expect(existsSync(dir1)).toBe(true);
    expect(existsSync(dir3)).toBe(true);

    // Promoting ep3 retires & sweeps ep1 while keeping dir3 active until dispose
    coord.promoteQueuedSession();
    expect(existsSync(dir1)).toBe(false);
    expect(existsSync(dir3)).toBe(true);

    coord.dispose();
    expect(existsSync(dir3)).toBe(false);
  });

  it('disables disk caching when getMultiViewTileCount returns >= 2', () => {
    const cacheRoot = resolveVodCacheRoot(makeTempDir());
    let tiles = 2;
    const coord = createVodCacheCoordinator({
      cacheRoot,
      getDeviceRamBytes: () => 8 * GIB,
      readFreeDiskBytes: () => 20 * GIB,
      getMultiViewTileCount: () => tiles,
    });

    const mvOpts = coord.prepareLoad({
      url: 'https://vod.example/mv.mp4',
      kind: 'vod',
      bufferPreset: 'large',
    });
    expect(mvOpts['cache-on-disk']).toBe('no');
    expect(mvOpts).not.toHaveProperty('demuxer-cache-dir');

    const mvQueued = coord.prepareQueuedLoad({
      url: 'https://vod.example/mv2.mp4',
      kind: 'vod',
      bufferPreset: 'large',
    });
    expect(mvQueued['cache-on-disk']).toBe('no');
    expect(mvQueued).not.toHaveProperty('demuxer-cache-dir');
    expect(Number(mvQueued['demuxer-readahead-secs'])).toBeGreaterThanOrEqual(15);

    tiles = 1;
    const singleOpts = coord.prepareLoad({
      url: 'https://vod.example/single.mp4',
      kind: 'vod',
      bufferPreset: 'large',
    });
    expect(singleOpts['cache-on-disk']).toBe('yes');
    expect(singleOpts['demuxer-cache-dir']).toBeTruthy();
    coord.dispose();
  });

  it('decays throttle backoff after 120s of healthy non-stalled VOD playback and resets on dispose', () => {
    const cacheRoot = resolveVodCacheRoot(makeTempDir());
    const coord = createVodCacheCoordinator({
      cacheRoot,
      getDeviceRamBytes: () => 8 * GIB,
      readFreeDiskBytes: () => 20 * GIB,
    });
    const vodUrl = 'https://vod.example/decay.mp4?token=abc';

    // Escalate to level 2 -> disk cache disabled
    coord.recordThrottleForAttempt(1, vodUrl, 'vod', 429);
    coord.recordThrottleForAttempt(2, vodUrl, 'vod', 509);
    expect(coord.getBackoffLevel(vodUrl)).toBe(2);
    expect(
      coord.prepareLoad({ url: vodUrl, kind: 'vod', bufferPreset: 'large' })['cache-on-disk'],
    ).toBe('no');

    // Feed 1s healthy clock ticks for 120s -> backoff decays 2 -> 1 (disk cache re-enabled!)
    for (let sec = 0; sec <= 120; sec += 1) {
      coord.onPlaybackEvents(vodUrl, 'vod', [
        {
          attempt: 3,
          type: 'clock',
          anchor: { positionMs: sec * 1000, atMs: 1000 + sec * 1000, rate: 1 },
        },
      ]);
    }
    expect(coord.getBackoffLevel(vodUrl)).toBe(1);
    const recovered = coord.prepareLoad({ url: vodUrl, kind: 'vod', bufferPreset: 'large' });
    expect(recovered['cache-on-disk']).toBe('yes');

    // Paused (rate 0) and stalled playback must NOT advance healthy decay
    coord.onPlaybackEvents(vodUrl, 'vod', [
      { attempt: 4, type: 'clock', anchor: { positionMs: 1000, atMs: 1000, rate: 1 } },
      { attempt: 4, type: 'stall', phase: 'start', atMs: 2000 },
      { attempt: 4, type: 'clock', anchor: { positionMs: 1000, atMs: 200_000, rate: 1 } },
      { attempt: 4, type: 'stall', phase: 'end', atMs: 201_000 },
      { attempt: 4, type: 'clock', anchor: { positionMs: 1000, atMs: 202_000, rate: 0 } },
      { attempt: 4, type: 'clock', anchor: { positionMs: 1000, atMs: 400_000, rate: 0 } },
    ]);
    expect(coord.getBackoffLevel(vodUrl)).toBe(1);

    // dispose() resets throttle state and cleans up active/retired dirs
    coord.dispose();
    expect(coord.getBackoffLevel(vodUrl)).toBe(0);
  });
});
