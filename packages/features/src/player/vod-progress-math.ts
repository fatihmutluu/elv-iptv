import type { OsdTimeDisplayMode } from '@elv/domain';
import type { AppI18n } from '@elv/i18n';

/** Touch fine-scrubbing sensitivity tiers (`#355`). */
export type TouchScrubSensitivityTier = 'normal' | 'quarter' | 'fine';

/** Vertical displacement (px) threshold entering `0.25×` fine scrubbing (`#355`). */
export const FINE_SCRUB_QUARTER_DY_PX = 56;

/** Vertical displacement (px) threshold entering `0.1×` ultra-fine scrubbing (`#355`). */
export const FINE_SCRUB_ULTRA_DY_PX = 116;

/** Formats a millisecond playback timestamp as `m:ss` or `h:mm:ss`. */
export function formatPlaybackPosition(ms: number): string {
  if (!Number.isFinite(ms)) return '0:00';
  const clamped = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(clamped % 60).padStart(2, '0');
  const minutes = Math.floor(clamped / 60);
  if (minutes < 60) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}

/** Formats a Unix epoch timestamp (ms) as local `HH:MM` (`#160`). */
export function formatWallClockHm(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '--:--';
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Cycles the OSD right-hand timestamp mode: `total -> remaining -> endsAt -> total` (`#160`). */
export function cycleOsdTimeDisplayMode(mode: OsdTimeDisplayMode): OsdTimeDisplayMode {
  if (mode === 'total') return 'remaining';
  if (mode === 'remaining') return 'endsAt';
  return 'total';
}

/**
 * Formats the VOD right-hand timestamp according to {@link OsdTimeDisplayMode} (`#160`):
 * - `'total'`: total duration (e.g. `20:52`)
 * - `'remaining'`: negated remaining duration (e.g. `-20:21`)
 * - `'endsAt'`: speed-adjusted projected wall-clock end time (e.g. `Ends at 21:14`)
 */
export function formatVodEndTimestamp(
  positionMs: number,
  durationMs: number | undefined,
  playbackSpeed: number,
  mode: OsdTimeDisplayMode,
  wallClockMs: number,
  i18n: Pick<AppI18n, 't'>,
): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) {
    return '--:--';
  }
  const safePos = Number.isFinite(positionMs) ? Math.min(Math.max(0, positionMs), durationMs) : 0;
  if (mode === 'total') return formatPlaybackPosition(durationMs);
  const remainingMs = Math.max(0, durationMs - safePos);
  if (mode === 'remaining') return `-${formatPlaybackPosition(remainingMs)}`;
  const speed =
    Number.isFinite(playbackSpeed) && playbackSpeed > 0 ? Math.max(0.25, playbackSpeed) : 1;
  const endEpochMs = wallClockMs + remainingMs / speed;
  return i18n.t('player.endsAt', { time: formatWallClockHm(endEpochMs) });
}

/** Resolves the touch fine-scrubbing tier and horizontal multiplier from vertical displacement `|dy|` (`#355`). */
export function resolveTouchScrubTier(absDy: number): {
  readonly tier: TouchScrubSensitivityTier;
  readonly multiplier: number;
} {
  if (!Number.isFinite(absDy) || absDy < FINE_SCRUB_QUARTER_DY_PX) {
    return { tier: 'normal', multiplier: 1 };
  }
  if (absDy < FINE_SCRUB_ULTRA_DY_PX) {
    return { tier: 'quarter', multiplier: 0.25 };
  }
  return { tier: 'fine', multiplier: 0.1 };
}

/** Clamps a normalized ratio into `[0, 1]`. */
export function clampProgressRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Integrates one incremental horizontal touch-scrub step cleanly without playhead jumps across
 * sensitivity boundaries (`#355`).
 */
export function integrateFineScrubStep(params: {
  readonly prevRatio: number;
  readonly dxDelta: number;
  readonly width: number;
  readonly absDy: number;
}): {
  readonly nextRatio: number;
  readonly tier: TouchScrubSensitivityTier;
  readonly multiplier: number;
} {
  const { tier, multiplier } = resolveTouchScrubTier(params.absDy);
  if (!Number.isFinite(params.width) || params.width <= 0 || !Number.isFinite(params.dxDelta)) {
    return { nextRatio: clampProgressRatio(params.prevRatio), tier, multiplier };
  }
  const nextRatio = clampProgressRatio(
    params.prevRatio + (params.dxDelta / params.width) * multiplier,
  );
  return { nextRatio, tier, multiplier };
}
