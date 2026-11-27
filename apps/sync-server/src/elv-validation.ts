import type { ElvMatchBatchInput, ElvMatchBatchItemInput, ElvMediaType } from './elv-types.ts';
import type { ValidationResult } from './validation.ts';

/** Maximum items allowed in a single `POST /v1/elv/match-batch` request. */
const MAX_ELV_MATCH_BATCH_ITEMS = 500;

/** Strict IMDb title ID pattern (`tt` followed by 5 to 10 digits). */
const IMDB_ID_RE = /^tt\d{5,10}$/;
const IMDB_ID_CI_RE = /^tt\d{5,10}$/i;
const TMDB_ID_RE = /^[1-9]\d{0,9}$/;
const LANG_RE = /^([a-z]{2})(?:-([a-z]{2}))?$/i;

const MAX_KEY_LENGTH = 160;
const MAX_TITLE_LENGTH = 200;
const MAX_SEARCH_QUERY_LENGTH = 120;
const MIN_VALID_YEAR = 1880;
const MAX_VALID_YEAR = 2100;

const ITEM_KEY_WHITESPACE_RE = /\s/;
const ITEM_KEY_RAW_SCHEME_RE = /(?:^|[^a-z0-9_.-])(?:https?|rtmps?|rtsp|file):/i;
const ITEM_KEY_SECRET_RE =
  /\b(?:password|passwd|username|access_token|refresh_token|api_key|authorization)\s*[:=]/i;
const ITEM_KEY_PRIVATE_PATH_RE =
  /(?:^|[\s"'(=:])(?:\/(?:Users|home|var|tmp|private|data|storage)\/|[A-Za-z]:\\|\\\\[A-Za-z0-9_.-]+\\)/;

const ALLOWED_ROOT_KEYS = new Set(['items', 'lang']);
const ALLOWED_ITEM_KEYS = new Set([
  'key',
  'cleanTitle',
  'year',
  'mediaType',
  'providerImdbId',
  'providerTmdbId',
]);

const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  'password',
  'passwd',
  'username',
  'user',
  'serverurl',
  'server_url',
  'm3uurl',
  'm3u_url',
  'streamurl',
  'stream_url',
  'playlisturl',
  'playlist_url',
  'url',
  'host',
  'token',
  'auth',
  'authorization',
  'credentials',
  'apikey',
  'api_key',
  'secret',
]);

const SENSITIVE_VALUE_PATTERNS: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: 'url_scheme', re: /(?:[a-z][a-z0-9+.-]*:\/\/|file:\S)/i },
  { label: 'uri_credentials', re: /[^\s/:@]{1,128}:[^\s/:@]{1,128}@[^\s/:@]+/ },
  {
    label: 'auth_secret',
    re: /\b(?:password|passwd|username|access_token|refresh_token|api_key|authorization)\s*[:=]/i,
  },
  { label: 'bearer_token', re: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
  {
    label: 'private_file_path',
    re: /(?:^|[\s"'(=:])(?:\/(?:Users|home|var|tmp|private|data|storage)\/|[A-Za-z]:\\|\\\\[A-Za-z0-9_.-]+\\)/,
  },
  {
    label: 'email_address',
    re: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,128}\.[A-Za-z]{2,}\b/,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function detectSensitiveString(value: string): string | null {
  for (const entry of SENSITIVE_VALUE_PATTERNS) {
    if (entry.re.test(value)) return entry.label;
  }
  return null;
}

function checkForbiddenKey(key: string): string | null {
  if (FORBIDDEN_CREDENTIAL_KEYS.has(key.toLowerCase())) {
    return `forbidden_field:${key}`;
  }
  return null;
}

/** Validates an IMDb title ID strictly against `^tt\d{5,10}$`. */
export function validateImdbId(raw: unknown): ValidationResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_imdb_id' };
  const trimmed = raw.trim();
  if (!IMDB_ID_RE.test(trimmed)) return { ok: false, error: 'invalid_imdb_id' };
  return { ok: true, value: trimmed };
}

/** Validates and normalizes an ISO-639-1 / BCP-47 language tag (e.g. `pt-br` -> `pt-BR`, `TR` -> `tr`). */
export function validateElvLang(raw: unknown): ValidationResult<string> {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: 'en' };
  }
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_lang' };
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: 'en' };
  const match = LANG_RE.exec(trimmed);
  if (!match?.[1]) return { ok: false, error: 'invalid_lang' };
  const language = match[1].toLowerCase();
  const region = match[2]?.toUpperCase();
  return { ok: true, value: region ? `${language}-${region}` : language };
}

