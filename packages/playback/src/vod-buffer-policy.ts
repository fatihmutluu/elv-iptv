import type { BufferPreset } from '@elv/domain';
import type { MediaKind } from './engine';

const MIB = 1024 * 1024;
const RAM_SCALE_CEILING_BYTES = 8 * 1024 * MIB;
const HIGH_RAM_PREFER_THRESHOLD_BYTES = 8 * 1024 * MIB;
const HIGH_RAM_AUTO_MEMORY_BYTES = 160 * MIB;
const HIGH_RAM_BALANCED_MEMORY_BYTES = 192 * MIB;
const HIGH_RAM_THROTTLE_MEMORY_FLOOR_BYTES = 32 * MIB;
const MIN_FORWARD_FLOOR_MS = 15_000;
const MIN_BACK_FLOOR_MS = 2_000;
const LOW_RAM_DISK_CAP_BYTES = 32 * MIB;
const THROTTLE_DECAY_WINDOW_SECONDS = 120;

/** Device RAM threshold (`1536 MiB`) below which low-RAM safety caps apply (`#350`). */
export const VOD_LOW_RAM_THRESHOLD_BYTES = 1536 * MIB;

/** Strict RAM buffer ceiling (`16 MiB`) enforced on low-RAM devices (`#350`). */
export const VOD_LOW_RAM_MAX_MEMORY_BYTES = 16 * MIB;

/** Minimum free storage (`512 MiB`) required before enabling ephemeral VOD disk caching (`#350`). */
export const VOD_MIN_FREE_DISK_BYTES = 512 * MIB;

/** Hard upper cap (`512 MiB`) for any ephemeral VOD disk cache session (`#350`). */
export const VOD_MAX_DISK_BYTES = 512 * MIB;

/** Maximum fraction (`10%`) of currently free disk space that VOD disk caching may claim (`#350`). */
export const VOD_MAX_FREE_DISK_RATIO = 0.1;

/** Maximum server-throttle backoff level (`3`) triggered by `429` / `509` responses (`#350`). */
export const VOD_MAX_THROTTLE_BACKOFF = 3;

/** Input evaluated by {@link computeVodBufferBudget} (`#350`). */
export interface VodBufferBudgetInput {
  readonly kind: MediaKind;
  readonly bufferPreset?: BufferPreset;
  readonly deviceRamBytes: number;
  readonly isLowRamDevice?: boolean;
  readonly freeDiskBytes?: number;
  readonly multiViewTileCount?: number;
  readonly throttleBackoffLevel?: number;
  readonly estimatedBitrateBps?: number;
  /** Prefer RAM-only VOD caching on >= 8 GiB hosts for non-`large` single-view presets. */
  readonly preferRamOnHighRam?: boolean;
}

/** Deterministic read-ahead, back-buffer, RAM, and disk budget for one VOD playback session (`#350`). */
export interface VodBufferBudget {
  readonly enabled: boolean;
  readonly forwardTargetMs: number;
  readonly minBufferMs: number;
  readonly backTargetMs: number;
  readonly maxMemoryBytes: number;
  readonly maxDiskBytes: number;
  readonly allowDiskCache: boolean;
  readonly throttleBackoffLevel: number;
  readonly prioritizeTimeOverSize: boolean;
}

interface PresetRange {
  readonly minForwardMs: number;
  readonly maxForwardMs: number;
  readonly minBackMs: number;
  readonly maxBackMs: number;
  readonly minMemoryBytes: number;
  readonly maxMemoryBytes: number;
  readonly minDiskBytes: number;
  readonly maxDiskBytes: number;
  readonly lowRamForwardMs: number;
  readonly lowRamBackMs: number;
}

const PRESET_RANGES: Readonly<Record<BufferPreset, PresetRange>> = {
  auto: {
    minForwardMs: 45_000,
    maxForwardMs: 120_000,
    minBackMs: 12_000,
    maxBackMs: 30_000,
    minMemoryBytes: 24 * MIB,
    maxMemoryBytes: 64 * MIB,
    minDiskBytes: 64 * MIB,
    maxDiskBytes: 192 * MIB,
    lowRamForwardMs: 20_000,
    lowRamBackMs: 5_000,
  },
  balanced: {
    minForwardMs: 60_000,
    maxForwardMs: 150_000,
    minBackMs: 15_000,
    maxBackMs: 45_000,
    minMemoryBytes: 32 * MIB,
    maxMemoryBytes: 96 * MIB,
    minDiskBytes: 96 * MIB,
    maxDiskBytes: 256 * MIB,
    lowRamForwardMs: 25_000,
    lowRamBackMs: 6_000,
  },
  large: {
    minForwardMs: 90_000,
    maxForwardMs: 240_000,
    minBackMs: 20_000,
    maxBackMs: 60_000,
    minMemoryBytes: 48 * MIB,
    maxMemoryBytes: 128 * MIB,
    minDiskBytes: 128 * MIB,
    maxDiskBytes: 512 * MIB,
    lowRamForwardMs: 30_000,
    lowRamBackMs: 8_000,
  },
};

