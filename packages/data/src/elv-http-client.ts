import type {
  ElvCastMember,
  ElvFeedItem,
  ElvMediaType,
  UpsertElvTitleInput,
} from './elv-enrichment-repo';
import { normalizeCatalogImdbId, normalizeCatalogTmdbId } from './writers';

const MAX_ELV_MATCH_BATCH_SIZE = 500;
const MAX_WIRE_TITLE_LEN = 200;
const MAX_SEARCH_QUERY_LEN = 120;
const URL_TOKEN_RE = /\b(?:https?|rtmp|rtsp|udp|rtp):\/\/\S+/gi;
const SAFE_LANG_RE = /^[a-z]{2}(?:-[a-z]{2})?$/i;
const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Strictly clean, credential-free match payload sent to `POST /v1/elv/match-batch`. */
export interface ElvMatchBatchRequestItem {
  readonly key: string;
  readonly cleanTitle: string;
  readonly year?: number | null;
  readonly mediaType: ElvMediaType;
  readonly providerImdbId?: string | null;
  readonly providerTmdbId?: string | null;
}

/** One resolved match hit returned by `POST /v1/elv/match-batch`. */
export interface ElvMatchBatchHit {
  readonly key: string;
  readonly imdbId: string;
  readonly confidence: number;
  readonly mediaType: ElvMediaType;
  readonly title?: UpsertElvTitleInput | null;
}

/** Normalized response from `POST /v1/elv/match-batch`. */
export interface ElvMatchBatchResult {
  readonly matches: readonly ElvMatchBatchHit[];
  readonly unmatchedKeys: readonly string[];
  readonly pendingKeys: readonly string[];
}

/** Trending/editorial IMDb feeds returned by `GET /v1/elv/feeds`. */
export interface ElvFeedsPayload {
  readonly topPicks: readonly ElvFeedItem[];
  readonly movieMeter: readonly ElvFeedItem[];
  readonly tvMeter: readonly ElvFeedItem[];
  readonly currentUpcomingTv: readonly ElvFeedItem[];
  readonly updatedAt: number;
}

/** Fix-Match candidate returned by `GET /v1/elv/search`. */
export interface ElvSearchCandidate {
  readonly imdbId: string;
  readonly title: string;
  readonly year: number | null;
  readonly mediaType: ElvMediaType;
  readonly posterUrl: string | null;
  readonly stars?: string | null;
}

/** Injectable pure-TS metadata client port communicating with the ELV metadata worker (`/v1/elv/*`). */
export interface ElvMetadataClient {
  matchBatch(
    items: readonly ElvMatchBatchRequestItem[],
    lang?: string,
    signal?: AbortSignal,
  ): Promise<ElvMatchBatchResult>;
  fetchTitleDetail(
    imdbId: string,
    lang?: string,
    signal?: AbortSignal,
  ): Promise<UpsertElvTitleInput | null>;
  fetchFeeds(signal?: AbortSignal): Promise<ElvFeedsPayload | null>;
  searchTitles(
    query: string,
    mediaType?: ElvMediaType,
    signal?: AbortSignal,
  ): Promise<readonly ElvSearchCandidate[]>;
}

/** Configuration for {@link createElvHttpClient}. */
export interface ElvHttpClientOptions {
  readonly baseUrl: string;
  readonly fetchFn?: typeof globalThis.fetch;
  /** Permits `http://localhost` / `127.0.0.1` only when explicitly opted in for local development. */
  readonly allowInsecureLocalhost?: boolean;
}

