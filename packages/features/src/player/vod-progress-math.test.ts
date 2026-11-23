import { createAppI18n } from '@elv/i18n';
import { describe, expect, it } from 'vitest';
import {
  cycleOsdTimeDisplayMode,
  FINE_SCRUB_QUARTER_DY_PX,
  FINE_SCRUB_ULTRA_DY_PX,
  formatPlaybackPosition,
  formatVodEndAccessibilityLabel,
  formatVodEndTimestamp,
  formatWallClockHm,
  integrateFineScrubStep,
  resolveTouchScrubTier,
} from './vod-progress-math';

const i18nEn = createAppI18n('en');
const i18nTr = createAppI18n('tr');

describe('vod-progress-math (#160, #355)', () => {
  it('cycles total -> remaining -> endsAt -> total', () => {
    expect(cycleOsdTimeDisplayMode('total')).toBe('remaining');
    expect(cycleOsdTimeDisplayMode('remaining')).toBe('endsAt');
    expect(cycleOsdTimeDisplayMode('endsAt')).toBe('total');
  });

  it('formats total, -remaining, and speed-adjusted Ends at HH:MM timestamps (#160)', () => {
    expect(formatPlaybackPosition(31_000)).toBe('0:31');
    expect(formatPlaybackPosition(Number.NaN)).toBe('0:00');
    expect(formatVodEndTimestamp(31_000, undefined, 1, 'total', 0, i18nEn)).toBe('--:--');

    const total = formatVodEndTimestamp(31_000, 1_252_000, 1, 'total', 0, i18nEn);
    expect(total).toBe('20:52');

    const rem = formatVodEndTimestamp(31_000, 1_252_000, 1, 'remaining', 0, i18nEn);
    expect(rem).toBe('-20:21');

    // Local 20:00 + 60m remaining at 2x speed = 20:30
    const baseWall = new Date(2026, 10, 22, 20, 0, 0).getTime();
    expect(formatWallClockHm(baseWall)).toBe('20:00');
    const endsAt2x = formatVodEndTimestamp(0, 3_600_000, 2, 'endsAt', baseWall, i18nEn);
    expect(endsAt2x).toBe('Ends at 20:30');

    const endsAt1x = formatVodEndTimestamp(0, 3_600_000, 1, 'endsAt', baseWall, i18nEn);
    expect(endsAt1x).toBe('Ends at 21:00');
  });

  it('clamps remaining time >= 0 on overshoot, scales by playback speed, and formats non-negative accessibility labels (#133)', () => {
    // 60m remaining at 2x speed -> -30:00 wall remaining & "30:00 remaining" announcement
    expect(formatVodEndTimestamp(0, 3_600_000, 2, 'remaining', 0, i18nEn)).toBe('-30:00');
    expect(formatVodEndAccessibilityLabel(0, 3_600_000, 2, 'remaining', 0, i18nEn)).toBe(
      '30:00 remaining',
    );
    expect(formatVodEndAccessibilityLabel(0, 3_600_000, 2, 'remaining', 0, i18nTr)).toBe(
      '30:00 kaldı',
    );

    // Overshoot (positionMs > durationMs) strictly clamps to 0:00, never negative
    expect(formatVodEndTimestamp(5_000_000, 1_252_000, 1, 'remaining', 0, i18nEn)).toBe('-0:00');
    expect(formatVodEndAccessibilityLabel(5_000_000, 1_252_000, 1, 'remaining', 0, i18nEn)).toBe(
      '0:00 remaining',
    );
    expect(formatVodEndAccessibilityLabel(10_000, undefined, 1, 'remaining', 0, i18nEn)).toBe(
      '--:--',
    );
  });

  it('resolves fine-scrub tiers and integrates incrementally with zero jump across tier boundaries (#355)', () => {
    expect(resolveTouchScrubTier(0)).toEqual({ tier: 'normal', multiplier: 1 });
    expect(resolveTouchScrubTier(FINE_SCRUB_QUARTER_DY_PX - 1)).toEqual({
      tier: 'normal',
      multiplier: 1,
    });
    expect(resolveTouchScrubTier(FINE_SCRUB_QUARTER_DY_PX)).toEqual({
      tier: 'quarter',
      multiplier: 0.25,
    });
    expect(resolveTouchScrubTier(FINE_SCRUB_ULTRA_DY_PX)).toEqual({
      tier: 'fine',
      multiplier: 0.1,
    });

    // Step 1: drag right 100px on 400px track at dy=0 (1x) -> +0.25 (0.2 -> 0.45)
    const s1 = integrateFineScrubStep({ prevRatio: 0.2, dxDelta: 100, width: 400, absDy: 10 });
    expect(s1.tier).toBe('normal');
    expect(s1.nextRatio).toBeCloseTo(0.45, 5);

    // Step 2: slide vertically to dy=80 (0.25x) with dxDelta=0 -> ZERO jump!
    const s2 = integrateFineScrubStep({
      prevRatio: s1.nextRatio,
      dxDelta: 0,
      width: 400,
      absDy: 80,
    });
    expect(s2.tier).toBe('quarter');
    expect(s2.nextRatio).toBeCloseTo(0.45, 5);

    // Step 3: drag right 40px at 0.25x -> +(40/400)*0.25 = +0.025 (0.45 -> 0.475)
    const s3 = integrateFineScrubStep({
      prevRatio: s2.nextRatio,
      dxDelta: 40,
      width: 400,
      absDy: 80,
    });
    expect(s3.nextRatio).toBeCloseTo(0.475, 5);

    // Step 4: slide up further to dy=140 (0.1x) with dxDelta=40 -> +(40/400)*0.1 = +0.01 (0.475 -> 0.485)
    const s4 = integrateFineScrubStep({
      prevRatio: s3.nextRatio,
      dxDelta: 40,
      width: 400,
      absDy: 140,
    });
    expect(s4.tier).toBe('fine');
    expect(s4.nextRatio).toBeCloseTo(0.485, 5);

    // Step 5: slide back down to dy=10 (1x) with dxDelta=0 -> ZERO jump!
    const s5 = integrateFineScrubStep({
      prevRatio: s4.nextRatio,
      dxDelta: 0,
      width: 400,
      absDy: 10,
    });
    expect(s5.tier).toBe('normal');
    expect(s5.nextRatio).toBeCloseTo(0.485, 5);
  });
});
