import type { ElvTitleRecord, ItemDetailRow, ItemRow, RatingValue } from '@elv/data';
import type { AppI18n } from '@elv/i18n';
import { resolveElvLocalizedSynopsis, resolveElvLocalizedValue } from './elv-presentation';

/** Pointer dwell delay (ms) before opening the Desktop expanded hover preview card. */
export const HOVER_PREVIEW_OPEN_DELAY_MS = 350;
/** Pointer leave grace delay (ms) allowing travel from poster card onto the expanded preview card. */
export const HOVER_PREVIEW_CLOSE_DELAY_MS = 160;
/** Minimum viewport inset (px) separating the floating hover preview card from screen edges. */
export const HOVER_PREVIEW_VIEWPORT_MARGIN_PX = 12;
/** Minimum expanded hover preview card width (px) for comfortable 3+3 button layout. */
const HOVER_PREVIEW_MIN_WIDTH = 256;
/** Maximum expanded hover preview card width (px) adapted to vertical 2:3 posters. */
const HOVER_PREVIEW_MAX_WIDTH = 284;
/** Baseline vertical height estimate (px) used to clamp the floating preview card safely inside the viewport. */
const HOVER_PREVIEW_ESTIMATED_HEIGHT = 472;

const HOVER_WIDTH_SCALE = 1.48;
const DEFAULT_ANCHOR_WIDTH = 168;
const MIN_CLAMPED_WIDTH = 180;
const VERTICAL_ELEVATION_FACTOR = 0.45;
const MIN_VERTICAL_LIFT_PX = 24;

/** Measured viewport-relative bounding rectangle of a hovered {@link PosterCard}. */
export interface HoverPreviewRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Logical viewport dimensions used to clamp the expanded hover preview card. */
export interface HoverPreviewViewport {
  readonly width: number;
  readonly height: number;
}

/** Clamped fixed-viewport coordinates and dimensions for {@link PosterHoverPreviewCard}. */
export interface ComputedHoverPreviewRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly maxHeight: number;
}

/** Interactive metadata & action payload supplied when hovering a VOD {@link PosterCard}. */
export interface PosterHoverPreviewEntry {
  readonly itemKey: string;
  readonly sourceId: string;
  readonly kind: 'movie' | 'series';
  readonly categoryId?: string;
  readonly title: string;
  readonly posterUri: string | null;
  readonly backdropUri?: string | null;
  readonly year: number | null;
  readonly rating: number | null;
  readonly overview?: string | null;
  readonly runtimeMin?: number | null;
  readonly trailerStreamUrl?: string | null;
  readonly trailerYoutubeId?: string | null;
  readonly durationMs?: number;
  readonly positionMs?: number;
  readonly watched?: boolean;
  readonly isFavorite?: boolean;
  readonly userRating?: RatingValue | null;
  readonly catalogItem?: ItemRow;
  /** Whether "Don't recommend again" should be shown & enabled (`false` on My List / Collections). */
  readonly allowDismissRecommendation?: boolean;
  readonly onPlay?: () => void;
  readonly onOpenDetail?: () => void;
  readonly onToggleFavorite?: () => unknown;
  readonly onToggleWatched?: (currentWatched: boolean) => unknown;
  readonly onToggleRating?: (next: RatingValue) => unknown;
  readonly onDismissRecommendation?: () => unknown;
}

/** Hydrated metadata snapshot cached per `(catalogRevision, locale, itemKey)`. */
export interface HoverPreviewHydratedMetadata {
  readonly title: string;
  readonly backdropUri: string | null;
  readonly year: number | null;
  readonly rating: number | null;
  readonly runtimeMin: number | null;
  readonly plot: string | null;
  readonly trailerStreamUrl: string | null;
  readonly trailerYoutubeId: string | null;
}

/** Bounded LRU cache storing hydrated hover-preview metadata across revisits. */
export interface HoverMetadataCache {
  get(
    catalogRevision: number,
    locale: string,
    itemKey: string,
  ): HoverPreviewHydratedMetadata | undefined;
  set(
    catalogRevision: number,
    locale: string,
    itemKey: string,
    value: HoverPreviewHydratedMetadata,
  ): void;
  clear(): void;
}

/** Wave R3 card i18n message keys resolved with EN/TR parity before or after `@elv/i18n` updates. */
export type HoverCardMessageId =
  | 'card.dontRecommend'
  | 'card.dontRecommendDone'
  | 'card.hoverPlay'
  | 'card.hoverTrailer'
  | 'card.hoverUnavailable';

