import type { CatalogService, EpisodeRow, SeasonRow } from '@elv/data';
import {
  computeDownloadProgressRatio,
  type DownloadEnqueueInput,
  isPlayableDownload,
} from '@elv/domain';
import { useContextMenu, useI18n } from '@elv/ui-kit';
import { useCallback, useMemo, useRef } from 'react';
import type { PlayTarget } from '../ports/play-target';
import { type DetailTarget, useDownloads } from '../shared';
import type { DetailHeroDownloadState } from './DetailHero';
import type { DetailVersionOption } from './detail-data-helpers';

/** Options for {@link useDetailDownloadActions}. */
export interface UseDetailDownloadActionsOptions {
  readonly catalog: CatalogService;
  readonly target: DetailTarget;
  readonly activeVersion: DetailVersionOption | undefined;
  readonly activeSeriesKey: string;
  readonly activeSeriesSourceId: string;
  readonly resolvedSeriesId: number | undefined;
  readonly seasons: readonly SeasonRow[];
  readonly selectedSeason: number | null;
  readonly currentSeasonEpisodes: readonly EpisodeRow[];
  readonly getCachedSeasonEpisodes: (season: number) => readonly EpisodeRow[] | undefined;
  readonly title: string;
  readonly backdropUri: string | null;
  readonly onPlay: (target: PlayTarget) => void;
}

