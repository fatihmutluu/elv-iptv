import { parseTmdbReleaseYear } from './elv-tmdb-scoring.ts';
import type {
  ElvCastMember,
  ElvMediaType,
  ElvRichTitlePayload,
  ElvTitleRecord,
} from './elv-types.ts';
import { isEnglishLang, validateImdbId } from './elv-validation.ts';

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const TMDB_IMAGE_PATH_RE = /^\/[A-Za-z0-9_.-]+\.(?:jpg|jpeg|png|webp)$/i;
const TMDB_ID_RE = /^[1-9]\d{0,9}$/;
const YOUTUBE_KEY_RE = /^[A-Za-z0-9_-]{6,20}$/;

const TMDB_GENRE_ID_MAP: Readonly<Record<number, readonly string[]>> = {
  28: ['Action'],
  12: ['Adventure'],
  16: ['Animation'],
  35: ['Comedy'],
  80: ['Crime'],
  99: ['Documentary'],
  18: ['Drama'],
  10751: ['Family'],
  14: ['Fantasy'],
  36: ['History'],
  27: ['Horror'],
  10402: ['Music'],
  9648: ['Mystery'],
  10749: ['Romance'],
  878: ['Sci-Fi'],
  10770: ['TV Movie'],
  53: ['Thriller'],
  10752: ['War'],
  37: ['Western'],
  10759: ['Action', 'Adventure'],
  10762: ['Family'],
  10763: ['News'],
  10764: ['Reality'],
  10765: ['Sci-Fi', 'Fantasy'],
  10766: ['Drama'],
  10767: ['Talk'],
  10768: ['War'],
};

const GENRE_NAME_ALIASES: Readonly<Record<string, string>> = {
  'science fiction': 'Sci-Fi',
  'sci-fi & fantasy': 'Sci-Fi',
  'action & adventure': 'Action',
  'war & politics': 'War',
};

const TMDB_BCP47_DEFAULTS: Readonly<Record<string, string>> = {
  en: 'en-US',
  tr: 'tr-TR',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  it: 'it-IT',
  pt: 'pt-PT',
  nl: 'nl-NL',
  pl: 'pl-PL',
  ru: 'ru-RU',
  ar: 'ar-SA',
  ja: 'ja-JP',
  ko: 'ko-KR',
  zh: 'zh-CN',
};

function asRecord(val: unknown): Record<string, unknown> | null {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function nonEmptyString(val: unknown): string | null {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Formats a safe TMDB image URL at the given width preset (`w185`, `w342`, `w1280`). */
export function buildTmdbImageUrl(path: unknown, size: 'w185' | 'w342' | 'w1280'): string | null {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  return TMDB_IMAGE_PATH_RE.test(trimmed) ? `${TMDB_IMAGE_BASE}/${size}${trimmed}` : null;
}

/** Normalizes an ELV language tag into a TMDB BCP-47 locale (`tr` -> `tr-TR`, `en` -> `en-US`). */
export function toTmdbBcp47Lang(lang: string): string {
  const trimmed = lang.trim();
  if (!trimmed) return 'en-US';
  const dash = trimmed.indexOf('-');
  if (dash !== -1) {
    return `${trimmed.slice(0, dash).toLowerCase()}-${trimmed.slice(dash + 1).toUpperCase()}`;
  }
  const lower = trimmed.toLowerCase();
  return TMDB_BCP47_DEFAULTS[lower] ?? lower;
}

/** Maps TMDB genre objects (`{ id, name }`) or numeric `genre_ids` to canonical English genre buckets. */
export function mapTmdbGenreIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'number' && Number.isInteger(entry)) {
      const mapped = TMDB_GENRE_ID_MAP[entry];
      if (mapped) {
        for (const name of mapped) {
          if (!out.includes(name)) out.push(name);
        }
      }
      continue;
    }
    const rec = asRecord(entry);
    if (!rec) continue;
    const id = typeof rec.id === 'number' && Number.isInteger(rec.id) ? rec.id : null;
    if (id !== null && TMDB_GENRE_ID_MAP[id]) {
      for (const name of TMDB_GENRE_ID_MAP[id]) {
        if (!out.includes(name)) out.push(name);
      }
      continue;
    }
    const rawName = nonEmptyString(rec.name);
    if (rawName) {
      const normalized = GENRE_NAME_ALIASES[rawName.toLowerCase()] ?? rawName;
      if (!out.includes(normalized)) out.push(normalized);
    }
  }
  return out.slice(0, 8);
}

