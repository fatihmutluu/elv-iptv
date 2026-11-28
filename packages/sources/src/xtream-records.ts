import { type ElvError, elvError } from '@elv/domain';
import { sanitizeArtworkUrl } from './artwork-url';
import { decodeLegacyCodepage } from './codepages';
import { firstProviderImdbId, firstProviderTmdbId } from './provider-ids';
import { daysInMonth, resolveServerTimezone, wallTimeToUtcMs } from './timezone-offset';
import { decodeUtf8 } from './utf8';
import { mergeById, toNumber, toStrictInt, toText } from './xtream-normalize';
import type {
  XtreamAccount,
  XtreamCategory,
  XtreamEpgEntry,
  XtreamEpisode,
  XtreamLive,
  XtreamMovie,
  XtreamSeries,
  XtreamSeriesInfo,
  XtreamVodInfo,
} from './xtream-types';

/** Any JSON object; absent keys read as `undefined`. */
export type Raw = Record<string, unknown>;

/** True for a non-null, non-array object. */
export function isRaw(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const asRaw = (v: unknown): Raw => (isRaw(v) ? v : {});

const MS_EPOCH_THRESHOLD = 1e11;
const FUTURE_GRACE_MS = 24 * 60 * 60 * 1000;
const STRICT_NUMERIC_TS_RE = /^[+-]?\d+(?:\.\d+)?$/;
const ISO_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|z|[+-]\d{2}:?\d{2})?$/;
const ISO_DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PLACEHOLDER_META_RE = /^(?:n\/a|null|none|-+)$/i;

function parseIsoUtcMs(value: string): number | undefined {
  const trimmed = value.trim();
  const dt = ISO_DATETIME_RE.exec(trimmed);
  if (dt !== null) {
    const year = Number(dt[1]);
    const month = Number(dt[2]);
    const day = Number(dt[3]);
    const hour = Number(dt[4]);
    const minute = Number(dt[5]);
    const second = Number(dt[6]);
    if (year < 1000 || month < 1 || month > 12) return undefined;
    if (day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
      return undefined;
    }
    const wallMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const tzPart = dt[7];
    if (tzPart === undefined || tzPart === 'Z' || tzPart === 'z') return wallMs;
    const sign = tzPart[0] === '-' ? -1 : 1;
    const digits = tzPart.slice(1).replace(':', '');
    const offH = Number(digits.slice(0, 2));
    const offM = Number(digits.slice(2, 4));
    if (offH > 23 || offM > 59) return undefined;
    return wallMs - sign * (offH * 60 + offM) * 60_000;
  }
  const d = ISO_DATE_ONLY_RE.exec(trimmed);
  if (d !== null) {
    const year = Number(d[1]);
    const month = Number(d[2]);
    const day = Number(d[3]);
    if (year < 1000 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
      return undefined;
    }
    return Date.UTC(year, month - 1, day, 0, 0, 0);
  }
  return undefined;
}

/**
 * Parses an Xtream timestamp (`exp_date`, `added`, `last_modified`, EPG epoch) into epoch ms:
 * rejects `<= 0`, preserves 12–13 digit ms epochs without `* 1000`, multiplies seconds by `1000`,
 * parses ISO date/datetime strings as UTC, and optionally drops distant-future values (`> nowMs + 24h`).
 */
export function parseXtreamTimestampMs(
  value: unknown,
  opts?: { nowMs?: number; rejectFuture?: boolean },
): number | undefined {
  let ts: number | undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    ts = value >= MS_EPOCH_THRESHOLD ? Math.trunc(value) : Math.trunc(value * 1000);
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    if (STRICT_NUMERIC_TS_RE.test(trimmed)) {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) return undefined;
      ts = n >= MS_EPOCH_THRESHOLD ? Math.trunc(n) : Math.trunc(n * 1000);
    } else {
      ts = parseIsoUtcMs(trimmed);
    }
  }
  if (ts === undefined || !Number.isFinite(ts) || ts <= 0) return undefined;
  if (opts?.rejectFuture) {
    const nowMs = opts.nowMs ?? Date.now();
    if (ts > nowMs + FUTURE_GRACE_MS) return undefined;
  }
  return ts;
}

/** Returns `true` when `user_info.auth` explicitly marks the account unauthorized/disabled (`0`, `'0'`, `false`, `'false'`). */
function isXtreamAuthDisabled(auth: unknown): boolean {
  if (auth === 0 || auth === false) return true;
  if (typeof auth === 'string') {
    const lower = auth.trim().toLowerCase();
    return lower === '0' || lower === 'false';
  }
  return false;
}