function hasWhitespaceOrControlChar(value: string): boolean {
  if (ITEM_KEY_WHITESPACE_RE.test(value)) return true;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateItemKey(raw: unknown): ValidationResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_item_key' };
  if (raw.length === 0 || raw.length > MAX_KEY_LENGTH || hasWhitespaceOrControlChar(raw)) {
    return { ok: false, error: 'invalid_item_key' };
  }
  if (raw.includes('://') || ITEM_KEY_RAW_SCHEME_RE.test(raw)) {
    return { ok: false, error: 'sensitive_data:url_scheme' };
  }
  if (ITEM_KEY_SECRET_RE.test(raw)) {
    return { ok: false, error: 'sensitive_data:auth_secret' };
  }
  if (ITEM_KEY_PRIVATE_PATH_RE.test(raw)) {
    return { ok: false, error: 'sensitive_data:private_file_path' };
  }
  return { ok: true, value: raw };
}

function parseOptionalYear(raw: unknown): ValidationResult<number | null> {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: null };
  }
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < MIN_VALID_YEAR ||
    raw > MAX_VALID_YEAR
  ) {
    return { ok: false, error: 'invalid_year' };
  }
  return { ok: true, value: raw };
}

function parseOptionalImdbId(raw: unknown): ValidationResult<string | null> {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: null };
  }
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_provider_imdb_id' };
  const trimmed = raw.trim();
  if (!IMDB_ID_CI_RE.test(trimmed)) return { ok: false, error: 'invalid_provider_imdb_id' };
  return { ok: true, value: trimmed.toLowerCase() };
}

function parseOptionalTmdbId(raw: unknown): ValidationResult<string | null> {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: null };
  }
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw <= 0 || raw > 9_999_999_999) {
      return { ok: false, error: 'invalid_provider_tmdb_id' };
    }
    return { ok: true, value: String(raw) };
  }
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_provider_tmdb_id' };
  const trimmed = raw.trim();
  if (!TMDB_ID_RE.test(trimmed)) return { ok: false, error: 'invalid_provider_tmdb_id' };
  return { ok: true, value: trimmed };
}

/** Validates `POST /v1/elv/match-batch` input while strictly rejecting URLs, credentials, and unknown fields. */
export function validateElvMatchBatchInput(raw: unknown): ValidationResult<ElvMatchBatchInput> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_body' };

  for (const rootKey of Object.keys(raw)) {
    const forbidden = checkForbiddenKey(rootKey);
    if (forbidden) return { ok: false, error: forbidden };
    if (!ALLOWED_ROOT_KEYS.has(rootKey)) {
      return { ok: false, error: `disallowed_field:${rootKey}` };
    }
  }

  const langRes = validateElvLang(raw.lang);
  if (!langRes.ok) return langRes;

  if (!Array.isArray(raw.items)) return { ok: false, error: 'items_array_required' };
  if (raw.items.length === 0 || raw.items.length > MAX_ELV_MATCH_BATCH_ITEMS) {
    return { ok: false, error: 'invalid_items_count' };
  }

  const items: ElvMatchBatchItemInput[] = [];
  for (const entry of raw.items) {
    if (!isRecord(entry)) return { ok: false, error: 'invalid_item' };

    for (const itemKey of Object.keys(entry)) {
      const forbidden = checkForbiddenKey(itemKey);
      if (forbidden) return { ok: false, error: forbidden };
      if (!ALLOWED_ITEM_KEYS.has(itemKey)) {
        return { ok: false, error: `disallowed_item_field:${itemKey}` };
      }
    }

    const keyRes = validateItemKey(entry.key);
    if (!keyRes.ok) return keyRes;
    const key = keyRes.value;

    if (typeof entry.cleanTitle !== 'string') return { ok: false, error: 'invalid_clean_title' };
    const cleanTitle = entry.cleanTitle.trim();
    if (cleanTitle.length === 0 || cleanTitle.length > MAX_TITLE_LENGTH) {
      return { ok: false, error: 'invalid_clean_title' };
    }
    const titleSensitive = detectSensitiveString(cleanTitle);
    if (titleSensitive) return { ok: false, error: `sensitive_data:${titleSensitive}` };

    if (entry.mediaType !== 'movie' && entry.mediaType !== 'series') {
      return { ok: false, error: 'invalid_media_type' };
    }

    const yearRes = parseOptionalYear(entry.year);
    if (!yearRes.ok) return yearRes;
    const imdbRes = parseOptionalImdbId(entry.providerImdbId);
    if (!imdbRes.ok) return imdbRes;
    const tmdbRes = parseOptionalTmdbId(entry.providerTmdbId);
    if (!tmdbRes.ok) return tmdbRes;

    items.push({
      key,
      cleanTitle,
      year: yearRes.value,
      mediaType: entry.mediaType,
      providerImdbId: imdbRes.value,
      providerTmdbId: tmdbRes.value,
    });
  }

  return { ok: true, value: { items, lang: langRes.value } };
}

