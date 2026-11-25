import { describe, expect, it } from 'vitest';
import { computeHeroHeight } from './hero-layout';

describe('computeHeroHeight', () => {
  it('computes landscape hero height clamped to [360, 580] at 62% viewport height', () => {
    expect(computeHeroHeight(820, false, false, true)).toBe(Math.round(820 * 0.62));
    expect(computeHeroHeight(1080, false, true, false)).toBe(580);
    expect(computeHeroHeight(500, false, false, true)).toBe(360);
  });

  it('computes portrait hero height clamped to [360, 460] at 56% viewport height', () => {
    expect(computeHeroHeight(700, true, false, false)).toBe(Math.round(700 * 0.56));
    expect(computeHeroHeight(844, true, false, false)).toBe(460);
    expect(computeHeroHeight(500, true, false, false)).toBe(360);
  });

  it('falls back to 720px safe height when viewportHeight is invalid', () => {
    expect(computeHeroHeight(0, false, false, true)).toBe(Math.round(720 * 0.62));
    expect(computeHeroHeight(Number.NaN, true, false, false)).toBe(Math.round(720 * 0.56));
  });
});