function normalizeXtreamAccountStatus(
  userInfo: Raw,
  explicitStatus: string | undefined,
  expiresAt: number | undefined,
  nowMs: number,
): string {
  if (isXtreamAuthDisabled(userInfo.auth)) return 'Disabled';
  const raw =
    explicitStatus !== undefined
      ? explicitStatus.trim()
      : typeof userInfo.status === 'string'
        ? userInfo.status.trim()
        : '';
  const lower = raw.toLowerCase();
  if (lower === 'expired') return 'Expired';
  if (lower === 'disabled' || lower === 'banned') return 'Disabled';
  if (lower === '' || lower === 'active') {
    return expiresAt !== undefined && expiresAt < nowMs ? 'Expired' : 'Active';
  }
  return raw;
}

/**
 * Classifies an Xtream `user_info` payload into an `auth/*` error when credentials, status
 * (`Expired`, `Disabled`, `Banned`, custom non-active), or a past positive `exp_date` fail.
 */
export function classifyAccountFailure(info: Raw, nowMs = Date.now()): ElvError | undefined {
  if (isXtreamAuthDisabled(info.auth)) return elvError('auth', 'invalid-credentials');
  const status = typeof info.status === 'string' ? info.status.trim() : '';
  const lower = status.toLowerCase();
  if (lower === 'expired') return elvError('auth', 'account-expired');
  if (lower === 'disabled' || lower === 'banned') return elvError('auth', 'account-disabled');
  if (lower !== '' && lower !== 'active') {
    const slug = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return elvError('auth', `account-${slug || 'unknown'}`);
  }
  const expiresAt = parseXtreamTimestampMs(info.exp_date);
  if (expiresAt !== undefined && expiresAt < nowMs) return elvError('auth', 'account-expired');
  return undefined;
}

function toMetaText(value: unknown): string | undefined {
  const text = toText(value);
  return text === undefined || PLACEHOLDER_META_RE.test(text) ? undefined : text;
}

function toRating(value: unknown): number | undefined {
  const n = toNumber(value);
  return n !== undefined && n > 0 ? n : undefined;
}

function hasWhitespaceOrControl(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function httpDirectSource(value: unknown): string | undefined {
  const text = toText(value);
  if (text === undefined || !HTTP_BACKDROP_RE.test(text) || hasWhitespaceOrControl(text)) {
    return undefined;
  }
  try {
    const parsed = new URL(text);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.hostname.length > 0
      ? text
      : undefined;
  } catch {
    return undefined;
  }
}

function yearOf(...candidates: unknown[]): number | undefined {
  for (const c of candidates) {
    const direct = typeof c === 'number' && Number.isFinite(c) ? c : undefined;
    if (direct !== undefined) return direct;
    const m = typeof c === 'string' ? /^\s*(\d{4})/.exec(c) : null;
    if (m?.[1] !== undefined) return Number(m[1]);
  }
  return undefined;
}

function textIds(list: unknown[]): string[] {
  const ids: string[] = [];
  for (const v of list) {
    const n = toText(v);
    if (n !== undefined && !ids.includes(n)) ids.push(n);
  }
  return ids;
}

function categoryIds(raw: Raw): string[] {
  const many = Array.isArray(raw.category_ids) ? textIds(raw.category_ids) : [];
  return many.length > 0 ? many : textIds([raw.category_id]);
}

function put<T extends object>(target: T, key: string, value: unknown): void {
  if (value !== undefined) (target as Record<string, unknown>)[key] = value;
}

function artworkUrl(value: unknown): string | undefined {
  const text = toText(value);
  return text === undefined ? undefined : sanitizeArtworkUrl(text).url;
}

const HTTP_BACKDROP_RE = /^https?:\/\//i;

function httpBackdropValue(value: unknown): string | undefined {
  const url = artworkUrl(value);
  return url !== undefined && HTTP_BACKDROP_RE.test(url) ? url : undefined;
}

function backdropUrl(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        const hit = httpBackdropValue(entry);
        if (hit !== undefined) return hit;
      }
      continue;
    }
    const hit = httpBackdropValue(candidate);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

const MAX_CAST_CHARS = 512;
const MAX_DIRECTOR_CHARS = 256;

