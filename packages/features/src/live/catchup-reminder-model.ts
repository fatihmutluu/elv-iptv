import type { ItemRow, ProgrammeReminderRecord, ProgrammeRow } from '@elv/data';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';

/** Milliseconds in one day (`24h`), used for catch-up retention checks (`#27`). */
export const CATCHUP_DAY_MS = 86_400_000;

/** Configurable lead-time options (in minutes) before programme start (`#35`). */
export const REMINDER_LEAD_OPTIONS_MIN = [0, 5, 10, 15] as const;

/** Default reminder lead-time option in minutes (5 min, matching `DEFAULT_REMINDER_LEAD_TIME_MS`). */
export const DEFAULT_REMINDER_LEAD_MIN = 5;

/** Tolerance (ms) when matching an Xtream `get_simple_data_table` entry to an XMLTV programme. */
const ARCHIVE_MATCH_TOLERANCE_MS = 5 * 60_000;

/** Resolved catch-up availability state for a past programme (`#27`). */
export type CatchupAvailability = 'available' | 'expired' | 'unavailable';

/** Stable key indexing a scheduled programme reminder by channel and start timestamp (`#35`). */
export function buildReminderKey(channelKey: string, programmeStart: number): string {
  return `${channelKey}|${Math.round(programmeStart)}`;
}

/** Builds a fast lookup `Set` of reminder keys from active unfired reminder records (`#35`). */
export function indexReminderKeys(
  reminders: readonly Pick<ProgrammeReminderRecord, 'channelKey' | 'programmeStart'>[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const r of reminders) {
    keys.add(buildReminderKey(r.channelKey, r.programmeStart));
  }
  return keys;
}

/**
 * Evaluates catch-up availability for a past EPG programme (`#27`).
 * Returns `'available'` only when `programme.stop <= nowMs`, `channel.catchupDays > 0`,
 * the programme ended within `catchupDays`, and neither XMLTV nor provider archive metadata
 * marks `hasArchive === false`.
 */
export function resolveCatchupAvailability(
  channel: Pick<ItemRow, 'catchupDays'> | null | undefined,
  programme: Pick<ProgrammeRow, 'start' | 'stop' | 'hasArchive'> | null | undefined,
  nowMs: number,
  archiveHasArchive?: boolean,
): CatchupAvailability {
  if (channel == null || programme == null) return 'unavailable';
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(programme.start) ||
    !Number.isFinite(programme.stop)
  ) {
    return 'unavailable';
  }
  if (programme.stop > nowMs || programme.stop <= programme.start) return 'unavailable';
  const days = channel.catchupDays;
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
    return 'unavailable';
  }
  if (archiveHasArchive === false || programme.hasArchive === false) {
    return 'unavailable';
  }
  if (nowMs - programme.stop > days * CATCHUP_DAY_MS) {
    return 'expired';
  }
  return 'available';
}

/** Convenience predicate for rendering subtle catch-up availability badges on past EPG slots. */
export function isPastCatchupEligible(
  channel: Pick<ItemRow, 'catchupDays'> | null | undefined,
  programme: Pick<ProgrammeRow, 'start' | 'stop' | 'hasArchive'> | null | undefined,
  nowMs: number,
): boolean {
  return resolveCatchupAvailability(channel, programme, nowMs) === 'available';
}

/**
 * Matches a programme against on-demand Xtream `fetchChannelArchiveEpg` rows (`#306`),
 * preferring exact start match and falling back to nearest start within `+/- 5 min`.
 */
export function findArchiveProgrammeMatch(
  archiveEntries: readonly ProgrammeRow[],
  programme: Pick<ProgrammeRow, 'start' | 'stop' | 'title'>,
): ProgrammeRow | undefined {
  let best: ProgrammeRow | undefined;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const entry of archiveEntries) {
    const delta = Math.abs(entry.start - programme.start);
    if (delta === 0) return entry;
    if (delta <= ARCHIVE_MATCH_TOLERANCE_MS && delta < bestDelta) {
      bestDelta = delta;
      best = entry;
    }
  }
  return best;
}

/**
 * Builds a catch-up `PlayTarget` (`kind: 'vod'` so seekbar and `-10s/+10s` controls work seamlessly)
 * carrying `catchup.liveTarget` for single-connection-safe `"Back to live"` switching (`#27`).
 */
export function buildCatchupPlayTarget(opts: {
  readonly channel: ItemRow;
  readonly programme: ProgrammeRow;
  readonly liveTarget: PlayableEntry;
  readonly hasArchive?: boolean;
}): PlayTarget {
  const { channel, programme, liveTarget } = opts;
  const resolvedArchive = opts.hasArchive !== undefined ? opts.hasArchive : programme.hasArchive;
  return {
    itemKey: channel.key,
    sourceId: channel.sourceId,
    ...(liveTarget.accountKey !== undefined ? { accountKey: liveTarget.accountKey } : {}),
    title: programme.title,
    subtitle: channel.name,
    kind: 'vod',
    startPositionMs: 0,
    logo: channel.logo,
    itemKind: 'live',
    catchup: {
      startMs: programme.start,
      stopMs: programme.stop,
      programmeTitle: programme.title,
      ...(resolvedArchive !== undefined ? { hasArchive: resolvedArchive } : {}),
      liveTarget,
    },
  };
}
