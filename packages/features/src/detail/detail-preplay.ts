import type { ElvError } from '@elv/domain';
import type { MessageId } from '@elv/i18n';
import type { DetailTechnicalMeta } from '../shared/detail-target';

/** Localized message and actionable recovery hint for a series seasons error. */
export interface DescribedDetailError {
  readonly messageId: MessageId;
  readonly hintId: MessageId;
}

/** Realistic visible 3-line inline synopsis character budgets before `"see more..."` truncation. */
export const SYNOPSIS_INLINE_BUDGET_LANDSCAPE = 235;
export const SYNOPSIS_INLINE_BUDGET_PORTRAIT = 145;
export const SYNOPSIS_INLINE_MAX_LINES = 3;
const SYNOPSIS_INLINE_LINK_RESERVE = 16;

/** Result of {@link truncateSynopsisForInline}. */
export interface InlineSynopsisResult {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Computes Detail Hero spotlight height (`Cinema Quietude v3` Wave R2):
 * - Desktop & TV landscape: ~76% viewport height clamped to `[520, 760]`
 * - Compact landscape (e.g. phone landscape): `76%` clamped to `[340, 680]`
 * - Portrait: `60%` clamped to `[460, 540]`
 */
export function computeDetailHeroHeight(
  viewportHeight: number,
  isPortrait: boolean,
  isTv: boolean,
  isDesktop: boolean,
): number {
  const safeHeight = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 720;
  if (isPortrait) {
    return Math.max(460, Math.min(540, Math.round(safeHeight * 0.6)));
  }
  if (isDesktop || isTv) {
    return Math.max(520, Math.min(760, Math.round(safeHeight * 0.76)));
  }
  return Math.max(340, Math.min(680, Math.round(safeHeight * 0.76)));
}

/** Computes realistic 3-line inline synopsis char budget for the measured width and user font scale. */
export function computeSynopsisCharBudget(
  availableWidth: number,
  fontScale: number,
  isPortrait: boolean,
): number {
  const safeScale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) {
    const baseBudget = isPortrait
      ? SYNOPSIS_INLINE_BUDGET_PORTRAIT
      : SYNOPSIS_INLINE_BUDGET_LANDSCAPE;
    return Math.max(85, Math.min(260, Math.round(baseBudget / safeScale)));
  }
  const scaled = Math.round(
    (availableWidth / (660 * safeScale)) * SYNOPSIS_INLINE_BUDGET_LANDSCAPE,
  );
  return Math.max(85, Math.min(260, scaled));
}

/**
 * Word-boundary inline synopsis clamp for Detail Hero (`Wave R2`).
 * Never truncates short descriptions fitting within `maxChars` and `maxLines`; when overflowing,
 * trims cleanly at a word boundary leaving space for the inline `"see more..."` trigger.
 */
export function truncateSynopsisForInline(
  synopsis: string,
  maxChars: number,
  maxLines = SYNOPSIS_INLINE_MAX_LINES,
): InlineSynopsisResult {
  const trimmed = synopsis.trim();
  if (trimmed.length === 0) return { text: '', truncated: false };

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const collapsed = lines.join(' ');
  const safeMaxChars =
    Number.isFinite(maxChars) && maxChars > 0
      ? Math.floor(maxChars)
      : SYNOPSIS_INLINE_BUDGET_LANDSCAPE;
  const safeMaxLines =
    Number.isFinite(maxLines) && maxLines > 0 ? Math.floor(maxLines) : SYNOPSIS_INLINE_MAX_LINES;

  if (lines.length <= safeMaxLines && collapsed.length <= safeMaxChars) {
    return { text: trimmed, truncated: false };
  }

  const lineLimited =
    lines.length > safeMaxLines ? lines.slice(0, safeMaxLines).join(' ') : collapsed;
  const limit = Math.max(16, safeMaxChars - SYNOPSIS_INLINE_LINK_RESERVE);
  if (lines.length > safeMaxLines && lineLimited.length <= limit) {
    return { text: lineLimited, truncated: true };
  }
  if (lineLimited.length <= limit) {
    return { text: lineLimited, truncated: true };
  }

  let cut = lineLimited.lastIndexOf(' ', limit);
  if (cut <= Math.floor(limit * 0.4)) cut = limit;
  const clamped = lineLimited.slice(0, cut).replace(/[\s,;:.!?-]+$/u, '');
  return {
    text: clamped.length > 0 ? clamped : lineLimited.slice(0, limit).trim(),
    truncated: true,
  };
}

/** One crisp technical metadata badge derived from {@link DetailTechnicalMeta}. */
export interface DetailTechnicalBadge {
  readonly key: 'resolution' | 'hdr' | 'codec' | 'audioChannels' | 'container' | 'durationMin';
  readonly label: string;
}

/** Extracts clean, non-empty technical badges from optional {@link DetailTechnicalMeta}. */
export function buildTechnicalBadges(
  meta: DetailTechnicalMeta | undefined,
): DetailTechnicalBadge[] {
  if (!meta) return [];
  const badges: DetailTechnicalBadge[] = [];
  const pushStr = (
    key: Exclude<DetailTechnicalBadge['key'], 'durationMin'>,
    value: string | undefined,
    upper = false,
  ) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    badges.push({ key, label: upper ? trimmed.toUpperCase() : trimmed });
  };
  pushStr('resolution', meta.resolution);
  pushStr('hdr', meta.hdr);
  pushStr('codec', meta.codec);
  pushStr('audioChannels', meta.audioChannels);
  pushStr('container', meta.container, true);
  if (
    typeof meta.durationMin === 'number' &&
    Number.isFinite(meta.durationMin) &&
    meta.durationMin > 0
  ) {
    badges.push({ key: 'durationMin', label: `${Math.round(meta.durationMin)}m` });
  }
  return badges;
}

/** Maps a `CatalogService.seasons` {@link ElvError} to localized copy and recovery hint ids. */
export function describeDetailSeasonsError(error: ElvError): DescribedDetailError {
  if (error.category === 'auth') {
    if (
      error.code === 'invalid-credentials' ||
      error.code === 'http-401' ||
      error.code === 'http-403'
    ) {
      return {
        messageId: 'source.error.invalidCredentials',
        hintId: 'source.hint.invalidCredentials',
      };
    }
    return {
      messageId: 'source.error.accountExpired',
      hintId: 'source.hint.accountExpired',
    };
  }
  if (error.category === 'network') {
    if (error.code === 'rate-limited' || error.code === 'http-429' || error.code === 'http-509') {
      return {
        messageId: 'source.error.rateLimited',
        hintId: 'source.hint.rateLimited',
      };
    }
    if (error.code === 'timeout') {
      return {
        messageId: 'source.error.timeout',
        hintId: 'source.hint.timeout',
      };
    }
    return {
      messageId: 'source.error.unreachable',
      hintId: 'source.hint.unreachable',
    };
  }
  if (error.code === 'item-not-found' || error.code === 'http-404') {
    return {
      messageId: 'player.error.itemNotFound',
      hintId: 'player.hint.itemNotFound',
    };
  }
  return {
    messageId: 'source.error.storage',
    hintId: 'source.hint.storage',
  };
}