function creditText(maxChars: number, ...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    let text: string | undefined;
    if (typeof candidate === 'string') {
      text = toMetaText(candidate);
    } else if (Array.isArray(candidate)) {
      const parts: string[] = [];
      for (const item of candidate) {
        if (typeof item === 'string') {
          const part = toMetaText(item);
          if (part !== undefined) parts.push(part);
        }
      }
      if (parts.length > 0) text = parts.join(', ');
    }
    if (text !== undefined) {
      return text.length > maxChars ? text.slice(0, maxChars).trimEnd() : text;
    }
  }
  return undefined;
}

/** Maps `user_info`/`server_info`; normalizes status, unlimited `exp_date <= 0`, and non-IANA timezones. */
export function toAccount(
  userInfo: Raw,
  serverInfo: Raw,
  status?: string,
  nowMs = Date.now(),
): XtreamAccount {
  const expiresAt = parseXtreamTimestampMs(userInfo.exp_date);
  const account: XtreamAccount = {
    status: normalizeXtreamAccountStatus(userInfo, status, expiresAt, nowMs),
    isTrial: toNumber(userInfo.is_trial) === 1,
    outputFormats: Array.isArray(userInfo.allowed_output_formats)
      ? userInfo.allowed_output_formats.map((f) => toText(f)).filter((f) => f !== undefined)
      : [],
  };
  put(account, 'expiresAt', expiresAt);
  put(account, 'maxConnections', toNumber(userInfo.max_connections));
  put(account, 'activeConnections', toNumber(userInfo.active_cons));
  put(
    account,
    'serverTimezone',
    resolveServerTimezone(serverInfo.timezone, serverInfo.time_now, serverInfo.timestamp_now),
  );
  return account;
}

/** Maps category rows; rows without an id are dropped and a parent of 0 means none. */
export function toCategories(rows: Raw[]): XtreamCategory[] {
  const out: XtreamCategory[] = [];
  for (const r of rows) {
    const id = toText(r.category_id);
    if (id === undefined) continue;
    const category: XtreamCategory = { id, name: toText(r.category_name) ?? '' };
    const parent = toText(r.parent_id);
    if (parent !== undefined && parent !== '0') category.parentId = parent;
    out.push(category);
  }
  return out;
}

/** Maps live rows; `epg_channel_id` empty means no guide id. */
export function toLive(rows: Raw[]): XtreamLive[] {
  const out: XtreamLive[] = [];
  for (const r of rows) {
    const id = toStrictInt(r.stream_id);
    if (id === undefined) continue;
    const archive = toNumber(r.tv_archive) === 1;
    const live: XtreamLive = {
      id,
      name: toText(r.name) ?? '',
      categoryIds: categoryIds(r),
      catchupDays: archive ? (toNumber(r.tv_archive_duration) ?? 0) : 0,
    };
    const num = toStrictInt(r.num);
    if (num !== undefined && num > 0) live.num = num;
    put(live, 'icon', artworkUrl(r.stream_icon));
    put(live, 'epgId', toMetaText(r.epg_channel_id));
    put(live, 'added', parseXtreamTimestampMs(r.added, { rejectFuture: true }));
    out.push(live);
  }
  return mergeById(out);
}

/** Maps movie rows and merges repeated ids. */
export function toMovies(rows: Raw[]): XtreamMovie[] {
  const out: XtreamMovie[] = [];
  for (const r of rows) {
    const id = toStrictInt(r.stream_id);
    if (id === undefined) continue;
    const movie: XtreamMovie = {
      id,
      name: toText(r.name) ?? '',
      categoryIds: categoryIds(r),
      extension: toText(r.container_extension) ?? 'mp4',
    };
    put(movie, 'icon', artworkUrl(r.stream_icon));
    put(movie, 'backdrop', backdropUrl(r.backdrop_path, r.backdrop));
    put(movie, 'rating', toRating(r.rating));
    put(movie, 'year', yearOf(r.year));
    put(movie, 'cast', creditText(MAX_CAST_CHARS, r.cast, r.actors));
    put(movie, 'director', creditText(MAX_DIRECTOR_CHARS, r.director));
    put(movie, 'providerImdbId', firstProviderImdbId(r.imdb_id, r.imdb));
    put(movie, 'providerTmdbId', firstProviderTmdbId(r.tmdb, r.tmdb_id));
    put(movie, 'added', parseXtreamTimestampMs(r.added, { rejectFuture: true }));
    out.push(movie);
  }
  return mergeById(out);
}