const HOVER_CARD_FALLBACKS_EN: Readonly<Record<HoverCardMessageId, string>> = {
  'card.dontRecommend': "Don't recommend again",
  'card.dontRecommendDone': 'Removed from recommendations',
  'card.hoverPlay': 'Play',
  'card.hoverTrailer': 'Trailer',
  'card.hoverUnavailable': 'Unavailable',
};

const HOVER_CARD_FALLBACKS_TR: Readonly<Record<HoverCardMessageId, string>> = {
  'card.dontRecommend': 'Bir daha önerme',
  'card.dontRecommendDone': 'Önerilerden kaldırıldı',
  'card.hoverPlay': 'Oynat',
  'card.hoverTrailer': 'Fragman',
  'card.hoverUnavailable': 'Kullanılamıyor',
};

/** Minimal translator signature compatible with both `AppI18n` and unit-test stubs. */
export interface HoverCardTranslatorLike {
  readonly locale?: string;
  t(id: never, values?: Record<string, string | number>): string;
}

/**
 * Translates a Wave R3 card string through `@elv/i18n`, falling back cleanly to EN/TR copy
 * when running against an un-merged `@elv/i18n` bundle while preserving identity test mocks.
 */
export function translateHoverCardKey(
  translator: HoverCardTranslatorLike | Pick<AppI18n, 'locale' | 't'>,
  id: HoverCardMessageId,
): string {
  const fn = translator.t as (key: string) => string;
  const translated = fn(id);
  if (translated && translated !== id) return translated;
  if (fn('context.play') === 'context.play') return translated;
  return translator.locale === 'tr' ? HOVER_CARD_FALLBACKS_TR[id] : HOVER_CARD_FALLBACKS_EN[id];
}

/**
 * Translates a Wave R3 card key using a bare `t` function (used in pure context-menu builders).
 */
export function translateHoverCardWithFn(
  t: AppI18n['t'] | ((key: string) => string),
  id: HoverCardMessageId,
  locale?: string,
): string {
  const fn = t as (key: string) => string;
  const translated = fn(id);
  if (translated && translated !== id) return translated;
  if (fn('context.play') === 'context.play') return translated;
  return locale === 'tr' ? HOVER_CARD_FALLBACKS_TR[id] : HOVER_CARD_FALLBACKS_EN[id];
}

