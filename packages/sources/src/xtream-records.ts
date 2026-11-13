import { decodeUtf8 } from './utf8';
import { mergeById, toNumber, toText } from './xtream-normalize';
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
    const direct = typeof c === 'number' ? c : undefined;
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
    const id = toNumber(r.stream_id);
    if (id === undefined) continue;
    const archive = toNumber(r.tv_archive) === 1;
    const live: XtreamLive = {
      id,
      name: toText(r.name) ?? '',
      categoryIds: categoryIds(r),
      catchupDays: archive ? (toNumber(r.tv_archive_duration) ?? 0) : 0,
    };
    put(live, 'num', toNumber(r.num));
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
    const id = toNumber(r.stream_id);
    if (id === undefined) continue;
    const movie: XtreamMovie = {
      id,
      name: toText(r.name) ?? '',
      categoryIds: categoryIds(r),
      extension: toText(r.container_extension) ?? 'mp4',
    };
    put(movie, 'icon', toText(r.stream_icon));
    put(movie, 'rating', toNumber(r.rating));
    put(movie, 'year', toNumber(r.year));
    put(movie, 'added', ms(r.added));
    out.push(movie);
  }
  return mergeById(out);
}

/** Maps series rows and merges repeated ids; the year may come from either release date spelling. */
export function toSeries(rows: Raw[]): XtreamSeries[] {
  const out: XtreamSeries[] = [];
  for (const r of rows) {
    const id = toNumber(r.series_id);
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

/** Flattens the season-keyed episode map into a sorted list. */
export function toSeriesInfo(raw: Raw): XtreamSeriesInfo {
  const seasons = new Set<number>();
  for (const s of Array.isArray(raw.seasons) ? raw.seasons : []) {
    const n = toNumber(isRaw(s) ? s.season_number : s);
    if (n !== undefined) seasons.add(n);
  }
  const episodes: XtreamEpisode[] = [];
  const groups: Array<[string | undefined, unknown]> = Array.isArray(raw.episodes)
    ? raw.episodes.map((g): [string | undefined, unknown] => [undefined, g])
    : Object.entries(asRaw(raw.episodes));
  for (const [key, group] of groups) {
    for (const e of Array.isArray(group) ? group : []) {
      if (!isRaw(e)) continue;
      const id = toNumber(e.id);
      const season = toNumber(key) ?? toNumber(e.season);
      if (id === undefined || season === undefined) continue;
      seasons.add(season);
      const episode: XtreamEpisode = {
        id,
        season,
        episode: toNumber(e.episode_num) ?? 0,
        title: toText(e.title) ?? '',
        extension: toText(e.container_extension) ?? 'mp4',
      };
      put(episode, 'durationSec', toNumber(asRaw(e.info).duration_secs));
      episodes.push(episode);
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

function fromBase64(value: unknown): string | undefined {
  const text = toText(value);
  if (text === undefined) return undefined;
  try {
    const bin = atob(text);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const decoded = decodeUtf8(bytes);
    return decoded.includes('�') || CONTROL.test(decoded) ? text : toText(decoded);
  } catch {
    return text;
  }
}

/** Maps `get_short_epg` listings: base64 text, second timestamps to milliseconds. */
export function toEpg(raw: Raw): XtreamEpgEntry[] {
  const out: XtreamEpgEntry[] = [];
  for (const e of Array.isArray(raw.epg_listings) ? raw.epg_listings : []) {
    if (!isRaw(e)) continue;
    const start = ms(e.start_timestamp);
    const stop = ms(e.stop_timestamp);
    if (start === undefined || stop === undefined) continue;
    const entry: XtreamEpgEntry = { start, stop, title: fromBase64(e.title) ?? '' };
    put(entry, 'desc', fromBase64(e.description));
    out.push(entry);
  }
  return out;
}
