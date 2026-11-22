/** Canonical EPG programme genre category used for subtle visual tinting (`#396`). */
export type EpgGenre = 'sports' | 'movie' | 'news' | 'kids' | 'series' | 'other';

/** Bitmask flag for a live broadcast programme (`<live>` or title live badge). */
export const EPG_FLAG_LIVE = 1;

/** Bitmask flag for a new broadcast programme (`<new>` or title new badge). */
export const EPG_FLAG_NEW = 2;

/** Bitmask flag for a premiere broadcast programme (`<premiere>`). */
export const EPG_FLAG_PREMIERE = 4;

/** Bitmask flag for a repeat / previously shown broadcast programme (`<previously-shown>`). */
export const EPG_FLAG_REPEAT = 8;

/** Input flags accepted by {@link encodeProgrammeFlags}. */
export interface ProgrammeFlagInput {
  readonly isLive?: boolean | undefined;
  readonly isNew?: boolean | undefined;
  readonly isPremiere?: boolean | undefined;
  readonly previouslyShown?: boolean | undefined;
  readonly isRepeat?: boolean | undefined;
}

/** Decoded boolean broadcast flags produced by {@link decodeProgrammeFlags}. */
export interface DecodedProgrammeFlags {
  readonly isLive: boolean;
  readonly isNew: boolean;
  readonly isPremiere: boolean;
  readonly isRepeat: boolean;
}

const SPORTS_TOKENS = new Set([
  'sports',
  'sport',
  'spor',
  'futbol',
  'football',
  'soccer',
  'basketball',
  'basketbol',
  'tennis',
  'tenis',
  'motorsport',
  'f1',
  'racing',
  'golf',
  'boxing',
  'boks',
  'hockey',
  'rugby',
  'athletics',
  'volleyball',
  'voleybol',
  'baseball',
  'cricket',
  'olympics',
  'deportes',
  'deporte',
]);

const MOVIE_TOKENS = new Set([
  'movie',
  'movies',
  'film',
  'films',
  'sinema',
  'cinema',
  'kino',
  'pelicula',
  'peliculas',
  'cine',
  'feature',
  'thriller',
  'horror',
  'action',
  'aksiyon',
  'adventure',
]);

const NEWS_TOKENS = new Set([
  'news',
  'haber',
  'haberler',
  'nachrichten',
  'actualites',
  'actualite',
  'noticias',
  'noticia',
  'journal',
  'bulletin',
  'politics',
  'ekonomi',
  'economy',
  'weather',
  'gundem',
]);

const NEWS_PHRASES = ['current affairs', 'hava durumu'] as const;

const KIDS_TOKENS = new Set([
  'kids',
  'kid',
  'children',
  'child',
  'cocuk',
  'animation',
  'animasyon',
  'cartoon',
  'kinder',
  'jeunesse',
  'enfants',
  'enfant',
  'infantil',
  'ninos',
  'nino',
  'family',
  'aile',
]);

const KIDS_PHRASES = ['cizgi film'] as const;

const SERIES_TOKENS = new Set([
  'series',
  'serie',
  'drama',
  'dizi',
  'diziler',
  'comedy',
  'komedi',
  'comedie',
  'comedia',
  'documentary',
  'belgesel',
  'dokumentation',
  'documentaire',
  'documental',
  'sitcom',
  'soap',
  'reality',
  'entertainment',
  'eglence',
  'magazine',
  'lifestyle',
]);

const SERIES_PHRASES = ['talk show'] as const;

function foldCategoryText(raw: string): string {
  return raw
    .replace(/\u0130/g, 'i')
    .replace(/\u0131/g, 'i')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchesAnyPhrase(folded: string, phrases: readonly string[]): boolean {
  for (const phrase of phrases) {
    if (folded.includes(phrase)) return true;
  }
  return false;
}

function classifyFolded(folded: string): Exclude<EpgGenre, 'other'> | null {
  const tokens = folded.split(' ');
  for (const token of tokens) {
    if (SPORTS_TOKENS.has(token)) return 'sports';
  }
  if (matchesAnyPhrase(folded, KIDS_PHRASES)) return 'kids';
  for (const token of tokens) {
    if (KIDS_TOKENS.has(token)) return 'kids';
  }
  if (matchesAnyPhrase(folded, NEWS_PHRASES)) return 'news';
  for (const token of tokens) {
    if (NEWS_TOKENS.has(token)) return 'news';
  }
  for (const token of tokens) {
    if (MOVIE_TOKENS.has(token)) return 'movie';
  }
  if (matchesAnyPhrase(folded, SERIES_PHRASES)) return 'series';
  for (const token of tokens) {
    if (SERIES_TOKENS.has(token)) return 'series';
  }
  return null;
}

/**
 * Normalizes a list of XMLTV `<category>` labels (EN/TR/DE/FR/ES) into a canonical {@link EpgGenre}.
 * Returns `null` when no non-empty categories are present, or `'other'` when categories do not match
 * a specific canonical genre bucket.
 */
export function normalizeEpgGenre(categories: readonly string[]): EpgGenre | null {
  let hasNonEmpty = false;
  for (const raw of categories) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    hasNonEmpty = true;
    const folded = foldCategoryText(trimmed);
    if (folded.length === 0) continue;
    const matched = classifyFolded(folded);
    if (matched !== null) return matched;
  }
  return hasNonEmpty ? 'other' : null;
}

/** Encodes XMLTV programme broadcast flags into a compact SQLite-friendly bitmask. */
export function encodeProgrammeFlags(flags: ProgrammeFlagInput): number {
  let mask = 0;
  if (flags.isLive) mask |= EPG_FLAG_LIVE;
  if (flags.isNew) mask |= EPG_FLAG_NEW;
  if (flags.isPremiere) mask |= EPG_FLAG_PREMIERE;
  if (flags.previouslyShown || flags.isRepeat) mask |= EPG_FLAG_REPEAT;
  return mask;
}

/** Decodes a broadcast flag bitmask produced by {@link encodeProgrammeFlags} into booleans. */
export function decodeProgrammeFlags(mask: number): DecodedProgrammeFlags {
  const bits = Number.isFinite(mask) ? Math.trunc(mask) : 0;
  return {
    isLive: (bits & EPG_FLAG_LIVE) !== 0,
    isNew: (bits & EPG_FLAG_NEW) !== 0,
    isPremiere: (bits & EPG_FLAG_PREMIERE) !== 0,
    isRepeat: (bits & EPG_FLAG_REPEAT) !== 0,
  };
}
