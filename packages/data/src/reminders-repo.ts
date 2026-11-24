import { elvError, err, ok, type Result, type SqlDriver, type SqlValue } from '@elv/domain';
import { foldText } from './fold';
import { loadChannelGuideAndShifts } from './guide-queries';
import { isSafeRecentChannelKey } from './recent-channels-repo';
import { SOURCE_ID } from './sources';
import { normalizeProfileId } from './user-state-helpers';

/** Default lead time before programme start when scheduling a reminder (5 minutes, `#35`). */
export const DEFAULT_REMINDER_LEAD_TIME_MS = 300_000;

/** Maximum configurable lead time before programme start (60 minutes, `#35`). */
export const MAX_REMINDER_LEAD_TIME_MS = 3_600_000;

/** Tolerance window (`+/- 30 min`) used when reconciling reminders after an XMLTV guide refresh (`#35`). */
export const REMINDER_RECONCILE_WINDOW_MS = 30 * 60_000;

/** Hard upper bound on rows returned by {@link listReminders}. */
export const MAX_REMINDERS_LIMIT = 500;

const MAX_TITLE_LENGTH = 256;

/** A persisted per-profile programme reminder (`#35`). */
export interface ProgrammeReminderRecord {
  readonly profileId: string;
  readonly sourceId: string;
  readonly channelKey: string;
  readonly channelName: string;
  readonly programmeTitle: string;
  readonly programmeStart: number;
  readonly programmeStop: number;
  readonly leadTimeMs: number;
  readonly fired: boolean;
  readonly createdAt: number;
}

/** Input for {@link upsertReminder}. */
export interface UpsertReminderInput {
  readonly profileId?: string;
  readonly sourceId: string;
  readonly channelKey: string;
  readonly channelName: string;
  readonly programmeTitle: string;
  readonly programmeStart: number;
  readonly programmeStop: number;
  readonly leadTimeMs?: number;
}

/** Optional query filters for {@link listReminders}. */
export interface ListRemindersOptions {
  /** When `true`, includes reminders already marked `fired = 1` (default `false`). */
  readonly includeFired?: boolean;
  /** Optional minimum `programme_start` epoch-ms lower bound (inclusive). */
  readonly fromMs?: number;
  /** Maximum rows returned (clamped to `1..500`, default `500`). */
  readonly limit?: number;
}

interface RawReminderRow {
  profile_id: string;
  source_id: string;
  channel_key: string;
  channel_name: string;
  programme_title: string;
  programme_start: number;
  programme_stop: number;
  lead_time_ms: number;
  fired: number;
  created_at: number;
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TITLE_LENGTH || hasControlChar(trimmed)) {
    return null;
  }
  return trimmed;
}

function mapReminderRow(row: RawReminderRow): ProgrammeReminderRecord {
  return {
    profileId: row.profile_id,
    sourceId: row.source_id,
    channelKey: row.channel_key,
    channelName: row.channel_name,
    programmeTitle: row.programme_title,
    programmeStart: row.programme_start,
    programmeStop: row.programme_stop,
    leadTimeMs: row.lead_time_ms,
    fired: row.fired !== 0,
    createdAt: row.created_at,
  };
}

/**
 * Lists scheduled programme reminders for `profileId`, ordered by `programme_start ASC, channel_key ASC`.
 * By default returns only unfired reminders using `idx_programme_reminders_due (profile_id, fired, programme_start)`.
 */
export async function listReminders(
  db: SqlDriver,
  profileId?: string,
  opts?: ListRemindersOptions,
): Promise<ProgrammeReminderRecord[]> {
  const profile = normalizeProfileId(profileId);
  const limit =
    opts?.limit !== undefined && Number.isFinite(opts.limit)
      ? Math.min(MAX_REMINDERS_LIMIT, Math.max(0, Math.floor(opts.limit)))
      : MAX_REMINDERS_LIMIT;
  if (limit === 0) return [];

  const clauses = ['profile_id = ?'];
  const params: SqlValue[] = [profile];
  if (opts?.includeFired !== true) {
    clauses.push('fired = 0');
  }
  if (opts?.fromMs !== undefined && Number.isFinite(opts.fromMs)) {
    clauses.push('programme_start >= ?');
    params.push(Math.round(opts.fromMs));
  }
  params.push(limit);

  const rows = await db.all<RawReminderRow>(
    `SELECT profile_id, source_id, channel_key, channel_name, programme_title,
            programme_start, programme_stop, lead_time_ms, fired, created_at
       FROM programme_reminders
      WHERE ${clauses.join(' AND ')}
      ORDER BY programme_start ASC, channel_key ASC
      LIMIT ?`,
    params,
  );
  return rows.map(mapReminderRow);
}