function validateBaseUrl(rawBaseUrl: string, allowInsecureLocalhost: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl.trim());
  } catch {
    throw new Error('ELV metadata client requires a valid URL');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('ELV metadata base URL must not contain embedded credentials');
  }
  const isHttps = parsed.protocol === 'https:';
  const isAllowedLocal =
    allowInsecureLocalhost &&
    parsed.protocol === 'http:' &&
    LOCALHOST_HOSTS.has(parsed.hostname.toLowerCase());
  if (!isHttps && !isAllowedLocal) {
    throw new Error('ELV metadata client requires an HTTPS base URL');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeLang(lang: string | undefined): string | undefined {
  if (typeof lang !== 'string') return undefined;
  const trimmed = lang.trim().replace('_', '-');
  if (!SAFE_LANG_RE.test(trimmed)) return undefined;
  const dash = trimmed.indexOf('-');
  if (dash === -1) return trimmed.toLowerCase();
  return `${trimmed.slice(0, dash).toLowerCase()}-${trimmed.slice(dash + 1).toUpperCase()}`;
}

function sanitizeWireTitle(raw: string): string {
  return raw.replace(URL_TOKEN_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_WIRE_TITLE_LEN);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asMediaType(value: unknown, fallback: ElvMediaType = 'movie'): ElvMediaType {
  return value === 'series' ? 'series' : value === 'movie' ? 'movie' : fallback;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asString(item)).filter((item): item is string => item !== null);
}

function parseCast(value: unknown): ElvCastMember[] {
  if (!Array.isArray(value)) return [];
  const out: ElvCastMember[] = [];
  for (const raw of value) {
    const rec = asRecord(raw);
    const name = asString(rec?.name);
    if (rec === null || name === null) continue;
    out.push({
      personId: asString(rec.personId),
      name,
      character: asString(rec.character),
      portraitUrl: asString(rec.portraitUrl),
    });
  }
  return out;
}

function mapWireTitle(
  raw: unknown,
  fallbackImdbId: string,
  fallbackMediaType: ElvMediaType,
  lang: string | undefined,
  isDetail: boolean,
  nowMs: number,
): UpsertElvTitleInput | null {
  const rec = asRecord(raw);
  if (rec === null) return null;
  const imdbId = normalizeCatalogImdbId(asString(rec.imdbId) ?? fallbackImdbId);
  if (imdbId === null) return null;
  const originalTitle = asString(rec.originalTitle) ?? asString(rec.title);
  if (originalTitle === null) return null;

  const langKey = (normalizeLang(asString(rec.synopsisLang) ?? lang) ?? 'en').toLowerCase();
  const localizedTitles: Record<string, string> = {};
  const rawLocMap = asRecord(rec.localizedTitles);
  if (rawLocMap !== null) {
    for (const [k, v] of Object.entries(rawLocMap)) {
      const s = asString(v);
      if (s !== null) localizedTitles[k.toLowerCase()] = s;
    }
  }
  const localizedTitle = asString(rec.localizedTitle);
  if (localizedTitle !== null) {
    localizedTitles[(normalizeLang(lang) ?? langKey).toLowerCase()] = localizedTitle;
  }

  const synopses: Record<string, string> = {};
  const rawSynMap = asRecord(rec.synopses);
  if (rawSynMap !== null) {
    for (const [k, v] of Object.entries(rawSynMap)) {
      const s = asString(v);
      if (s !== null) synopses[k.toLowerCase()] = s;
    }
  }
  const synopsis = asString(rec.synopsis);
  if (synopsis !== null) synopses[langKey] = synopsis;

  const tmdbId = normalizeCatalogTmdbId(
    typeof rec.tmdbId === 'string' || typeof rec.tmdbId === 'number' ? rec.tmdbId : null,
  );

  return {
    imdbId,
    tmdbId,
    mediaType: asMediaType(rec.mediaType, fallbackMediaType),
    originalTitle,
    englishTitle: asString(rec.englishTitle),
    localizedTitles,
    year: asNumber(rec.year),
    rating: asNumber(rec.rating),
    votes: asNumber(rec.votes),
    runtimeMin: asNumber(rec.runtimeMin),
    genres: asStringList(rec.genres),
    posterUrl: asString(rec.posterUrl),
    backdropUrl: asString(rec.backdropUrl),
    trailerStreamUrl: asString(rec.trailerStreamUrl),
    trailerYoutubeId: asString(rec.trailerYoutubeId),
    director: asString(rec.director),
    cast: parseCast(rec.cast),
    mltImdbIds: asStringList(rec.mltImdbIds),
    franchiseKey: asString(rec.franchiseKey),
    franchiseName: asString(rec.franchiseName),
    franchiseOrder: asNumber(rec.franchiseOrder),
    synopses,
    ...(isDetail ? { detailFetchedAt: nowMs } : {}),
    updatedAt: asNumber(rec.updatedAt) ?? nowMs,
  };
}

function parseFeedList(raw: unknown): ElvFeedItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ElvFeedItem[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (rec === null) continue;
    const imdbId = normalizeCatalogImdbId(asString(rec.imdbId));
    const title = asString(rec.title);
    if (imdbId === null || title === null) continue;
    const year = asNumber(rec.year);
    const rating = asNumber(rec.rating);
    const posterUrl = asString(rec.posterUrl);
    const genres = asStringList(rec.genres);
    const rank = asNumber(rec.rank);
    out.push({
      imdbId,
      title,
      mediaType: asMediaType(rec.mediaType),
      ...(year !== null ? { year } : {}),
      ...(rating !== null ? { rating } : {}),
      ...(posterUrl !== null ? { posterUrl } : {}),
      ...(genres.length > 0 ? { genres } : {}),
      ...(rank !== null ? { rank } : {}),
    });
  }
  return out;
}

/**
 * Creates a strict HTTPS HTTP client for `/v1/elv/*` metadata endpoints (`#511`).
 * Never forwards provider credentials or stream URLs on the wire.
 */
