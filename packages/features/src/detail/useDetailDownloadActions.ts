import type { EpisodeRow } from '@elv/data';
import { computeDownloadProgressRatio, isPlayableDownload } from '@elv/domain';
import { useContextMenu, useI18n } from '@elv/ui-kit';
import { useCallback, useMemo } from 'react';
import type { PlayTarget } from '../ports/play-target';
import { type DetailTarget, useDownloads } from '../shared';
import type { DetailHeroDownloadState } from './DetailHero';
import type { DetailVersionOption } from './detail-data-helpers';

/** Options for {@link useDetailDownloadActions}. */
export interface UseDetailDownloadActionsOptions {
  readonly target: DetailTarget;
  readonly activeVersion: DetailVersionOption | undefined;
  readonly activeSeriesSourceId: string;
  readonly title: string;
  readonly backdropUri: string | null;
  readonly onPlay: (target: PlayTarget) => void;
}

/** Manages movie and episode offline download state and context actions for {@link DetailScreen}. */
export function useDetailDownloadActions({
  target,
  activeVersion,
  activeSeriesSourceId,
  title,
  backdropUri,
  onPlay,
}: UseDetailDownloadActionsOptions) {
  const i18n = useI18n();
  const downloads = useDownloads();
  const contextMenu = useContextMenu();

  const showMovieDownload = target.kind === 'movie' && downloads.supported;
  const activeMovieKey = activeVersion?.key ?? target.itemKey;
  const activeMovieSourceId = activeVersion?.sourceId ?? target.sourceId;
  const activeMovieTitle = activeVersion?.title ?? title;
  const movieDownloadRecord = showMovieDownload
    ? downloads.byItemKey.get(activeMovieKey)
    : undefined;

  const movieDownloadState = useMemo<DetailHeroDownloadState | undefined>(() => {
    if (!showMovieDownload) return undefined;
    if (isPlayableDownload(movieDownloadRecord)) {
      return { icon: 'check', active: true, label: i18n.t('downloads.actionDownloaded') };
    }
    if (movieDownloadRecord?.status === 'downloading' || movieDownloadRecord?.status === 'queued') {
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
  }, [i18n, movieDownloadRecord, showMovieDownload]);

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
        seriesTitle: title,
        season: episode.season,
        episodeNum: episode.episode,
        poster: backdropUri,
      });
    },
    [activeSeriesSourceId, backdropUri, contextMenu, downloads, i18n, onPlay, title],
  );

  return {
    downloads,
    contextMenu,
    showMovieDownload,
    movieDownloadState,
    handlePressMovieDownload,
    handlePressEpisodeDownload,
  };
}
