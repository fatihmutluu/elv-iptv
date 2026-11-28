import { ok } from '@elv/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlaybackService } from './service';
import { createFakePlayerEngine } from './testing';
import type { PlaybackState } from './types';
import {
  computeVodBufferBudget,
  decayThrottleBackoffLevel,
  nextThrottleBackoffLevel,
  VOD_LOW_RAM_MAX_MEMORY_BYTES,
  VOD_LOW_RAM_THRESHOLD_BYTES,
  VOD_MAX_DISK_BYTES,
  VOD_MAX_FREE_DISK_RATIO,
  VOD_MAX_THROTTLE_BACKOFF,
  VOD_MIN_FREE_DISK_BYTES,
  type VodBufferBudgetInput,
} from './vod-buffer-policy';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe('vod-buffer-policy (#350)', () => {
  it('exports the spec-defined safety constants', () => {
    expect(VOD_LOW_RAM_THRESHOLD_BYTES).toBe(1536 * MIB);
    expect(VOD_LOW_RAM_MAX_MEMORY_BYTES).toBe(16 * MIB);
    expect(VOD_MIN_FREE_DISK_BYTES).toBe(512 * MIB);
    expect(VOD_MAX_DISK_BYTES).toBe(512 * MIB);
    expect(VOD_MAX_FREE_DISK_RATIO).toBe(0.1);
    expect(VOD_MAX_THROTTLE_BACKOFF).toBe(3);
  });

  it('strictly disables VOD read-ahead and disk spill for live streams', () => {
    const budget = computeVodBufferBudget({
      kind: 'live',
      bufferPreset: 'large',
      deviceRamBytes: 16 * GIB,
      freeDiskBytes: 50 * GIB,
      multiViewTileCount: 1,
      throttleBackoffLevel: 2,
    });
    expect(budget).toEqual({
      enabled: false,
      forwardTargetMs: 0,
      minBufferMs: 0,
      backTargetMs: 0,
      maxMemoryBytes: 0,
      maxDiskBytes: 0,
      allowDiskCache: false,
      throttleBackoffLevel: 0,
      prioritizeTimeOverSize: false,
    });
  });

  it('enforces low-RAM caps when isLowRamDevice is true, RAM < 1536 MiB, or RAM is non-finite', () => {
    const cases: readonly VodBufferBudgetInput[] = [
      {
        kind: 'vod',
        bufferPreset: 'large',
        deviceRamBytes: 8 * GIB,
        isLowRamDevice: true,
        freeDiskBytes: 10 * GIB,
      },
      { kind: 'vod', bufferPreset: 'large', deviceRamBytes: 1024 * MIB, freeDiskBytes: 10 * GIB },
      {
        kind: 'vod',
        bufferPreset: 'balanced',
        deviceRamBytes: Number.NaN,
        freeDiskBytes: 10 * GIB,
      },
      { kind: 'vod', bufferPreset: 'auto', deviceRamBytes: -1, freeDiskBytes: 10 * GIB },
    ];

    for (const input of cases) {
      const budget = computeVodBufferBudget(input);
      expect(budget.enabled).toBe(true);
      expect(budget.maxMemoryBytes).toBeLessThanOrEqual(VOD_LOW_RAM_MAX_MEMORY_BYTES);
      expect(budget.maxMemoryBytes).toBeGreaterThan(0);
      expect(budget.prioritizeTimeOverSize).toBe(false);
      expect(budget.forwardTargetMs).toBeLessThanOrEqual(30_000);
      expect(budget.forwardTargetMs).toBeGreaterThanOrEqual(15_000);
      expect(budget.backTargetMs).toBeLessThanOrEqual(8_000);
      expect(budget.backTargetMs).toBeGreaterThan(0);
      expect(budget.minBufferMs).toBeGreaterThan(0);
      expect(budget.minBufferMs).toBeLessThanOrEqual(budget.forwardTargetMs);
      expect(budget.allowDiskCache).toBe(true);
      expect(budget.maxDiskBytes).toBeLessThanOrEqual(32 * MIB);
    }

    // Low RAM still disables disk spill when free disk < 512 MiB, multi-view, or backoff >= 2
    expect(
      computeVodBufferBudget({
        kind: 'vod',
        deviceRamBytes: 1024 * MIB,
        freeDiskBytes: 256 * MIB,
      }).allowDiskCache,
    ).toBe(false);
    expect(
      computeVodBufferBudget({
        kind: 'vod',
        deviceRamBytes: 1024 * MIB,
        freeDiskBytes: 10 * GIB,
        multiViewTileCount: 2,
      }).allowDiskCache,
    ).toBe(false);
    expect(
      computeVodBufferBudget({
        kind: 'vod',
        deviceRamBytes: 1024 * MIB,
        freeDiskBytes: 10 * GIB,
        throttleBackoffLevel: 2,
      }).allowDiskCache,
    ).toBe(false);
  });

  it('scales non-low-RAM presets smoothly across RAM tiers within documented ranges', () => {
    const lowTierRam = 1536 * MIB;
    const midTierRam = 4 * GIB;
    const highTierRam = 16 * GIB;
    const plentyDisk = 50 * GIB;

    const autoLow = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'auto',
      deviceRamBytes: lowTierRam,
      freeDiskBytes: plentyDisk,
    });
    const autoMid = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'auto',
      deviceRamBytes: midTierRam,
      freeDiskBytes: plentyDisk,
    });
    const autoHigh = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'auto',
      deviceRamBytes: highTierRam,
      freeDiskBytes: plentyDisk,
    });

    expect(autoLow.forwardTargetMs).toBe(45_000);
    expect(autoHigh.forwardTargetMs).toBe(120_000);
    expect(autoMid.forwardTargetMs).toBeGreaterThan(autoLow.forwardTargetMs);
    expect(autoMid.forwardTargetMs).toBeLessThan(autoHigh.forwardTargetMs);
    expect(autoLow.backTargetMs).toBe(12_000);
    expect(autoHigh.backTargetMs).toBe(30_000);
    expect(autoLow.maxDiskBytes).toBe(64 * MIB);
    expect(autoHigh.maxDiskBytes).toBe(192 * MIB);

    const balLow = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'balanced',
      deviceRamBytes: lowTierRam,
      freeDiskBytes: plentyDisk,
    });
    const balHigh = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'balanced',
      deviceRamBytes: highTierRam,
      freeDiskBytes: plentyDisk,
    });
    expect(balLow.forwardTargetMs).toBe(60_000);
    expect(balHigh.forwardTargetMs).toBe(150_000);
    expect(balLow.backTargetMs).toBe(15_000);
    expect(balHigh.backTargetMs).toBe(45_000);
    expect(balLow.maxDiskBytes).toBe(96 * MIB);
    expect(balHigh.maxDiskBytes).toBe(256 * MIB);

    const largeLow = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'large',
      deviceRamBytes: lowTierRam,
      freeDiskBytes: plentyDisk,
    });
    const largeHigh = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'large',
      deviceRamBytes: highTierRam,
      freeDiskBytes: plentyDisk,
    });
    expect(largeLow.forwardTargetMs).toBe(90_000);
    expect(largeHigh.forwardTargetMs).toBe(240_000);
    expect(largeLow.backTargetMs).toBe(20_000);
    expect(largeHigh.backTargetMs).toBe(60_000);
    expect(largeLow.maxDiskBytes).toBe(128 * MIB);
    expect(largeHigh.maxDiskBytes).toBe(512 * MIB);

    // Default bufferPreset matches auto
    expect(
      computeVodBufferBudget({
        kind: 'vod',
        deviceRamBytes: midTierRam,
        freeDiskBytes: plentyDisk,
      }),
    ).toEqual(autoMid);
  });

  it('enforces disk eligibility, 10% free-space cap, 512 MiB hard cap, and multi-view disablement', () => {
    // Undefined, NaN, negative, or < 512 MiB disables disk cache
    for (const freeDiskBytes of [undefined, Number.NaN, -100, 512 * MIB - 1]) {
      const budget = computeVodBufferBudget({
        kind: 'vod',
        bufferPreset: 'large',
        deviceRamBytes: 8 * GIB,
        ...(freeDiskBytes === undefined ? {} : { freeDiskBytes }),
      });
      expect(budget.allowDiskCache).toBe(false);
      expect(budget.maxDiskBytes).toBe(0);
    }

    // 1 GiB free disk -> 10% = 102.4 MiB -> caps below preset's 512 MiB
    const tightDisk = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'large',
      deviceRamBytes: 8 * GIB,
      freeDiskBytes: 1 * GIB,
    });
    expect(tightDisk.allowDiskCache).toBe(true);
    expect(tightDisk.maxDiskBytes).toBe(Math.floor(1 * GIB * 0.1));

    // 100 GiB free disk -> still capped at VOD_MAX_DISK_BYTES (512 MiB)
    const hugeDisk = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'large',
      deviceRamBytes: 16 * GIB,
      freeDiskBytes: 100 * GIB,
    });
    expect(hugeDisk.allowDiskCache).toBe(true);
    expect(hugeDisk.maxDiskBytes).toBe(VOD_MAX_DISK_BYTES);

    // Multi-view disables disk cache and scales memory/targets safely
    const single = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'balanced',
      deviceRamBytes: 8 * GIB,
      freeDiskBytes: 20 * GIB,
      multiViewTileCount: 1,
    });
    const multi = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'balanced',
      deviceRamBytes: 8 * GIB,
      freeDiskBytes: 20 * GIB,
      multiViewTileCount: 4,
    });
    expect(multi.allowDiskCache).toBe(false);
    expect(multi.maxDiskBytes).toBe(0);
    expect(multi.maxMemoryBytes).toBeLessThan(single.maxMemoryBytes);
    expect(multi.prioritizeTimeOverSize).toBe(false);
  });

  it('scales targets down for high-bitrate 4K streams so they do not blow memory', () => {
    const standardHd = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'large',
      deviceRamBytes: 4 * GIB,
      estimatedBitrateBps: 5_000_000,
    });
    const highBitrate4k = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'large',
      deviceRamBytes: 4 * GIB,
      estimatedBitrateBps: 50_000_000,
    });

    expect(highBitrate4k.forwardTargetMs).toBeLessThan(standardHd.forwardTargetMs);
    expect(highBitrate4k.forwardTargetMs).toBeGreaterThanOrEqual(15_000);
    expect(highBitrate4k.backTargetMs).toBeLessThan(standardHd.backTargetMs);
    expect(highBitrate4k.prioritizeTimeOverSize).toBe(false);

    // Non-finite or <= 0 bitrate is ignored cleanly
    const noBitrate = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'auto',
      deviceRamBytes: 4 * GIB,
    });
    expect(
      computeVodBufferBudget({
        kind: 'vod',
        bufferPreset: 'auto',
        deviceRamBytes: 4 * GIB,
        estimatedBitrateBps: 0,
      }),
    ).toEqual(noBitrate);
    expect(
      computeVodBufferBudget({
        kind: 'vod',
        bufferPreset: 'auto',
        deviceRamBytes: 4 * GIB,
        estimatedBitrateBps: Number.NaN,
      }),
    ).toEqual(noBitrate);
  });

  it('applies throttle backoff halving, 15s floor, and disk disable at level >= 2', () => {
    const base = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'large',
      deviceRamBytes: 8 * GIB,
      freeDiskBytes: 20 * GIB,
      throttleBackoffLevel: 0,
    });
    const lvl1 = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'large',
      deviceRamBytes: 8 * GIB,
      freeDiskBytes: 20 * GIB,
      throttleBackoffLevel: 1,
    });
    const lvl2 = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'large',
      deviceRamBytes: 8 * GIB,
      freeDiskBytes: 20 * GIB,
      throttleBackoffLevel: 2,
    });
    const lvl3 = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'large',
      deviceRamBytes: 8 * GIB,
      freeDiskBytes: 20 * GIB,
      throttleBackoffLevel: 99,
    });

    expect(lvl1.throttleBackoffLevel).toBe(1);
    expect(lvl1.forwardTargetMs).toBe(Math.floor(base.forwardTargetMs / 2));
    expect(lvl1.allowDiskCache).toBe(true);
    expect(lvl1.maxDiskBytes).toBe(Math.floor(base.maxDiskBytes / 2));

    expect(lvl2.throttleBackoffLevel).toBe(2);
    expect(lvl2.forwardTargetMs).toBe(Math.floor(base.forwardTargetMs / 4));
    expect(lvl2.allowDiskCache).toBe(false);
    expect(lvl2.maxDiskBytes).toBe(0);

    expect(lvl3.throttleBackoffLevel).toBe(VOD_MAX_THROTTLE_BACKOFF);
    expect(lvl3.forwardTargetMs).toBe(Math.floor(base.forwardTargetMs / 8));
    expect(lvl3.allowDiskCache).toBe(false);
    expect(lvl3.maxDiskBytes).toBe(0);

    // Floors forwardTargetMs at 15_000 ms even at max backoff on smaller presets
    const autoMaxBackoff = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'auto',
      deviceRamBytes: 2 * GIB,
      throttleBackoffLevel: 3,
    });
    expect(autoMaxBackoff.forwardTargetMs).toBe(15_000);
    expect(autoMaxBackoff.minBufferMs).toBeLessThanOrEqual(15_000);
  });

  it('transitions and decays throttle backoff levels deterministically', () => {
    expect(nextThrottleBackoffLevel(0, 429)).toBe(1);
    expect(nextThrottleBackoffLevel(1, 509)).toBe(2);
    expect(nextThrottleBackoffLevel(2, 429)).toBe(3);
    expect(nextThrottleBackoffLevel(3, 509)).toBe(3);
    expect(nextThrottleBackoffLevel(1, 503)).toBe(1);
    expect(nextThrottleBackoffLevel(1, 200)).toBe(1);
    expect(nextThrottleBackoffLevel(-5, 429)).toBe(1);
    expect(nextThrottleBackoffLevel(Number.NaN, 509)).toBe(1);

    expect(decayThrottleBackoffLevel(3, 0)).toBe(3);
    expect(decayThrottleBackoffLevel(3, 119)).toBe(3);
    expect(decayThrottleBackoffLevel(3, 120)).toBe(2);
    expect(decayThrottleBackoffLevel(3, 240)).toBe(1);
    expect(decayThrottleBackoffLevel(3, 360)).toBe(0);
    expect(decayThrottleBackoffLevel(2, 999)).toBe(0);
    expect(decayThrottleBackoffLevel(2, -120)).toBe(2);
    expect(decayThrottleBackoffLevel(2, Number.NaN)).toBe(2);
  });

  it('uses RAM-first high-RAM desktop policy on >= 8 GiB non-multi-view non-large presets with throttle scaling (Wave Q4)', () => {
    const autoHighRam = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'auto',
      deviceRamBytes: 8 * GIB,
      freeDiskBytes: 50 * GIB,
      preferRamOnHighRam: true,
    });
    expect(autoHighRam.allowDiskCache).toBe(false);
    expect(autoHighRam.maxDiskBytes).toBe(0);
    expect(autoHighRam.maxMemoryBytes).toBe(160 * MIB);

    // Omitted bufferPreset defaults to 'auto' -> 160 MiB RAM-only
    const omittedPresetHighRam = computeVodBufferBudget({
      kind: 'vod',
      deviceRamBytes: 16 * GIB,
      freeDiskBytes: 50 * GIB,
      preferRamOnHighRam: true,
    });
    expect(omittedPresetHighRam.allowDiskCache).toBe(false);
    expect(omittedPresetHighRam.maxDiskBytes).toBe(0);
    expect(omittedPresetHighRam.maxMemoryBytes).toBe(160 * MIB);

    const balancedHighRam = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'balanced',
      deviceRamBytes: 16 * GIB,
      freeDiskBytes: 50 * GIB,
      preferRamOnHighRam: true,
    });
    expect(balancedHighRam.allowDiskCache).toBe(false);
    expect(balancedHighRam.maxDiskBytes).toBe(0);
    expect(balancedHighRam.maxMemoryBytes).toBe(192 * MIB);

    // Throttle backoff scales boosted RAM budget by 1 << level, floored at 32 MiB
    expect(
      computeVodBufferBudget({
        kind: 'vod',
        bufferPreset: 'auto',
        deviceRamBytes: 16 * GIB,
        freeDiskBytes: 50 * GIB,
        preferRamOnHighRam: true,
        throttleBackoffLevel: 1,
      }).maxMemoryBytes,
    ).toBe(80 * MIB);
    expect(
      computeVodBufferBudget({
        kind: 'vod',
        bufferPreset: 'auto',
        deviceRamBytes: 16 * GIB,
        freeDiskBytes: 50 * GIB,
        preferRamOnHighRam: true,
        throttleBackoffLevel: 2,
      }).maxMemoryBytes,
    ).toBe(40 * MIB);
    expect(
      computeVodBufferBudget({
        kind: 'vod',
        bufferPreset: 'auto',
        deviceRamBytes: 16 * GIB,
        freeDiskBytes: 50 * GIB,
        preferRamOnHighRam: true,
        throttleBackoffLevel: 3,
      }).maxMemoryBytes,
    ).toBe(32 * MIB);
    expect(
      computeVodBufferBudget({
        kind: 'vod',
        bufferPreset: 'balanced',
        deviceRamBytes: 16 * GIB,
        freeDiskBytes: 50 * GIB,
        preferRamOnHighRam: true,
        throttleBackoffLevel: 1,
      }).maxMemoryBytes,
    ).toBe(96 * MIB);
    expect(
      computeVodBufferBudget({
        kind: 'vod',
        bufferPreset: 'balanced',
        deviceRamBytes: 16 * GIB,
        freeDiskBytes: 50 * GIB,
        preferRamOnHighRam: true,
        throttleBackoffLevel: 2,
      }).maxMemoryBytes,
    ).toBe(48 * MIB);
    expect(
      computeVodBufferBudget({
        kind: 'vod',
        bufferPreset: 'balanced',
        deviceRamBytes: 16 * GIB,
        freeDiskBytes: 50 * GIB,
        preferRamOnHighRam: true,
        throttleBackoffLevel: 3,
      }).maxMemoryBytes,
    ).toBe(32 * MIB);

    // Unchanged when bufferPreset === 'large'
    const largeExplicit = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'large',
      deviceRamBytes: 16 * GIB,
      freeDiskBytes: 50 * GIB,
      preferRamOnHighRam: true,
    });
    const largeDefault = computeVodBufferBudget({
      kind: 'vod',
      bufferPreset: 'large',
      deviceRamBytes: 16 * GIB,
      freeDiskBytes: 50 * GIB,
    });
    expect(largeExplicit).toEqual(largeDefault);
    expect(largeExplicit.allowDiskCache).toBe(true);
    expect(largeExplicit.maxDiskBytes).toBe(VOD_MAX_DISK_BYTES);

    // Unchanged when deviceRamBytes < 8 GiB, isLowRamDevice, multiView, or preferRamOnHighRam false
    expect(
      computeVodBufferBudget({
        kind: 'vod',
        bufferPreset: 'auto',
        deviceRamBytes: 8 * GIB - 1,
        freeDiskBytes: 50 * GIB,
        preferRamOnHighRam: true,
      }),
    ).toEqual(
      computeVodBufferBudget({
        kind: 'vod',
        bufferPreset: 'auto',
        deviceRamBytes: 8 * GIB - 1,
        freeDiskBytes: 50 * GIB,
      }),
    );
    expect(
      computeVodBufferBudget({
        kind: 'vod',
        bufferPreset: 'balanced',
        deviceRamBytes: 16 * GIB,
        isLowRamDevice: true,
        freeDiskBytes: 50 * GIB,
        preferRamOnHighRam: true,
      }).maxMemoryBytes,
    ).toBe(VOD_LOW_RAM_MAX_MEMORY_BYTES);
    expect(
      computeVodBufferBudget({
        kind: 'vod',
        bufferPreset: 'balanced',
        deviceRamBytes: 16 * GIB,
        freeDiskBytes: 50 * GIB,
        multiViewTileCount: 2,
        preferRamOnHighRam: true,
      }),
    ).toEqual(
      computeVodBufferBudget({
        kind: 'vod',
        bufferPreset: 'balanced',
        deviceRamBytes: 16 * GIB,
        freeDiskBytes: 50 * GIB,
        multiViewTileCount: 2,
      }),
    );
    expect(
      computeVodBufferBudget({
        kind: 'vod',
        bufferPreset: 'auto',
        deviceRamBytes: 16 * GIB,
        freeDiskBytes: 50 * GIB,
        preferRamOnHighRam: false,
      }).allowDiskCache,
    ).toBe(true);
    expect(
      computeVodBufferBudget({
        kind: 'live',
        deviceRamBytes: 16 * GIB,
        freeDiskBytes: 50 * GIB,
        preferRamOnHighRam: true,
      }).enabled,
    ).toBe(false);
  });
});

