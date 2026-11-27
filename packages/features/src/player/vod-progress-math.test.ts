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

describe('vod-progress-math (#160, #355, #507)', () => {
  it('toggles strictly between remaining and total (2-mode cycle)', () => {
    expect(cycleOsdTimeDisplayMode('remaining')).toBe('total');
    expect(cycleOsdTimeDisplayMode('total')).toBe('remaining');
  });

  it('formats elapsed/remaining (no minus sign) and total timestamps (#507)', () => {
    expect(formatPlaybackPosition(31_000)).toBe('0:31');
    expect(formatPlaybackPosition(Number.NaN)).toBe('0:00');
    expect(formatVodEndTimestamp(31_000, undefined, 'remaining')).toBe('--:--');
    expect(formatVodEndTimestamp(31_000, undefined, 'total')).toBe('--:--');

    // Wave P8 canonical example: 20:09 elapsed out of 44:58 total -> 24:49 remaining (no leading minus)
    const elapsedMs = (20 * 60 + 9) * 1000;
    const totalMs = (44 * 60 + 58) * 1000;
    expect(formatPlaybackPosition(elapsedMs)).toBe('20:09');
    expect(formatVodEndTimestamp(elapsedMs, totalMs)).toBe('24:49');
    expect(formatVodEndTimestamp(elapsedMs, totalMs, 'remaining')).toBe('24:49');
    expect(formatVodEndTimestamp(elapsedMs, totalMs, 'total')).toBe('44:58');

    const baseWall = new Date(2026, 10, 22, 20, 0, 0).getTime();
    expect(formatWallClockHm(baseWall)).toBe('20:00');
    expect(formatWallClockHm(Number.NaN)).toBe('--:--');
  });

  it('clamps remaining time >= 0 on overshoot and formats accessible labels for remaining & total (#133, #507)', () => {
    const elapsedMs = (20 * 60 + 9) * 1000;
    const totalMs = (44 * 60 + 58) * 1000;
    expect(formatVodEndAccessibilityLabel(elapsedMs, totalMs, 'remaining', i18nEn)).toBe(
      '24:49 remaining',
    );
    expect(formatVodEndAccessibilityLabel(elapsedMs, totalMs, 'remaining', i18nTr)).toBe(
      '24:49 kaldı',
    );
    expect(formatVodEndAccessibilityLabel(elapsedMs, totalMs, 'total', i18nEn)).toBe(
      `${i18nEn.t('player.totalDuration')}: 44:58`,
    );

    // Overshoot (positionMs > durationMs) strictly clamps to 0:00, never negative
    expect(formatVodEndTimestamp(5_000_000, 1_252_000, 'remaining')).toBe('0:00');
    expect(formatVodEndAccessibilityLabel(5_000_000, 1_252_000, 'remaining', i18nEn)).toBe(
      '0:00 remaining',
    );
    expect(formatVodEndAccessibilityLabel(10_000, undefined, 'remaining', i18nEn)).toBe('--:--');
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
