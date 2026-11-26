import type { SqlDriver } from '@elv/domain';
import { queryNextEpisode } from './next-episode';
import { findRestrictedItemKeys, loadActiveParentalFilter } from './parental-repo';
import { sourceOfKey } from './queries';
import {
  clampLimit,
  mapProgressRow,
  normalizeProfileId,
  type RawProgressRow,
  type WatchProgressRow,
} from './user-state-helpers';

/** Series reference extracted before clearing watch progress so Next-Up dismissal can be persisted. */
export interface SeriesDismissalRef {
  readonly seriesKey: string;
  readonly sourceId: string;
}

interface RawLatestSeriesEpisodeRow {
  source_id: string;
  item_key: string;
  title: string;
  logo: string | null;
  series_key: string;
  updated_at: number;
}

interface RawSeriesRefRow {
  series_key: string | null;
  source_id: string | null;
}

const LATEST_COMPLETED_SERIES_EPISODES_SQL = `
WITH latest_series_ep AS (
  SELECT source_id, item_key, title, logo, series_key, updated_at,
         ROW_NUMBER() OVER (PARTITION BY series_key ORDER BY updated_at DESC, item_key ASC) AS rn
    FROM watch_progress
   WHERE profile_id = ?
     AND kind = 'episode'
     AND watched = 1
     AND series_key IS NOT NULL
     AND series_key != ''
)
SELECT l.source_id, l.item_key, l.title, l.logo, l.series_key, l.updated_at
  FROM latest_series_ep l
  LEFT JOIN continue_watching_dismissals d
    ON d.profile_id = ? AND d.series_key = l.series_key
 WHERE l.rn = 1
   AND (d.dismissed_at IS NULL OR d.dismissed_at < l.updated_at)
   AND NOT EXISTS (
     SELECT 1 FROM watch_progress wp_ip
      WHERE wp_ip.profile_id = ?
        AND wp_ip.series_key = l.series_key
        AND wp_ip.watched = 0
        AND wp_ip.position_ms >= ?
        AND wp_ip.duration_ms > 0
   )
 ORDER BY l.updated_at DESC, l.item_key ASC
 LIMIT ?`;

const UPSERT_DISMISSAL_SQL = `
INSERT INTO continue_watching_dismissals (profile_id, series_key, source_id, dismissed_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(profile_id, series_key) DO UPDATE SET
  source_id = excluded.source_id,
  dismissed_at = excluded.dismissed_at`;

/**
 * Resolves `(seriesKey, sourceId)` for an episode key before deleting its `watch_progress` row
 * (checking `watch_progress` first, then `episodes`) so dismissing either an in-progress episode
 * or a synthesized Next-Up card records a series dismissal in `continue_watching_dismissals`.
 */
export async function lookupSeriesRefForDismissal(
  db: SqlDriver,
  profileId: string,
  itemKey: string,
): Promise<SeriesDismissalRef | null> {
  const trimmed = itemKey.trim();
  if (trimmed === '') return null;

  const progressRows = await db.all<RawSeriesRefRow>(
    'SELECT series_key, source_id FROM watch_progress WHERE profile_id = ? AND item_key = ? LIMIT 1',
    [profileId, trimmed],
  );
  const fromProgress = progressRows[0];
  if (
    fromProgress !== undefined &&
    fromProgress.series_key !== null &&
    fromProgress.series_key.trim() !== '' &&
    fromProgress.source_id !== null &&
    fromProgress.source_id.trim() !== ''
  ) {
    return {
      seriesKey: fromProgress.series_key.trim(),
      sourceId: fromProgress.source_id.trim(),
    };
  }

  const hintedSource = sourceOfKey(trimmed);
  const epRows =
    hintedSource !== undefined
      ? await db.all<RawSeriesRefRow>(
          'SELECT series_key, source_id FROM episodes WHERE source_id = ? AND key = ? LIMIT 1',
          [hintedSource, trimmed],
        )
      : await db.all<RawSeriesRefRow>(
          'SELECT series_key, source_id FROM episodes WHERE key = ? LIMIT 1',
          [trimmed],
        );
  const fromEpisode = epRows[0];
  if (
    fromEpisode !== undefined &&
    fromEpisode.series_key !== null &&
    fromEpisode.series_key.trim() !== '' &&
    fromEpisode.source_id !== null &&
    fromEpisode.source_id.trim() !== ''
  ) {
    return {
      seriesKey: fromEpisode.series_key.trim(),
      sourceId: fromEpisode.source_id.trim(),
    };
  }
  return null;
}

/** Upserts a per-profile series dismissal timestamp into `continue_watching_dismissals`. */
export async function recordContinueWatchingDismissal(
  db: SqlDriver,
  profileId: string,
  ref: SeriesDismissalRef,
  clock: () => number = Date.now,
): Promise<void> {
  const dismissedAt = Math.max(0, Math.round(clock()));
  await db.run(UPSERT_DISMISSAL_SQL, [profileId, ref.seriesKey, ref.sourceId, dismissedAt]);
}

function formatNextUpSubtitle(
  season: number | null,
  episode: number | null,
  title: string | null,
): string | null {
  const trimmedTitle = title?.trim() ?? '';
  const hasSeason = typeof season === 'number' && Number.isFinite(season) && season > 0;
  const hasEpisode = typeof episode === 'number' && Number.isFinite(episode) && episode > 0;
  const code =
    hasSeason && hasEpisode
      ? `S${season} · E${episode}`
      : hasEpisode
        ? `E${episode}`
        : hasSeason
          ? `S${season}`
          : '';
  if (code !== '' && trimmedTitle !== '') return `${code} — ${trimmedTitle}`;
  if (code !== '') return code;
  return trimmedTitle !== '' ? trimmedTitle : null;
}

