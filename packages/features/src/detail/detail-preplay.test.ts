import { describe, expect, it } from 'vitest';
import {
  computeDetailHeroHeight,
  computeSynopsisCharBudget,
  SYNOPSIS_INLINE_BUDGET_LANDSCAPE,
  SYNOPSIS_INLINE_BUDGET_PORTRAIT,
  truncateSynopsisForInline,
} from './detail-preplay';

describe('detail-preplay Wave R2 helpers', () => {
  describe('computeDetailHeroHeight', () => {
    it('sizes desktop and TV landscape hero to ~76% viewport height clamped to [520, 760]', () => {
      expect(computeDetailHeroHeight(720, false, false, true)).toBe(Math.round(720 * 0.76));
      expect(computeDetailHeroHeight(800, false, false, true)).toBe(Math.round(800 * 0.76));
      expect(computeDetailHeroHeight(900, false, false, true)).toBe(Math.round(900 * 0.76));
      expect(computeDetailHeroHeight(1080, false, true, false)).toBe(760);
      expect(computeDetailHeroHeight(600, false, false, true)).toBe(520);
    });

    it('sizes non-desktop landscape responsibly and keeps portrait comfortable at [460, 540]', () => {
      expect(computeDetailHeroHeight(834, false, false, false)).toBe(Math.round(834 * 0.76));
      expect(computeDetailHeroHeight(393, false, false, false)).toBe(340);

      expect(computeDetailHeroHeight(844, true, false, false)).toBe(Math.round(844 * 0.6));
      expect(computeDetailHeroHeight(1194, true, false, false)).toBe(540);
      expect(computeDetailHeroHeight(667, true, false, false)).toBe(460);
    });

    it('falls back cleanly when viewportHeight is invalid', () => {
      expect(computeDetailHeroHeight(0, false, false, true)).toBe(Math.round(720 * 0.76));
      expect(computeDetailHeroHeight(Number.NaN, true, false, false)).toBe(460);
    });
  });

  describe('computeSynopsisCharBudget & truncateSynopsisForInline', () => {
    it('exposes realistic 3-line default budgets for landscape and portrait', () => {
      expect(SYNOPSIS_INLINE_BUDGET_LANDSCAPE).toBe(235);
      expect(SYNOPSIS_INLINE_BUDGET_PORTRAIT).toBe(145);
      expect(computeSynopsisCharBudget(660, 1, false)).toBe(235);
      expect(computeSynopsisCharBudget(660, 1.2, false)).toBeLessThan(210);
      expect(computeSynopsisCharBudget(340, 1, true)).toBeLessThanOrEqual(145);
      expect(computeSynopsisCharBudget(0, 1.2, false)).toBe(
        computeSynopsisCharBudget(660, 1.2, false),
      );
      expect(computeSynopsisCharBudget(0, 0.9, false)).toBe(
        computeSynopsisCharBudget(660, 0.9, false),
      );
      expect(computeSynopsisCharBudget(0, 1.2, true)).toBe(121);
      expect(computeSynopsisCharBudget(0, 0.9, true)).toBe(161);
    });

    it('never truncates empty or short synopses within 3-line budget', () => {
      expect(truncateSynopsisForInline('   ', 235)).toEqual({ text: '', truncated: false });

      const shortPlot =
        'A veteran astronomer stationed at a frozen northern observatory detects a faint rhythmic pulse from an uncharted exoplanet.';
      expect(shortPlot.length).toBeLessThan(235);
      expect(truncateSynopsisForInline(shortPlot, 235)).toEqual({
        text: shortPlot,
        truncated: false,
      });

      const exact230 = 'A'.repeat(230);
      expect(truncateSynopsisForInline(exact230, 235)).toEqual({
        text: exact230,
        truncated: false,
      });
    });

    it('truncates synopses with more than 3 explicit lines even when character count is short', () => {
      const multiline = 'Line one\nLine two\nLine three\nLine four';
      const result = truncateSynopsisForInline(multiline, 235);
      expect(result.truncated).toBe(true);
      expect(result.text).toBe('Line one Line two Line three');
    });

    it('clamps genuinely overflowing prose cleanly at a word boundary without trailing punctuation noise', () => {
      const longPlot =
        'In a quiet orbital listening station suspended above the twilight meridian, a veteran engineer uncovers a recurring signal hidden beneath decades of archived telemetry. As rival relays begin shutting down one by one, the crew must decide whether to broadcast the message back home or seal the beacon forever.';
      const res = truncateSynopsisForInline(longPlot, 235);
      expect(res.truncated).toBe(true);
      expect(res.text.length).toBeLessThanOrEqual(220);
      expect(res.text.length).toBeGreaterThan(170);
      expect(res.text.endsWith(' ')).toBe(false);
      expect(res.text.endsWith(',')).toBe(false);
      // Should not cut inside the middle of a word
      expect(longPlot.startsWith(res.text)).toBe(true);
      const nextChar = longPlot.charAt(res.text.length);
      expect([' ', ',', '.', ';', ':'].includes(nextChar)).toBe(true);
    });
  });
});