function findTranslationData(
  translationsRaw: unknown,
  targetBaseLang: string,
  targetRegion: string | undefined,
): { readonly title: string | null; readonly overview: string | null } {
  const list = asRecord(translationsRaw)?.translations;
  if (!Array.isArray(list)) return { title: null, overview: null };

  let bestRec: Record<string, unknown> | null = null;
  for (const item of list) {
    const rec = asRecord(item);
    if (!rec || nonEmptyString(rec.iso_639_1)?.toLowerCase() !== targetBaseLang) continue;
    const iso3166 = nonEmptyString(rec.iso_3166_1)?.toUpperCase();
    const data = asRecord(rec.data);
    if (
      !nonEmptyString(data?.overview) &&
      !nonEmptyString(data?.title) &&
      !nonEmptyString(data?.name)
    ) {
      continue;
    }
    if (targetRegion && iso3166 === targetRegion) {
      bestRec = rec;
      break;
    }
    if (!bestRec || (targetBaseLang === 'en' && iso3166 === 'US')) {
      bestRec = rec;
    }
  }

  const data = asRecord(bestRec?.data);
  return {
    title: nonEmptyString(data?.title) ?? nonEmptyString(data?.name),
    overview: nonEmptyString(data?.overview),
  };
}

function extractYoutubeTrailerId(videosRaw: unknown): string | null {
  const results = asRecord(videosRaw)?.results;
  if (!Array.isArray(results)) return null;
  let fallbackTeaser: string | null = null;
  let fallbackTrailer: string | null = null;
  for (const entry of results) {
    const rec = asRecord(entry);
    if (!rec || nonEmptyString(rec.site)?.toLowerCase() !== 'youtube') continue;
    const key = nonEmptyString(rec.key);
    if (!key || !YOUTUBE_KEY_RE.test(key)) continue;
    const type = nonEmptyString(rec.type)?.toLowerCase() ?? '';
    if (type === 'trailer' && rec.official === true) return key;
    if (type === 'trailer' && !fallbackTrailer) fallbackTrailer = key;
    if (type === 'teaser' && !fallbackTeaser) fallbackTeaser = key;
  }
  return fallbackTrailer ?? fallbackTeaser;
}

function extractTmdbCast(creditsRaw: unknown): ElvCastMember[] {
  const castRaw = asRecord(creditsRaw)?.cast;
  if (!Array.isArray(castRaw)) return [];
  const indexed = castRaw
    .map((entry, idx) => ({ rec: asRecord(entry), idx }))
    .filter((item): item is { readonly rec: Record<string, unknown>; readonly idx: number } =>
      Boolean(item.rec),
    );
  indexed.sort((a, b) => {
    const orderA = typeof a.rec.order === 'number' ? a.rec.order : a.idx;
    const orderB = typeof b.rec.order === 'number' ? b.rec.order : b.idx;
    return orderA - orderB;
  });
  const cast: ElvCastMember[] = [];
  for (const { rec } of indexed) {
    const id = typeof rec.id === 'number' ? String(rec.id) : nonEmptyString(rec.id);
    const name = nonEmptyString(rec.name);
    if (!id || !TMDB_ID_RE.test(id) || !name) continue;
    cast.push({
      personId: `tmdb:${id}`,
      name,
      character: nonEmptyString(rec.character),
      portraitUrl: buildTmdbImageUrl(rec.profile_path, 'w185'),
    });
    if (cast.length >= 15) break;
  }
  return cast;
}

function extractTmdbDirector(
  detail: Record<string, unknown>,
  mediaType: ElvMediaType,
): string | null {
  if (mediaType === 'series' && Array.isArray(detail.created_by)) {
    for (const creator of detail.created_by) {
      const name = nonEmptyString(asRecord(creator)?.name);
      if (name) return name;
    }
  }
  const crew = asRecord(detail.credits)?.crew;
  if (Array.isArray(crew)) {
    for (const member of crew) {
      const rec = asRecord(member);
      if (nonEmptyString(rec?.job) === 'Director') {
        const name = nonEmptyString(rec?.name);
        if (name) return name;
      }
    }
  }
  return null;
}