/** Maps series rows and merges repeated ids; the year may come from either release date spelling. */
export function toSeries(rows: Raw[]): XtreamSeries[] {
  const out: XtreamSeries[] = [];
  for (const r of rows) {
    const id = toStrictInt(r.series_id);
    if (id === undefined) continue;
    const series: XtreamSeries = { id, name: toText(r.name) ?? '', categoryIds: categoryIds(r) };
    put(series, 'cover', artworkUrl(r.cover));
    put(series, 'backdrop', backdropUrl(r.backdrop_path, r.backdrop));
    put(series, 'plot', toMetaText(r.plot));
    put(series, 'rating', toRating(r.rating));
    put(series, 'year', yearOf(r.year, r.release_date, r.releaseDate));
    put(series, 'cast', creditText(MAX_CAST_CHARS, r.cast, r.actors));
    put(series, 'director', creditText(MAX_DIRECTOR_CHARS, r.director));
    put(series, 'providerImdbId', firstProviderImdbId(r.imdb_id, r.imdb));
    put(series, 'providerTmdbId', firstProviderTmdbId(r.tmdb, r.tmdb_id));
    put(series, 'lastModified', parseXtreamTimestampMs(r.last_modified, { rejectFuture: true }));
    out.push(series);
  }
  return mergeById(out);
}

/** Flattens the season-keyed or array-encoded episode container into a deduplicated sorted list. */
export function toSeriesInfo(raw: Raw): XtreamSeriesInfo {
  const seasons = new Set<number>();
  for (const s of Array.isArray(raw.seasons) ? raw.seasons : []) {
    const n = toStrictInt(isRaw(s) ? s.season_number : s);
    if (n !== undefined) seasons.add(n);
  }
  const episodes: XtreamEpisode[] = [];
  const seenIds = new Set<number>();
  const nextPerSeason = new Map<number, number>();
  const addEpisode = (
    e: unknown,
    fallbackSeason: number | undefined,
    keySeason?: number,
    indexHint?: number,
  ): void => {
    if (!isRaw(e)) return;
    const id = toStrictInt(e.id);
    const season = keySeason ?? toStrictInt(e.season) ?? fallbackSeason;
    if (id === undefined || season === undefined || seenIds.has(id)) return;
    seenIds.add(id);
    seasons.add(season);
    const fallbackEp = indexHint ?? (nextPerSeason.get(season) ?? 0) + 1;
    nextPerSeason.set(season, fallbackEp);
    const explicitEp = toStrictInt(e.episode_num);
    const episode: XtreamEpisode = {
      id,
      season,
      episode: explicitEp !== undefined && explicitEp > 0 ? explicitEp : fallbackEp,
      title: toText(e.title) ?? '',
      extension: toText(e.container_extension) ?? 'mp4',
    };
    put(episode, 'durationSec', toNumber(asRaw(e.info).duration_secs));
    episodes.push(episode);
  };
  if (Array.isArray(raw.episodes)) {
    for (let idx = 0; idx < raw.episodes.length; idx++) {
      const entry = raw.episodes[idx];
      if (Array.isArray(entry)) {
        for (let epIdx = 0; epIdx < entry.length; epIdx++) {
          addEpisode(entry[epIdx], idx, undefined, epIdx + 1);
        }
      } else if (isRaw(entry)) {
        addEpisode(entry, 0);
      }
    }
  } else {
    for (const [key, group] of Object.entries(asRaw(raw.episodes))) {
      const keySeason = toStrictInt(key);
      const list = Array.isArray(group) ? group : [];
      for (let epIdx = 0; epIdx < list.length; epIdx++) {
        addEpisode(list[epIdx], undefined, keySeason, epIdx + 1);
      }
    }
  }
  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  const info = asRaw(raw.info);
  const seriesInfo: XtreamSeriesInfo = { seasons: [...seasons].sort((a, b) => a - b), episodes };
  put(seriesInfo, 'cast', creditText(MAX_CAST_CHARS, info.cast, info.actors, raw.cast, raw.actors));
  put(seriesInfo, 'director', creditText(MAX_DIRECTOR_CHARS, info.director, raw.director));
  put(
    seriesInfo,
    'backdrop',
    backdropUrl(info.backdrop_path, info.backdrop, raw.backdrop_path, raw.backdrop),
  );
  return seriesInfo;
}

