import type {
  ElvCastMember,
  ElvFeedItem,
  ElvMediaType,
  ElvTitleRecord,
  ImdbSuggestionCandidate,
} from './elv-types.ts';
import { foldTitleForMatch } from './elv-validation.ts';

/** Standard IMDb CDN image widths for posters, cast portraits, and 16:9 backdrops. */
export const IMDB_POSTER_WIDTH_PX = 300;
const IMDB_CAST_PORTRAIT_WIDTH_PX = 140;
const IMDB_BACKDROP_WIDTH_PX = 1280;

/** Minimum confidence score required to accept an IMDb match (prevents false merges). */
export const MIN_MATCH_CONFIDENCE = 0.78;

const IMDB_TITLE_ID_RE = /^tt\d{5,10}$/;
const IMDB_TITLE_PATH_RE = /\/title\/(tt\d{5,10})/i;
const IMDB_PERSON_PATH_RE = /\/name\/(nm\d{5,10})/i;
const IMDB_IMAGE_V1_RE = /\._V1_[^/]*\.(?:jpe?g|png|webp)$/i;
const ALLOWED_AMAZON_MEDIA_HOST_RE = /^(?:[a-z0-9-]+\.)?media-amazon\.com$/;
const ALLOWED_IMDB_MEDIA_HOST_RE = /^(?:[a-z0-9-]+\.)?media-imdb\.com$/;
const ALLOWED_IMDB_VIDEO_HOST_RE =
  /^(?:imdb-video\.media-imdb\.com|[a-z0-9-]+\.media-imdb\.com|[a-z0-9-]+\.cloudfront\.net)$/;

const LEADING_ARTICLE_RE = /^(?:the|a|an)\s+/;
const ROMAN_NUMERAL_TO_DIGIT: Readonly<Record<string, string>> = {
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
};

function isAllowedImdbImageHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === 'images-na.ssl-images-amazon.com' ||
    ALLOWED_AMAZON_MEDIA_HOST_RE.test(lower) ||
    ALLOWED_IMDB_MEDIA_HOST_RE.test(lower)
  );
}

/**
 * Rewrites an IMDb/Amazon CDN image URL cleanly to `._V1_QL75_UX${widthPx}_.jpg`.
 * Strictly enforces HTTPS and an IMDb/Amazon media host allowlist (SSRF-safe).
 * Returns empty string for untrusted or malformed URLs.
 */
export function resizeImdbImageUrl(url: string, widthPx: number): string {
  if (typeof url !== 'string' || url.trim().length === 0) return '';
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:') return '';
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return '';
  if (!isAllowedImdbImageHost(parsed.hostname)) return '';

  const clampedWidth = Math.min(1920, Math.max(40, Math.round(widthPx)));
  const cleanPath = parsed.pathname;
  const rewrittenPath = IMDB_IMAGE_V1_RE.test(cleanPath)
    ? cleanPath.replace(IMDB_IMAGE_V1_RE, `._V1_QL75_UX${clampedWidth}_.jpg`)
    : cleanPath;
  return `https://${parsed.hostname.toLowerCase()}${rewrittenPath}`;
}

/** Validates a direct HTTPS IMDb/Amazon trailer playback URL (MP4/HLS). */
function sanitizeTrailerStreamUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== ''
  ) {
    return null;
  }
  if (!ALLOWED_IMDB_VIDEO_HOST_RE.test(parsed.hostname.toLowerCase())) return null;
  return parsed.toString();
}

/** Maps IMDb suggestion `qid`/`q` values to ELV media types (`movie`, `series`, or `other`). */
export function mapImdbQidToMediaType(qid: unknown, q?: unknown): ElvMediaType | 'other' {
  const token = String(qid ?? q ?? '')
    .trim()
    .toLowerCase();
  if (token === 'movie' || token === 'tvmovie' || token === 'feature' || token === 'short') {
    return 'movie';
  }
  if (
    token === 'tvseries' ||
    token === 'tvminiseries' ||
    token === 'tvspecial' ||
    token === 'tv series' ||
    token === 'tv mini-series'
  ) {
    return 'series';
  }
  return 'other';
}