/** Maps a full `/3/{movie|tv}/{id}?append_to_response=...` JSON object into `ElvRichTitlePayload`. */
export function mapTmdbDetailToRichPayload(
  raw: unknown,
  mediaType: ElvMediaType,
  lang: string,
  nowMs: number,
  fallbackImdbId?: string | null,
): ElvRichTitlePayload | null {
  const detail = asRecord(raw);
  if (!detail) return null;

  const tmdbId =
    typeof detail.id === 'number' && Number.isInteger(detail.id) && detail.id > 0
      ? String(detail.id)
      : nonEmptyString(detail.id);
  if (!tmdbId || !TMDB_ID_RE.test(tmdbId)) return null;

  const extImdb = validateImdbId(asRecord(detail.external_ids)?.imdb_id ?? detail.imdb_id);
  const fallbackValid = fallbackImdbId ? validateImdbId(fallbackImdbId) : null;
  const imdbId = extImdb.ok ? extImdb.value : fallbackValid?.ok ? fallbackValid.value : null;
  if (!imdbId) return null;

  const displayTitle = nonEmptyString(mediaType === 'series' ? detail.name : detail.title);
  const originalTitle =
    nonEmptyString(mediaType === 'series' ? detail.original_name : detail.original_title) ??
    displayTitle;
  if (!originalTitle) return null;

  const [targetBase = 'en', targetRegion] = toTmdbBcp47Lang(lang).split('-');
  const enTrans = findTranslationData(detail.translations, 'en', 'US');
  const targetTrans = !isEnglishLang(lang)
    ? findTranslationData(
        detail.translations,
        targetBase.toLowerCase(),
        targetRegion?.toUpperCase(),
      )
    : { title: null, overview: null };

  const origLang = nonEmptyString(detail.original_language)?.toLowerCase();
  const englishTitle =
    enTrans.title ??
    (isEnglishLang(lang) ? displayTitle : null) ??
    (origLang === 'en' ? originalTitle : null);
  const localizedTitle = !isEnglishLang(lang)
    ? (targetTrans.title ?? (displayTitle && displayTitle !== originalTitle ? displayTitle : null))
    : null;

  const directOverview = nonEmptyString(detail.overview);
  const originalSynopsis = isEnglishLang(lang)
    ? (directOverview ?? enTrans.overview)
    : enTrans.overview;
  const localizedSynopsis = !isEnglishLang(lang)
    ? (targetTrans.overview ??
      (directOverview && directOverview !== enTrans.overview ? directOverview : null))
    : null;

  const rawAvg = detail.vote_average;
  const rawVotes = detail.vote_count;
  const epTimes = Array.isArray(detail.episode_run_time) ? detail.episode_run_time : [];
  const firstEp = epTimes.find((t) => typeof t === 'number' && Number.isFinite(t) && t > 0);
  const lastEpRuntime = asRecord(detail.last_episode_to_air)?.runtime;
  const runtimeMin =
    mediaType === 'movie'
      ? typeof detail.runtime === 'number' && detail.runtime > 0
        ? Math.round(detail.runtime)
        : null
      : typeof firstEp === 'number'
        ? Math.round(firstEp)
        : typeof lastEpRuntime === 'number' && lastEpRuntime > 0
          ? Math.round(lastEpRuntime)
          : null;

  const col = asRecord(detail.belongs_to_collection);
  const colId = typeof col?.id === 'number' && col.id > 0 ? String(col.id) : null;
  const colName = nonEmptyString(col?.name);

  const recommendedTmdbIds: string[] = [];
  const recResults = asRecord(detail.recommendations)?.results;
  if (Array.isArray(recResults)) {
    for (const entry of recResults) {
      const id = asRecord(entry)?.id;
      const str = typeof id === 'number' && id > 0 ? String(id) : nonEmptyString(id);
      if (str && TMDB_ID_RE.test(str) && !recommendedTmdbIds.includes(str)) {
        recommendedTmdbIds.push(str);
        if (recommendedTmdbIds.length >= 12) break;
      }
    }
  }

  const record: ElvTitleRecord = {
    imdbId,
    tmdbId,
    mediaType,
    originalTitle,
    englishTitle,
    year: parseTmdbReleaseYear(
      mediaType === 'series' ? detail.first_air_date : detail.release_date,
    ),
    rating:
      typeof rawAvg === 'number' && Number.isFinite(rawAvg) && rawAvg > 0
        ? Math.round(rawAvg * 10) / 10
        : null,
    votes:
      typeof rawVotes === 'number' && Number.isFinite(rawVotes) && rawVotes > 0
        ? Math.round(rawVotes)
        : null,
    runtimeMin,
    genres: mapTmdbGenreIds(detail.genres),
    posterUrl: buildTmdbImageUrl(detail.poster_path, 'w342'),
    backdropUrl: buildTmdbImageUrl(detail.backdrop_path, 'w1280'),
    trailerStreamUrl: null,
    trailerYoutubeId: extractYoutubeTrailerId(detail.videos),
    director: extractTmdbDirector(detail, mediaType),
    cast: extractTmdbCast(detail.credits),
    mltImdbIds: [],
    franchiseKey: colId && colName ? `tmdb-col:${colId}` : null,
    franchiseName: colId && colName ? colName : null,
    franchiseOrder: null,
    originalSynopsis,
    updatedAt: nowMs,
  };

  return { record, localizedTitle, localizedSynopsis, recommendedTmdbIds };
}