/** Maps `get_vod_info`, preserving omitted `container_extension` as `undefined` and extracting valid HTTP(S) `direct_source`. */
export function toVodInfo(raw: Raw): XtreamVodInfo {
  const info = asRaw(raw.info);
  const movieData = asRaw(raw.movie_data);
  const vod: XtreamVodInfo = {};
  put(vod, 'extension', toText(movieData.container_extension));
  put(vod, 'directSource', httpDirectSource(movieData.direct_source));
  put(vod, 'durationSec', toNumber(info.duration_secs));
  put(vod, 'plot', toMetaText(info.plot));
  put(vod, 'year', yearOf(info.year, info.releasedate));
  put(
    vod,
    'cast',
    creditText(
      MAX_CAST_CHARS,
      info.cast,
      info.actors,
      movieData.cast,
      movieData.actors,
      raw.cast,
      raw.actors,
    ),
  );
  put(
    vod,
    'director',
    creditText(MAX_DIRECTOR_CHARS, info.director, movieData.director, raw.director),
  );
  put(vod, 'providerImdbId', firstProviderImdbId(info.imdb_id, info.imdb));
  put(vod, 'providerTmdbId', firstProviderTmdbId(info.tmdb_id, info.tmdb));
  put(
    vod,
    'backdrop',
    backdropUrl(
      info.backdrop_path,
      info.backdrop,
      movieData.backdrop_path,
      movieData.backdrop,
      raw.backdrop_path,
      raw.backdrop,
    ),
  );
  return vod;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: detects binary garbage
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const BASE64_COMPACT_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function parseEpgDatetime(value: unknown, serverTimezone?: string): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = ISO_DATETIME_RE.exec(value.trim());
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (year < 1000 || month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const tzPart = m[7];
  if (tzPart !== undefined) {
    if (tzPart === 'Z' || tzPart === 'z') return wallMs;
    const sign = tzPart[0] === '-' ? -1 : 1;
    const digits = tzPart.slice(1).replace(':', '');
    const offH = Number(digits.slice(0, 2));
    const offM = Number(digits.slice(2, 4));
    if (offH > 23 || offM > 59) return undefined;
    return wallMs - sign * (offH * 60 + offM) * 60_000;
  }
  return wallTimeToUtcMs(wallMs, serverTimezone);
}

function hasControlByte(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return true;
  }
  return false;
}

function fromBase64(value: unknown, serverTimezone?: string): string | undefined {
  const text = toText(value);
  if (text === undefined) return undefined;
  const compact = text.replace(/[\r\n]/g, '');
  if (compact.length < 4 || compact.length % 4 === 1 || !BASE64_COMPACT_RE.test(compact)) {
    return text;
  }
  try {
    const bin = atob(compact);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (hasControlByte(bytes)) return text;
    const decoded = decodeUtf8(bytes);
    if (!decoded.includes('\ufffd') && !CONTROL.test(decoded)) {
      return toText(decoded);
    }
    const legacy = decodeLegacyCodepage(bytes, serverTimezone);
    if (legacy !== undefined && !legacy.includes('\ufffd') && !CONTROL.test(legacy)) {
      return toText(legacy);
    }
    return text;
  } catch {
    return text;
  }
}

function toOptionalBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === '1' || trimmed === 'true') return true;
    if (trimmed === '0' || trimmed === 'false') return false;
  }
  return undefined;
}

/**
 * Maps `get_short_epg` and `get_simple_data_table` listings: decodes base64 text (UTF-8 with
 * single-byte codepage fallback), converts numeric second timestamps or `start`/`end`/`stop`
 * datetime strings to epoch ms, and preserves optional `has_archive` / `now_playing` flags.
 */
export function toEpg(raw: Raw, serverTimezone?: string): XtreamEpgEntry[] {
  const out: XtreamEpgEntry[] = [];
  for (const e of Array.isArray(raw.epg_listings) ? raw.epg_listings : []) {
    if (!isRaw(e)) continue;
    const start =
      parseXtreamTimestampMs(e.start_timestamp) ?? parseEpgDatetime(e.start, serverTimezone);
    const stop =
      parseXtreamTimestampMs(e.stop_timestamp) ??
      parseEpgDatetime(e.end, serverTimezone) ??
      parseEpgDatetime(e.stop, serverTimezone);
    if (start === undefined || stop === undefined || stop <= start) continue;
    const entry: XtreamEpgEntry = {
      start,
      stop,
      title: fromBase64(e.title, serverTimezone) ?? '',
    };
    put(entry, 'desc', fromBase64(e.description, serverTimezone));
    put(entry, 'hasArchive', toOptionalBool(e.has_archive));
    put(entry, 'nowPlaying', toOptionalBool(e.now_playing));
    out.push(entry);
  }
  return out;
}
