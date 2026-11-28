import { sanitizeArtworkUrl } from './artwork-url';
import type {
  StalkerCategory,
  StalkerChannel,
  StalkerEpgEntry,
  StalkerEpisode,
  StalkerEpisodeFile,
  StalkerPage,
  StalkerProfile,
  StalkerSeason,
  StalkerSeriesItem,
  StalkerVodItem,
  StalkerWatchdogEventResult,
} from './stalker-types';
import { parseStalkerTimestampMs } from './stalker-url';
import { toNumber, toStrictInt, toText } from './xtream-normalize';
import { isRaw, type Raw } from './xtream-records';

export { parseStalkerTimestampMs } from './stalker-url';

const MAX_CAST_CHARS = 512;
const MAX_DIRECTOR_CHARS = 256;
const HMS_RE = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/;
const SEASON_NUM_RE = /(?:season|s)\s*(\d+)/i;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PLACEHOLDER_TEXT = new Set(['n/a', 'na', '-', '--', 'null', 'none', 'undefined']);

function put<T extends object>(target: T, key: string, value: unknown): void {
  if (value !== undefined) (target as Record<string, unknown>)[key] = value;
}

function cleanMetadataText(value: unknown): string | undefined {
  const text = toText(value);
  if (text === undefined) return undefined;
  return PLACEHOLDER_TEXT.has(text.toLowerCase()) ? undefined : text;
}

function positiveRating(...candidates: unknown[]): number | undefined {
  for (const c of candidates) {
    const n = toNumber(c);
    if (n !== undefined && n > 0) return n;
  }
  return undefined;
}

function toBool(value: unknown): boolean | undefined {
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

function extractSeriesEpisodeNumbers(rawSeries: unknown): number[] | undefined {
  if (!Array.isArray(rawSeries)) return undefined;
  const seen = new Set<number>();
  const nums: number[] = [];
  for (const entry of rawSeries) {
    const n = toStrictInt(entry);
    if (n !== undefined && n > 0 && !seen.has(n)) {
      seen.add(n);
      nums.push(n);
    }
  }
  return nums.length > 0 ? nums : undefined;
}

function artworkUrl(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const text = toText(candidate);
    if (text === undefined) continue;
    const valid = sanitizeArtworkUrl(text).url;
    if (valid !== undefined) return valid;
  }
  return undefined;
}

function yearOf(...candidates: unknown[]): number | undefined {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c >= 1800) return Math.trunc(c);
    const m = typeof c === 'string' ? /^\s*(\d{4})/.exec(c) : null;
    if (m?.[1] !== undefined) {
      const y = Number(m[1]);
      if (y >= 1800) return y;
    }
  }
  return undefined;
}

function creditText(maxChars: number, ...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const text = cleanMetadataText(candidate);
    if (text !== undefined) {
      return text.length > maxChars ? text.slice(0, maxChars).trimEnd() : text;
    }
  }
  return undefined;
}

function parseDurationSec(raw: Raw): number | undefined {
  const directSecs = toNumber(raw.duration_secs);
  if (directSecs !== undefined && directSecs > 0) return Math.round(directSecs);
  for (const field of [raw.time, raw.duration]) {
    if (typeof field === 'string') {
      const hms = HMS_RE.exec(field.trim());
      if (hms) {
        const a = Number(hms[1]);
        const b = Number(hms[2]);
        const c = hms[3] === undefined ? undefined : Number(hms[3]);
        const total = c === undefined ? a * 60 + b : a * 3600 + b * 60 + c;
        if (total > 0) return total;
      }
    }
    const n = toNumber(field);
    if (n !== undefined && n > 0) {
      return field === raw.time ? Math.round(n * 60) : Math.round(n);
    }
  }
  return undefined;
}

function parseCatchupDays(raw: Raw): number {
  const enabled = toBool(raw.enable_tv_archive) === true || toNumber(raw.tv_archive) === 1;
  if (!enabled) return 0;
  const rawDuration = toNumber(raw.tv_archive_duration);
  if (rawDuration === undefined || rawDuration <= 0) return 0;
  return rawDuration >= 24 ? Math.floor(rawDuration / 24) : Math.floor(rawDuration);
}