function extractSequelToken(foldedTitle: string): string | null {
  const partMatch =
    /\b(?:part|chapter|vol|volume|book|episode)\s+(\d+|ii|iii|iv|v|vi|two|three|four|five)\b/.exec(
      foldedTitle,
    );
  if (partMatch?.[1]) {
    return ROMAN_NUMERAL_TO_DIGIT[partMatch[1]] ?? partMatch[1];
  }
  const tokens = foldedTitle.split(' ').filter(Boolean);
  if (tokens.length < 2) return null;
  const last = tokens[tokens.length - 1] ?? '';
  if (/^[2-9]$|^10$/.test(last)) return last;
  if (last in ROMAN_NUMERAL_TO_DIGIT) return ROMAN_NUMERAL_TO_DIGIT[last] ?? null;
  return null;
}

function normalizedLevenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const left = a.slice(0, 120);
  const right = b.slice(0, 120);
  const prev = new Array<number>(right.length + 1);
  const curr = new Array<number>(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) prev[j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    curr[0] = i;
    const leftChar = left.charCodeAt(i - 1);
    for (let j = 1; j <= right.length; j += 1) {
      const cost = leftChar === right.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= right.length; j += 1) prev[j] = curr[j] ?? 0;
  }
  const dist = prev[right.length] ?? maxLen;
  return Math.max(0, 1 - dist / Math.max(left.length, right.length));
}

function computeTitleSimilarity(queryTitle: string, candidateTitle: string): number {
  const a = foldTitleForMatch(queryTitle);
  const b = foldTitleForMatch(candidateTitle);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const aNoArt = a.replace(LEADING_ARTICLE_RE, '');
  const bNoArt = b.replace(LEADING_ARTICLE_RE, '');
  const leadingArticleDiffers =
    a.slice(0, a.length - aNoArt.length) !== b.slice(0, b.length - bNoArt.length);
  if (aNoArt.length > 0 && aNoArt === bNoArt) return 0.9;

  const aTokens = new Set(aNoArt.split(' ').filter(Boolean));
  const bTokens = new Set(bNoArt.split(' ').filter(Boolean));
  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }
  const union = aTokens.size + bTokens.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  const charSim = normalizedLevenshteinSimilarity(aNoArt, bNoArt);
  let blended = 0.6 * jaccard + 0.4 * charSim;

  if (leadingArticleDiffers) {
    blended = Math.min(blended, 0.9);
  }

  const aSeq = extractSequelToken(a);
  const bSeq = extractSequelToken(b);
  if (aSeq !== bSeq) {
    blended = Math.max(0, blended - 0.35);
  }
  return blended;
}

const AMBIGUOUS_REMAKE_WINDOW_UNITS = 500;

/** Query attributes passed to `scoreImdbCandidate` and `selectBestImdbMatch`. */
export interface ImDbMatchQuery {
  readonly cleanTitle: string;
  readonly year: number | null;
  readonly mediaType: ElvMediaType;
}

/**
 * Scores an IMDb suggestion candidate against a cleaned catalog query (`0.0 .. 1.0`).
 * Strictly penalizes year mismatches >= 2 (preventing remake false merges) and type mismatches.
 */
export function scoreImdbCandidate(
  query: ImDbMatchQuery,
  candidate: ImdbSuggestionCandidate,
): number {
  const titleSim = computeTitleSimilarity(query.cleanTitle, candidate.title);
  let score = titleSim * 0.85;

  if (candidate.mediaType === 'other') {
    score -= 0.4;
  } else if (candidate.mediaType !== query.mediaType) {
    score -= 0.35;
  }

  if (query.year !== null && candidate.year !== null) {
    const diff = Math.abs(query.year - candidate.year);
    if (diff === 0) {
      score += 0.15;
    } else if (diff === 1) {
      score += 0.05;
    } else {
      score -= 0.4;
    }
  } else if (query.year !== null && candidate.year === null) {
    score -= 0.08;
  }

  const clamped = Math.max(0, Math.min(1, score));
  return Math.round(clamped * 10_000) / 10_000;
}