describe('PlaybackService ClockAnchor.bufferHealth propagation (#350)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => vi.useRealTimers());

  it('preserves bufferHealth on accepted anchors, notifies subscribers on paused growth, and merges cleanly across stale-seek clock guard', async () => {
    const engine = createFakePlayerEngine({
      scripts: {},
      now: () => Date.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const service = createPlaybackService({
      engine,
      clock: { now: () => Date.now() },
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
      config: { startTimeoutMs: 8_000 },
    });

    const t = service.tune({
      item: 'vod-1',
      accountKey: 'acc',
      kind: 'vod',
      resolve: () =>
        Promise.resolve(ok({ url: 'http://provider.invalid/movie/1.mp4', headers: {} })),
    });
    await vi.advanceTimersByTimeAsync(300);

    const now = Date.now();
    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: {
        positionMs: 30_000,
        atMs: now,
        rate: 0,
        durationMs: 300_000,
        bufferHealth: { bufferedAheadMs: 20_000, bufferedBehindMs: 5_000, diskCacheBytes: 4 * MIB },
      },
    });
    expect(service.getState().anchor?.bufferHealth).toEqual({
      bufferedAheadMs: 20_000,
      bufferedBehindMs: 5_000,
      diskCacheBytes: 4 * MIB,
    });

    // Updating only bufferHealth while position/atMs stay identical notifies subscribers
    const updates: PlaybackState[] = [];
    service.subscribe((s) => updates.push(s));
    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: {
        positionMs: 30_000,
        atMs: now,
        rate: 0,
        durationMs: 300_000,
        bufferHealth: { bufferedAheadMs: 45_000, bufferedBehindMs: 5_000, diskCacheBytes: 8 * MIB },
      },
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.anchor?.bufferHealth?.bufferedAheadMs).toBe(45_000);

    // Seek to 120_000 -> optimistic anchor sits at 120_000; stale pre-seek clock at 30_500 must NOT overwrite positionMs
    // while still merging incoming bufferHealth metadata cleanly.
    service.seek(120_000);
    expect(service.getState().anchor?.positionMs).toBe(120_000);

    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: {
        positionMs: 30_500,
        atMs: Date.now(),
        rate: 1,
        durationMs: 300_000,
        bufferHealth: { bufferedAheadMs: 60_000, bufferedBehindMs: 15_000, throttled: true },
      },
    });
    expect(service.getState().anchor?.positionMs).toBe(120_000);
    expect(service.getState().anchor?.bufferHealth).toEqual({
      bufferedAheadMs: 60_000,
      bufferedBehindMs: 15_000,
      throttled: true,
    });

    service.dispose();
  });
});
