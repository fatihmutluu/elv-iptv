import type { EpisodeRow, WatchProgressRow } from '@elv/data';
import type { DownloadRecord } from '@elv/domain';
import {
  CtaButton,
  EditorialCategoryBar,
  type EditorialCategoryItem,
  useI18n,
  useTheme,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback, useMemo } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import { DetailEpisodeRow, EpisodeSkeletonRows } from './DetailEpisodeRow';
import { describeDetailSeasonsError } from './detail-model';
import type { EpisodeChunk } from './episode-chunks';
import type { DetailSeasonsState } from './useDetailData';

/** Props of {@link DetailEpisodes}. */
export interface DetailEpisodesProps {
  readonly seasonsState: DetailSeasonsState;
  readonly selectedSeason: number | null;
  readonly episodes: readonly EpisodeRow[];
  readonly episodesLoading: boolean;
  readonly episodesRefreshing?: boolean;
  readonly episodeProgressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly seriesBackdropUri: string | null;
  readonly onSelectSeason: (season: number) => void;
  readonly onRetrySeasons: () => void;
  readonly onPressEpisode: (episode: EpisodeRow, index: number) => void;
  readonly chunks?: readonly EpisodeChunk[];
  readonly selectedChunkIndex?: number;
  readonly focusedChunkIndex?: number | null;
  readonly episodeIndexOffset?: number;
  readonly onSelectChunk?: (chunkIndex: number) => void;
  readonly isTv: boolean;
  readonly isPortrait: boolean;
  readonly padX: number;
  readonly focusedSeasonIndex: number | null;
  readonly focusedEpisodeIndex: number | null;
  readonly focusedRetry: boolean;
  readonly onLayoutY?: (y: number) => void;
  readonly downloadsSupported?: boolean;
  readonly downloadsByKey?: ReadonlyMap<string, DownloadRecord>;
  readonly onPressEpisodeDownload?: (episode: EpisodeRow) => void;
}