function clampValue(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Computes the centered, slightly elevated, strictly viewport-clamped position and width for the
 * Desktop expanded hover preview card anchored to a vertical `2:3` poster rect.
 */
export function computeHoverPreviewRect(
  anchorRect: HoverPreviewRect,
  viewport: HoverPreviewViewport,
  cardWidth?: number,
  estimatedHeight = HOVER_PREVIEW_ESTIMATED_HEIGHT,
): ComputedHoverPreviewRect {
  const margin = HOVER_PREVIEW_VIEWPORT_MARGIN_PX;
  const vw = finiteOrDefault(viewport.width, 1280);
  const vh = finiteOrDefault(viewport.height, 720);
  const refWidth =
    Number.isFinite(anchorRect.width) && anchorRect.width > 0
      ? anchorRect.width
      : finiteOrDefault(cardWidth, DEFAULT_ANCHOR_WIDTH);
  const refHeight =
    Number.isFinite(anchorRect.height) && anchorRect.height > 0
      ? anchorRect.height
      : Math.round(refWidth * 1.5);
  const anchorX = Number.isFinite(anchorRect.x) ? anchorRect.x : 0;
  const anchorY = Number.isFinite(anchorRect.y) ? anchorRect.y : 0;

  const targetWidth = Math.min(
    HOVER_PREVIEW_MAX_WIDTH,
    Math.max(HOVER_PREVIEW_MIN_WIDTH, Math.round(refWidth * HOVER_WIDTH_SCALE)),
  );
  const availableW = Math.max(MIN_CLAMPED_WIDTH, vw - margin * 2);
  const width = Math.min(targetWidth, availableW);
  const availableH = Math.max(200, vh - margin * 2);
  const height = Math.min(
    finiteOrDefault(estimatedHeight, HOVER_PREVIEW_ESTIMATED_HEIGHT),
    availableH,
  );

  const anchorCenterX = anchorX + refWidth / 2;
  const rawLeft = Math.round(anchorCenterX - width / 2);
  const left = Math.round(clampValue(rawLeft, margin, vw - width - margin));

  const liftPx = Math.round(
    Math.max(MIN_VERTICAL_LIFT_PX, (height - refHeight) * VERTICAL_ELEVATION_FACTOR),
  );
  const rawTop = Math.round(anchorY - liftPx);
  const top = Math.round(clampValue(rawTop, margin, vh - height - margin));
  const maxHeight = Math.max(200, Math.floor(vh - top - margin));

  return { left, top, width, height, maxHeight };
}

/** Formats `Year · ★ IMDb Rating · Runtime` metadata cleanly with available non-null fields. */
export function formatHoverPreviewMeta(input: {
  readonly year: number | null;
  readonly rating: number | null;
  readonly runtimeMin: number | null;
  readonly formatRuntime: (minutes: number) => string;
}): string | undefined {
  const parts: string[] = [];
  if (input.year !== null && Number.isFinite(input.year)) {
    parts.push(String(Math.round(input.year)));
  }
  if (input.rating !== null && Number.isFinite(input.rating)) {
    parts.push(`★ ${input.rating.toFixed(1)}`);
  }
  if (input.runtimeMin !== null && Number.isFinite(input.runtimeMin) && input.runtimeMin > 0) {
    parts.push(input.formatRuntime(Math.round(input.runtimeMin)));
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/** Merges baseline card fields, provider `ItemDetailRow`, and optional ELV enrichment cleanly. */
export function mergeHoverPreviewMetadata(
  baseline: {
    readonly title: string;
    readonly backdropUri?: string | null;
    readonly year: number | null;
    readonly rating: number | null;
    readonly overview?: string | null;
    readonly runtimeMin?: number | null;
    readonly trailerStreamUrl?: string | null;
    readonly trailerYoutubeId?: string | null;
  },
  detailRow: ItemDetailRow | null,
  elvTitle: ElvTitleRecord | null,
  locale: string,
): HoverPreviewHydratedMetadata {
  const elvLocalizedTitle =
    elvTitle !== null ? resolveElvLocalizedValue(elvTitle.localizedTitles, locale) : null;
  const resolvedTitle =
    nonEmptyString(elvLocalizedTitle) ??
    nonEmptyString(elvTitle?.englishTitle) ??
    nonEmptyString(elvTitle?.originalTitle) ??
    nonEmptyString(detailRow?.name) ??
    baseline.title;

  const backdropUri =
    nonEmptyString(elvTitle?.backdropUrl) ??
    nonEmptyString((detailRow as { backdrop?: string | null } | null)?.backdrop) ??
    nonEmptyString(baseline.backdropUri);

  const year =
    elvTitle?.year != null && Number.isFinite(elvTitle.year)
      ? elvTitle.year
      : (detailRow?.year ?? baseline.year);

  const rating =
    elvTitle?.rating != null && Number.isFinite(elvTitle.rating)
      ? elvTitle.rating
      : (detailRow?.rating ?? baseline.rating);

  const runtimeMin =
    elvTitle?.runtimeMin != null && Number.isFinite(elvTitle.runtimeMin)
      ? elvTitle.runtimeMin
      : (baseline.runtimeMin ?? null);

  const elvSynopsis =
    elvTitle !== null ? resolveElvLocalizedSynopsis(elvTitle.synopses, locale) : null;
  const plot =
    nonEmptyString(elvSynopsis) ??
    nonEmptyString(detailRow?.plot) ??
    nonEmptyString(baseline.overview);

  return {
    title: resolvedTitle,
    backdropUri,
    year,
    rating,
    runtimeMin,
    plot,
    trailerStreamUrl:
      nonEmptyString(elvTitle?.trailerStreamUrl) ?? nonEmptyString(baseline.trailerStreamUrl),
    trailerYoutubeId:
      nonEmptyString(elvTitle?.trailerYoutubeId) ?? nonEmptyString(baseline.trailerYoutubeId),
  };
}

/** Creates a bounded LRU cache of hydrated hover-preview metadata keyed by `(revision, locale, itemKey)`. */
export function createHoverMetadataCache(maxEntries = 80): HoverMetadataCache {
  const cap = Math.max(1, Math.floor(maxEntries));
  const map = new Map<string, HoverPreviewHydratedMetadata>();
  const makeKey = (rev: number, loc: string, itemKey: string) => `${rev}:${loc}:${itemKey}`;

  return {
    get(catalogRevision, locale, itemKey) {
      const k = makeKey(catalogRevision, locale, itemKey);
      const hit = map.get(k);
      if (hit === undefined) return undefined;
      map.delete(k);
      map.set(k, hit);
      return hit;
    },
    set(catalogRevision, locale, itemKey, value) {
      const k = makeKey(catalogRevision, locale, itemKey);
      if (map.has(k)) map.delete(k);
      map.set(k, value);
      while (map.size > cap) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    clear() {
      map.clear();
    },
  };
}
