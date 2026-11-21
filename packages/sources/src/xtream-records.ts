import { decodeLegacyCodepage } from './codepages';
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
const ms = (seconds: unknown): number | undefined => {
  const n = toNumber(seconds);
  return n === undefined ? undefined : n * 1000;
};

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

/** Maps `user_info`/`server_info`; the caller has already checked `auth` and `status`. */
export function toAccount(userInfo: Raw, serverInfo: Raw, status: string): XtreamAccount {
  const account: XtreamAccount = {
    status,
    isTrial: toNumber(userInfo.is_trial) === 1,
    outputFormats: Array.isArray(userInfo.allowed_output_formats)
      ? userInfo.allowed_output_formats.map((f) => toText(f)).filter((f) => f !== undefined)
      : [],
  };
  put(account, 'expiresAt', ms(userInfo.exp_date));
  put(account, 'maxConnections', toNumber(userInfo.max_connections));
  put(account, 'activeConnections', toNumber(userInfo.active_cons));
  put(account, 'serverTimezone', toText(serverInfo.timezone));
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
    put(live, 'icon', toText(r.stream_icon));
    put(live, 'epgId', toText(r.epg_channel_id));
    put(live, 'added', ms(r.added));
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
    put(movie, 'icon', toText(r.stream_icon));
    put(movie, 'rating', toNumber(r.rating));
    put(movie, 'year', yearOf(r.year));
    put(movie, 'added', ms(r.added));
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
    put(series, 'cover', toText(r.cover));
    put(series, 'plot', toText(r.plot));
    put(series, 'rating', toNumber(r.rating));
    put(series, 'year', yearOf(r.year, r.release_date, r.releaseDate));
    put(series, 'lastModified', ms(r.last_modified));
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
  return { seasons: [...seasons].sort((a, b) => a - b), episodes };
}

/** Maps `get_vod_info`. */
export function toVodInfo(raw: Raw): XtreamVodInfo {
  const info = asRaw(raw.info);
  const vod: XtreamVodInfo = {
    extension: toText(asRaw(raw.movie_data).container_extension) ?? 'mp4',
  };
  put(vod, 'durationSec', toNumber(info.duration_secs));
  put(vod, 'plot', toText(info.plot));
  put(vod, 'year', yearOf(info.year, info.releasedate));
  return vod;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: detects binary garbage
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const BASE64_COMPACT_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const EPG_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|z|[+-]\d{2}:?\d{2})?$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const MAX_TZ_CACHE = 64;
const TZ_FORMATTERS = new Map<string, Intl.DateTimeFormat | null>();

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] as number);
}

function tzFormatter(timeZone: string): Intl.DateTimeFormat | null {
  if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') return null;
  const cached = TZ_FORMATTERS.get(timeZone);
  if (cached !== undefined) return cached;
  let fmt: Intl.DateTimeFormat | null = null;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    fmt = null;
  }
  if (TZ_FORMATTERS.size >= MAX_TZ_CACHE) TZ_FORMATTERS.clear();
  TZ_FORMATTERS.set(timeZone, fmt);
  return fmt;
}

function tzWallAsUtcMs(fmt: Intl.DateTimeFormat, epochMs: number): number {
  let y = 0;
  let mo = 1;
  let d = 1;
  let h = 0;
  let mi = 0;
  let s = 0;
  for (const part of fmt.formatToParts(new Date(epochMs))) {
    if (part.type === 'year') y = Number(part.value);
    else if (part.type === 'month') mo = Number(part.value);
    else if (part.type === 'day') d = Number(part.value);
    else if (part.type === 'hour') h = Number(part.value) % 24;
    else if (part.type === 'minute') mi = Number(part.value);
    else if (part.type === 'second') s = Number(part.value);
  }
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

function parseEpgDatetime(value: unknown, serverTimezone?: string): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = EPG_DATETIME_RE.exec(value.trim());
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
  const zone = serverTimezone?.trim();
  if (!zone) return wallMs;
  const fmt = tzFormatter(zone);
  if (fmt === null) return wallMs;
  const offset1 = tzWallAsUtcMs(fmt, wallMs) - wallMs;
  const candidate1 = wallMs - offset1;
  const offset2 = tzWallAsUtcMs(fmt, candidate1) - candidate1;
  return wallMs - offset2;
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

/**
 * Maps `get_short_epg` listings: decodes base64 text (UTF-8 with single-byte codepage fallback)
 * and converts numeric second timestamps or `start`/`end`/`stop` datetime strings to epoch ms.
 */
export function toEpg(raw: Raw, serverTimezone?: string): XtreamEpgEntry[] {
  const out: XtreamEpgEntry[] = [];
  for (const e of Array.isArray(raw.epg_listings) ? raw.epg_listings : []) {
    if (!isRaw(e)) continue;
    const rawStartTs = ms(e.start_timestamp);
    const rawStopTs = ms(e.stop_timestamp);
    const start =
      (rawStartTs !== undefined && (rawStartTs > 0 || e.start === undefined)
        ? rawStartTs
        : undefined) ?? parseEpgDatetime(e.start, serverTimezone);
    const stop =
      (rawStopTs !== undefined && (rawStopTs > 0 || (e.end === undefined && e.stop === undefined))
        ? rawStopTs
        : undefined) ??
      parseEpgDatetime(e.end, serverTimezone) ??
      parseEpgDatetime(e.stop, serverTimezone);
    if (start === undefined || stop === undefined || stop <= start) continue;
    const entry: XtreamEpgEntry = {
      start,
      stop,
      title: fromBase64(e.title, serverTimezone) ?? '',
    };
    put(entry, 'desc', fromBase64(e.description, serverTimezone));
    out.push(entry);
  }
  return out;
}