function resolveChannelCmd(raw: Raw): string {
  const direct = toText(raw.cmd);
  if (direct !== undefined) return direct;
  if (Array.isArray(raw.cmds)) {
    for (const entry of raw.cmds) {
      if (isRaw(entry)) {
        const nested = toText(entry.url) ?? toText(entry.cmd);
        if (nested !== undefined) return nested;
      }
    }
  }
  return '';
}

function applyVodMetadata<T extends { categoryId?: string; cover?: string }>(
  target: T,
  row: Raw,
  timeZone?: string,
): void {
  const catId = toText(row.category_id);
  if (catId !== undefined && catId !== '*') target.categoryId = catId;
  put(target, 'cover', artworkUrl(row.screenshot_uri, row.cover, row.logo));
  put(target, 'rating', positiveRating(row.rating_imdb, row.rating_kinopoisk, row.rating));
  put(target, 'year', yearOf(row.year));
  put(target, 'plot', cleanMetadataText(row.description) ?? cleanMetadataText(row.plot));
  put(target, 'cast', creditText(MAX_CAST_CHARS, row.actors, row.cast));
  put(target, 'director', creditText(MAX_DIRECTOR_CHARS, row.director));
  put(target, 'addedAt', parseStalkerTimestampMs(row.added, timeZone));
  if (toBool(row.censored) === true) put(target, 'censored', true);
}

/** Maps `type=stb&action=get_profile` response `js` object into {@link StalkerProfile}. */
export function toStalkerProfile(raw: Raw): StalkerProfile {
  const blocked = toBool(raw.blocked) === true;
  const rawStatus = typeof raw.status === 'string' ? raw.status.trim() : '';
  const hasDescriptiveStatus =
    rawStatus.length > 0 && rawStatus !== '0' && rawStatus !== '1' && rawStatus !== '2';
  const status = hasDescriptiveStatus ? rawStatus : blocked ? 'Blocked' : 'Active';
  const profile: StalkerProfile = { status, blocked };
  const timezone = toText(raw.default_timezone) ?? toText(raw.timezone);
  const expiresAt =
    parseStalkerTimestampMs(raw.expire_billing_date, timezone) ??
    parseStalkerTimestampMs(raw.expire_date, timezone) ??
    parseStalkerTimestampMs(raw.tariff_expired_date, timezone) ??
    parseStalkerTimestampMs(raw.exp_date, timezone);
  const maxConn =
    toStrictInt(raw.max_online) ??
    toStrictInt(raw.playback_limit) ??
    toStrictInt(raw.max_connections);
  const watchdogTimeout = toStrictInt(raw.watchdog_timeout);
  put(profile, 'expiresAt', expiresAt);
  if (maxConn !== undefined && maxConn > 0) profile.maxConnections = maxConn;
  put(profile, 'timezone', timezone);
  if (watchdogTimeout !== undefined && watchdogTimeout > 0) {
    profile.watchdogTimeoutSec = watchdogTimeout;
  }
  return profile;
}

/** Maps `type=watchdog&action=get_events` response `js` payload into {@link StalkerWatchdogEventResult}. */
export function toStalkerWatchdogEvent(raw: unknown): StalkerWatchdogEventResult {
  const out: StalkerWatchdogEventResult = {};
  if (!isRaw(raw)) return out;
  const data = isRaw(raw.data) ? raw.data : undefined;
  const event = toText(data?.event) ?? toText(raw.event);
  if (event !== undefined) out.event = event;
  const timeout = toStrictInt(raw.watchdog_timeout) ?? toStrictInt(data?.watchdog_timeout);
  if (timeout !== undefined && timeout > 0) out.watchdogTimeoutSec = timeout;
  return out;
}

/** Maps Stalker genres or VOD/series categories, filtering synthetic `"*"` / `"All"` entries. */
export function toStalkerCategories(rows: unknown[]): StalkerCategory[] {
  const out: StalkerCategory[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRaw(row)) continue;
    const id = toText(row.id);
    const title = toText(row.title) ?? toText(row.name);
    if (id === undefined || title === undefined) continue;
    const alias = toText(row.alias);
    if (id === '*' || id.toLowerCase() === 'all' || alias?.toLowerCase() === 'all') continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const cat: StalkerCategory = { id, title };
    put(cat, 'alias', alias);
    if (toBool(row.censored) === true) cat.censored = true;
    out.push(cat);
  }
  return out;
}

