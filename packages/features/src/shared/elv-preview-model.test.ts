import { describe, expect, it } from 'vitest';
import {
  buildElvPreviewState,
  ELV_PREVIEW_DUPLICATE_FILENAMES,
  ELV_PREVIEW_MESSAGE_KEYS,
} from './elv-preview-model';

describe('buildElvPreviewState', () => {
  it('computes all-clean state when master switch and all 3 sub-features are enabled', () => {
    const state = buildElvPreviewState({
      elvModeEnabled: true,
      mergeVersions: true,
      enrichMetadata: true,
      imdbCategories: true,
    });

    expect(state.effectiveMerge).toBe(true);
    expect(state.effectivePosters).toBe(true);
    expect(state.effectiveCategories).toBe(true);
    expect(state.allClean).toBe(true);
    expect(state.badgeKey).toBe('elv.preview.badgeClean');
    expect(state.captionKey).toBe('elv.preview.captionAllOn');

    expect(state.categories).toEqual([
      { id: 'scifi', labelKey: 'elv.preview.genre.scifi', clean: true, active: true },
      { id: 'drama', labelKey: 'elv.preview.genre.drama', clean: true, active: false },
      { id: 'thriller', labelKey: 'elv.preview.genre.thriller', clean: true, active: false },
      { id: 'mystery', labelKey: 'elv.preview.genre.mystery', clean: true, active: false },
    ]);

    expect(state.cards).toHaveLength(4);
    expect(state.cards.map((c) => c.titleKey)).toEqual([
      'elv.preview.film1.title',
      'elv.preview.film2.title',
      'elv.preview.film3.title',
      'elv.preview.film4.title',
    ]);
    expect(state.cards.map((c) => c.artworkId)).toEqual([
      'velvet-meridian',
      'solar-drift',
      'glass-harbor',
      'cinder-waltz',
    ]);
    expect(state.cards.map((c) => `${c.year}:${c.rating}`)).toEqual([
      '2025:8.8',
      '2024:8.5',
      '2023:8.2',
      '2025:8.6',
    ]);
    expect(state.cards.every((c) => c.cleanPoster && !c.isDuplicate)).toBe(true);
  });

  it('collapses all effective flags to false when master elvModeEnabled is false', () => {
    const state = buildElvPreviewState({
      elvModeEnabled: false,
      mergeVersions: true,
      enrichMetadata: true,
      imdbCategories: true,
    });

    expect(state.effectiveMerge).toBe(false);
    expect(state.effectivePosters).toBe(false);
    expect(state.effectiveCategories).toBe(false);
    expect(state.allClean).toBe(false);
    expect(state.badgeKey).toBe('elv.preview.badgeRaw');
    expect(state.captionKey).toBe('elv.preview.captionChaos');

    expect(state.categories).toEqual([
      { id: 'raw-1', labelKey: 'elv.preview.rawCat1', clean: false, active: true },
      { id: 'raw-2', labelKey: 'elv.preview.rawCat2', clean: false, active: false },
      { id: 'raw-3', labelKey: 'elv.preview.rawCat3', clean: false, active: false },
    ]);

    expect(state.cards).toHaveLength(4);
    expect(state.cards.map((c) => c.rawFilename)).toEqual([...ELV_PREVIEW_DUPLICATE_FILENAMES]);
    expect(state.cards.every((c) => c.isDuplicate && !c.cleanPoster && c.titleKey === null)).toBe(
      true,
    );
    expect(state.cards.every((c) => c.artworkId === 'velvet-meridian')).toBe(true);
  });

  it('splits into 4 duplicate Velvet Meridian copies with clean posters when only mergeVersions is false', () => {
    const state = buildElvPreviewState({
      elvModeEnabled: true,
      mergeVersions: false,
      enrichMetadata: true,
      imdbCategories: true,
    });

    expect(state.effectiveMerge).toBe(false);
    expect(state.effectivePosters).toBe(true);
    expect(state.effectiveCategories).toBe(true);
    expect(state.allClean).toBe(false);
    expect(state.badgeKey).toBe('elv.preview.badgeRaw');
    expect(state.captionKey).toBe('elv.preview.captionChaos');
    expect(state.categories).toHaveLength(4);
    expect(state.cards.every((c) => c.isDuplicate && c.cleanPoster)).toBe(true);
    expect(state.cards.map((c) => c.rawFilename)).toEqual([
      '[TR] VELVET MERIDIAN 4K UHD HEVC',
      '[TR] Velvet.Meridian.2025.FHD.NEW',
      'VELVET MERIDIAN (SD) BACKUP',
      'VELVET_MERIDIAN_CAM_v2',
    ]);
  });

  it('keeps 4 distinct films with broken raw posters when only enrichMetadata is false', () => {
    const state = buildElvPreviewState({
      elvModeEnabled: true,
      mergeVersions: true,
      enrichMetadata: false,
      imdbCategories: true,
    });

    expect(state.effectiveMerge).toBe(true);
    expect(state.effectivePosters).toBe(false);
    expect(state.effectiveCategories).toBe(true);
    expect(state.allClean).toBe(false);
    expect(state.cards.map((c) => c.artworkId)).toEqual([
      'velvet-meridian',
      'solar-drift',
      'glass-harbor',
      'cinder-waltz',
    ]);
    expect(state.cards.every((c) => !c.cleanPoster && !c.isDuplicate)).toBe(true);
  });

  it('shows 3 raw IPTV spam folders while keeping clean merged posters when only imdbCategories is false', () => {
    const state = buildElvPreviewState({
      elvModeEnabled: true,
      mergeVersions: true,
      enrichMetadata: true,
      imdbCategories: false,
    });

    expect(state.effectiveMerge).toBe(true);
    expect(state.effectivePosters).toBe(true);
    expect(state.effectiveCategories).toBe(false);
    expect(state.allClean).toBe(false);
    expect(state.categories).toHaveLength(3);
    expect(state.categories.every((cat) => !cat.clean)).toBe(true);
    expect(state.cards.every((c) => c.cleanPoster && !c.isDuplicate)).toBe(true);
  });

  it('declares all 18 Wave E3 elv.preview.* message keys', () => {
    expect(ELV_PREVIEW_MESSAGE_KEYS).toHaveLength(18);
  });
});
