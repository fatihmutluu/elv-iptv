import {
  CtaButton,
  EditorialCategoryBar,
  type EditorialCategoryItem,
  useI18n,
  useTheme,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback, useMemo } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import { EpisodeSkeletonRows } from './DetailEpisodeRow';
import { describeDetailSeasonsError } from './detail-model';
import type { DetailSeasonsState } from './useDetailData';

/** Props of {@link DetailEpisodes}. */
export interface DetailEpisodesProps {
  readonly seasonsState: DetailSeasonsState;
  readonly selectedSeason: number | null;
  readonly episodesCount: number;
  readonly episodesLoading: boolean;
  readonly onSelectSeason: (season: number) => void;
  readonly onRetrySeasons: () => void;
  readonly isTv: boolean;
  readonly isPortrait: boolean;
  readonly padX: number;
  readonly focusedSeasonIndex: number | null;
  readonly focusedRetry: boolean;
  readonly onLayoutY?: (y: number) => void;
}

function DetailEpisodesInner({
  seasonsState,
  selectedSeason,
  episodesCount,
  episodesLoading,
  onSelectSeason,
  onRetrySeasons,
  isTv,
  isPortrait,
  padX,
  focusedSeasonIndex,
  focusedRetry,
  onLayoutY,
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

  const handleSelectSeasonId = useCallback(
    (id: string) => {
      onSelectSeason(Number(id));
    },
    [onSelectSeason],
  );

  return (
    <View
      testID="detail-episodes"
      onLayout={onLayoutY ? handleLayout : undefined}
      style={[
        styles.section,
        {
          marginTop: theme.spacing.lg,
          marginBottom:
            seasonsState.kind === 'ready' &&
            seasonsState.seasons.length > 0 &&
            !episodesLoading &&
            episodesCount > 0
              ? isTv
                ? 6
                : 2
              : 0,
        },
      ]}
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

          {episodesLoading ? (
            <EpisodeSkeletonRows isPortrait={isPortrait} padX={padX} />
          ) : episodesCount === 0 ? (
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
          ) : null}
        </>
      )}
    </View>
  );
}

/**
 * Series season selector bar and loading/error/empty header for the virtualized single-column
 * endless episode `FlatList` in `DetailScreen` (`UI_UX_PHILOSOPHY.md` §3.2).
 */
export const DetailEpisodes = memo(DetailEpisodesInner);
DetailEpisodes.displayName = 'DetailEpisodes';

const styles = StyleSheet.create({
  section: { width: '100%' },
  errorBox: { borderWidth: 1 },
});