/**
 * Selects the highest-scoring IMDb candidate above `MIN_MATCH_CONFIDENCE` (0.78), or `null`.
 * Rejects ambiguous remakes when `query.year === null` and >= 2 distinct-year candidates score within `0.05`.
 */
export function selectBestImdbMatch(
  query: ImDbMatchQuery,
  candidates: readonly ImdbSuggestionCandidate[],
): { readonly candidate: ImdbSuggestionCandidate; readonly confidence: number } | null {
  const qualified: { readonly candidate: ImdbSuggestionCandidate; readonly confidence: number }[] =
    [];
  let best: { readonly candidate: ImdbSuggestionCandidate; readonly confidence: number } | null =
    null;

  for (const candidate of candidates) {
    const confidence = scoreImdbCandidate(query, candidate);
    if (confidence >= MIN_MATCH_CONFIDENCE) {
      const entry = { candidate, confidence };
      qualified.push(entry);
      if (!best || confidence > best.confidence) {
        best = entry;
      }
    }
  }

  if (!best) return null;

  if (query.year === null && qualified.length >= 2) {
    const distinctYears = new Set<number>();
    for (const entry of qualified) {
      const deltaUnits = Math.round((best.confidence - entry.confidence) * 10_000);
      if (deltaUnits <= AMBIGUOUS_REMAKE_WINDOW_UNITS && entry.candidate.year !== null) {
        distinctYears.add(entry.candidate.year);
      }
    }
    if (distinctYears.size >= 2) return null;
  }

  return best;
}

function safeFromCodePoint(raw: string, cp: number): string {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return raw;
  }
  return String.fromCodePoint(cp);
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (match, hex: string) =>
      safeFromCodePoint(match, Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (match, dec: string) =>
      safeFromCodePoint(match, Number.parseInt(dec, 10)),
    )
    .trim();
}

function parseIsoDurationMinutes(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(raw.trim());
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const mins = Number(match[2] ?? 0);
  const total = hours * 60 + mins;
  return total > 0 ? total : null;
}

function parseYearFromDate(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1880 && raw <= 2100) {
    return raw;
  }
  if (typeof raw !== 'string') return null;
  const match = /^(\d{4})/.exec(raw.trim());
  if (!match?.[1]) return null;
  const year = Number(match[1]);
  return year >= 1880 && year <= 2100 ? year : null;
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function readNested(obj: unknown, path: readonly string[]): unknown {
  let curr: unknown = obj;
  for (const seg of path) {
    const rec = asRecord(curr);
    if (!rec) return undefined;
    curr = rec[seg];
  }
  return curr;
}

function extractJsonLdBlocks(html: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match = re.exec(html);
  while (match !== null) {
    const rawJson = match[1]?.trim() ?? '';
    if (rawJson.length > 0) {
      try {
        const parsed: unknown = JSON.parse(rawJson);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const rec = asRecord(item);
            if (rec) results.push(rec);
          }
        } else {
          const rec = asRecord(parsed);
          if (rec) results.push(rec);
        }
      } catch {
        // Ignore malformed or truncated script blocks
      }
    }
    match = re.exec(html);
  }
  return results;
}

function extractNextData(html: string): Record<string, unknown> | null {
  const re = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;
  const match = re.exec(html);
  if (!match?.[1]) return null;
  try {
    return asRecord(JSON.parse(match[1].trim()));
  } catch {
    return null;
  }
}

function parseGenres(raw: unknown): string[] {
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((s) => decodeHtmlEntities(s))
      .filter((s) => s.length > 0)
      .slice(0, 8);
  }
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const entry of raw) {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        out.push(decodeHtmlEntities(entry));
      } else {
        const text = asRecord(entry)?.text;
        if (typeof text === 'string' && text.trim().length > 0) {
          out.push(decodeHtmlEntities(text));
        }
      }
    }
    return [...new Set(out)].slice(0, 8);
  }
  return [];
}