/** Creates or updates a per-profile programme reminder (`#35`), resetting `fired` to `false`. */
export async function upsertReminder(
  db: SqlDriver,
  input: UpsertReminderInput,
  clock: () => number = Date.now,
): Promise<Result<ProgrammeReminderRecord>> {
  const invalid = () => err(elvError('source-format', 'invalid-reminder'));
  if (!SOURCE_ID.test(input.sourceId) || !isSafeRecentChannelKey(input.channelKey)) {
    return invalid();
  }
  const channelName = cleanLabel(input.channelName);
  const programmeTitle = cleanLabel(input.programmeTitle);
  if (channelName === null || programmeTitle === null) return invalid();
  if (
    !Number.isFinite(input.programmeStart) ||
    !Number.isFinite(input.programmeStop) ||
    input.programmeStart < 0 ||
    input.programmeStop <= input.programmeStart
  ) {
    return invalid();
  }

  const profileId = normalizeProfileId(input.profileId);
  const channelKey = input.channelKey.trim();
  const programmeStart = Math.round(input.programmeStart);
  const programmeStop = Math.round(input.programmeStop);
  const leadTimeMs =
    input.leadTimeMs !== undefined && Number.isFinite(input.leadTimeMs)
      ? Math.max(0, Math.min(MAX_REMINDER_LEAD_TIME_MS, Math.round(input.leadTimeMs)))
      : DEFAULT_REMINDER_LEAD_TIME_MS;
  const now = Math.max(0, Math.round(clock()));

  await db.run(
    `INSERT INTO programme_reminders (
       profile_id, source_id, channel_key, channel_name, programme_title,
       programme_start, programme_stop, lead_time_ms, fired, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(profile_id, channel_key, programme_start) DO UPDATE SET
       source_id = excluded.source_id,
       channel_name = excluded.channel_name,
       programme_title = excluded.programme_title,
       programme_stop = excluded.programme_stop,
       lead_time_ms = excluded.lead_time_ms,
       fired = 0`,
    [
      profileId,
      input.sourceId,
      channelKey,
      channelName,
      programmeTitle,
      programmeStart,
      programmeStop,
      leadTimeMs,
      now,
    ],
  );

  const saved = await db.all<RawReminderRow>(
    `SELECT profile_id, source_id, channel_key, channel_name, programme_title,
            programme_start, programme_stop, lead_time_ms, fired, created_at
       FROM programme_reminders
      WHERE profile_id = ? AND channel_key = ? AND programme_start = ?
      LIMIT 1`,
    [profileId, channelKey, programmeStart],
  );
  const row = saved[0];
  if (row !== undefined) return ok(mapReminderRow(row));
  return ok({
    profileId,
    sourceId: input.sourceId,
    channelKey,
    channelName,
    programmeTitle,
    programmeStart,
    programmeStop,
    leadTimeMs,
    fired: false,
    createdAt: now,
  });
}

/** Removes a scheduled reminder by `(profileId, channelKey, programmeStart)`. */
export async function removeReminder(
  db: SqlDriver,
  channelKey: string,
  programmeStart: number,
  profileId?: string,
): Promise<Result<void>> {
  if (!Number.isFinite(programmeStart)) return ok(undefined);
  await db.run(
    'DELETE FROM programme_reminders WHERE profile_id = ? AND channel_key = ? AND programme_start = ?',
    [normalizeProfileId(profileId), channelKey.trim(), Math.round(programmeStart)],
  );
  return ok(undefined);
}

/** Marks a scheduled reminder as `fired = 1` so it will not trigger again. */
export async function markReminderFired(
  db: SqlDriver,
  channelKey: string,
  programmeStart: number,
  profileId?: string,
): Promise<Result<void>> {
  if (!Number.isFinite(programmeStart)) return ok(undefined);
  await db.run(
    'UPDATE programme_reminders SET fired = 1 WHERE profile_id = ? AND channel_key = ? AND programme_start = ?',
    [normalizeProfileId(profileId), channelKey.trim(), Math.round(programmeStart)],
  );
  return ok(undefined);
}

