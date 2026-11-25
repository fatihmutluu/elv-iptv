import {
  type AudioChannelLayout,
  type AudioPassthroughCodec,
  type AutoFrameRateMode,
  MAX_REFRESH_RATE_AUDIO_DELAY_MS,
  MIN_REFRESH_RATE_AUDIO_DELAY_MS,
  type RefreshRateBucket,
} from '@elv/domain';
import { clampSyncDelayMs } from './sync-delay';

/** Standard cinema and broadcast frame rates used for Auto Frame-Rate snapping (`#116`, `#188`, `#199`, `#214`). */
export const STANDARD_FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60] as const;

const FPS_SNAP_TOLERANCE = 0.15;
const MAX_VALID_FPS = 240;

const FPS_TO_BUCKET: ReadonlyMap<number, RefreshRateBucket> = new Map<number, RefreshRateBucket>([
  [23.976, '23.976'],
  [24, '24'],
  [25, '25'],
  [29.97, '29.97'],
  [30, '30'],
  [50, '50'],
  [59.94, '59.94'],
  [60, '60'],
]);

/** Display refresh-rate and dynamic-range switching policy forwarded to native and desktop engines (`#116`, `#188`, `#199`, `#214`). */
export interface DisplaySyncPolicy {
  readonly autoFrameRate: AutoFrameRateMode;
  readonly autoDynamicRange: boolean;
}

/** Desktop audio passthrough, exclusive mode, AC3 transcoding, and channel layout configuration (`#213`). */
export interface DesktopAudioOutputConfig {
  readonly passthrough: boolean;
  readonly codecs: readonly AudioPassthroughCodec[];
  readonly exclusive: boolean;
  readonly ac3Encode: boolean;
  readonly channelLayout: AudioChannelLayout;
}

/**
 * Snaps a raw decoded or PTS-estimated frame rate to the closest value in {@link STANDARD_FRAME_RATES}
 * within `0.15` fps tolerance. Rejects non-finite, non-positive, or `> 240` fps inputs.
 */
export function snapStandardFrameRate(rawFps: number): number | undefined {
  if (!Number.isFinite(rawFps) || rawFps <= 0 || rawFps > MAX_VALID_FPS) {
    return undefined;
  }
  let closest: number | undefined;
  let bestDelta = FPS_SNAP_TOLERANCE;
  for (const candidate of STANDARD_FRAME_RATES) {
    const delta = Math.abs(rawFps - candidate);
    if (delta <= bestDelta) {
      bestDelta = delta;
      closest = candidate;
    }
  }
  return closest;
}

/** Maps a raw or snapped frame rate to its canonical {@link RefreshRateBucket} key, or `undefined` if unmatched. */
export function refreshRateBucketKey(fps: number | undefined): RefreshRateBucket | undefined {
  if (fps === undefined) return undefined;
  const snapped = snapStandardFrameRate(fps);
  if (snapped === undefined) return undefined;
  return FPS_TO_BUCKET.get(snapped);
}

/**
 * Resolves the effective audio delay in milliseconds by combining the user's base A/V delay with
 * any per-refresh-rate offset matching `fps`, clamped to `[-30_000, 30_000]` ms (`#115`).
 */
export function resolveEffectiveAudioDelayMs(
  baseDelayMs: number,
  fps: number | undefined,
  byRefreshRate: Readonly<Partial<Record<RefreshRateBucket, number>>> | undefined,
): number {
  const base = Number.isFinite(baseDelayMs) ? baseDelayMs : 0;
  let refreshOffset = 0;
  if (byRefreshRate !== undefined) {
    const bucket = refreshRateBucketKey(fps);
    if (bucket !== undefined) {
      const rawOffset = byRefreshRate[bucket];
      if (typeof rawOffset === 'number' && Number.isFinite(rawOffset)) {
        refreshOffset = Math.round(
          Math.min(
            MAX_REFRESH_RATE_AUDIO_DELAY_MS,
            Math.max(MIN_REFRESH_RATE_AUDIO_DELAY_MS, rawOffset),
          ),
        );
      }
    }
  }
  return clampSyncDelayMs(base + refreshOffset);
}