function extractNextDataCast(mainColumn: unknown): ElvCastMember[] {
  const edges = readNested(mainColumn, ['cast', 'edges']);
  if (!Array.isArray(edges)) return [];
  const cast: ElvCastMember[] = [];
  for (const edge of edges) {
    const node = asRecord(asRecord(edge)?.node);
    const nameObj = asRecord(node?.name);
    const personId = typeof nameObj?.id === 'string' ? nameObj.id.trim() : '';
    const nameText = readNested(nameObj, ['nameText', 'text']);
    if (!/^nm\d{5,10}$/.test(personId) || typeof nameText !== 'string' || !nameText.trim()) {
      continue;
    }
    const chars = node?.characters;
    const firstChar =
      Array.isArray(chars) && typeof asRecord(chars[0])?.name === 'string'
        ? decodeHtmlEntities(String(asRecord(chars[0])?.name))
        : null;
    const rawImg = readNested(nameObj, ['primaryImage', 'url']);
    const portraitUrl =
      typeof rawImg === 'string'
        ? resizeImdbImageUrl(rawImg, IMDB_CAST_PORTRAIT_WIDTH_PX) || null
        : null;
    cast.push({
      personId,
      name: decodeHtmlEntities(nameText),
      character: firstChar,
      portraitUrl,
    });
    if (cast.length >= 15) break;
  }
  return cast;
}

function extractLdCast(ld: Record<string, unknown>): ElvCastMember[] {
  const actors = Array.isArray(ld.actor) ? ld.actor : [];
  const cast: ElvCastMember[] = [];
  for (const entry of actors) {
    const rec = asRecord(entry);
    const name = typeof rec?.name === 'string' ? decodeHtmlEntities(rec.name) : '';
    const url = typeof rec?.url === 'string' ? rec.url : '';
    const personId = IMDB_PERSON_PATH_RE.exec(url)?.[1] ?? '';
    if (!name || !personId) continue;
    cast.push({ personId, name, character: null, portraitUrl: null });
    if (cast.length >= 15) break;
  }
  return cast;
}

function extractMltIds(mainColumn: unknown): string[] {
  const edges = readNested(mainColumn, ['moreLikeThisTitles', 'edges']);
  if (!Array.isArray(edges)) return [];
  const ids: string[] = [];
  for (const edge of edges) {
    const id = readNested(edge, ['node', 'id']);
    if (typeof id === 'string' && IMDB_TITLE_ID_RE.test(id) && !ids.includes(id)) {
      ids.push(id);
      if (ids.length >= 12) break;
    }
  }
  return ids;
}

function extractVideoMetadata(
  aboveFold: unknown,
  ld: Record<string, unknown> | null,
): { readonly backdropUrl: string | null; readonly trailerStreamUrl: string | null } {
  let backdropUrl: string | null = null;
  let trailerStreamUrl: string | null = null;

  const videoEdges = readNested(aboveFold, ['primaryVideos', 'edges']);
  if (Array.isArray(videoEdges) && videoEdges.length > 0) {
    const node = asRecord(asRecord(videoEdges[0])?.node);
    const thumbUrl = readNested(node, ['thumbnail', 'url']);
    if (typeof thumbUrl === 'string') {
      backdropUrl = resizeImdbImageUrl(thumbUrl, IMDB_BACKDROP_WIDTH_PX) || null;
    }
    const playbackUrls = node?.playbackURLs;
    if (Array.isArray(playbackUrls)) {
      for (const entry of playbackUrls) {
        const candidateUrl = sanitizeTrailerStreamUrl(asRecord(entry)?.url);
        if (candidateUrl) {
          trailerStreamUrl = candidateUrl;
          break;
        }
      }
    }
  }

  const ldTrailer = asRecord(ld?.trailer);
  if (!backdropUrl && typeof ldTrailer?.thumbnailUrl === 'string') {
    backdropUrl = resizeImdbImageUrl(ldTrailer.thumbnailUrl, IMDB_BACKDROP_WIDTH_PX) || null;
  }
  if (!trailerStreamUrl && typeof ldTrailer?.contentUrl === 'string') {
    trailerStreamUrl = sanitizeTrailerStreamUrl(ldTrailer.contentUrl);
  }
  return { backdropUrl, trailerStreamUrl };
}