/** Deletes all reminders whose `programme_stop <= nowMs` across all profiles and returns the deleted count. */
export async function pruneExpiredReminders(db: SqlDriver, nowMs: number): Promise<number> {
  if (!Number.isFinite(nowMs)) return 0;
  const res = await db.run('DELETE FROM programme_reminders WHERE programme_stop <= ?', [
    Math.round(nowMs),
  ]);
  return res.changes;
}

/**
 * Reconciles unfired reminders for `sourceId` after an XMLTV guide refresh (`#35`): if a scheduled
 * programme's start/stop time shifted within `+/- 30 min` for the same channel and folded title,
 * updates the reminder's `programme_start` and `programme_stop` in place.
 */
export async function reconcileRemindersAfterGuideImport(
  db: SqlDriver,
  sourceId: string,
): Promise<number> {
  const reminders = await db.all<RawReminderRow>(
    `SELECT profile_id, source_id, channel_key, channel_name, programme_title,
            programme_start, programme_stop, lead_time_ms, fired, created_at
       FROM programme_reminders
      WHERE source_id = ? AND fired = 0`,
    [sourceId],
  );
  if (reminders.length === 0) return 0;

  const uniqueKeys = [...new Set(reminders.map((r) => r.channel_key))];
  const { mapRows, shiftByChannel } = await loadChannelGuideAndShifts(db, sourceId, uniqueKeys);
  const guideByChannel = new Map<string, string>();
  for (const row of mapRows) {
    if (row.guide_id !== '') guideByChannel.set(row.channel_key, row.guide_id);
  }
  if (guideByChannel.size === 0) return 0;

  let reconciled = 0;
  for (const rem of reminders) {
    const guideId = guideByChannel.get(rem.channel_key);
    if (guideId === undefined) continue;
    const shiftMs = shiftByChannel.get(rem.channel_key) ?? 0;
    const targetFold = foldText(rem.programme_title);
    if (targetFold === '') continue;

    const minRawStart = rem.programme_start - REMINDER_RECONCILE_WINDOW_MS - shiftMs;
    const maxRawStart = rem.programme_start + REMINDER_RECONCILE_WINDOW_MS - shiftMs;
    const candidates = await db.all<{
      start: number;
      stop: number;
      title: string;
      title_fold: string;
    }>(
      `SELECT start, stop, title, title_fold
         FROM programmes
        WHERE source_id = ? AND guide_id = ? AND start >= ? AND start <= ?
        ORDER BY start ASC`,
      [sourceId, guideId, minRawStart, maxRawStart],
    );

    let best: { start: number; stop: number; delta: number } | undefined;
    for (const cand of candidates) {
      const candFold = cand.title_fold !== '' ? cand.title_fold : foldText(cand.title);
      if (candFold !== targetFold) continue;
      const shiftedStart = cand.start + shiftMs;
      const shiftedStop = cand.stop + shiftMs;
      const delta = Math.abs(shiftedStart - rem.programme_start);
      if (delta <= REMINDER_RECONCILE_WINDOW_MS && (best === undefined || delta < best.delta)) {
        best = { start: shiftedStart, stop: shiftedStop, delta };
      }
    }
    if (best === undefined) continue;
    if (best.start === rem.programme_start && best.stop === rem.programme_stop) continue;

    if (best.start === rem.programme_start) {
      await db.run(
        `UPDATE programme_reminders
            SET programme_stop = ?
          WHERE profile_id = ? AND channel_key = ? AND programme_start = ?`,
        [best.stop, rem.profile_id, rem.channel_key, rem.programme_start],
      );
    } else {
      await db.run(
        `INSERT OR REPLACE INTO programme_reminders (
           profile_id, source_id, channel_key, channel_name, programme_title,
           programme_start, programme_stop, lead_time_ms, fired, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          rem.profile_id,
          rem.source_id,
          rem.channel_key,
          rem.channel_name,
          rem.programme_title,
          best.start,
          best.stop,
          rem.lead_time_ms,
          rem.fired,
          rem.created_at,
        ],
      );
      await db.run(
        'DELETE FROM programme_reminders WHERE profile_id = ? AND channel_key = ? AND programme_start = ?',
        [rem.profile_id, rem.channel_key, rem.programme_start],
      );
    }
    reconciled += 1;
  }

  return reconciled;
}
