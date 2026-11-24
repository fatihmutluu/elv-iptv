import type { SqlDriver } from '@elv/domain';
import type { EpgGenre } from '@elv/sources';
import { bucketProgrammesByLocalDay, localDayKey } from './guide-queries-day';
import { queryChannelByNumber } from './guide-queries-number';
import {
  type CrossChannelProgrammeRow,
  DEFAULT_EPG_SLICE_LIMIT,
  MAX_EPG_SLICE_LIMIT,
  queryCrossChannelEpgSlice,
} from './guide-queries-slice';
import type { ParentalQueryOptions } from './parental-policy';
import {
  findRestrictedItemKeys,
  isProgrammeRestricted,
  loadActiveParentalFilter,
} from './parental-repo';
import { sourceOfKey } from './queries-shared';
import type { SourceSettings } from './sources';

export {
  bucketProgrammesByLocalDay,
  type CrossChannelProgrammeRow,
  DEFAULT_EPG_SLICE_LIMIT,
  localDayKey,
  MAX_EPG_SLICE_LIMIT,
  queryChannelByNumber,
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
  readonly genre: EpgGenre | null;
  readonly flags: number;
  readonly ratingSystem?: string | null;
  readonly ratingValue?: string | null;
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
  epg_shift_ms: number | null;
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
  genre: string | null;
  flags: number | null;
  rating_system: string | null;
  rating_value: string | null;
}

const VALID_GENRES = new Set<EpgGenre>(['sports', 'movie', 'news', 'kids', 'series', 'other']);