function DetailEpisodesInner({
  seasonsState,
  selectedSeason,
  episodes,
  episodesLoading,
  episodesRefreshing = false,
  episodeProgressByKey,
  seriesBackdropUri,
  onSelectSeason,
  onRetrySeasons,
  onPressEpisode,
  chunks,
  selectedChunkIndex = 0,
  focusedChunkIndex = null,
  episodeIndexOffset = 0,
  onSelectChunk,
  isTv,
  isPortrait,
  padX,
  focusedSeasonIndex,
  focusedEpisodeIndex,
  focusedRetry,
  onLayoutY,
  downloadsSupported = false,
  downloadsByKey,
  onPressEpisodeDownload,
}: DetailEpisodesProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      onLayoutY?.(e.nativeEvent.layout.y);
    },
    [onLayoutY],
  );

  const seasonItems = useMemo<readonly EditorialCategoryItem[]>(
    () =>
      seasonsState.kind === 'ready'
        ? seasonsState.seasons.map((s) => ({
            id: String(s.season),
            label: i18n.t('detail.seasonOption', { season: s.season }),
            testID: `detail-season-${s.season}`,
          }))
        : [],
    [i18n, seasonsState],
  );

  const chunkItems = useMemo<readonly EditorialCategoryItem[]>(
    () =>
      chunks
        ? chunks.map((chunk) => ({
            id: String(chunk.index),
            label: chunk.label,
            testID: `detail-episode-chunk-${chunk.index}`,
          }))
        : [],
    [chunks],
  );

  const handleSelectSeasonId = useCallback(
    (id: string) => {
      onSelectSeason(Number(id));
    },
    [onSelectSeason],
  );

  const handleSelectChunkId = useCallback(
    (id: string) => {
      onSelectChunk?.(Number(id));
    },
    [onSelectChunk],
  );

  const watchedLabel = i18n.t('home.watchedBadge');

  return (
    <View
      testID="detail-episodes"
      onLayout={onLayoutY ? handleLayout : undefined}
      style={[styles.section, { marginTop: theme.spacing.lg }]}
    >
      <Text
        style={[
          theme.typography.h2,
          {
            color: theme.colors.textPrimary,
            paddingHorizontal: padX,
            marginBottom: theme.spacing.xs,
          },
        ]}
      >
        {i18n.t('detail.episodes')}
      </Text>

      {seasonsState.kind === 'loading' ? (
        <EpisodeSkeletonRows isPortrait={isPortrait} padX={padX} />
      ) : seasonsState.kind === 'error' ? (
        (() => {
          const described = describeDetailSeasonsError(seasonsState.error);
          return (
            <View
              testID="detail-seasons-error"
              style={[
                styles.errorBox,
                {
                  marginHorizontal: padX,
                  borderRadius: theme.radius.card,
                  backgroundColor: theme.colors.bgCard,
                  borderColor: theme.colors.surfaceBorder,
                  padding: theme.spacing.md,
                  gap: theme.spacing.xs,
                },
              ]}
            >
              <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
                {i18n.t(described.messageId)}
              </Text>
              <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                {i18n.t(described.hintId)}
              </Text>
              <View style={{ marginTop: theme.spacing.xs }}>
                <CtaButton
                  testID="detail-retry-seasons"
                  variant="secondary"
                  icon="refresh"
                  label={i18n.t('series.retrySeasons')}
                  focusable={!isTv}
                  focused={isTv && focusedRetry}
                  onPress={onRetrySeasons}
                />
              </View>
            </View>
          );
        })()
      ) : seasonsState.seasons.length === 0 ? (
        <Text
          testID="detail-episodes-empty"
          style={[
            theme.typography.body,
            {
              color: theme.colors.textSecondary,
              paddingHorizontal: padX,
              marginTop: theme.spacing.xs,
            },
          ]}
        >
          {i18n.t('series.emptySeasons')}
        </Text>
      ) : (
        <>
          <EditorialCategoryBar
            testID="detail-seasons-bar"
            items={seasonItems}
            activeId={selectedSeason !== null ? String(selectedSeason) : null}
            onSelect={handleSelectSeasonId}
            isTv={isTv}
            focusedIndex={focusedSeasonIndex}
            padX={padX}
          />

          {!episodesLoading && chunkItems.length > 0 && onSelectChunk ? (
            <View style={{ marginTop: theme.spacing.xxs }}>
              <EditorialCategoryBar
                testID="detail-episode-chunks-bar"
                items={chunkItems}
                activeId={String(selectedChunkIndex)}
                onSelect={handleSelectChunkId}
                isTv={isTv}
                focusedIndex={focusedChunkIndex}
                padX={padX}
              />
            </View>
          ) : null}

          {episodesLoading ? (
            <EpisodeSkeletonRows isPortrait={isPortrait} padX={padX} />
          ) : episodes.length === 0 ? (
            <Text
              testID="detail-episodes-empty"
              style={[
                theme.typography.body,
                {
                  color: theme.colors.textSecondary,
                  paddingHorizontal: padX,
                  marginTop: theme.spacing.xs,
                },
              ]}
            >
              {i18n.t('series.emptyEpisodes')}
            </Text>
          ) : (
            <View
              style={[
                styles.episodeList,
                {
                  paddingHorizontal: padX,
                  paddingTop: isTv ? 6 : 2,
                  gap: isTv ? theme.spacing.sm : theme.spacing.xs,
                  opacity: episodesRefreshing ? 0.72 : 1,
                },
              ]}
            >
              {episodes.map((ep, localIdx) => {
                const fullIndex = episodeIndexOffset + localIdx;
                return (
                  <DetailEpisodeRow
                    key={ep.key}
                    episode={ep}
                    index={fullIndex}
                    progress={episodeProgressByKey.get(ep.key)}
                    seriesBackdropUri={seriesBackdropUri}
                    isTv={isTv}
                    isPortrait={isPortrait}
                    focused={isTv && focusedEpisodeIndex === localIdx}
                    watchedLabel={watchedLabel}
                    onPressEpisode={onPressEpisode}
                    downloadsSupported={downloadsSupported}
                    downloadRecord={downloadsByKey?.get(ep.key)}
                    {...(onPressEpisodeDownload !== undefined
                      ? { onPressDownload: onPressEpisodeDownload }
                      : {})}
                  />
                );
              })}
            </View>
          )}
        </>
      )}
    </View>
  );
}

/**
 * Series season selector chips and Cinema Quietude episode list (`UI_UX_PHILOSOPHY.md` §3).
 * Renders zero-CLS tonal skeletons while loading, localized error + Retry recovery on failure,
 * and `16:9` episode rows with play overlay, accent progress bars, and `Watched` micro-pills.
 */
export const DetailEpisodes = memo(DetailEpisodesInner);
DetailEpisodes.displayName = 'DetailEpisodes';

const styles = StyleSheet.create({
  section: { width: '100%' },
  episodeList: { width: '100%' },
  errorBox: { borderWidth: 1 },
});
