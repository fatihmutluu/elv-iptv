import type { MessageId } from '@elv/i18n';

/** All 18 `@elv/i18n` message keys consumed by {@link buildElvPreviewState} and `ElvModeInteractivePreview`. */
export const ELV_PREVIEW_MESSAGE_KEYS = [
  'elv.preview.badgeClean',
  'elv.preview.badgeRaw',
  'elv.preview.captionAllOn',
  'elv.preview.captionChaos',
  'elv.preview.genre.scifi',
  'elv.preview.genre.drama',
  'elv.preview.genre.thriller',
  'elv.preview.genre.mystery',
  'elv.preview.rawCat1',
  'elv.preview.rawCat2',
  'elv.preview.rawCat3',
  'elv.preview.film1.title',
  'elv.preview.film2.title',
  'elv.preview.film3.title',
  'elv.preview.film4.title',
  'elv.preview.rawNoPoster',
  'elv.preview.rawNoRating',
  'elv.preview.duplicateTag',
] as const satisfies readonly MessageId[];

/** Exact subset of {@link MessageId} used by the interactive ELV Mode preview. */
type ElvPreviewMessageKey = (typeof ELV_PREVIEW_MESSAGE_KEYS)[number];

/** Original royalty-free fictional film artwork identifiers rendered by `ElvModeInteractivePreview`. */
export type ElvPreviewArtworkId =
  | 'velvet-meridian'
  | 'solar-drift'
  | 'glass-harbor'
  | 'cinder-waltz';

/** Input toggles controlling the live 4-card ELV Mode interactive preview. */
export interface ElvPreviewOptions {
  readonly elvModeEnabled: boolean;
  readonly mergeVersions: boolean;
  readonly enrichMetadata: boolean;
  readonly imdbCategories: boolean;
}

/** One category item rendered in the preview category bar. */
interface ElvPreviewCategory {
  readonly id: string;
  readonly slotKey: string;
  readonly labelKey: ElvPreviewMessageKey;
  readonly clean: boolean;
  readonly active: boolean;
}

/** One poster card rendered in the 4-card interactive ELV Mode preview. */
export interface ElvPreviewCard {
  readonly id: string;
  readonly slotKey: string;
  readonly artworkId: ElvPreviewArtworkId;
  readonly titleKey: ElvPreviewMessageKey | null;
  readonly rawFilename: string;
  readonly year: string;
  readonly rating: string;
  readonly cleanPoster: boolean;
  readonly isDuplicate: boolean;
  readonly rawQualityTag: string;
}

/** Pure derived view-model returned by {@link buildElvPreviewState}. */
export interface ElvPreviewState {
  readonly effectiveMerge: boolean;
  readonly effectivePosters: boolean;
  readonly effectiveCategories: boolean;
  readonly allClean: boolean;
  readonly badgeKey: ElvPreviewMessageKey;
  readonly captionKey: ElvPreviewMessageKey;
  readonly categories: readonly ElvPreviewCategory[];
  readonly cards: readonly ElvPreviewCard[];
}

/** Messy raw IPTV duplicate filenames displayed side-by-side when version merging is disabled. */
export const ELV_PREVIEW_DUPLICATE_FILENAMES = [
  '[TR] VELVET MERIDIAN 4K UHD HEVC',
  '[TR] Velvet.Meridian.2025.FHD.NEW',
  'VELVET MERIDIAN (SD) BACKUP',
  'VELVET_MERIDIAN_CAM_v2',
] as const;

const CLEAN_CATEGORIES: readonly ElvPreviewCategory[] = [
  {
    id: 'scifi',
    slotKey: 'cat-slot-0',
    labelKey: 'elv.preview.genre.scifi',
    clean: true,
    active: true,
  },
  {
    id: 'drama',
    slotKey: 'cat-slot-1',
    labelKey: 'elv.preview.genre.drama',
    clean: true,
    active: false,
  },
  {
    id: 'thriller',
    slotKey: 'cat-slot-2',
    labelKey: 'elv.preview.genre.thriller',
    clean: true,
    active: false,
  },
  {
    id: 'mystery',
    slotKey: 'cat-slot-3',
    labelKey: 'elv.preview.genre.mystery',
    clean: true,
    active: false,
  },
];

