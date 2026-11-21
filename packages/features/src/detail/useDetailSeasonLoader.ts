import type { CatalogService, EpisodeRow, SeasonRow, WatchProgressRow } from '@elv/data';
import { type MutableRefObject, useCallback, useRef } from 'react';
import { batchLoadProgressByKeys } from '../shared';
import {
  type DetailSnapshot,
  mergeEpisodeProgress,
  pickAdjacentSeasonsToPrewarm,
} from './detail-data-helpers';

/** Options for {@link useDetailSeasonLoader}. */
export interface UseDetailSeasonLoaderOptions {
  readonly catalog: CatalogService;
  readonly mountedRef: MutableRefObject<boolean>;
  readonly snapRef: MutableRefObject<DetailSnapshot>;
  readonly activeItemKeyRef: MutableRefObject<string>;
  readonly activeSourceIdRef: MutableRefObject<string>;
  readonly episodesBySeasonRef: MutableRefObject<Map<number, readonly EpisodeRow[]>>;
  readonly persistToCache: (itemKey: string, sourceId: string, nextSnap: DetailSnapshot) => void;
  readonly updateSnap: (
    updater: (prev: DetailSnapshot) => DetailSnapshot,
    persist?: boolean,
  ) => void;
}

/**
 * Zero-blink season episode loader & cancellable adjacent-season prewarmer for {@link useDetailData}
 * (`#445`). Serves cached seasons synchronously on frame 0 and retains existing episodes softly
 * (`episodesRefreshing: true`) while an uncached season loads.
 */
export function useDetailSeasonLoader({
  catalog,
  mountedRef,
  snapRef,
  activeItemKeyRef,
  activeSourceIdRef,
  episodesBySeasonRef,
  persistToCache,
  updateSnap,
}: UseDetailSeasonLoaderOptions) {
  const episodesGenRef = useRef(0);
  const prewarmGenRef = useRef(0);

  const cancelPrewarm = useCallback(() => {
    prewarmGenRef.current += 1;
  }, []);

  const prewarmAdjacentSeasons = useCallback(
    (seriesId: number, seasons: readonly SeasonRow[], activeSeason: number, itemKey: string) => {
      const toWarm = pickAdjacentSeasonsToPrewarm(
        seasons,
        activeSeason,
        new Set(episodesBySeasonRef.current.keys()),
      );
      if (toWarm.length === 0) return;
      const pGen = ++prewarmGenRef.current;
      const valid = () =>
        mountedRef.current &&
        activeItemKeyRef.current === itemKey &&
        prewarmGenRef.current === pGen;
      void (async () => {
        for (const seasonNum of toWarm) {
          if (!valid()) return;
          if (episodesBySeasonRef.current.has(seasonNum)) continue;
          const rows = await catalog.episodes(seriesId, seasonNum).catch(() => null);
          if (!rows || !valid()) return;
          episodesBySeasonRef.current.set(seasonNum, rows);
          const progressMap = await batchLoadProgressByKeys(
            catalog,
            rows.map((e) => e.key),
          ).catch(() => new Map<string, WatchProgressRow>());
          if (!valid()) return;
          if (progressMap.size > 0) {
            updateSnap((prev) => ({
              ...prev,
              episodeProgressByKey: mergeEpisodeProgress(prev.episodeProgressByKey, progressMap),
            }));
          } else {
            persistToCache(itemKey, activeSourceIdRef.current, snapRef.current);
          }
        }
      })();
    },
    [
      activeItemKeyRef,
      activeSourceIdRef,
      catalog,
      episodesBySeasonRef,
      mountedRef,
      persistToCache,
      snapRef,
      updateSnap,
    ],
  );

  const loadSeasonEpisodes = useCallback(
    async (
      seriesId: number,
      season: number,
      itemKey: string,
      opts?: { readonly backgroundRefresh?: boolean; readonly seasons?: readonly SeasonRow[] },
    ) => {
      const epGen = ++episodesGenRef.current;
      const cached = episodesBySeasonRef.current.get(season);
      const isStaleEp = () =>
        !mountedRef.current ||
        epGen !== episodesGenRef.current ||
        activeItemKeyRef.current !== itemKey;

      if (cached !== undefined && !opts?.backgroundRefresh) {
        updateSnap((prev) => ({
          ...prev,
          selectedSeason: season,
          episodes: cached,
          episodesLoading: false,
          episodesRefreshing: false,
        }));
        if (opts?.seasons) prewarmAdjacentSeasons(seriesId, opts.seasons, season, itemKey);
        const progressMap = await batchLoadProgressByKeys(
          catalog,
          cached.map((e) => e.key),
        ).catch(() => new Map<string, WatchProgressRow>());
        if (!isStaleEp() && progressMap.size > 0) {
          updateSnap((prev) => ({
            ...prev,
            episodeProgressByKey: mergeEpisodeProgress(prev.episodeProgressByKey, progressMap),
          }));
        }
        return;
      }

      if (!opts?.backgroundRefresh) {
        const hasVisible = snapRef.current.episodes.length > 0;
        updateSnap(
          (prev) => ({
            ...prev,
            selectedSeason: season,
            episodesLoading: !hasVisible,
            episodesRefreshing: hasVisible,
          }),
          false,
        );
      }

      try {
        const rows = await catalog.episodes(seriesId, season).catch(() => [] as EpisodeRow[]);
        if (isStaleEp()) return;
        episodesBySeasonRef.current.set(season, rows);
        const progressMap = await batchLoadProgressByKeys(
          catalog,
          rows.map((e) => e.key),
        ).catch(() => new Map<string, WatchProgressRow>());
        if (isStaleEp()) return;
        updateSnap((prev) => ({
          ...prev,
          selectedSeason: season,
          episodes: rows,
          episodeProgressByKey: mergeEpisodeProgress(prev.episodeProgressByKey, progressMap),
          episodesLoading: false,
          episodesRefreshing: false,
        }));
        const seasonsList =
          opts?.seasons ??
          (snapRef.current.seasonsState.kind === 'ready'
            ? snapRef.current.seasonsState.seasons
            : undefined);
        if (seasonsList) prewarmAdjacentSeasons(seriesId, seasonsList, season, itemKey);
      } catch {
        if (!isStaleEp()) {
          updateSnap((prev) => ({ ...prev, episodesLoading: false, episodesRefreshing: false }));
        }
      }
    },
    [
      activeItemKeyRef,
      catalog,
      episodesBySeasonRef,
      mountedRef,
      prewarmAdjacentSeasons,
      snapRef,
      updateSnap,
    ],
  );

  return { loadSeasonEpisodes, cancelPrewarm };
}