/** Maps Stalker live channel rows with artwork URL validation and static-link flags. */
export function toStalkerChannels(rows: unknown[]): StalkerChannel[] {
  const out: StalkerChannel[] = [];
  for (const row of rows) {
    if (!isRaw(row)) continue;
    const id = toText(row.id);
    if (id === undefined) continue;
    const ch: StalkerChannel = {
      id,
      name: toText(row.name) ?? '',
      cmd: resolveChannelCmd(row),
      catchupDays: parseCatchupDays(row),
    };
    const num = toStrictInt(row.number);
    if (num !== undefined && num > 0) ch.number = num;
    const genreId = toText(row.tv_genre_id) ?? toText(row.genre_id);
    if (genreId !== undefined && genreId !== '*') ch.genreId = genreId;
    put(ch, 'logo', artworkUrl(row.logo));
    put(ch, 'epgId', toText(row.xmltv_id) ?? toText(row.epg_id));
    if (toBool(row.censored) === true) ch.censored = true;
    put(ch, 'useHttpTmpLink', toBool(row.use_http_tmp_link));
    put(ch, 'useLoadBalancing', toBool(row.use_load_balancing));
    out.push(ch);
  }
  return out;
}

/** Maps Stalker VOD movie or VOD-series rows with artwork URL validation and embedded `series[]` numbers. */
export function toStalkerVodItems(rows: unknown[], timeZone?: string): StalkerVodItem[] {
  const out: StalkerVodItem[] = [];
  for (const row of rows) {
    if (!isRaw(row)) continue;
    const id = toText(row.id);
    if (id === undefined) continue;
    const item: StalkerVodItem = {
      id,
      name: toText(row.name) ?? toText(row.o_name) ?? '',
      cmd: toText(row.cmd) ?? '',
    };
    applyVodMetadata(item, row, timeZone);
    put(item, 'durationSec', parseDurationSec(row));
    if (toBool(row.is_series) === true) item.isSeries = true;
    put(item, 'seriesEpisodeNumbers', extractSeriesEpisodeNumbers(row.series));
    put(item, 'useHttpTmpLink', toBool(row.use_http_tmp_link));
    put(item, 'useLoadBalancing', toBool(row.use_load_balancing));
    out.push(item);
  }
  return out;
}

/** Maps Stalker series rows with artwork URL validation. */
export function toStalkerSeriesItems(rows: unknown[], timeZone?: string): StalkerSeriesItem[] {
  const out: StalkerSeriesItem[] = [];
  for (const row of rows) {
    if (!isRaw(row)) continue;
    const id = toText(row.id);
    if (id === undefined) continue;
    const item: StalkerSeriesItem = {
      id,
      name: toText(row.name) ?? toText(row.o_name) ?? '',
    };
    applyVodMetadata(item, row, timeZone);
    put(item, 'cmd', toText(row.cmd));
    put(item, 'seriesEpisodeNumbers', extractSeriesEpisodeNumbers(row.series));
    out.push(item);
  }
  return out;
}

/** Maps Stalker season rows for a given `seriesId`. */
export function toStalkerSeasons(seriesId: string, rows: unknown[]): StalkerSeason[] {
  const out: StalkerSeason[] = [];
  let idx = 0;
  for (const row of rows) {
    if (!isRaw(row)) continue;
    const id = toText(row.id);
    if (id === undefined) continue;
    idx += 1;
    const name = toText(row.name) ?? `Season ${idx}`;
    const fromName = SEASON_NUM_RE.exec(name)?.[1];
    const seasonNumber =
      toStrictInt(row.season_number) ?? (fromName !== undefined ? Number(fromName) : idx);
    const season: StalkerSeason = { id, seriesId, seasonNumber, name };
    put(season, 'cmd', toText(row.cmd));
    put(season, 'seriesEpisodeNumbers', extractSeriesEpisodeNumbers(row.series));
    out.push(season);
  }
  return out;
}