/** Parses an IMDb title HTML document (JSON-LD + optional `__NEXT_DATA__`) into an `ElvTitleRecord`. */
export function parseImdbTitleHtml(
  imdbId: string,
  html: string,
  nowMs: number,
): ElvTitleRecord | null {
  const ldBlocks = extractJsonLdBlocks(html);
  const ld =
    ldBlocks.find((b) => {
      const t = String(b['@type'] ?? '').toLowerCase();
      return t === 'movie' || t === 'tvseries' || t === 'tvminiseries';
    }) ?? null;

  const nextData = extractNextData(html);
  const aboveFold = readNested(nextData, ['props', 'pageProps', 'aboveTheFoldData']);
  const mainColumn = readNested(nextData, ['props', 'pageProps', 'mainColumnData']);
  if (!ld && !aboveFold) return null;

  const ldType = String(ld?.['@type'] ?? '').toLowerCase();
  const nextTypeId = String(readNested(aboveFold, ['titleType', 'id']) ?? '').toLowerCase();
  const mediaType: ElvMediaType =
    ldType.includes('tv') || nextTypeId.includes('tvseries') || nextTypeId.includes('tvmini')
      ? 'series'
      : 'movie';

  const nextOrig = readNested(aboveFold, ['originalTitleText', 'text']);
  const nextEng = readNested(aboveFold, ['titleText', 'text']);
  const ldName = typeof ld?.name === 'string' ? decodeHtmlEntities(ld.name) : null;
  const ldAlt = typeof ld?.alternateName === 'string' ? decodeHtmlEntities(ld.alternateName) : null;

  const originalTitle =
    (typeof nextOrig === 'string' && nextOrig.trim() ? decodeHtmlEntities(nextOrig) : null) ??
    ldName ??
    (typeof nextEng === 'string' && nextEng.trim() ? decodeHtmlEntities(nextEng) : null);
  if (!originalTitle) return null;

  const englishTitle =
    (typeof nextEng === 'string' && nextEng.trim() ? decodeHtmlEntities(nextEng) : null) ??
    ldAlt ??
    ldName ??
    originalTitle;

  const year =
    parseYearFromDate(readNested(aboveFold, ['releaseYear', 'year'])) ??
    parseYearFromDate(ld?.datePublished);

  const rawRating =
    readNested(aboveFold, ['ratingsSummary', 'aggregateRating']) ??
    readNested(ld, ['aggregateRating', 'ratingValue']);
  const rating =
    typeof rawRating === 'number' && Number.isFinite(rawRating)
      ? Math.round(rawRating * 10) / 10
      : typeof rawRating === 'string' && Number.isFinite(Number(rawRating))
        ? Math.round(Number(rawRating) * 10) / 10
        : null;

  const rawVotes =
    readNested(aboveFold, ['ratingsSummary', 'voteCount']) ??
    readNested(ld, ['aggregateRating', 'ratingCount']);
  const votes =
    typeof rawVotes === 'number' && Number.isFinite(rawVotes) ? Math.round(rawVotes) : null;

  const runtimeSec = readNested(aboveFold, ['runtime', 'seconds']);
  const runtimeMin =
    typeof runtimeSec === 'number' && runtimeSec > 0
      ? Math.round(runtimeSec / 60)
      : parseIsoDurationMinutes(ld?.duration);

  const nextGenres = parseGenres(readNested(aboveFold, ['genres', 'genres']));
  const ldGenres = parseGenres(ld?.genre);
  const genres = nextGenres.length > 0 ? nextGenres : ldGenres;

  const rawPoster =
    readNested(aboveFold, ['primaryImage', 'url']) ??
    (typeof ld?.image === 'string' ? ld.image : readNested(ld, ['image', 'url']));
  const posterUrl =
    typeof rawPoster === 'string'
      ? resizeImdbImageUrl(rawPoster, IMDB_POSTER_WIDTH_PX) || null
      : null;

  const { backdropUrl, trailerStreamUrl } = extractVideoMetadata(aboveFold, ld);

  const nextDirector = readNested(mainColumn, [
    'directors',
    '0',
    'credits',
    '0',
    'name',
    'nameText',
    'text',
  ]);
  let ldDirector: string | null = null;
  if (Array.isArray(ld?.director) && typeof asRecord(ld.director[0])?.name === 'string') {
    ldDirector = decodeHtmlEntities(String(asRecord(ld.director[0])?.name));
  } else if (typeof asRecord(ld?.director)?.name === 'string') {
    ldDirector = decodeHtmlEntities(String(asRecord(ld?.director)?.name));
  }
  const director =
    (typeof nextDirector === 'string' && nextDirector.trim()
      ? decodeHtmlEntities(nextDirector)
      : null) ?? ldDirector;

  const nextCast = extractNextDataCast(mainColumn);
  const cast = nextCast.length > 0 ? nextCast : ld ? extractLdCast(ld) : [];
  const mltImdbIds = extractMltIds(mainColumn);

  const nextPlot = readNested(aboveFold, ['plot', 'plotText', 'plainText']);
  const ldPlot = typeof ld?.description === 'string' ? decodeHtmlEntities(ld.description) : null;
  const originalSynopsis =
    (typeof nextPlot === 'string' && nextPlot.trim() ? decodeHtmlEntities(nextPlot) : null) ??
    ldPlot;

  return {
    imdbId,
    mediaType,
    originalTitle,
    englishTitle,
    year,
    rating,
    votes,
    runtimeMin,
    genres,
    posterUrl,
    backdropUrl,
    trailerStreamUrl,
    trailerYoutubeId: null,
    director,
    cast,
    mltImdbIds,
    franchiseKey: null,
    franchiseName: null,
    franchiseOrder: null,
    originalSynopsis,
    updatedAt: nowMs,
  };
}