/** Manages movie, single-episode, and bulk series/season offline download actions for {@link DetailScreen}. */
export function useDetailDownloadActions({
  catalog,
  target,
  activeVersion,
  activeSeriesKey,
  activeSeriesSourceId,
  resolvedSeriesId,
  seasons,
  selectedSeason,
  currentSeasonEpisodes,
  getCachedSeasonEpisodes,
  title,
  backdropUri,
  onPlay,
}: UseDetailDownloadActionsOptions) {
  const i18n = useI18n();
  const downloads = useDownloads();
  const contextMenu = useContextMenu();
  const bulkDownloadInFlightRef = useRef(false);

  const showHeroDownload = downloads.supported;
  const showMovieDownload = target.kind === 'movie' && downloads.supported;
  const activeMovieKey = activeVersion?.key ?? target.itemKey;
  const activeMovieSourceId = activeVersion?.sourceId ?? target.sourceId;
  const activeMovieTitle = activeVersion?.title ?? title;
  const movieDownloadRecord = showMovieDownload
    ? downloads.byItemKey.get(activeMovieKey)
    : undefined;

  const currentSeasonEpisodeKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const ep of currentSeasonEpisodes) keys.add(ep.key);
    return keys;
  }, [currentSeasonEpisodes]);

  const heroDownloadState = useMemo<DetailHeroDownloadState | undefined>(() => {
    if (!showHeroDownload) return undefined;
    if (target.kind === 'movie') {
      if (isPlayableDownload(movieDownloadRecord)) {
        return { icon: 'check', active: true, label: i18n.t('downloads.actionDownloaded') };
      }
      if (
        movieDownloadRecord?.status === 'downloading' ||
        movieDownloadRecord?.status === 'queued'
      ) {
        const pct = Math.round(
          (computeDownloadProgressRatio(
            movieDownloadRecord.bytesDownloaded,
            movieDownloadRecord.totalBytes,
          ) ?? 0) * 100,
        );
        return {
          icon: 'pause',
          active: true,
          label: i18n.t('downloads.actionDownloading', { percent: pct }),
        };
      }
      if (movieDownloadRecord?.status === 'paused' || movieDownloadRecord?.status === 'failed') {
        return { icon: 'download', active: false, label: i18n.t('downloads.actionResume') };
      }
      return { icon: 'download', active: false, label: i18n.t('downloads.actionDownload') };
    }

    let activeCount = 0;
    let completedCount = 0;
    for (const rec of downloads.records) {
      if (rec.kind !== 'episode') continue;
      const matchesSeries =
        rec.seriesKey === activeSeriesKey ||
        currentSeasonEpisodeKeys.has(rec.itemKey) ||
        (rec.seriesKey == null &&
          rec.sourceId === activeSeriesSourceId &&
          rec.seriesTitle === title);
      if (!matchesSeries) continue;
      if (rec.status === 'downloading' || rec.status === 'queued') activeCount += 1;
      else if (isPlayableDownload(rec)) completedCount += 1;
    }

    if (activeCount > 0) {
      return {
        icon: 'pause',
        active: true,
        label: i18n.t('detail.scopePicker.downloadActionActive', { count: activeCount }),
      };
    }
    if (completedCount > 0) {
      return {
        icon: 'check',
        active: true,
        label: i18n.t('detail.scopePicker.downloadActionCompleted', { count: completedCount }),
      };
    }
    return {
      icon: 'download',
      active: false,
      label: i18n.t('detail.scopePicker.downloadAction'),
    };
  }, [
    activeSeriesKey,
    activeSeriesSourceId,
    currentSeasonEpisodeKeys,
    downloads.records,
    i18n,
    movieDownloadRecord,
    showHeroDownload,
    target.kind,
    title,
  ]);

  const handlePressMovieDownload = useCallback(() => {
    if (!showMovieDownload) return;
    if (movieDownloadRecord && isPlayableDownload(movieDownloadRecord)) {
      contextMenu.openContextMenu({
        title: activeMovieTitle,
        items: [
          {
            id: 'play-offline',
            label: i18n.t('downloads.actionPlayOffline'),
            icon: 'play',
            testID: 'detail-download-play-offline',
            onSelect: () => {
              onPlay({
                itemKey: activeMovieKey,
                sourceId: activeMovieSourceId,
                title: activeMovieTitle,
                kind: 'vod',
                itemKind: 'movie',
                isLocalOffline: true,
                localFileUri: movieDownloadRecord.localUri,
                ...(backdropUri !== null ? { logo: backdropUri } : {}),
              });
            },
          },
          {
            id: 'delete-download',
            label: i18n.t('downloads.actionDelete'),
            icon: 'trash',
            destructive: true,
            testID: 'detail-download-delete',
            onSelect: () => {
              void downloads.remove(activeMovieKey);
            },
          },
        ],
      });
      return;
    }
    if (movieDownloadRecord?.status === 'downloading' || movieDownloadRecord?.status === 'queued') {
      void downloads.pause(activeMovieKey);
      return;
    }
    if (movieDownloadRecord?.status === 'paused' || movieDownloadRecord?.status === 'failed') {
      void downloads.resume(activeMovieKey);
      return;
    }
    void downloads.enqueue({
      sourceId: activeMovieSourceId,
      itemKey: activeMovieKey,
      kind: 'movie',
      title: activeMovieTitle,
      poster: backdropUri,
    });
  }, [
    activeMovieKey,
    activeMovieSourceId,
    activeMovieTitle,
    backdropUri,
    contextMenu,
    downloads,
    i18n,
    movieDownloadRecord,
    onPlay,
    showMovieDownload,
  ]);

  const handlePressEpisodeDownload = useCallback(
    (episode: EpisodeRow) => {
      if (!downloads.supported) return;
      const rec = downloads.byItemKey.get(episode.key);
      const epTitle =
        episode.title?.trim() ||
        i18n.t('series.episodeUntitled', { episode: episode.episode ?? 1 });
      if (rec && isPlayableDownload(rec)) {
        contextMenu.openContextMenu({
          title: epTitle,
          items: [
            {
              id: 'play-offline',
              label: i18n.t('downloads.actionPlayOffline'),
              icon: 'play',
              testID: 'detail-episode-download-play-offline',
              onSelect: () => {
                onPlay({
                  itemKey: episode.key,
                  sourceId: activeSeriesSourceId,
                  title: epTitle,
                  kind: 'vod',
                  itemKind: 'episode',
                  isLocalOffline: true,
                  localFileUri: rec.localUri,
                  subtitle: title,
                  ...(episode.season !== null ? { season: episode.season } : {}),
                  ...(episode.episode !== null ? { episode: episode.episode } : {}),
                  ...(backdropUri !== null ? { logo: backdropUri } : {}),
                });
              },
            },
            {
              id: 'delete-download',
              label: i18n.t('downloads.actionDelete'),
              icon: 'trash',
              destructive: true,
              testID: 'detail-episode-download-delete',
              onSelect: () => {
                void downloads.remove(episode.key);
              },
            },
          ],
        });
        return;
      }
      if (rec?.status === 'downloading' || rec?.status === 'queued') {
        void downloads.pause(episode.key);
        return;
      }
      if (rec?.status === 'paused' || rec?.status === 'failed') {
        void downloads.resume(episode.key);
        return;
      }
      void downloads.enqueue({
        sourceId: activeSeriesSourceId,
        itemKey: episode.key,
        kind: 'episode',
        title: epTitle,
        seriesKey: activeSeriesKey,
        seriesTitle: title,
        season: episode.season,
        episodeNum: episode.episode,
        poster: backdropUri,
      });
    },
    [
      activeSeriesKey,
      activeSeriesSourceId,
      backdropUri,
      contextMenu,
      downloads,
      i18n,
      onPlay,
      title,
    ],
  );

  const enqueueEpisodesBulk = useCallback(
    async (seasonBatches: readonly (readonly EpisodeRow[])[]): Promise<boolean> => {
      if (!downloads.supported) return false;
      const seen = new Set<string>();
      const inputs: DownloadEnqueueInput[] = [];
      for (const seasonEpisodes of seasonBatches) {
        for (let i = 0; i < seasonEpisodes.length; i += 1) {
          const ep = seasonEpisodes[i];
          if (!ep || seen.has(ep.key)) continue;
          seen.add(ep.key);
          const existing = downloads.byItemKey.get(ep.key);
          if (
            existing !== undefined &&
            (existing.status === 'queued' ||
              existing.status === 'downloading' ||
              isPlayableDownload(existing))
          ) {
            continue;
          }
          const epNum = ep.episode ?? i + 1;
          const epTitle = ep.title?.trim() || i18n.t('series.episodeUntitled', { episode: epNum });
          inputs.push({
            sourceId: activeSeriesSourceId,
            itemKey: ep.key,
            kind: 'episode',
            title: epTitle,
            seriesKey: activeSeriesKey,
            seriesTitle: title,
            season: ep.season,
            episodeNum: epNum,
            poster: backdropUri,
          });
        }
      }
      if (inputs.length === 0) return true;
      if (typeof downloads.enqueueBatch === 'function') {
        const res = await downloads.enqueueBatch(inputs);
        return res.ok;
      }
      let allOk = true;
      for (const input of inputs) {
        const res = await downloads.enqueue(input);
        if (!res.ok) allOk = false;
      }
      return allOk;
    },
    [activeSeriesKey, activeSeriesSourceId, backdropUri, downloads, i18n, title],
  );

  const resolveSeasonEpisodes = useCallback(
    async (season: number): Promise<readonly EpisodeRow[]> => {
      if (season === selectedSeason && currentSeasonEpisodes.length > 0) {
        return currentSeasonEpisodes;
      }
      const cached = getCachedSeasonEpisodes(season);
      if (cached !== undefined && cached.length > 0) return cached;
      if (resolvedSeriesId === undefined) return [];
      return catalog.episodes(resolvedSeriesId, season).catch(() => [] as EpisodeRow[]);
    },
    [catalog, currentSeasonEpisodes, getCachedSeasonEpisodes, resolvedSeriesId, selectedSeason],
  );

  const downloadSeason = useCallback(
    async (season: number): Promise<boolean> => {
      if (bulkDownloadInFlightRef.current) return false;
      bulkDownloadInFlightRef.current = true;
      try {
        const eps = await resolveSeasonEpisodes(season);
        return await enqueueEpisodesBulk([eps]);
      } catch {
        return false;
      } finally {
        bulkDownloadInFlightRef.current = false;
      }
    },
    [enqueueEpisodesBulk, resolveSeasonEpisodes],
  );

  const downloadEntireSeries = useCallback(async (): Promise<boolean> => {
    if (seasons.length === 0 || bulkDownloadInFlightRef.current) return false;
    bulkDownloadInFlightRef.current = true;
    try {
      const seasonBatches: (readonly EpisodeRow[])[] = [];
      for (const s of seasons) {
        const eps = await resolveSeasonEpisodes(s.season);
        if (eps.length > 0) seasonBatches.push(eps);
      }
      return await enqueueEpisodesBulk(seasonBatches);
    } catch {
      return false;
    } finally {
      bulkDownloadInFlightRef.current = false;
    }
  }, [enqueueEpisodesBulk, resolveSeasonEpisodes, seasons]);

  return {
    downloads,
    contextMenu,
    showHeroDownload,
    showMovieDownload,
    heroDownloadState,
    handlePressMovieDownload,
    handlePressEpisodeDownload,
    downloadSeason,
    downloadEntireSeries,
  };
}