/** Maps Stalker episode rows for a given `seriesId` and `seasonId`. */
export function toStalkerEpisodes(
  seriesId: string,
  seasonId: string,
  rows: unknown[],
): StalkerEpisode[] {
  const out: StalkerEpisode[] = [];
  let idx = 0;
  for (const row of rows) {
    if (!isRaw(row)) continue;
    const id = toText(row.id);
    if (id === undefined) continue;
    idx += 1;
    const epNum =
      toStrictInt(row.series_number) ??
      toStrictInt(row.episode_num) ??
      toStrictInt(row.episode) ??
      toStrictInt(row.number);
    const episode: StalkerEpisode = {
      id,
      seriesId,
      seasonId,
      episodeNumber: epNum !== undefined && epNum > 0 ? epNum : idx,
      title: toText(row.name) ?? toText(row.title) ?? '',
      cmd: toText(row.cmd) ?? '',
    };
    put(episode, 'durationSec', parseDurationSec(row));
    put(episode, 'protocol', toText(row.protocol));
    if (toBool(row.is_file) === true) episode.isFile = true;
    put(episode, 'fileType', toText(row.file_type));
    out.push(episode);
  }
  return out;
}

/** Maps Ministra episode file rows (`type=vod&action=get_ordered_list&episode_id=...`). */
export function toStalkerEpisodeFiles(rows: unknown[]): StalkerEpisodeFile[] {
  const out: StalkerEpisodeFile[] = [];
  for (const row of rows) {
    if (!isRaw(row)) continue;
    const id = toText(row.id);
    if (id === undefined) continue;
    const file: StalkerEpisodeFile = { id };
    put(file, 'cmd', toText(row.cmd));
    put(file, 'protocol', toText(row.protocol));
    put(file, 'isFile', toBool(row.is_file));
    put(file, 'fileType', toText(row.file_type));
    put(file, 'name', toText(row.name));
    out.push(file);
  }
  return out;
}

/** Maps Stalker EPG programme rows (`get_short_epg` or `get_epg_info` bucket) into epoch-ms entries. */
export function toStalkerEpgEntries(rows: unknown[], timeZone?: string): StalkerEpgEntry[] {
  const out: StalkerEpgEntry[] = [];
  for (const row of rows) {
    if (!isRaw(row)) continue;
    const start =
      parseStalkerTimestampMs(row.start_timestamp, timeZone) ??
      parseStalkerTimestampMs(row.time, timeZone) ??
      parseStalkerTimestampMs(row.start, timeZone);
    if (start === undefined) continue;
    let stop =
      parseStalkerTimestampMs(row.stop_timestamp, timeZone) ??
      parseStalkerTimestampMs(row.time_to, timeZone) ??
      parseStalkerTimestampMs(row.stop, timeZone) ??
      parseStalkerTimestampMs(row.end, timeZone);
    if (stop === undefined) {
      const dur = toNumber(row.duration);
      if (dur !== undefined && dur > 0) stop = start + Math.round(dur * 1000);
    }
    if (stop === undefined || stop <= start) continue;
    const entry: StalkerEpgEntry = {
      start,
      stop,
      title: toText(row.name) ?? toText(row.title) ?? '',
    };
    put(entry, 'desc', toText(row.descr) ?? toText(row.description));
    out.push(entry);
  }
  return out;
}

/** Maps `get_epg_info` payload into a prototype-safe map of channel ID -> programmes. */
export function toStalkerEpgMap(raw: Raw, timeZone?: string): Record<string, StalkerEpgEntry[]> {
  const container = isRaw(raw.data) ? raw.data : raw;
  const out: Record<string, StalkerEpgEntry[]> = Object.create(null);
  for (const key of Object.keys(container)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const list = container[key];
    if (!Array.isArray(list)) continue;
    out[key] = toStalkerEpgEntries(list, timeZone);
  }
  return out;
}

/** Wraps a `get_ordered_list` response payload into a typed {@link StalkerPage}. */
export function toStalkerPage<T>(
  raw: Raw,
  requestedPage: number,
  mapRows: (rows: unknown[]) => T[],
): StalkerPage<T> {
  const items = Array.isArray(raw.data) ? mapRows(raw.data) : [];
  const totalItems = toStrictInt(raw.total_items) ?? items.length;
  const maxPageItems = toStrictInt(raw.max_page_items) ?? Math.max(items.length, 14);
  return { items, totalItems, maxPageItems, page: requestedPage };
}
