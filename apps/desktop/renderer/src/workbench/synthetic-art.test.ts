import { describe, expect, it } from 'vitest';
import {
  createSyntheticArtwork,
  HERO_SPOTLIGHTS,
  POSTER_CATALOG,
  SYNTHETIC_ARTWORK_BY_ID,
  WIDE_RAIL_ITEMS,
} from './synthetic-art.ts';

describe('synthetic-art generator', () => {
  it('generates valid, deterministic data:image/svg+xml URIs with zero external network URLs', () => {
    const first = createSyntheticArtwork({
      id: 'test-horizon',
      aspect: '16:9',
      palette: ['#070B14', '#16243D', '#E11D48', '#38BDF8'],
      motif: 'horizon',
    });
    const second = createSyntheticArtwork({
      id: 'test-horizon',
      aspect: '16:9',
      palette: ['#070B14', '#16243D', '#E11D48', '#38BDF8'],
      motif: 'horizon',
    });

    expect(first).toBe(second);
    expect(first.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    const decoded = decodeURIComponent(first.slice('data:image/svg+xml;utf8,'.length));
    expect(decoded).toContain('<svg ');
    expect(decoded).toContain('viewBox="0 0 640 360"');
    expect(decoded).toContain('</svg>');
    const withoutXmlns = decoded.replace('xmlns="http://www.w3.org/2000/svg"', '');
    expect(withoutXmlns).not.toMatch(/https?:\/\//i);
  });

  it('uses 2:3 viewBox for poster artwork and 16:9 viewBox for hero/wide artwork', () => {
    const posterUri = createSyntheticArtwork({
      id: 'test-poster',
      aspect: '2:3',
      palette: ['#0A0812', '#22183A', '#A855F7', '#F472B6'],
      motif: 'lanterns',
    });
    const decoded = decodeURIComponent(posterUri.slice('data:image/svg+xml;utf8,'.length));
    expect(decoded).toContain('viewBox="0 0 360 540"');
  });

  it('covers all hero spotlights, wide rail items, and 6 poster cards with CSP-safe SVG data URIs', () => {
    expect(HERO_SPOTLIGHTS).toHaveLength(3);
    expect(WIDE_RAIL_ITEMS.length).toBeGreaterThanOrEqual(4);
    expect(POSTER_CATALOG).toHaveLength(6);

    const allItems = [...HERO_SPOTLIGHTS, ...WIDE_RAIL_ITEMS, ...POSTER_CATALOG];
    for (const item of allItems) {
      expect(item.imageUri.startsWith('data:image/svg+xml;utf8,')).toBe(true);
      expect(item.imageUri.includes('#')).toBe(false);
      expect(item.imageUri).not.toMatch(/https?:\/\//i);
      expect(SYNTHETIC_ARTWORK_BY_ID[item.id]).toBe(item.imageUri);
    }
    expect(WIDE_RAIL_ITEMS.map((item) => item.title)).toContain('Velvet Cinema 4K');
    expect(WIDE_RAIL_ITEMS.map((item) => item.title)).toContain('Pitch Sports 1');
  });
});
