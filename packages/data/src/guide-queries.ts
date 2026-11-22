import type { SqlDriver } from '@elv/domain';
import {
  type CrossChannelProgrammeRow,
  DEFAULT_EPG_SLICE_LIMIT,
  MAX_EPG_SLICE_LIMIT,
  queryCrossChannelEpgSlice,
} from './guide-queries-slice';
import { type ItemRow, sourceOfKey } from './queries';

export {
  type CrossChannelProgrammeRow,
  DEFAULT_EPG_SLICE_LIMIT,
  MAX_EPG_SLICE_LIMIT,
  queryCrossChannelEpgSlice,
};

/** Hard upper bound on channel keys accepted by {@link queryNowNext}. */
export const MAX_NOW_NEXT_KEYS = 60;

/** Hard upper bound on channel keys accepted by {@link queryEpgWindow}. */
export const MAX_EPG_WINDOW_KEYS = 40;

/** Maximum time span (48 hours) returned by a single {@link queryEpgWindow} call. */
export const MAX_EPG_WINDOW_SPAN_MS = 48 * 3_600_000;

/** Lookahead window (12 hours) scanned by {@link queryNowNext} for upcoming programmes. */
const NOW_NEXT_LOOKAHEAD_MS = 12 * 3_600_000;

/** One XMLTV programme mapped onto a live channel key. */
export interface ProgrammeRow {
  readonly channelKey: string;
  readonly sourceId: string;
  readonly guideId: string;
  readonly start: number;
  readonly stop: number;
  readonly title: string;
  readonly subTitle: string | null;
  readonly description: string | null;
  readonly episodeNum: string | null;
  readonly icon: string | null;
}

/** Current (`now`) and upcoming (`next`) programme pair for a single live channel. */
export interface NowNextEntry {
  readonly channelKey: string;
  readonly now: ProgrammeRow | null;
  readonly next: ProgrammeRow | null;
}

interface RawGuideMapRow {
  channel_key: string;
  guide_id: string;
}

interface RawProgrammeRow {
  guide_id: string;
  start: number;
  stop: number;
  title: string;
  sub_title: string | null;
  description: string | null;
  episode_num: string | null;
  icon: string | null;
}

