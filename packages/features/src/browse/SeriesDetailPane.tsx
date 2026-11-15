import type { CatalogService, EpisodeRow, SeasonRow } from '@elv/data';
import type { FocusStore, KeyEvent } from '@elv/focus-core';
import { ElvList, useFormFactor, useI18n } from '@elv/ui-kit';
import {
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Text, View } from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import { createTwoPaneFocusStore, SeriesStatusBox } from './BrowseHelpers';
import {
  BROWSE_ROW_HEIGHT_POINTER,
  BROWSE_ROW_HEIGHT_TV,
  BROWSE_VISIBLE_ROWS,
  BrowseTvKeyBridge,
  browseStyles,
  createArrayListSource,
  PlainBrowseButton,
  PlainListRow,
} from './BrowseParts';
import {
  type DescribedBrowseFailure,
  describeCatalogReadFailure,
  formatEpisodeLabel,
  formatItemTitle,
  type SeriesDetailState,
} from './browse-model';

const SEASONS_LIST_ID = 'series-seasons';
const EPISODES_LIST_ID = 'series-episodes';

export interface SeriesDetailPaneProps {
  catalog: CatalogService;
  refreshToken: number;
  detail: SeriesDetailState;
  onDetailChange: (next: SeriesDetailState) => void;
  onBackToSeries: () => void;
  onPlay: (target: PlayTarget) => void;
  onFocusTopNav?: () => void;
  isActiveScope: boolean;
}

type SeasonsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly failure: DescribedBrowseFailure }
  | { readonly kind: 'ready'; readonly rows: readonly SeasonRow[] };

