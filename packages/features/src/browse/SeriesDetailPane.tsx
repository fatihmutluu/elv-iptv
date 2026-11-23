import type { CatalogService, EpisodeRow, SeasonRow } from '@elv/data';
import type { FocusStore, KeyEvent } from '@elv/focus-core';
import { useFormFactor, useI18n, useTheme } from '@elv/ui-kit';
import {
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { View } from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import { createTwoPaneFocusStore, SeriesStatusBox, syncTwoPaneScopeActive } from './BrowseHelpers';
import {
  BrowseTvKeyBridge,
  browseStyles,
  computeBrowseRowHeight,
  createArrayListSource,
} from './BrowseParts';
import {
  type DescribedBrowseFailure,
  describeCatalogReadFailure,
  formatEpisodeLabel,
  type SeriesDetailState,
} from './browse-model';
import { EPISODES_LIST_ID, SEASONS_LIST_ID, SeriesSeasonsAndEpisodes } from './SeriesParts';

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

interface EpisodesState {
  readonly season: number | null;
  readonly loading: boolean;
  readonly rows: readonly EpisodeRow[];
}

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
  const theme = useTheme();
  const i18n = useI18n();
  const isTv = formFactor === 'tv';
  const isPhone = formFactor === 'phone';
  const rowHeight = computeBrowseRowHeight(isTv, theme.fontScale);

  const [seasonsState, setSeasonsState] = useState<SeasonsState>({ kind: 'loading' });
  const [episodesState, setEpisodesState] = useState<EpisodesState>({
    season: null,
    loading: false,
    rows: [],
  });
  const [retryNonce, setRetryNonce] = useState(0);

  const activePane = detail.activePane ?? 'seasons';
  const seasons = seasonsState.kind === 'ready' ? seasonsState.rows : [];
  const safeSeasonIdx =
    seasons.length > 0
      ? Math.min(Math.max(0, Math.floor(detail.selectedSeasonIndex)), seasons.length - 1)
      : 0;
  const activeSeason = seasons[safeSeasonIdx];
  const episodesLoading =
    seasonsState.kind === 'ready' &&
    activeSeason !== undefined &&
    (episodesState.loading || episodesState.season !== activeSeason.season);
  const episodes =
    activeSeason !== undefined &&
    episodesState.season === activeSeason.season &&
    !episodesState.loading
      ? episodesState.rows
      : [];
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
  const episodesStateRef = useRef(episodesState);
  episodesStateRef.current = episodesState;
  const seasonsStateRef = useRef(seasonsState);
  seasonsStateRef.current = seasonsState;
  const safeSeasonIdxRef = useRef(safeSeasonIdx);
  safeSeasonIdxRef.current = safeSeasonIdx;

  const commitDetail = useCallback((next: SeriesDetailState) => {
    detailRef.current = next;
    onDetailChangeRef.current(next);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryNonce and refreshToken intentionally re-trigger season fetch
  useEffect(() => {
    let cancelled = false;
    setSeasonsState({ kind: 'loading' });
    setEpisodesState({ season: null, loading: false, rows: [] });
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
      setEpisodesState({ season: null, loading: false, rows: [] });
      return undefined;
    }
    let cancelled = false;
    const seasonNum = activeSeason.season;
    setEpisodesState({ season: seasonNum, loading: true, rows: [] });
    catalog.episodes(detail.series.id, seasonNum).then(
      (rows) => {
        if (cancelled) return;
        setEpisodesState({ season: seasonNum, loading: false, rows });
      },
      () => {
        if (!cancelled) {
          setEpisodesState({ season: seasonNum, loading: false, rows: [] });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [activeSeason, catalog, detail.series.id, seasonsState]);

  useLayoutEffect(() => {
    if (!isTv) return;
    if (episodes.length === 0) {
      store.setCount(EPISODES_LIST_ID, 0);
    }
    const targetList =
      activePane === 'episodes' && episodes.length > 0 ? EPISODES_LIST_ID : SEASONS_LIST_ID;
    syncTwoPaneScopeActive(store, isActiveScope, targetList);
  }, [activePane, episodes.length, isActiveScope, isTv, store]);

  const seasonsSource = useMemo(() => createArrayListSource(seasons), [seasons]);
  const episodesSource = useMemo(() => createArrayListSource(episodes), [episodes]);

  const activateEpisode = useCallback(
    (epIndex: number) => {
      const ep = episodesRef.current[epIndex];
      if (ep === undefined) return;
      const cur = detailRef.current;
      commitDetail({
        ...cur,
        selectedSeasonIndex: safeSeasonIdxRef.current,
        selectedEpisodeIndex: epIndex,
        activePane: 'episodes',
      });
      const { playTitle } = formatEpisodeLabel(ep, epIndex, cur.series.name, i18n.t);
      onPlay({ itemKey: ep.key, sourceId: cur.series.sourceId, title: playTitle, kind: 'vod' });
    },
    [commitDetail, i18n.t, onPlay],
  );

  const handleTvKey = useCallback(
    (event: KeyEvent) => {
      const curState = seasonsStateRef.current;
      if (curState.kind !== 'ready' || curState.rows.length === 0) {
        if (event.kind === 'press' && event.key === 'select') {
          if (curState.kind === 'error') setRetryNonce((n) => n + 1);
          else if (curState.kind === 'ready') onBackRef.current();
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
          if (intent.listId === SEASONS_LIST_ID && episodesRef.current.length > 0) {
            store.activate(EPISODES_LIST_ID);
            commitDetail({
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
            commitDetail({ ...detailRef.current, activePane: 'seasons' });
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
            commitDetail({ ...detailRef.current, activePane: 'episodes' });
          } else if (intent.event.key === 'left' && store.isActive(EPISODES_LIST_ID)) {
            store.activate(SEASONS_LIST_ID);
            commitDetail({ ...detailRef.current, activePane: 'seasons' });
          }
        }
      }
    },
    [activateEpisode, commitDetail, store],
  );

  const handleSelectSeason = useCallback(
    (idx: number) => {
      const curSeasons =
        seasonsStateRef.current.kind === 'ready' ? seasonsStateRef.current.rows : [];
      const nextSeason = curSeasons[idx]?.season ?? null;
      if (nextSeason !== episodesStateRef.current.season) {
        episodesRef.current = [];
        store.setCount(EPISODES_LIST_ID, 0);
      }
      commitDetail({
        ...detailRef.current,
        selectedSeasonIndex: idx,
        selectedEpisodeIndex: 0,
        activePane: 'seasons',
      });
    },
    [commitDetail, store],
  );

  const handleActivateSeason = useCallback(
    (idx: number) => {
      commitDetail({
        ...detailRef.current,
        selectedSeasonIndex: idx,
        selectedEpisodeIndex: 0,
        activePane: isPhone ? 'episodes' : (detailRef.current.activePane ?? 'seasons'),
      });
    },
    [commitDetail, isPhone],
  );

  const handleSelectEpisode = useCallback(
    (idx: number) => {
      commitDetail({
        ...detailRef.current,
        selectedSeasonIndex: safeSeasonIdxRef.current,
        selectedEpisodeIndex: idx,
        activePane: 'episodes',
      });
    },
    [commitDetail],
  );

  return (
    <View style={[browseStyles.root, isTv ? browseStyles.rootTv : browseStyles.rootPointer]}>
      {isTv && isActiveScope ? <BrowseTvKeyBridge onEvent={handleTvKey} /> : null}
      {seasonsState.kind !== 'ready' || seasons.length === 0 ? (
        <SeriesStatusBox
          isTv={isTv}
          isActiveScope={isActiveScope}
          state={seasonsState.kind === 'ready' ? { kind: 'empty' } : seasonsState}
          onBackToSeries={onBackToSeries}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      ) : (
        <SeriesSeasonsAndEpisodes
          isTv={isTv}
          isPhone={isPhone}
          rowHeight={rowHeight}
          store={store}
          detail={detail}
          activePane={activePane}
          seasonsSource={seasonsSource}
          episodesSource={episodesSource}
          safeSeasonIdx={safeSeasonIdx}
          safeEpisodeIdx={safeEpisodeIdx}
          episodesLoading={episodesLoading}
          episodesCount={episodes.length}
          onBackToSeries={onBackToSeries}
          onBackToSeasons={() => commitDetail({ ...detailRef.current, activePane: 'seasons' })}
          onSelectSeason={handleSelectSeason}
          onActivateSeason={handleActivateSeason}
          onSelectEpisode={handleSelectEpisode}
          onActivateEpisode={activateEpisode}
        />
      )}
    </View>
  );
}
