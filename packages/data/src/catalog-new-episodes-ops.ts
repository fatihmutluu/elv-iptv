import { ok, type Result, type SqlDriver } from '@elv/domain';
import type { ImportDeps } from './import-types';
import { loadSeriesEpisodes } from './import-xtream';
import {
  DEFAULT_NEW_EPISODES_COOLDOWN_MS,
  DEFAULT_NEW_EPISODES_MAX_SERIES,
  dismissMyListNewEpisode,
  listMyListNewEpisodes,
  MAX_NEW_EPISODES_REFRESH_SERIES,
  type MyListNewEpisodeRow,
  type RefreshMyListNewEpisodesOptions,
  type RefreshMyListNewEpisodesResult,
  reconcileMyListNewEpisodes,
  stampMyListSeriesChecked,
} from './my-list-new-episodes';
import { normalizeProfileId } from './user-state-helpers';

/** My List newly arrived episodes methods exposed on `CatalogService` (`#502`). */
export interface CatalogNewEpisodesOpsMethods {
  listMyListNewEpisodes(
    limit?: number,
    profileId?: string,
    opts?: { readonly parentalUnlocked?: boolean },
  ): Promise<MyListNewEpisodeRow[]>;
  dismissMyListNewEpisode(episodeKey: string, profileId?: string): Promise<Result<void>>;
  refreshMyListNewEpisodes(
    profileId?: string,
    opts?: RefreshMyListNewEpisodesOptions,
  ): Promise<Result<RefreshMyListNewEpisodesResult>>;
}

interface RefreshCandidateRow {
  series_key: string;
  source_id: string;
  last_checked_at: number;
}

interface NewEpisodesQueueLike {
  run<T>(
    sourceId: string,
    kind: 'catalog' | 'guide' | 'series-episodes',
    signal: AbortSignal | undefined,
    fn: (runSignal: AbortSignal) => Promise<Result<T>>,
    opts?: { taskKey?: string },
  ): Promise<Result<T>>;
}

interface NewEpisodesPlaytimeLike {
  resolveRowLogos<T extends { sourceId: string; logo: string | null }>(rows: T[]): Promise<T[]>;
}

function clampCooldownMs(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_NEW_EPISODES_COOLDOWN_MS;
  return Math.max(0, Math.floor(raw));
}

function clampMaxSeries(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_NEW_EPISODES_MAX_SERIES;
  return Math.min(MAX_NEW_EPISODES_REFRESH_SERIES, Math.max(0, Math.floor(raw)));
}

/** @internal Creates My List new episodes query, dismissal, and provider-polite refresh methods for `CatalogService`. */
export function createCatalogNewEpisodesOpsMethods(deps: {
  db: SqlDriver;
  clock: () => number;
  importDeps: ImportDeps;
  queue: NewEpisodesQueueLike;
  playtime: NewEpisodesPlaytimeLike;
}): CatalogNewEpisodesOpsMethods {
  const { db, clock, importDeps, queue, playtime } = deps;

  return {
    async listMyListNewEpisodes(limit, profileId, opts) {
      const rows = await listMyListNewEpisodes(db, limit, profileId, opts);
      if (rows.length === 0) return rows;
      const resolvedLogos = await playtime.resolveRowLogos(
        rows.map((r) => ({ sourceId: r.sourceId, logo: r.seriesLogo })),
      );
      return rows.map((row, idx) => {
        const resolved = resolvedLogos[idx]?.logo ?? row.seriesLogo;
        return resolved === row.seriesLogo ? row : { ...row, seriesLogo: resolved };
      });
    },

    dismissMyListNewEpisode: (episodeKey, profileId) =>
      dismissMyListNewEpisode(db, episodeKey, profileId),

    async refreshMyListNewEpisodes(profileId, opts) {
      const normalized = normalizeProfileId(profileId);
      const cooldownMs = clampCooldownMs(opts?.cooldownMs);
      const maxSeries = clampMaxSeries(opts?.maxSeries);
      const force = opts?.force === true;
      const now = Math.max(1, Math.round(clock()));

      let checkedSeriesCount = 0;
      if (maxSeries > 0) {
        const candidates = await db.all<RefreshCandidateRow>(
          `SELECT f.item_key AS series_key,
                  f.source_id,
                  COALESCE(b.last_checked_at, 0) AS last_checked_at
             FROM favorites f
             INNER JOIN sources src
               ON src.id = f.source_id
              AND src.deleting = 0
             LEFT JOIN my_list_series_baselines b
               ON b.profile_id = f.profile_id
              AND b.series_key = f.item_key
            WHERE f.profile_id = ?
              AND f.kind = 'series'
              AND src.kind IN ('xtream', 'stalker')
            ORDER BY COALESCE(b.last_checked_at, 0) ASC, f.added_at DESC, f.item_key ASC`,
          [normalized],
        );

        const stale = candidates
          .filter((c) => force || c.last_checked_at === 0 || now - c.last_checked_at >= cooldownMs)
          .slice(0, maxSeries);

        for (const item of stale) {
          const loaded = await queue.run(
            item.source_id,
            'series-episodes',
            undefined,
            (runSignal) =>
              loadSeriesEpisodes(item.source_id, item.series_key, importDeps, {
                signal: runSignal,
              }),
            { taskKey: item.series_key },
          );
          if (loaded.ok) {
            checkedSeriesCount += 1;
            await stampMyListSeriesChecked(
              db,
              normalized,
              item.series_key,
              item.source_id,
              clock(),
            );
          }
        }
      }

      const newlyDetectedCount = await reconcileMyListNewEpisodes(db, normalized, { clock });
      return ok({ checkedSeriesCount, newlyDetectedCount });
    },
  };
}