/** Parses an IMDb chart page HTML document (`ItemList` JSON-LD) into feed items (up to 25). */
export function parseImdbChartHtml(
  html: string,
  defaultMediaType: ElvMediaType,
): readonly ElvFeedItem[] {
  const ldBlocks = extractJsonLdBlocks(html);
  const listBlock = ldBlocks.find((b) => String(b['@type'] ?? '').toLowerCase() === 'itemlist');
  const elements = listBlock?.itemListElement;
  if (!Array.isArray(elements)) return [];

  const items: ElvFeedItem[] = [];
  for (let i = 0; i < elements.length && items.length < 25; i += 1) {
    const entry = asRecord(elements[i]);
    const item = asRecord(entry?.item) ?? entry;
    if (!item) continue;
    const rawUrl = typeof item.url === 'string' ? item.url : '';
    const imdbId = IMDB_TITLE_PATH_RE.exec(rawUrl)?.[1] ?? '';
    if (!IMDB_TITLE_ID_RE.test(imdbId)) continue;

    const rawTitle = typeof item.name === 'string' ? decodeHtmlEntities(item.name) : '';
    if (!rawTitle) continue;

    const itemType = String(item['@type'] ?? '').toLowerCase();
    const mediaType: ElvMediaType = itemType.includes('tv')
      ? 'series'
      : itemType === 'movie'
        ? 'movie'
        : defaultMediaType;

    const rawRating = readNested(item, ['aggregateRating', 'ratingValue']);
    const rating =
      typeof rawRating === 'number' && Number.isFinite(rawRating)
        ? Math.round(rawRating * 10) / 10
        : typeof rawRating === 'string' && Number.isFinite(Number(rawRating))
          ? Math.round(Number(rawRating) * 10) / 10
          : null;

    const rawImage = typeof item.image === 'string' ? item.image : '';
    const posterUrl = rawImage ? resizeImdbImageUrl(rawImage, IMDB_POSTER_WIDTH_PX) || null : null;
    const genres = parseGenres(item.genre);
    const year = parseYearFromDate(item.datePublished);

    items.push({
      imdbId,
      title: rawTitle,
      mediaType,
      year,
      rating,
      posterUrl,
      genres,
      rank: items.length + 1,
    });
  }
  return items;
}