export function SeriesDetailPane({
  catalog,
  refreshToken,
  detail,
  onDetailChange,
  onBackToSeries,
  onPlay,
  onFocusTopNav,
  isActiveScope,
}: SeriesDetailPaneProps): ReactElement {
  const formFactor = useFormFactor();
  const i18n = useI18n();
  const isTv = formFactor === 'tv';
  const isPhone = formFactor === 'phone';
  const rowHeight = isTv ? BROWSE_ROW_HEIGHT_TV : BROWSE_ROW_HEIGHT_POINTER;

  const [seasonsState, setSeasonsState] = useState<SeasonsState>({ kind: 'loading' });
  const [episodes, setEpisodes] = useState<readonly EpisodeRow[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  const activePane = detail.activePane ?? 'seasons';
  const seasons = seasonsState.kind === 'ready' ? seasonsState.rows : [];
  const safeSeasonIdx =
    seasons.length > 0
      ? Math.min(Math.max(0, Math.floor(detail.selectedSeasonIndex)), seasons.length - 1)
      : 0;
  const activeSeason = seasons[safeSeasonIdx];
  const safeEpisodeIdx =
    episodes.length > 0
      ? Math.min(Math.max(0, Math.floor(detail.selectedEpisodeIndex)), episodes.length - 1)
      : 0;

  const storeRef = useRef<FocusStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createTwoPaneFocusStore(
      'series-detail',
      SEASONS_LIST_ID,
      EPISODES_LIST_ID,
      activePane === 'episodes' ? EPISODES_LIST_ID : SEASONS_LIST_ID,
    );
  }
  const store = storeRef.current;

  const detailRef = useRef(detail);
  detailRef.current = detail;
  const onDetailChangeRef = useRef(onDetailChange);
  onDetailChangeRef.current = onDetailChange;
  const onBackRef = useRef(onBackToSeries);
  onBackRef.current = onBackToSeries;
  const onFocusTopNavRef = useRef(onFocusTopNav);
  onFocusTopNavRef.current = onFocusTopNav;
  const episodesRef = useRef(episodes);
  episodesRef.current = episodes;
  const seasonsStateRef = useRef(seasonsState);
  seasonsStateRef.current = seasonsState;

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryNonce and refreshToken intentionally re-trigger season fetch
  useEffect(() => {
    let cancelled = false;
    setSeasonsState({ kind: 'loading' });
    setEpisodes([]);
    catalog.seasons(detail.series.id).then(
      (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setSeasonsState({ kind: 'error', failure: describeCatalogReadFailure(res.error) });
          return;
        }
        setSeasonsState({ kind: 'ready', rows: res.value });
      },
      () => {
        if (!cancelled) {
          setSeasonsState({
            kind: 'error',
            failure: {
              messageId: 'source.error.unreachable',
              hintId: 'source.hint.unreachable',
            },
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [catalog, detail.series.id, refreshToken, retryNonce]);

  useEffect(() => {
    if (seasonsState.kind !== 'ready' || activeSeason === undefined) {
      setEpisodes([]);
      setEpisodesLoading(false);
      return undefined;
    }
    let cancelled = false;
    setEpisodesLoading(true);
    catalog.episodes(detail.series.id, activeSeason.season).then(
      (rows) => {
        if (cancelled) return;
        setEpisodes(rows);
        setEpisodesLoading(false);
      },
      () => {
        if (!cancelled) {
          setEpisodes([]);
          setEpisodesLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [activeSeason, catalog, detail.series.id, seasonsState]);

  useLayoutEffect(() => {
    if (!isTv) return;
    const targetList =
      activePane === 'episodes' && episodes.length > 0 ? EPISODES_LIST_ID : SEASONS_LIST_ID;
    if (!store.isActive(targetList)) {
      store.activate(targetList);
    }
  }, [activePane, episodes.length, isTv, store]);

  const seasonsSource = useMemo(() => createArrayListSource(seasons), [seasons]);
  const episodesSource = useMemo(() => createArrayListSource(episodes), [episodes]);

  const activateEpisode = useCallback(
    (epIndex: number) => {
      const ep = episodesRef.current[epIndex];
      if (ep === undefined) return;
      const cur = detailRef.current;
      onDetailChangeRef.current({
        ...cur,
        selectedSeasonIndex: safeSeasonIdx,
        selectedEpisodeIndex: epIndex,
        activePane: 'episodes',
      });
      const { playTitle } = formatEpisodeLabel(ep, epIndex, cur.series.name, i18n.t);
      onPlay({ itemKey: ep.key, sourceId: cur.series.sourceId, title: playTitle, kind: 'vod' });
    },
    [i18n.t, onPlay, safeSeasonIdx],
  );

  const handleTvKey = useCallback(
    (event: KeyEvent) => {
      const curState = seasonsStateRef.current;
      if (curState.kind !== 'ready' || curState.rows.length === 0) {
        if (event.kind === 'press' && event.key === 'select' && curState.kind === 'error') {
          setRetryNonce((n) => n + 1);
        } else if (event.kind === 'press' && event.key === 'back') {
          onBackRef.current();
        } else if (event.kind === 'press' && event.key === 'up') {
          onFocusTopNavRef.current?.();
        }
        return;
      }

      for (const intent of store.dispatch(event)) {
        if (
          intent.kind === 'edge' &&
          intent.side === 'start' &&
          (event.key === 'up' || event.key === 'channelUp')
        ) {
          onFocusTopNavRef.current?.();
        } else if (intent.kind === 'select') {
          if (intent.listId === SEASONS_LIST_ID) {
            if (episodesRef.current.length > 0) store.activate(EPISODES_LIST_ID);
            onDetailChangeRef.current({
              ...detailRef.current,
              selectedSeasonIndex: intent.index,
              activePane: 'episodes',
            });
          } else if (intent.listId === EPISODES_LIST_ID) {
            activateEpisode(intent.index);
          }
        } else if (intent.kind === 'back') {
          if (store.isActive(EPISODES_LIST_ID) || detailRef.current.activePane === 'episodes') {
            store.activate(SEASONS_LIST_ID);
            onDetailChangeRef.current({ ...detailRef.current, activePane: 'seasons' });
          } else {
            onBackRef.current();
          }
        } else if (intent.kind === 'key' && intent.event.kind === 'press') {
          if (
            intent.event.key === 'right' &&
            store.isActive(SEASONS_LIST_ID) &&
            episodesRef.current.length > 0
          ) {
            store.activate(EPISODES_LIST_ID);
            onDetailChangeRef.current({ ...detailRef.current, activePane: 'episodes' });
          } else if (intent.event.key === 'left' && store.isActive(EPISODES_LIST_ID)) {
            store.activate(SEASONS_LIST_ID);
            onDetailChangeRef.current({ ...detailRef.current, activePane: 'seasons' });
          }
        }
      }
    },
    [activateEpisode, store],
  );

  const formatSeason = (season: SeasonRow | undefined) =>
    season === undefined
      ? i18n.t('browse.loading')
      : i18n.t('series.seasonCount', { season: season.season, count: season.episodeCount });

  const formatEp = (ep: EpisodeRow | undefined, idx: number) =>
    ep === undefined
      ? i18n.t('browse.loading')
      : formatEpisodeLabel(ep, idx, detail.series.name, i18n.t).rowText;

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
        onSelectIndex={(idx) =>
          onDetailChange({
            ...detail,
            selectedSeasonIndex: idx,
            selectedEpisodeIndex: 0,
            activePane: 'seasons',
          })
        }
        onActivateIndex={(idx) =>
          onDetailChange({
            ...detail,
            selectedSeasonIndex: idx,
            selectedEpisodeIndex: 0,
            activePane: isPhone ? 'episodes' : (detail.activePane ?? 'seasons'),
          })
        }
        renderRow={(s, active) => (
          <PlainListRow text={formatSeason(s)} active={active} isTv={isTv} />
        )}
        rowLabel={(s) => formatSeason(s)}
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
            onPress={() => onDetailChange({ ...detail, activePane: 'seasons' })}
          />
        ) : null}
      </View>
      {episodesLoading || episodes.length === 0 ? (
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
          onSelectIndex={(idx) =>
            onDetailChange({
              ...detail,
              selectedSeasonIndex: safeSeasonIdx,
              selectedEpisodeIndex: idx,
              activePane: 'episodes',
            })
          }
          onActivateIndex={activateEpisode}
          renderRow={(ep, active, idx) => (
            <PlainListRow text={formatEp(ep, idx)} active={active} isTv={isTv} />
          )}
          rowLabel={formatEp}
          testID="series-episodes-list"
        />
      )}
    </View>
  );

  return (
    <View style={[browseStyles.root, isTv ? browseStyles.rootTv : browseStyles.rootPointer]}>
      {isTv && isActiveScope ? <BrowseTvKeyBridge onEvent={handleTvKey} /> : null}
      {seasonsState.kind !== 'ready' || seasons.length === 0 ? (
        <SeriesStatusBox
          isTv={isTv}
          state={seasonsState.kind === 'ready' ? { kind: 'empty' } : seasonsState}
          onBackToSeries={onBackToSeries}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      ) : isPhone ? (
        activePane === 'episodes' ? (
          episodesPane
        ) : (
          seasonsPane
        )
      ) : (
        <View style={browseStyles.splitRow}>
          {seasonsPane}
          {episodesPane}
        </View>
      )}
    </View>
  );
}