/**
 * Synthesizes Next-Up `WatchProgressRow` entries for series whose most recent watched episode in
 * `watch_progress` was completed (`watched = 1`), skipping in-progress, dismissed, finale,
 * and already-watched subsequent episodes.
 */
async function synthesizeNextUpRows(
  db: SqlDriver,
  profileId: string,
  directRows: readonly WatchProgressRow[],
  minResumePositionMs: number,
  fetchLimit: number,
  opts?: { readonly parentalUnlocked?: boolean },
): Promise<WatchProgressRow[]> {
  if (fetchLimit <= 0) return [];
  const inProgressSeries = new Set<string>();
  for (const row of directRows) {
    if (row.seriesKey !== null && row.seriesKey !== '') {
      inProgressSeries.add(row.seriesKey);
    }
  }

  const candidateLimit = Math.min(250, Math.max(fetchLimit * 2, 48));
  const candidates = await db.all<RawLatestSeriesEpisodeRow>(LATEST_COMPLETED_SERIES_EPISODES_SQL, [
    profileId,
    profileId,
    profileId,
    minResumePositionMs,
    candidateLimit,
  ]);
  if (candidates.length === 0) return [];

  const nextUpRows: WatchProgressRow[] = [];
  for (const candidate of candidates) {
    if (nextUpRows.length >= fetchLimit) break;
    if (inProgressSeries.has(candidate.series_key)) continue;

    const nextEp = await queryNextEpisode(
      db,
      candidate.series_key,
      candidate.item_key,
      profileId,
      opts,
    );
    if (nextEp === null) continue;

    // queryNextEpisode ranks all unwatched subsequent episodes first and only returns a watched
    // episode when every remaining episode is already watched (rewatch fallback); skip those here.
    const watchedRows = await db.all<{ watched: number }>(
      'SELECT watched FROM watch_progress WHERE profile_id = ? AND item_key = ? LIMIT 1',
      [profileId, nextEp.key],
    );
    if ((watchedRows[0]?.watched ?? 0) !== 0) continue;

    const title =
      nextEp.seriesTitle !== null && nextEp.seriesTitle.trim() !== ''
        ? nextEp.seriesTitle
        : candidate.title;
    const durationMs =
      nextEp.durationSec !== null && Number.isFinite(nextEp.durationSec) && nextEp.durationSec > 0
        ? Math.round(nextEp.durationSec * 1000)
        : 0;

    nextUpRows.push({
      profileId,
      sourceId: nextEp.sourceId,
      itemKey: nextEp.key,
      kind: 'episode',
      title,
      subtitle: formatNextUpSubtitle(nextEp.season, nextEp.episode, nextEp.title),
      logo: nextEp.logo ?? candidate.logo,
      seriesKey: candidate.series_key,
      season: nextEp.season,
      episode: nextEp.episode,
      positionMs: 0,
      durationMs,
      watched: false,
      updatedAt: candidate.updated_at,
    });
  }

  return nextUpRows;
}

/**
 * Queries active in-progress items, merges synthesized Next-Up rows (preferring active in-progress
 * episodes on duplicate `seriesKey`), sorts by `updatedAt DESC, itemKey ASC`, applies the active
 * parental-lock filter, and slices to the clamped limit.
 */
export async function queryContinueWatchingWithNextUp(
  db: SqlDriver,
  progressCols: string,
  minResumePositionMs: number,
  limit: number,
  profileId: string,
  opts?: { readonly parentalUnlocked?: boolean },
): Promise<WatchProgressRow[]> {
  const clamped = clampLimit(limit, 24);
  if (clamped === 0) return [];
  const normalized = normalizeProfileId(profileId);
  const filter = await loadActiveParentalFilter(db, normalized, opts?.parentalUnlocked);
  const fetchLimit = filter === null ? clamped : Math.min(100, clamped * 4);
  const directRaw = await db.all<RawProgressRow>(
    `SELECT ${progressCols} FROM (
       SELECT ${progressCols}, ROW_NUMBER() OVER (PARTITION BY COALESCE(NULLIF(series_key, ''), NULLIF(version_group_key, ''), item_key) ORDER BY updated_at DESC, item_key ASC) AS rn
         FROM watch_progress WHERE profile_id = ? AND watched = 0 AND position_ms >= ? AND duration_ms > 0
     ) WHERE rn = 1 ORDER BY updated_at DESC, item_key ASC LIMIT ?`,
    [normalized, minResumePositionMs, fetchLimit],
  );
  const directRows = directRaw.map(mapProgressRow);
  const nextUpRows = await synthesizeNextUpRows(
    db,
    normalized,
    directRows,
    minResumePositionMs,
    fetchLimit,
    opts,
  );

  const activeSeriesKeys = new Set<string>();
  for (const row of directRows) {
    if (row.seriesKey !== null && row.seriesKey !== '') {
      activeSeriesKeys.add(row.seriesKey);
    }
  }
  const merged: WatchProgressRow[] = [...directRows];
  const seenNextUpSeries = new Set<string>();
  for (const row of nextUpRows) {
    const sk = row.seriesKey;
    if (sk !== null && sk !== '') {
      if (activeSeriesKeys.has(sk) || seenNextUpSeries.has(sk)) continue;
      seenNextUpSeries.add(sk);
    }
    merged.push(row);
  }
  merged.sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0;
  });

  if (filter === null) return merged.slice(0, clamped);
  const restricted = await findRestrictedItemKeys(
    db,
    filter,
    merged.map((r) => ({
      itemKey: r.itemKey,
      sourceId: r.sourceId,
      kind: r.kind,
      title: r.title,
      seriesKey: r.seriesKey,
    })),
  );
  return merged.filter((r) => !restricted.has(r.itemKey)).slice(0, clamped);
}