interface RawLiveNumberRow {
  id: number;
  key: string;
  source_id: string;
  provider_id: string | null;
  name: string;
  logo: string | null;
  num: number | null;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function toProgrammeRow(channelKey: string, sourceId: string, r: RawProgrammeRow): ProgrammeRow {
  return {
    channelKey,
    sourceId,
    guideId: r.guide_id,
    start: r.start,
    stop: r.stop,
    title: r.title,
    subTitle: r.sub_title,
    description: r.description,
    episodeNum: r.episode_num,
    icon: r.icon,
  };
}

function groupChannelKeys(
  channelKeys: readonly string[],
  maxKeys: number,
): { ordered: string[]; bySource: Map<string, string[]> } {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const bySource = new Map<string, string[]>();
  for (const key of channelKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (ordered.length >= maxKeys) break;
    const sourceId = sourceOfKey(key);
    if (sourceId === undefined || sourceId === '') continue;
    ordered.push(key);
    const bucket = bySource.get(sourceId);
    if (bucket === undefined) bySource.set(sourceId, [key]);
    else bucket.push(key);
  }
  return { ordered, bySource };
}

/**
 * Queries the current (`now`) and upcoming (`next`) programmes for up to {@link MAX_NOW_NEXT_KEYS}
 * live channels via `channel_guide` and `programmes` primary keys (zero full-table scans).
 */
export async function queryNowNext(
  db: SqlDriver,
  channelKeys: readonly string[],
  nowMs: number,
): Promise<NowNextEntry[]> {
  if (!Number.isFinite(nowMs) || nowMs < 0) return [];
  const { ordered, bySource } = groupChannelKeys(channelKeys, MAX_NOW_NEXT_KEYS);
  if (ordered.length === 0) return [];

  const entryByChannel = new Map<string, NowNextEntry>();

  for (const [sourceId, keys] of bySource) {
    const mapRows = await db.all<RawGuideMapRow>(
      `SELECT channel_key, guide_id FROM channel_guide
        WHERE source_id = ? AND channel_key IN (${placeholders(keys.length)})`,
      [sourceId, ...keys],
    );
    if (mapRows.length === 0) continue;

    const guideByChannel = new Map<string, string>();
    const guideIdSet = new Set<string>();
    for (const row of mapRows) {
      if (row.guide_id === '') continue;
      guideByChannel.set(row.channel_key, row.guide_id);
      guideIdSet.add(row.guide_id);
    }
    const guideIds = [...guideIdSet];
    if (guideIds.length === 0) continue;

    const progRows = await db.all<RawProgrammeRow>(
      `SELECT guide_id, start, stop, title, sub_title, description, episode_num, icon
         FROM programmes
        WHERE source_id = ? AND guide_id IN (${placeholders(guideIds.length)})
          AND start < ? AND stop > ?
        ORDER BY guide_id, start`,
      [sourceId, ...guideIds, nowMs + NOW_NEXT_LOOKAHEAD_MS, nowMs],
    );

    const progsByGuide = new Map<string, RawProgrammeRow[]>();
    for (const prog of progRows) {
      const list = progsByGuide.get(prog.guide_id);
      if (list === undefined) progsByGuide.set(prog.guide_id, [prog]);
      else list.push(prog);
    }

    for (const channelKey of keys) {
      const guideId = guideByChannel.get(channelKey);
      if (guideId === undefined) continue;
      const list = progsByGuide.get(guideId) ?? [];
      let nowRow: RawProgrammeRow | undefined;
      for (const prog of list) {
        if (prog.start <= nowMs && prog.stop > nowMs) {
          nowRow = prog;
          break;
        }
      }
      const nextFloor = nowRow === undefined ? nowMs : nowRow.stop;
      let nextRow: RawProgrammeRow | undefined;
      for (const prog of list) {
        if (prog.start >= nextFloor) {
          nextRow = prog;
          break;
        }
      }
      entryByChannel.set(channelKey, {
        channelKey,
        now: nowRow === undefined ? null : toProgrammeRow(channelKey, sourceId, nowRow),
        next: nextRow === undefined ? null : toProgrammeRow(channelKey, sourceId, nextRow),
      });
    }
  }

  const out: NowNextEntry[] = [];
  for (const key of ordered) {
    const entry = entryByChannel.get(key);
    if (entry !== undefined) out.push(entry);
  }
  return out;
}

/**
 * Queries programmes overlapping `[fromMs, toMs]` for up to {@link MAX_EPG_WINDOW_KEYS} live
 * channels (clamped to {@link MAX_EPG_WINDOW_SPAN_MS}), ordered by `start` ascending.
 */
export async function queryEpgWindow(
  db: SqlDriver,
  channelKeys: readonly string[],
  fromMs: number,
  toMs: number,
): Promise<Record<string, ProgrammeRow[]>> {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs < 0 || toMs <= fromMs) {
    return {};
  }
  const clampedToMs = Math.min(toMs, fromMs + MAX_EPG_WINDOW_SPAN_MS);
  const { ordered, bySource } = groupChannelKeys(channelKeys, MAX_EPG_WINDOW_KEYS);
  if (ordered.length === 0) return {};

  const out: Record<string, ProgrammeRow[]> = {};

  for (const [sourceId, keys] of bySource) {
    const mapRows = await db.all<RawGuideMapRow>(
      `SELECT channel_key, guide_id FROM channel_guide
        WHERE source_id = ? AND channel_key IN (${placeholders(keys.length)})`,
      [sourceId, ...keys],
    );
    if (mapRows.length === 0) continue;

    const channelsByGuide = new Map<string, string[]>();
    for (const row of mapRows) {
      if (row.guide_id === '') continue;
      out[row.channel_key] = [];
      const list = channelsByGuide.get(row.guide_id);
      if (list === undefined) channelsByGuide.set(row.guide_id, [row.channel_key]);
      else list.push(row.channel_key);
    }
    const guideIds = [...channelsByGuide.keys()];
    if (guideIds.length === 0) continue;

    const progRows = await db.all<RawProgrammeRow>(
      `SELECT guide_id, start, stop, title, sub_title, description, episode_num, icon
         FROM programmes
        WHERE source_id = ? AND guide_id IN (${placeholders(guideIds.length)})
          AND start < ? AND stop > ?
        ORDER BY guide_id, start`,
      [sourceId, ...guideIds, clampedToMs, fromMs],
    );

    for (const prog of progRows) {
      const targetChannels = channelsByGuide.get(prog.guide_id);
      if (targetChannels === undefined) continue;
      for (const chKey of targetChannels) {
        out[chKey]?.push(toProgrammeRow(chKey, sourceId, prog));
      }
    }
  }