function toEpgGenre(raw: string | null | undefined): EpgGenre | null {
  return typeof raw === 'string' && VALID_GENRES.has(raw as EpgGenre) ? (raw as EpgGenre) : null;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function toProgrammeRow(
  channelKey: string,
  sourceId: string,
  r: RawProgrammeRow,
  shiftMs = 0,
): ProgrammeRow {
  return {
    channelKey,
    sourceId,
    guideId: r.guide_id,
    start: r.start + shiftMs,
    stop: r.stop + shiftMs,
    title: r.title,
    subTitle: r.sub_title,
    description: r.description,
    episodeNum: r.episode_num,
    icon: r.icon,
    genre: toEpgGenre(r.genre),
    flags: typeof r.flags === 'number' && Number.isFinite(r.flags) ? Math.trunc(r.flags) : 0,
    ...(r.rating_system !== null && r.rating_system !== ''
      ? { ratingSystem: r.rating_system }
      : {}),
    ...(r.rating_value !== null && r.rating_value !== '' ? { ratingValue: r.rating_value } : {}),
  };
}

async function readSourceEpgShiftMs(db: SqlDriver, sourceId: string): Promise<number> {
  const rows = await db.all<{ settings_json: string }>(
    'SELECT settings_json FROM sources WHERE id = ? LIMIT 1',
    [sourceId],
  );
  const raw = rows[0]?.settings_json;
  if (raw === undefined) return 0;
  try {
    const parsed = JSON.parse(raw) as Partial<SourceSettings> | null;
    const shift = parsed?.epgShiftMs;
    return typeof shift === 'number' && Number.isFinite(shift) ? Math.round(shift) : 0;
  } catch {
    return 0;
  }
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

async function loadChannelGuideAndShifts(
  db: SqlDriver,
  sourceId: string,
  keys: readonly string[],
): Promise<{
  mapRows: RawGuideMapRow[];
  shiftByChannel: Map<string, number>;
  minShift: number;
  maxShift: number;
}> {
  const [sourceShiftMs, mapRows] = await Promise.all([
    readSourceEpgShiftMs(db, sourceId),
    db.all<RawGuideMapRow>(
      `SELECT cg.channel_key, cg.guide_id, l.epg_shift_ms
         FROM channel_guide cg
         LEFT JOIN live l ON l.source_id = cg.source_id AND l.key = cg.channel_key
        WHERE cg.source_id = ? AND cg.channel_key IN (${placeholders(keys.length)})`,
      [sourceId, ...keys],
    ),
  ]);
  const shiftByChannel = new Map<string, number>();
  let minShift = Number.POSITIVE_INFINITY;
  let maxShift = Number.NEGATIVE_INFINITY;
  for (const row of mapRows) {
    if (row.guide_id === '') continue;
    const chShift =
      typeof row.epg_shift_ms === 'number' && Number.isFinite(row.epg_shift_ms)
        ? row.epg_shift_ms
        : 0;
    const total = chShift + sourceShiftMs;
    shiftByChannel.set(row.channel_key, total);
    if (total < minShift) minShift = total;
    if (total > maxShift) maxShift = total;
  }
  if (!Number.isFinite(minShift)) minShift = 0;
  if (!Number.isFinite(maxShift)) maxShift = 0;
  return { mapRows, shiftByChannel, minShift, maxShift };
}

/**
 * Queries the current (`now`) and upcoming (`next`) programmes for up to {@link MAX_NOW_NEXT_KEYS}
 * live channels via `channel_guide`, `live`, and `programmes` indexes (zero full-table scans),
 * applying per-channel `live.epg_shift_ms` plus source-level `SourceSettings.epgShiftMs`.
 */
export async function queryNowNext(
  db: SqlDriver,
  channelKeys: readonly string[],
  nowMs: number,
  opts?: ParentalQueryOptions,
): Promise<NowNextEntry[]> {
  if (!Number.isFinite(nowMs) || nowMs < 0) return [];
  const { ordered, bySource } = groupChannelKeys(channelKeys, MAX_NOW_NEXT_KEYS);
  if (ordered.length === 0) return [];
  const filter = await loadActiveParentalFilter(db, opts?.profileId, opts?.parentalUnlocked);
  const restrictedKeys =
    filter === null
      ? null
      : await findRestrictedItemKeys(
          db,
          filter,
          ordered.map((itemKey) => ({ itemKey })),
        );

  const entryByChannel = new Map<string, NowNextEntry>();

  for (const [sourceId, rawKeys] of bySource) {
    const keys =
      restrictedKeys === null ? rawKeys : rawKeys.filter((key) => !restrictedKeys.has(key));
    if (keys.length === 0) continue;
    const { mapRows, shiftByChannel, minShift, maxShift } = await loadChannelGuideAndShifts(
      db,
      sourceId,
      keys,
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
      `SELECT guide_id, start, stop, title, sub_title, description, episode_num, icon, genre, flags, rating_system, rating_value
         FROM programmes
        WHERE source_id = ? AND guide_id IN (${placeholders(guideIds.length)})
          AND start < ? AND stop > ?
        ORDER BY guide_id, start`,
      [sourceId, ...guideIds, nowMs + NOW_NEXT_LOOKAHEAD_MS - minShift, nowMs - maxShift],
    );

    const progsByGuide = new Map<string, RawProgrammeRow[]>();
    for (const prog of progRows) {
      if (
        filter !== null &&
        isProgrammeRestricted(filter, prog.title, prog.description, prog.rating_value)
      ) {
        continue;
      }
      const list = progsByGuide.get(prog.guide_id);
      if (list === undefined) progsByGuide.set(prog.guide_id, [prog]);
      else list.push(prog);
    }

    for (const channelKey of keys) {
      const guideId = guideByChannel.get(channelKey);
      if (guideId === undefined) continue;
      const shiftMs = shiftByChannel.get(channelKey) ?? 0;
      const list = progsByGuide.get(guideId) ?? [];
      let nowRow: RawProgrammeRow | undefined;
      for (const prog of list) {
        const s = prog.start + shiftMs;
        const e = prog.stop + shiftMs;
        if (s <= nowMs && e > nowMs) {
          nowRow = prog;
          break;
        }
      }
      const nextFloor = nowRow === undefined ? nowMs : nowRow.stop + shiftMs;
      const nextCeiling = nowMs + NOW_NEXT_LOOKAHEAD_MS;
      let nextRow: RawProgrammeRow | undefined;
      for (const prog of list) {
        const s = prog.start + shiftMs;
        if (s >= nextFloor && s < nextCeiling) {
          nextRow = prog;
          break;
        }
      }
      entryByChannel.set(channelKey, {
        channelKey,
        now: nowRow === undefined ? null : toProgrammeRow(channelKey, sourceId, nowRow, shiftMs),
        next: nextRow === undefined ? null : toProgrammeRow(channelKey, sourceId, nextRow, shiftMs),
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
 * channels (clamped to {@link MAX_EPG_WINDOW_SPAN_MS}), ordered by `start` ascending, applying
 * per-channel `live.epg_shift_ms` plus source-level `SourceSettings.epgShiftMs`.
 */
export async function queryEpgWindow(
  db: SqlDriver,
  channelKeys: readonly string[],
  fromMs: number,
  toMs: number,
  opts?: ParentalQueryOptions,
): Promise<Record<string, ProgrammeRow[]>> {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs < 0 || toMs <= fromMs) {
    return {};
  }
  const clampedToMs = Math.min(toMs, fromMs + MAX_EPG_WINDOW_SPAN_MS);
  const { ordered, bySource } = groupChannelKeys(channelKeys, MAX_EPG_WINDOW_KEYS);
  if (ordered.length === 0) return {};
  const filter = await loadActiveParentalFilter(db, opts?.profileId, opts?.parentalUnlocked);
  const restrictedKeys =
    filter === null
      ? null
      : await findRestrictedItemKeys(
          db,
          filter,
          ordered.map((itemKey) => ({ itemKey })),
        );

  const out: Record<string, ProgrammeRow[]> = {};

  for (const [sourceId, rawKeys] of bySource) {
    const keys =
      restrictedKeys === null ? rawKeys : rawKeys.filter((key) => !restrictedKeys.has(key));
    if (keys.length === 0) continue;
    const { mapRows, shiftByChannel, minShift, maxShift } = await loadChannelGuideAndShifts(
      db,
      sourceId,
      keys,
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
      `SELECT guide_id, start, stop, title, sub_title, description, episode_num, icon, genre, flags, rating_system, rating_value
         FROM programmes
        WHERE source_id = ? AND guide_id IN (${placeholders(guideIds.length)})
          AND start < ? AND stop > ?
        ORDER BY guide_id, start`,
      [sourceId, ...guideIds, clampedToMs - minShift, fromMs - maxShift],
    );

    for (const prog of progRows) {
      if (
        filter !== null &&
        isProgrammeRestricted(filter, prog.title, prog.description, prog.rating_value)
      ) {
        continue;
      }
      const targetChannels = channelsByGuide.get(prog.guide_id);
      if (targetChannels === undefined) continue;
      for (const chKey of targetChannels) {
        const shiftMs = shiftByChannel.get(chKey) ?? 0;
        if (prog.start + shiftMs < clampedToMs && prog.stop + shiftMs > fromMs) {
          out[chKey]?.push(toProgrammeRow(chKey, sourceId, prog, shiftMs));
        }
      }
    }
  }

  return out;
}
