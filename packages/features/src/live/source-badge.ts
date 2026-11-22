import { cleanDisplayTitle, type ProgrammeRow, type SourceRow } from '@elv/data';
import type { Theme } from '@elv/ui-kit';

const MAX_SOURCE_BADGE_CHARS = 10;

/** Subset of theme colors consumed by pure live badge & genre helpers (`#126`, `#401`). */
export type SourceBadgeTheme = {
  readonly colors: Pick<
    Theme['colors'],
    'accent' | 'successColor' | 'liveColor' | 'focusRingColor' | 'textSecondary'
  >;
};

/** Deterministic theme-derived source pill metadata for multi-source Live views (`#126`). */
export interface SourceBadgeInfo {
  readonly sourceId: string;
  readonly label: string;
  readonly color: string;
}

/** Semantic EPG genre classification used for subtle theme-derived cell tints (`#401`). */
export type EpgGenreKind = 'sports' | 'news' | 'movies' | 'kids-doc';

/** Resolved theme-derived EPG genre accent tint (`#401`). */
export interface EpgGenreTint {
  readonly genre: EpgGenreKind;
  readonly accentColor: string;
}

const SPORTS_RE =
  /\b(?:sport|sports|football|soccer|basketball|tennis|formula|f1|match|league|futbol|basketbol|spor|maç)\b/i;
const NEWS_RE = /\b(?:news|journal|headline|haber|haberler|bülten|gündem|breaking)\b/i;
const MOVIES_RE =
  /\b(?:movie|movies|film|cinema|sinema|drama|thriller|action|comedy|aksiyon|komedi)\b/i;
const KIDS_DOC_RE =
  /\b(?:kids|cartoon|anime|çocuk|çizgi|documentary|belgesel|nature|science|bilim)\b/i;

function compactSourceLabel(name: string, sourceId: string): string {
  const normalized = name.trim().replace(/\s+/g, ' ');
  const base = normalized.length > 0 ? normalized : sourceId.trim();
  const chars = Array.from(base);
  if (chars.length <= MAX_SOURCE_BADGE_CHARS) return base;
  return `${chars
    .slice(0, MAX_SOURCE_BADGE_CHARS - 1)
    .join('')
    .trimEnd()}…`;
}

/**
 * Resolves a deterministic theme-derived semantic badge for `sourceId` when multiple sources are
 * configured and `showSourceBadges` is enabled (`#126`). Returns `null` for single-source setups.
 */
export function resolveSourceBadge(
  sourceId: string,
  sources: readonly Pick<SourceRow, 'id' | 'name'>[],
  theme: SourceBadgeTheme,
  showSourceBadges = true,
): SourceBadgeInfo | null {
  if (!showSourceBadges || sources.length <= 1) return null;
  const idx = sources.findIndex((s) => s.id === sourceId);
  if (idx < 0) return null;
  const source = sources[idx];
  if (!source) return null;
  const palette = [
    theme.colors.accent,
    theme.colors.successColor,
    theme.colors.liveColor,
    theme.colors.focusRingColor,
    theme.colors.textSecondary,
  ] as const;
  return {
    sourceId: source.id,
    label: compactSourceLabel(source.name, source.id),
    color: palette[idx % palette.length] ?? theme.colors.accent,
  };
}

/** Builds an O(1) lookup map of {@link SourceBadgeInfo} across all ready sources (`#126`). */
export function buildSourceBadgeMap(
  sources: readonly Pick<SourceRow, 'id' | 'name'>[],
  theme: SourceBadgeTheme,
  showSourceBadges = true,
): ReadonlyMap<string, SourceBadgeInfo> {
  const out = new Map<string, SourceBadgeInfo>();
  if (!showSourceBadges || sources.length <= 1) return out;
  for (const source of sources) {
    const badge = resolveSourceBadge(source.id, sources, theme, true);
    if (badge) out.set(source.id, badge);
  }
  return out;
}

/**
 * Non-destructively formats a live channel display title via `@elv/data`'s `cleanDisplayTitle`
 * when `cleanChannelTitles` is enabled, falling back to `name` if empty (`#145`).
 */
export function formatChannelDisplayName(name: string, cleanChannelTitles: boolean): string {
  if (!cleanChannelTitles) return name;
  const cleaned = cleanDisplayTitle(name);
  return cleaned.length > 0 ? cleaned : name;
}

/**
 * Maps an EPG programme's text metadata onto a subtle theme-derived genre accent token (`#401`).
 */
export function resolveEpgGenreTint(
  programme: Pick<ProgrammeRow, 'title' | 'subTitle' | 'description'>,
  theme: SourceBadgeTheme,
): EpgGenreTint | null {
  const text = `${programme.title} ${programme.subTitle ?? ''} ${programme.description ?? ''}`;
  if (SPORTS_RE.test(text)) return { genre: 'sports', accentColor: theme.colors.successColor };
  if (NEWS_RE.test(text)) return { genre: 'news', accentColor: theme.colors.liveColor };
  if (MOVIES_RE.test(text)) return { genre: 'movies', accentColor: theme.colors.accent };
  if (KIDS_DOC_RE.test(text))
    return { genre: 'kids-doc', accentColor: theme.colors.focusRingColor };
  return null;
}