const DISABLED_BUDGET: VodBufferBudget = Object.freeze({
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

function clampBackoffLevel(level: number | undefined): number {
  if (level === undefined || !Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(VOD_MAX_THROTTLE_BACKOFF, Math.floor(level)));
}

function resolvePreset(preset: BufferPreset | undefined): PresetRange {
  if (preset === 'balanced') return PRESET_RANGES.balanced;
  if (preset === 'large') return PRESET_RANGES.large;
  return PRESET_RANGES.auto;
}

function lerpRounded(min: number, max: number, factor: number): number {
  return Math.round(min + (max - min) * factor);
}

/**
 * Increments the server-throttle backoff level by `1` (capped at {@link VOD_MAX_THROTTLE_BACKOFF})
 * on HTTP `429` or `509` responses; leaves other status codes unchanged (`#350`).
 */
export function nextThrottleBackoffLevel(current: number, httpStatus: number): number {
  const safe = clampBackoffLevel(current);
  if (httpStatus === 429 || httpStatus === 509) {
    return Math.min(VOD_MAX_THROTTLE_BACKOFF, safe + 1);
  }
  return safe;
}

/**
 * Decays the server-throttle backoff level by `1` for every `120` seconds of healthy playback (`#350`).
 */
export function decayThrottleBackoffLevel(current: number, healthySeconds: number): number {
  const safe = clampBackoffLevel(current);
  if (!Number.isFinite(healthySeconds) || healthySeconds <= 0) return safe;
  const steps = Math.floor(healthySeconds / THROTTLE_DECAY_WINDOW_SECONDS);
  return Math.max(0, safe - steps);
}

/**
 * Computes a deterministic VOD forward read-ahead, back-buffer, memory, and ephemeral disk cache
 * budget honoring low-RAM limits, free-disk ratios, multi-view isolation, bitrate bounds, and
 * `429`/`509` throttle backoff (`#350`). Live streams always return a disabled budget.
 */
export function computeVodBufferBudget(input: VodBufferBudgetInput): VodBufferBudget {
  if (input.kind === 'live') return DISABLED_BUDGET;

  const range = resolvePreset(input.bufferPreset);
  const throttleBackoffLevel = clampBackoffLevel(input.throttleBackoffLevel);
  const tileCount =
    input.multiViewTileCount !== undefined &&
    Number.isFinite(input.multiViewTileCount) &&
    input.multiViewTileCount > 1
      ? Math.floor(input.multiViewTileCount)
      : 1;
  const isMultiView = tileCount > 1;

  const isLowRam =
    input.isLowRamDevice === true ||
    !Number.isFinite(input.deviceRamBytes) ||
    input.deviceRamBytes < VOD_LOW_RAM_THRESHOLD_BYTES;

  let forwardTargetMs: number;
  let backTargetMs: number;
  let maxMemoryBytes: number;
  let presetDiskCap: number;

  if (isLowRam) {
    forwardTargetMs = range.lowRamForwardMs;
    backTargetMs = range.lowRamBackMs;
    maxMemoryBytes = VOD_LOW_RAM_MAX_MEMORY_BYTES;
    presetDiskCap = LOW_RAM_DISK_CAP_BYTES;
  } else {
    const ramSpan = RAM_SCALE_CEILING_BYTES - VOD_LOW_RAM_THRESHOLD_BYTES;
    const ramFactor = Math.max(
      0,
      Math.min(1, (input.deviceRamBytes - VOD_LOW_RAM_THRESHOLD_BYTES) / ramSpan),
    );
    forwardTargetMs = lerpRounded(range.minForwardMs, range.maxForwardMs, ramFactor);
    backTargetMs = lerpRounded(range.minBackMs, range.maxBackMs, ramFactor);
    maxMemoryBytes = lerpRounded(range.minMemoryBytes, range.maxMemoryBytes, ramFactor);
    presetDiskCap = lerpRounded(range.minDiskBytes, range.maxDiskBytes, ramFactor);
  }

  if (isMultiView) {
    const memoryFloor = isLowRam ? 4 * MIB : 8 * MIB;
    maxMemoryBytes = Math.min(
      isLowRam ? VOD_LOW_RAM_MAX_MEMORY_BYTES : maxMemoryBytes,
      Math.max(memoryFloor, Math.floor(maxMemoryBytes / tileCount)),
    );
    forwardTargetMs = Math.max(MIN_FORWARD_FLOOR_MS, Math.floor(forwardTargetMs / tileCount));
    backTargetMs = Math.max(MIN_BACK_FLOOR_MS, Math.floor(backTargetMs / tileCount));
  }

  const hasEnoughFreeDisk =
    input.freeDiskBytes !== undefined &&
    Number.isFinite(input.freeDiskBytes) &&
    input.freeDiskBytes >= VOD_MIN_FREE_DISK_BYTES;

  let allowDiskCache = hasEnoughFreeDisk && !isMultiView && throttleBackoffLevel < 2;
  let maxDiskBytes = 0;

  if (allowDiskCache && input.freeDiskBytes !== undefined) {
    const ratioCap = Math.floor(input.freeDiskBytes * VOD_MAX_FREE_DISK_RATIO);
    maxDiskBytes = Math.min(presetDiskCap, ratioCap, VOD_MAX_DISK_BYTES);
    if (maxDiskBytes <= 0) {
      allowDiskCache = false;
      maxDiskBytes = 0;
    }
  }

  if (throttleBackoffLevel > 0) {
    const divisor = 1 << throttleBackoffLevel;
    forwardTargetMs = Math.max(MIN_FORWARD_FLOOR_MS, Math.floor(forwardTargetMs / divisor));
    if (allowDiskCache) {
      maxDiskBytes = Math.floor(maxDiskBytes / divisor);
      if (maxDiskBytes <= 0) {
        allowDiskCache = false;
        maxDiskBytes = 0;
      }
    }
  }

  const effectivePreset: BufferPreset =
    input.bufferPreset === 'balanced' || input.bufferPreset === 'large'
      ? input.bufferPreset
      : 'auto';
  if (
    input.preferRamOnHighRam === true &&
    !isLowRam &&
    input.deviceRamBytes >= HIGH_RAM_PREFER_THRESHOLD_BYTES &&
    !isMultiView &&
    effectivePreset !== 'large'
  ) {
    allowDiskCache = false;
    maxDiskBytes = 0;
    const boostedMemoryBytes = Math.max(
      maxMemoryBytes,
      effectivePreset === 'balanced' ? HIGH_RAM_BALANCED_MEMORY_BYTES : HIGH_RAM_AUTO_MEMORY_BYTES,
    );
    maxMemoryBytes =
      throttleBackoffLevel > 0
        ? Math.max(
            HIGH_RAM_THROTTLE_MEMORY_FLOOR_BYTES,
            Math.floor(boostedMemoryBytes / (1 << throttleBackoffLevel)),
          )
        : boostedMemoryBytes;
  }

  let bitrateConstrained = false;
  if (
    input.estimatedBitrateBps !== undefined &&
    Number.isFinite(input.estimatedBitrateBps) &&
    input.estimatedBitrateBps > 0
  ) {
    const effectiveBytes = allowDiskCache ? maxMemoryBytes + maxDiskBytes : maxMemoryBytes;
    const sustainableTotalMs = Math.floor(
      ((effectiveBytes * 8) / input.estimatedBitrateBps) * 1000,
    );
    const desiredTotalMs = forwardTargetMs + backTargetMs;
    if (sustainableTotalMs < desiredTotalMs) {
      bitrateConstrained = true;
      const scale = Math.max(0, sustainableTotalMs / desiredTotalMs);
      forwardTargetMs = Math.max(
        Math.min(forwardTargetMs, MIN_FORWARD_FLOOR_MS),
        Math.floor(forwardTargetMs * scale),
      );
      backTargetMs = Math.max(
        Math.min(backTargetMs, MIN_BACK_FLOOR_MS),
        Math.floor(backTargetMs * scale),
      );
    }
  }

  backTargetMs = Math.min(backTargetMs, forwardTargetMs);
  const rawMinBufferMs = isLowRam
    ? Math.min(15_000, Math.round(forwardTargetMs * 0.5))
    : Math.max(15_000, Math.min(45_000, Math.round(forwardTargetMs * 0.3)));
  const minBufferMs = Math.min(forwardTargetMs, Math.max(10_000, rawMinBufferMs));

  return {
    enabled: true,
    forwardTargetMs,
    minBufferMs,
    backTargetMs,
    maxMemoryBytes,
    maxDiskBytes,
    allowDiskCache,
    throttleBackoffLevel,
    prioritizeTimeOverSize: !isLowRam && !isMultiView && !bitrateConstrained,
  };
}