const RAW_CATEGORIES: readonly ElvPreviewCategory[] = [
  {
    id: 'raw-1',
    slotKey: 'cat-slot-0',
    labelKey: 'elv.preview.rawCat1',
    clean: false,
    active: true,
  },
  {
    id: 'raw-2',
    slotKey: 'cat-slot-1',
    labelKey: 'elv.preview.rawCat2',
    clean: false,
    active: false,
  },
  {
    id: 'raw-3',
    slotKey: 'cat-slot-2',
    labelKey: 'elv.preview.rawCat3',
    clean: false,
    active: false,
  },
];

interface FictionalFilmSeed {
  readonly id: string;
  readonly artworkId: ElvPreviewArtworkId;
  readonly titleKey: ElvPreviewMessageKey;
  readonly rawFilename: string;
  readonly year: string;
  readonly rating: string;
  readonly rawQualityTag: string;
}

const FICTIONAL_FILMS: readonly FictionalFilmSeed[] = [
  {
    id: 'film-1',
    artworkId: 'velvet-meridian',
    titleKey: 'elv.preview.film1.title',
    rawFilename: ELV_PREVIEW_DUPLICATE_FILENAMES[0],
    year: '2025',
    rating: '8.8',
    rawQualityTag: '4K',
  },
  {
    id: 'film-2',
    artworkId: 'solar-drift',
    titleKey: 'elv.preview.film2.title',
    rawFilename: 'SOLAR.DRIFT.2024.1080p.TR.DUB',
    year: '2024',
    rating: '8.5',
    rawQualityTag: 'FHD',
  },
  {
    id: 'film-3',
    artworkId: 'glass-harbor',
    titleKey: 'elv.preview.film3.title',
    rawFilename: 'Glass_Harbor_HD_v3_NEW',
    year: '2023',
    rating: '8.2',
    rawQualityTag: 'HD',
  },
  {
    id: 'film-4',
    artworkId: 'cinder-waltz',
    titleKey: 'elv.preview.film4.title',
    rawFilename: '[VOD] CINDER WALTZ 2025 WEB-DL',
    year: '2025',
    rating: '8.6',
    rawQualityTag: 'WEB',
  },
];

const DUPLICATE_QUALITY_TAGS = ['4K', 'FHD', 'SD', 'CAM'] as const;

/**
 * Computes the deterministic 4-card ELV Mode interactive preview state (`#513`).
 * Master `elvModeEnabled` gates all 3 visual enhancement layers independently so toggling any
 * switch immediately transforms categories, deduplication, and poster enrichment.
 */
export function buildElvPreviewState(opts: ElvPreviewOptions): ElvPreviewState {
  const effectiveMerge = opts.elvModeEnabled && opts.mergeVersions;
  const effectivePosters = opts.elvModeEnabled && opts.enrichMetadata;
  const effectiveCategories = opts.elvModeEnabled && opts.imdbCategories;
  const allClean = effectiveMerge && effectivePosters && effectiveCategories;

  const categories = effectiveCategories ? CLEAN_CATEGORIES : RAW_CATEGORIES;

  const cards: readonly ElvPreviewCard[] = effectiveMerge
    ? FICTIONAL_FILMS.map((film, idx) => ({
        id: film.id,
        slotKey: `slot-${idx}`,
        artworkId: film.artworkId,
        titleKey: film.titleKey,
        rawFilename: film.rawFilename,
        year: film.year,
        rating: film.rating,
        cleanPoster: effectivePosters,
        isDuplicate: false,
        rawQualityTag: film.rawQualityTag,
      }))
    : ELV_PREVIEW_DUPLICATE_FILENAMES.map((rawFilename, idx) => ({
        id: `dup-${idx + 1}`,
        slotKey: `slot-${idx}`,
        artworkId: 'velvet-meridian',
        titleKey: null,
        rawFilename,
        year: '2025',
        rating: '8.8',
        cleanPoster: effectivePosters,
        isDuplicate: true,
        rawQualityTag: DUPLICATE_QUALITY_TAGS[idx] ?? 'SD',
      }));

  return {
    effectiveMerge,
    effectivePosters,
    effectiveCategories,
    allClean,
    badgeKey: allClean ? 'elv.preview.badgeClean' : 'elv.preview.badgeRaw',
    captionKey: allClean ? 'elv.preview.captionAllOn' : 'elv.preview.captionChaos',
    categories,
    cards,
  };
}