export function createElvHttpClient(opts: ElvHttpClientOptions): ElvMetadataClient {
  const base = validateBaseUrl(opts.baseUrl, opts.allowInsecureLocalhost === true);
  const fetchFn = opts.fetchFn ?? globalThis.fetch;

  return {
    async matchBatch(items, lang, signal) {
      if (items.length === 0) return { matches: [], unmatchedKeys: [], pendingKeys: [] };
      const safeLang = normalizeLang(lang);
      const wireItems = items
        .slice(0, MAX_ELV_MATCH_BATCH_SIZE)
        .map((item) => {
          const cleanTitle = sanitizeWireTitle(item.cleanTitle);
          const providerImdbId = normalizeCatalogImdbId(item.providerImdbId);
          const providerTmdbId = normalizeCatalogTmdbId(item.providerTmdbId);
          return {
            key: item.key,
            cleanTitle,
            ...(typeof item.year === 'number' && Number.isInteger(item.year)
              ? { year: item.year }
              : {}),
            mediaType: item.mediaType,
            ...(providerImdbId !== null ? { providerImdbId } : {}),
            ...(providerTmdbId !== null ? { providerTmdbId } : {}),
          };
        })
        .filter((item) => item.key.trim() !== '' && item.cleanTitle !== '');

      if (wireItems.length === 0) return { matches: [], unmatchedKeys: [], pendingKeys: [] };

      const res = await fetchFn(`${base}/v1/elv/match-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          items: wireItems,
          ...(safeLang !== undefined ? { lang: safeLang } : {}),
        }),
        ...(signal !== undefined ? { signal } : {}),
      });
      if (!res.ok) throw new Error(`ELV match-batch failed with HTTP ${res.status}`);
      const json = asRecord(await res.json());
      if (json === null) return { matches: [], unmatchedKeys: [], pendingKeys: [] };

      const nowMs = Date.now();
      const rawMatches = json.matches;
      const entries: unknown[] = Array.isArray(rawMatches)
        ? rawMatches
        : rawMatches !== null && typeof rawMatches === 'object'
          ? Object.values(rawMatches as Record<string, unknown>)
          : [];

      const matches: ElvMatchBatchHit[] = [];
      for (const entry of entries) {
        const rec = asRecord(entry);
        if (rec === null) continue;
        const key = asString(rec.key);
        const imdbId = normalizeCatalogImdbId(asString(rec.imdbId));
        const confidence = asNumber(rec.confidence);
        if (key === null || imdbId === null || confidence === null) continue;
        const mediaType = asMediaType(rec.mediaType);
        matches.push({
          key,
          imdbId,
          confidence,
          mediaType,
          title: mapWireTitle(rec.title, imdbId, mediaType, safeLang, false, nowMs),
        });
      }

      return {
        matches,
        unmatchedKeys: asStringList(json.unmatchedKeys),
        pendingKeys: asStringList(json.pendingKeys),
      };
    },

    async fetchTitleDetail(imdbId, lang, signal) {
      const normalized = normalizeCatalogImdbId(imdbId);
      if (normalized === null) return null;
      const safeLang = normalizeLang(lang);
      const qs = safeLang === undefined ? '' : `?lang=${encodeURIComponent(safeLang)}`;
      const res = await fetchFn(`${base}/v1/elv/title/${normalized}${qs}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        ...(signal !== undefined ? { signal } : {}),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`ELV title detail failed with HTTP ${res.status}`);
      return mapWireTitle(await res.json(), normalized, 'movie', safeLang, true, Date.now());
    },

    async fetchFeeds(signal) {
      const res = await fetchFn(`${base}/v1/elv/feeds`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        ...(signal !== undefined ? { signal } : {}),
      });
      if (!res.ok) return null;
      const json = asRecord(await res.json());
      if (json === null) return null;
      return {
        topPicks: parseFeedList(json.topPicks),
        movieMeter: parseFeedList(json.movieMeter),
        tvMeter: parseFeedList(json.tvMeter),
        currentUpcomingTv: parseFeedList(json.currentUpcomingTv),
        updatedAt: asNumber(json.updatedAt) ?? Date.now(),
      };
    },

    async searchTitles(query, mediaType, signal) {
      const cleaned = sanitizeWireTitle(query).slice(0, MAX_SEARCH_QUERY_LEN);
      if (cleaned === '') return [];
      const params = new URLSearchParams({ q: cleaned });
      if (mediaType !== undefined) params.set('type', mediaType);
      const res = await fetchFn(`${base}/v1/elv/search?${params.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        ...(signal !== undefined ? { signal } : {}),
      });
      if (!res.ok) return [];
      const json = asRecord(await res.json());
      const rawResults = json?.results;
      if (!Array.isArray(rawResults)) return [];
      const out: ElvSearchCandidate[] = [];
      for (const entry of rawResults) {
        const rec = asRecord(entry);
        if (rec === null) continue;
        const imdbId = normalizeCatalogImdbId(asString(rec.imdbId));
        const title = asString(rec.title);
        if (imdbId === null || title === null) continue;
        const stars = asString(rec.stars);
        out.push({
          imdbId,
          title,
          year: asNumber(rec.year),
          mediaType: asMediaType(rec.mediaType, mediaType ?? 'movie'),
          posterUrl: asString(rec.posterUrl),
          ...(stars !== null ? { stars } : {}),
        });
      }
      return out;
    },
  };
}