  return out;
}

const LIVE_BY_NUM_SQL = `SELECT l.id, l.key, l.source_id, l.provider_id, l.name, l.logo, l.num
  FROM live l
  JOIN sources s ON s.id = l.source_id AND s.deleting = 0
 WHERE l.source_id = ? AND l.num = ? AND l.is_hidden = 0
 ORDER BY l.id LIMIT 1`;

async function queryChannelByNumberInSource(
  db: SqlDriver,
  sourceId: string,
  num: number,
): Promise<ItemRow | undefined> {
  const rows = await db.all<RawLiveNumberRow>(LIVE_BY_NUM_SQL, [sourceId, num]);
  const r = rows[0];
  if (r === undefined) return undefined;
  return {
    id: r.id,
    key: r.key,
    kind: 'live',
    sourceId: r.source_id,
    providerId: r.provider_id,
    name: r.name,
    logo: r.logo,
    rating: null,
    year: null,
    num: r.num,
  };
}

/**
 * Looks up a live channel by channel number using `idx_live_num (source_id, num)` with zero full
 * table scans. When `sourceId` is omitted, probes sources in creation order.
 */
export async function queryChannelByNumber(
  db: SqlDriver,
  num: number,
  sourceId?: string,
): Promise<ItemRow | undefined> {
  if (!Number.isSafeInteger(num) || num < 0) return undefined;
  if (sourceId !== undefined) {
    return queryChannelByNumberInSource(db, sourceId, num);
  }
  const sources = await db.all<{ id: string }>(
    'SELECT id FROM sources WHERE deleting = 0 ORDER BY created_at, id',
  );
  for (const src of sources) {
    const match = await queryChannelByNumberInSource(db, src.id, num);
    if (match !== undefined) return match;
  }
  return undefined;
}

const MAX_FORMATTER_CACHE = 16;
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function formatLocalDate(d: Date): string {
  const year = String(d.getFullYear()).padStart(4, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getDayFormatter(timeZone: string): Intl.DateTimeFormat | undefined {
  const cached = dayFormatters.get(timeZone);
  if (cached !== undefined) return cached;
  if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') return undefined;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    if (dayFormatters.size >= MAX_FORMATTER_CACHE) dayFormatters.clear();
    dayFormatters.set(timeZone, formatter);
    return formatter;
  } catch {
    return undefined;
  }
}

/**
 * Formats an epoch-millisecond timestamp as a local calendar day key (`YYYY-MM-DD`) in `timeZone`
 * via `Intl.DateTimeFormat` (with safe local-`Date` fallback when `timeZone` is omitted/invalid or
 * `Intl` is unavailable). Returns `""` for non-finite or out-of-range timestamps.
 */
export function localDayKey(epochMs: number, timeZone?: string): string {
  if (!Number.isFinite(epochMs)) return '';
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return '';
  if (timeZone !== undefined && timeZone !== '') {
    const formatter = getDayFormatter(timeZone);
    if (formatter !== undefined) {
      let year = '';
      let month = '';
      let day = '';
      for (const part of formatter.formatToParts(date)) {
        if (part.type === 'year') year = part.value;
        else if (part.type === 'month') month = part.value;
        else if (part.type === 'day') day = part.value;
      }
      if (year !== '' && month !== '' && day !== '') {
        return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      }
    }
  }
  return formatLocalDate(date);
}

/**
 * Buckets programmes into local calendar days (`YYYY-MM-DD`) by `start` epoch-ms timestamp in the
 * optional IANA `timeZone`, preserving input order within each day and skipping invalid starts.
 */
export function bucketProgrammesByLocalDay<T extends { start: number }>(
  programmes: readonly T[],
  timeZone?: string,
): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const programme of programmes) {
    const key = localDayKey(programme.start, timeZone);
    if (key === '') continue;
    const list = buckets.get(key);
    if (list === undefined) buckets.set(key, [programme]);
    else list.push(programme);
  }
  return buckets;
}
