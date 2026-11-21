import type { EpisodeRow, WatchProgressRow } from '@elv/data';
import { CtaButton, FilterChip, useI18n, useTheme } from '@elv/ui-kit';
import { type ComponentRef, memo, type ReactElement, useCallback, useEffect, useRef } from 'react';
import { type LayoutChangeEvent, ScrollView, StyleSheet, Text, View } from 'react-native';
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
}

interface SeasonChipItemProps {
  readonly season: number;
  readonly label: string;
  readonly selected: boolean;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly onSelectSeason: (season: number) => void;
}

const SeasonChipItem = memo(function SeasonChipItemInner({
  season,
  label,
  selected,
  isTv,
  focused,
  onSelectSeason,
}: SeasonChipItemProps): ReactElement {
  const handlePress = useCallback(() => {
    onSelectSeason(season);
  }, [onSelectSeason, season]);

  return (
    <FilterChip
      testID={`detail-season-${season}`}
      label={label}
      selected={selected}
      focusable={!isTv}
      focused={focused}
      onPress={handlePress}
    />
  );
});

interface ChunkChipItemProps {
  readonly chunkIndex: number;
  readonly label: string;
  readonly selected: boolean;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly onSelectChunk: (chunkIndex: number) => void;
}

const ChunkChipItem = memo(function ChunkChipItemInner({
  chunkIndex,
  label,
  selected,
  isTv,
  focused,
  onSelectChunk,
}: ChunkChipItemProps): ReactElement {
  const handlePress = useCallback(() => {
    onSelectChunk(chunkIndex);
  }, [chunkIndex, onSelectChunk]);

  return (
    <FilterChip
      testID={`detail-episode-chunk-${chunkIndex}`}
      label={label}
      selected={selected}
      focusable={!isTv}
      focused={focused}
      onPress={handlePress}
    />
  );
});

function DetailEpisodesInner({
  seasonsState,
  selectedSeason,
  episodes,
  episodesLoading,
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
}: DetailEpisodesProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const seasonsScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const chunksScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);

  useEffect(() => {
    if (!isTv || focusedSeasonIndex === null || focusedSeasonIndex < 0) return;
    seasonsScrollRef.current?.scrollTo({
      x: Math.max(0, focusedSeasonIndex * 116 - padX),
      animated: !theme.reduceMotion,
    });
  }, [focusedSeasonIndex, isTv, padX, theme.reduceMotion]);

  useEffect(() => {
    if (!isTv || focusedChunkIndex === null || focusedChunkIndex < 0) return;
    chunksScrollRef.current?.scrollTo({
      x: Math.max(0, focusedChunkIndex * 96 - padX),
      animated: !theme.reduceMotion,
    });
  }, [focusedChunkIndex, isTv, padX, theme.reduceMotion]);

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      onLayoutY?.(e.nativeEvent.layout.y);
    },
    [onLayoutY],
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
          <ScrollView
            ref={seasonsScrollRef}
            testID="detail-seasons-bar"
            {...(isTv ? { focusable: false } : {})}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={[
              styles.seasonsBar,
              {
                paddingHorizontal: padX,
                paddingTop: isTv ? 12 : 6,
                paddingBottom: isTv ? 14 : 10,
                gap: theme.spacing.xs,
              },
            ]}
          >
            {seasonsState.seasons.map((s, idx) => (
              <SeasonChipItem
                key={s.season}
                season={s.season}
                label={i18n.t('detail.seasonOption', { season: s.season })}
                selected={s.season === selectedSeason}
                isTv={isTv}
                focused={isTv && focusedSeasonIndex === idx}
                onSelectSeason={onSelectSeason}
              />
            ))}
          </ScrollView>

          {!episodesLoading && chunks && chunks.length > 0 && onSelectChunk ? (
            <ScrollView
              ref={chunksScrollRef}
              testID="detail-episode-chunks-bar"
              accessibilityLabel={i18n.t('detail.episodes')}
              {...(isTv ? { focusable: false } : {})}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={[
                styles.seasonsBar,
                {
                  paddingHorizontal: padX,
                  paddingTop: isTv ? 6 : 2,
                  paddingBottom: isTv ? 12 : 8,
                  gap: theme.spacing.xs,
                },
              ]}
            >
              {chunks.map((chunk) => (
                <ChunkChipItem
                  key={chunk.index}
                  chunkIndex={chunk.index}
                  label={chunk.label}
                  selected={selectedChunkIndex === chunk.index}
                  isTv={isTv}
                  focused={isTv && focusedChunkIndex === chunk.index}
                  onSelectChunk={onSelectChunk}
                />
              ))}
            </ScrollView>
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
  seasonsBar: { alignItems: 'center' },
  episodeList: { width: '100%' },
  errorBox: { borderWidth: 1 },
});
