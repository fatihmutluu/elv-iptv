import type { ElvItemEnrichment, ItemDetailRow } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { describe, expect, it } from 'vitest';
import {
  computeHoverPreviewRect,
  createHoverMetadataCache,
  formatHoverPreviewMeta,
  HOVER_PREVIEW_CLOSE_DELAY_MS,
  HOVER_PREVIEW_OPEN_DELAY_MS,
  HOVER_PREVIEW_VIEWPORT_MARGIN_PX,
  mergeHoverPreviewMetadata,
  translateHoverCardKey,
} from './poster-hover-preview-model';

describe('poster-hover-preview-model', () => {
  it('defines canonical 350ms dwell and 160ms close grace constants', () => {
    expect(HOVER_PREVIEW_OPEN_DELAY_MS).toBe(350);
    expect(HOVER_PREVIEW_CLOSE_DELAY_MS).toBe(160);
    expect(HOVER_PREVIEW_VIEWPORT_MARGIN_PX).toBe(12);
  });

  it('computes centered, slightly elevated expanded preview rect within proportional bounds', () => {
    const pos = computeHoverPreviewRect(
      { x: 400, y: 260, width: 176, height: 264 },
      { width: 1440, height: 900 },
    );
    expect(pos.width).toBe(260); // round(176 * 1.48) = 260
    expect(pos.left).toBe(Math.round(400 + 176 / 2 - 260 / 2)); // 358
    expect(pos.top).toBeLessThan(260);
    expect(pos.top).toBeGreaterThanOrEqual(12);
    expect(pos.left + pos.width).toBeLessThanOrEqual(1440 - 12);
  });

  it('clamps min/max expanded widths and all 4 viewport edges strictly inside 12px margins', () => {
    const narrowCard = computeHoverPreviewRect(
      { x: 4, y: 4, width: 120, height: 180 },
      { width: 1280, height: 720 },
    );
    expect(narrowCard.width).toBe(256);
    expect(narrowCard.left).toBe(12);
    expect(narrowCard.top).toBe(12);

    const wideCard = computeHoverPreviewRect(
      { x: 1180, y: 600, width: 220, height: 330 },
      { width: 1280, height: 720 },
    );
    expect(wideCard.width).toBe(284);
    expect(wideCard.left).toBe(1280 - 284 - 12);
    expect(wideCard.height).toBe(472);
    expect(wideCard.top + wideCard.height).toBeLessThanOrEqual(720 - 12);
    expect(wideCard.top + wideCard.maxHeight).toBeLessThanOrEqual(720 - 12);

    const shortViewportBottom = computeHoverPreviewRect(
      { x: 400, y: 360, width: 170, height: 255 },
      { width: 1280, height: 500 },
    );
    expect(shortViewportBottom.top).toBeGreaterThanOrEqual(12);
    expect(shortViewportBottom.top + shortViewportBottom.maxHeight).toBeLessThanOrEqual(500 - 12);

    const tinyViewport = computeHoverPreviewRect(
      { x: 20, y: 20, width: 160, height: 240 },
      { width: 240, height: 320 },
    );
    expect(tinyViewport.left).toBe(12);
    expect(tinyViewport.top).toBe(12);
    expect(tinyViewport.width).toBe(216);
  });

  it('formats Year · ★ Rating · Runtime cleanly when any subset is present', () => {
    expect(
      formatHoverPreviewMeta({
        year: 2024,
        rating: 8.65,
        runtimeMin: 148,
        formatRuntime: (min) => `${min}m`,
      }),
    ).toBe('2024 · ★ 8.7 · 148m');
    expect(
      formatHoverPreviewMeta({
        year: null,
        rating: 7.4,
        runtimeMin: null,
        formatRuntime: (min) => `${min}m`,
      }),
    ).toBe('★ 7.4');
    expect(
      formatHoverPreviewMeta({
        year: null,
        rating: null,
        runtimeMin: 0,
        formatRuntime: (min) => `${min}m`,
      }),
    ).toBeUndefined();
  });

  it('maintains a bounded LRU metadata cache keyed by catalogRevision, locale, and itemKey', () => {
    const cache = createHoverMetadataCache(2);
    const metaA = {
      title: 'Film A',
      backdropUri: 'https://art.example/a-bg.jpg',
      year: 2024,
      rating: 8.2,
      runtimeMin: 112,
      plot: 'Plot A',
      trailerStreamUrl: null,
      trailerYoutubeId: 'dQw4w9WgXcQ',
    };
    const metaB = { ...metaA, title: 'Film B' };
    const metaC = { ...metaA, title: 'Film C' };

    cache.set(1, 'en', 'k1', metaA);
    cache.set(1, 'en', 'k2', metaB);
    // Touch k1 so k2 becomes LRU
    expect(cache.get(1, 'en', 'k1')).toEqual(metaA);
    // Different locale/revision is isolated
    expect(cache.get(1, 'tr', 'k1')).toBeUndefined();
    expect(cache.get(2, 'en', 'k1')).toBeUndefined();

    cache.set(1, 'en', 'k3', metaC);
    expect(cache.get(1, 'en', 'k2')).toBeUndefined();
    expect(cache.get(1, 'en', 'k1')).toEqual(metaA);
    expect(cache.get(1, 'en', 'k3')).toEqual(metaC);

    cache.clear();
    expect(cache.get(1, 'en', 'k1')).toBeUndefined();
  });

  it('merges provider ItemDetailRow and ELV title enrichment cleanly', () => {
    const detailRow: ItemDetailRow = {
      id: 1,
      key: 'x:s1:movie:1',
      sourceId: 's1',
      providerId: '1',
      kind: 'movie',
      name: 'Raw Movie [4K]',
      logo: 'https://art.example/poster.jpg',
      num: null,
      year: 2023,
      rating: 7.9,
      plot: 'Provider synopsis.',
    };
    const enrichment: ElvItemEnrichment = {
      itemKey: 'x:s1:movie:1',
      sourceId: 's1',
      mediaType: 'movie',
      imdbId: 'tt1234567',
      confidence: 0.99,
      manualLock: false,
      title: {
        imdbId: 'tt1234567',
        mediaType: 'movie',
        originalTitle: 'Dune: Part Two',
        englishTitle: 'Dune: Part Two',
        localizedTitles: { tr: 'Dune: Çöl Gezegeni Bölüm İki' },
        year: 2024,
        rating: 8.8,
        votes: 100_000,
        runtimeMin: 166,
        genres: ['Sci-Fi'],
        posterUrl: 'https://art.example/elv-poster.jpg',
        backdropUrl: 'https://art.example/elv-backdrop.jpg',
        trailerStreamUrl: 'https://cdn.example/trailer.mp4',
        trailerYoutubeId: 'Way9Dexny3w',
        director: null,
        cast: [],
        mltImdbIds: [],
        franchiseKey: null,
        franchiseName: null,
        franchiseOrder: null,
        synopses: {
          en: 'English ELV synopsis.',
          tr: 'Türkçe ELV özeti.',
        },
        detailFetchedAt: 100,
        updatedAt: 100,
      },
    };

    const mergedTr = mergeHoverPreviewMetadata(
      {
        title: 'Fallback',
        backdropUri: null,
        year: null,
        rating: null,
        overview: null,
      },
      detailRow,
      enrichment.title,
      'tr',
    );
    expect(mergedTr).toEqual({
      title: 'Dune: Çöl Gezegeni Bölüm İki',
      backdropUri: 'https://art.example/elv-backdrop.jpg',
      year: 2024,
      rating: 8.8,
      runtimeMin: 166,
      plot: 'Türkçe ELV özeti.',
      trailerStreamUrl: 'https://cdn.example/trailer.mp4',
      trailerYoutubeId: 'Way9Dexny3w',
    });

    const fallbackOnly = mergeHoverPreviewMetadata(
      {
        title: 'Local Film',
        backdropUri: null,
        year: 2021,
        rating: 7.2,
        overview: 'Baseline overview.',
      },
      detailRow,
      null,
      'en',
    );
    expect(fallbackOnly).toEqual({
      title: 'Raw Movie [4K]',
      backdropUri: null,
      year: 2023,
      rating: 7.9,
      runtimeMin: null,
      plot: 'Provider synopsis.',
      trailerStreamUrl: null,
      trailerYoutubeId: null,
    });
  });

  it('translates hover card keys in EN and TR cleanly with fallback before or after i18n registration', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    expect(translateHoverCardKey(en, 'card.hoverPlay')).not.toBe('card.hoverPlay');
    expect(translateHoverCardKey(en, 'card.dontRecommend')).not.toBe('card.dontRecommend');
    expect(translateHoverCardKey(en, 'card.hoverUnavailable')).not.toBe('card.hoverUnavailable');
    expect(translateHoverCardKey(tr, 'card.dontRecommend')).not.toBe('card.dontRecommend');
    expect(translateHoverCardKey(tr, 'card.hoverPlay')).not.toBe('card.hoverPlay');
    expect(translateHoverCardKey(tr, 'card.dontRecommend')).not.toBe(
      translateHoverCardKey(en, 'card.dontRecommend'),
    );
  });
});
