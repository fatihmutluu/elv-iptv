import type { SqlDriver } from '@elv/domain';
import type { EpgGenre } from '@elv/sources';

/** Default maximum rows returned by {@link queryCrossChannelEpgSlice}. */
export const DEFAULT_EPG_SLICE_LIMIT = 200;

/** Hard upper bound on rows returned by {@link queryCrossChannelEpgSlice}. */
export const MAX_EPG_SLICE_LIMIT = 500;

/** One cross-channel XMLTV programme row returned by {@link queryCrossChannelEpgSlice}. */
export interface CrossChannelProgrammeRow {
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
}

interface RawSliceProgrammeRow {
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
}

const VALID_GENRES = new Set<EpgGenre>(['sports', 'movie', 'news', 'kids', 'series', 'other']);

function toEpgGenre(raw: string | null | undefined): EpgGenre | null {
  return typeof raw === 'string' && VALID_GENRES.has(raw as EpgGenre) ? (raw as EpgGenre) : null;
}

/**
 * Queries programmes across all channels of `sourceId` overlapping `[fromMs, toMs)`
 * (`start < toMs AND stop > fromMs`), backed by `idx_programmes_source_start_stop`
 * and ordered by `start ASC, guide_id ASC`.
 */
export async function queryCrossChannelEpgSlice(
  db: SqlDriver,
  sourceId: string,
  fromMs: number,
  toMs: number,
  limit = DEFAULT_EPG_SLICE_LIMIT,
): Promise<CrossChannelProgrammeRow[]> {
  if (
    sourceId === '' ||
    !Number.isFinite(fromMs) ||
    !Number.isFinite(toMs) ||
    fromMs < 0 ||
    toMs <= fromMs
  ) {
    return [];
  }
  const n = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_EPG_SLICE_LIMIT;
  const clampedLimit = Math.min(MAX_EPG_SLICE_LIMIT, Math.max(0, n));
  if (clampedLimit === 0) return [];

  const rows = await db.all<RawSliceProgrammeRow>(
    `SELECT guide_id, start, stop, title, sub_title, description, episode_num, icon, genre, flags
       FROM programmes
      WHERE source_id = ? AND start < ? AND stop > ?
      ORDER BY start ASC, guide_id ASC
      LIMIT ?`,
    [sourceId, toMs, fromMs, clampedLimit],
  );
  return rows.map((r) => ({
    sourceId,
    guideId: r.guide_id,
    start: r.start,
    stop: r.stop,
    title: r.title,
    subTitle: r.sub_title,
    description: r.description,
    episodeNum: r.episode_num,
    icon: r.icon,
    genre: toEpgGenre(r.genre),
    flags: typeof r.flags === 'number' && Number.isFinite(r.flags) ? Math.trunc(r.flags) : 0,
  }));
}
