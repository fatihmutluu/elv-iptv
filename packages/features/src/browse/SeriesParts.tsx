import type { EpisodeRow, SeasonRow } from '@elv/data';
import type { FocusStore } from '@elv/focus-core';
import { ElvList, type ListSource, useI18n } from '@elv/ui-kit';
import { type ReactElement, useCallback } from 'react';
import { Text, View } from 'react-native';
import { BROWSE_VISIBLE_ROWS, browseStyles, PlainBrowseButton, PlainListRow } from './BrowseParts';
import { formatEpisodeLabel, formatItemTitle, type SeriesDetailState } from './browse-model';

export const SEASONS_LIST_ID = 'series-seasons';
export const EPISODES_LIST_ID = 'series-episodes';

/** Two-column (or single-pane phone) Seasons + Episodes layout for `SeriesDetailPane`. */
export function SeriesSeasonsAndEpisodes({
  isTv,
  isPhone,
  rowHeight,
  store,
  detail,
  activePane,
  seasonsSource,
  episodesSource,
  safeSeasonIdx,
  safeEpisodeIdx,
  episodesLoading,
  episodesCount,
  onBackToSeries,
  onBackToSeasons,
  onSelectSeason,
  onActivateSeason,
  onSelectEpisode,
  onActivateEpisode,
}: {
  isTv: boolean;
  isPhone: boolean;
  rowHeight: number;
  store: FocusStore;
  detail: SeriesDetailState;
  activePane: 'seasons' | 'episodes';
  seasonsSource: ListSource<SeasonRow>;
  episodesSource: ListSource<EpisodeRow>;
  safeSeasonIdx: number;
  safeEpisodeIdx: number;
  episodesLoading: boolean;
  episodesCount: number;
  onBackToSeries: () => void;
  onBackToSeasons: () => void;
  onSelectSeason: (idx: number) => void;
  onActivateSeason: (idx: number) => void;
  onSelectEpisode: (idx: number) => void;
  onActivateEpisode: (idx: number) => void;
}): ReactElement {
  const i18n = useI18n();

  const seasonRowLabel = useCallback(
    (season: SeasonRow | undefined) =>
      season === undefined
        ? i18n.t('browse.loading')
        : i18n.t('series.seasonCount', { season: season.season, count: season.episodeCount }),
    [i18n],
  );
  const renderSeasonRow = useCallback(
    (season: SeasonRow | undefined, active: boolean) => (
      <PlainListRow text={seasonRowLabel(season)} active={active} isTv={isTv} />
    ),
    [isTv, seasonRowLabel],
  );
  const episodeRowLabel = useCallback(
    (ep: EpisodeRow | undefined, idx: number) =>
      ep === undefined
        ? i18n.t('browse.loading')
        : formatEpisodeLabel(ep, idx, detail.series.name, i18n.t).rowText,
    [detail.series.name, i18n],
  );
  const renderEpisodeRow = useCallback(
    (ep: EpisodeRow | undefined, active: boolean, idx: number) => (
      <PlainListRow text={episodeRowLabel(ep, idx)} active={active} isTv={isTv} />
    ),
    [episodeRowLabel, isTv],
  );

  const seasonsPane = (
    <View style={isPhone ? browseStyles.singlePane : browseStyles.leftColumn}>
      <View style={browseStyles.paneHeader}>
        <Text style={[browseStyles.paneTitle, isTv ? browseStyles.paneTitleTv : null]}>
          {`${formatItemTitle(detail.series)} — ${i18n.t('series.seasons')}`}
        </Text>
        <PlainBrowseButton
          testID="series-back-series"
          label={i18n.t('series.backToSeries')}
          isTv={isTv}
          onPress={onBackToSeries}
        />
      </View>
      <ElvList
        listId={SEASONS_LIST_ID}
        store={store}
        source={seasonsSource}
        rowHeight={rowHeight}
        visibleRows={BROWSE_VISIBLE_ROWS}
        selectedIndex={safeSeasonIdx}
        onSelectIndex={onSelectSeason}
        onActivateIndex={onActivateSeason}
        renderRow={renderSeasonRow}
        rowLabel={seasonRowLabel}
        testID="series-seasons-list"
      />
    </View>
  );

  const episodesPane = (
    <View style={isPhone ? browseStyles.singlePane : browseStyles.rightColumn}>
      <View style={browseStyles.paneHeader}>
        <Text style={[browseStyles.paneTitle, isTv ? browseStyles.paneTitleTv : null]}>
          {i18n.t('series.episodes')}
        </Text>
        {isPhone ? (
          <PlainBrowseButton
            testID="series-back-seasons"
            label={i18n.t('series.backToSeasons')}
            isTv={isTv}
            onPress={onBackToSeasons}
          />
        ) : null}
      </View>
      {episodesLoading || episodesCount === 0 ? (
        <View style={browseStyles.emptyBox}>
          <Text style={[browseStyles.messageText, isTv ? browseStyles.messageTextTv : null]}>
            {episodesLoading ? i18n.t('browse.loading') : i18n.t('series.emptyEpisodes')}
          </Text>
        </View>
      ) : (
        <ElvList
          listId={EPISODES_LIST_ID}
          store={store}
          source={episodesSource}
          rowHeight={rowHeight}
          visibleRows={BROWSE_VISIBLE_ROWS}
          selectedIndex={safeEpisodeIdx}
          onSelectIndex={onSelectEpisode}
          onActivateIndex={onActivateEpisode}
          renderRow={renderEpisodeRow}
          rowLabel={episodeRowLabel}
          testID="series-episodes-list"
        />
      )}
    </View>
  );

  if (isPhone) {
    return activePane === 'episodes' ? episodesPane : seasonsPane;
  }
  return (
    <View style={browseStyles.splitRow}>
      {seasonsPane}
      {episodesPane}
    </View>
  );
}