/** Validated query parameters for `GET /v1/elv/search`. */
export interface ValidatedElvSearchParams {
  readonly query: string;
  readonly mediaType: ElvMediaType | null;
}

/** Validates `GET /v1/elv/search?q=...&type=movie|series` parameters. */
export function validateElvSearchParams(url: URL): ValidationResult<ValidatedElvSearchParams> {
  const rawQuery = url.searchParams.get('q');
  if (typeof rawQuery !== 'string') return { ok: false, error: 'invalid_query' };
  const query = rawQuery.trim();
  if (query.length === 0 || query.length > MAX_SEARCH_QUERY_LENGTH) {
    return { ok: false, error: 'invalid_query' };
  }
  const sensitive = detectSensitiveString(query);
  if (sensitive) return { ok: false, error: `sensitive_data:${sensitive}` };

  const rawType = url.searchParams.get('type');
  let mediaType: ElvMediaType | null = null;
  if (rawType !== null && rawType.trim().length > 0) {
    const normalized = rawType.trim().toLowerCase();
    if (normalized !== 'movie' && normalized !== 'series') {
      return { ok: false, error: 'invalid_media_type' };
    }
    mediaType = normalized;
  }

  return { ok: true, value: { query, mediaType } };
}

const TURKISH_AND_LATIN_CHAR_MAP: Readonly<Record<string, string>> = {
  '\u0130': 'i', // İ
  I: 'i',
  '\u0131': 'i', // ı
  '\u011e': 'g', // Ğ
  '\u011f': 'g', // ğ
  '\u015e': 's', // Ş
  '\u015f': 's', // ş
  '\u00c7': 'c', // Ç
  '\u00e7': 'c', // ç
  '\u00d6': 'o', // Ö
  '\u00f6': 'o', // ö
  '\u00dc': 'u', // Ü
  '\u00fc': 'u', // ü
  '\u00df': 'ss', // ß
  '\u00c6': 'ae', // Æ
  '\u00e6': 'ae', // æ
  '\u0152': 'oe', // Œ
  '\u0153': 'oe', // œ
};

/** Turkish-safe Unicode NFD/NFC title fold used for deterministic cache lookup keys and similarity scoring. */
export function foldTitleForMatch(raw: string): string {
  let mapped = '';
  for (const ch of raw) {
    mapped += TURKISH_AND_LATIN_CHAR_MAP[ch] ?? ch;
  }
  return mapped
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Builds a canonical lookup key for `elv_title_match_index`, or `null` when folded title is empty. */
export function buildMatchLookupKey(
  cleanTitle: string,
  mediaType: ElvMediaType,
  year: number | null,
): string | null {
  const folded = foldTitleForMatch(cleanTitle);
  if (folded.length === 0) return null;
  return `${mediaType}:${folded}:${year ?? ''}`;
}

/** Returns true when `lang` is English (`en` or `en-*`). */
export function isEnglishLang(lang: string): boolean {
  const lower = lang.trim().toLowerCase();
  return lower === 'en' || lower.startsWith('en-');
}
