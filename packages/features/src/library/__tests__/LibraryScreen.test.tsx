import type {
  CatalogService,
  FavoriteRow,
  ItemRow,
  RatingRow,
  SeriesUnplayedSummary,
  WatchProgressRow,
} from '@elv/data';
import { type DownloadManagerPort, type DownloadRecord, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  createTvRemoteDispatcher,
  I18nProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { DownloadsProvider } from '../../shared';
import { LibraryScreen } from '../LibraryScreen';

function makeDownload(overrides: Partial<DownloadRecord>): DownloadRecord {
  return {
    id: 'dl-1',
    profileId: 'default',
    sourceId: 'src-1',
    itemKey: 'movie:src-1:1',
    kind: 'movie',
    title: 'Saved Movie',
    seriesTitle: null,
    season: null,
    episodeNum: null,
    poster: 'https://img.example/poster.jpg',
    localFileName: 'saved.mp4',
    localUri: 'file:///downloads/saved.mp4',
    bytesDownloaded: 500_000_000,
    totalBytes: 500_000_000,
    status: 'completed',
    createdAt: 1000,
    updatedAt: 2000,
    completedAt: 2000,
    ...overrides,
  };
}

function createMockManager(
  records: readonly DownloadRecord[],
  supported = true,
): DownloadManagerPort {
  return {
    supported,
    list: jest.fn(async () => records),
    get: jest.fn(async (key) => records.find((r) => r.itemKey === key) ?? null),
    enqueue: jest.fn(async () => ok(records[0] as DownloadRecord)),
    pause: jest.fn(async () => ok(undefined)),
    resume: jest.fn(async () => ok(undefined)),
    cancel: jest.fn(async () => ok(undefined)),
    remove: jest.fn(async () => ok(undefined)),
    notifyOnlinePlaybackActive: jest.fn(),
    subscribe: jest.fn(() => () => {}),
  };
}

function createMockCatalog(overrides?: Partial<CatalogService>): CatalogService {
  return {
    addSource: jest.fn(),
    addSourceFromLink: jest.fn(),
    removeSource: jest.fn(),
    importSource: jest.fn(),
    listSources: jest.fn(async () => []),
    categories: jest.fn(async () => []),
    items: jest.fn(async () => []),
    seasons: jest.fn(async () => ok([])),
    episodes: jest.fn(async () => []),
    resolveStream: jest.fn(),
    listFavorites: jest.fn(async () => []),
    listRatings: jest.fn(async () => []),
    listWatched: jest.fn(async () => []),
    listCollections: jest.fn(async () => []),
    listCollectionItems: jest.fn(async () => []),
    listMyListNewEpisodes: jest.fn(async () => []),
    listSeriesUnplayedCounts: jest.fn(async () => []),
    refreshMyListNewEpisodes: jest.fn(async () =>
      ok({ checkedSeriesCount: 0, newlyDetectedCount: 0 }),
    ),
    setFavorite: jest.fn(async (_input, active) => ok(active)),
    setRating: jest.fn(async (_input, value) => ok(value)),
    setWatched: jest.fn(async () => ok(undefined)),
    close: jest.fn(async () => {}),
    ...overrides,
  } as unknown as CatalogService;
}

async function wrap(
  ui: ReactNode,
  opts?: {
    readonly manager?: DownloadManagerPort;
    readonly isTv?: boolean;
    readonly dispatcher?: ReturnType<typeof createTvRemoteDispatcher>;
  },
) {
  const i18n = createAppI18n('en');
  const isTv = opts?.isTv ?? false;
  const content = (
    <ViewportProvider
      value={{
        width: 1280,
        height: 720,
        formFactor: isTv ? 'tv' : 'desktop',
        inputModality: isTv ? 'tv' : 'pointer',
      }}
    >
      <ThemeProvider>
        <I18nProvider i18n={i18n}>
          <DownloadsProvider {...(opts?.manager !== undefined ? { manager: opts.manager } : {})}>
            {ui}
          </DownloadsProvider>
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>
  );
  return render(
    opts?.dispatcher ? (
      <TvRemoteProvider dispatcher={opts.dispatcher}>{content}</TvRemoteProvider>
    ) : (
      content
    ),
  );
}

describe('LibraryScreen', () => {
  it('renders Following tab rails (Live TV, Series, Movies, Collections) and supports See all drill-down', async () => {
    const favorites: FavoriteRow[] = [
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'live:s1:1',
        kind: 'live',
        title: 'BBC World',
        logo: null,
        year: null,
        rating: null,
        addedAt: 100,
        sortOrder: 0,
      },
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'series:s1:10',
        kind: 'series',
        title: 'Arcane',
        logo: null,
        year: 2021,
        rating: 9.0,
        addedAt: 200,
      },
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'movie:s1:20',
        kind: 'movie',
        title: 'Dune',
        logo: null,
        year: 2021,
        rating: 8.1,
        addedAt: 300,
      },
    ];
    const catalog = createMockCatalog({
      listFavorites: jest.fn(async () => favorites),
      listCollections: jest.fn(async () => [
        {
          id: 'col-1',
          profileId: 'default',
          name: 'Sci-Fi Picks',
          sortOrder: 0,
          itemCount: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      listCollectionItems: jest.fn(async () => [
        {
          id: 1,
          key: 'movie:s1:99',
          sourceId: 's1',
          providerId: '99',
          kind: 'movie',
          name: 'Arrival',
          logo: null,
          num: null,
          year: 2016,
          rating: 7.9,
        } satisfies ItemRow,
      ]),
    });
    const onPlay = jest.fn();
    const onOpenDetail = jest.fn();

    await wrap(
      <LibraryScreen
        catalog={catalog}
        sources={[]}
        refreshToken={0}
        onPlay={onPlay}
        onOpenDetail={onOpenDetail}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('library-rail-live')).toBeTruthy();
      expect(screen.getByTestId('library-rail-series')).toBeTruthy();
      expect(screen.getByTestId('library-rail-movies')).toBeTruthy();
      expect(screen.getByTestId('library-rail-collection-col-1')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('library-card-live-live:s1:1'));
    expect(onPlay).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: 'live:s1:1', kind: 'live' }),
    );

    await fireEvent.press(screen.getByTestId('library-card-movies-movie:s1:20'));
    expect(onOpenDetail).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: 'movie:s1:20', kind: 'movie' }),
    );

    // See all drill-down and Back
    await fireEvent.press(screen.getByTestId('library-see-all-movies'));
    expect(screen.getByTestId('library-see-all-grid-movies')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('library-see-all-back'));
    expect(screen.queryByTestId('library-see-all-grid-movies')).toBeNull();
  });

  it('switches to Likes tab and optimistically updates rails on context menu rating toggle', async () => {
    const ratings: RatingRow[] = [
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'movie:s1:1',
        kind: 'movie',
        value: 'like',
        title: 'Arrival',
        logo: null,
        year: 2016,
        rating: 7.9,
        updatedAt: 200,
      },
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'series:s1:2',
        kind: 'series',
        value: 'dislike',
        title: 'Bad Show',
        logo: null,
        year: 2020,
        rating: 4.1,
        updatedAt: 100,
      },
    ];
    const setRating = jest.fn(async (_input, val) => ok(val));
    const catalog = createMockCatalog({
      listRatings: jest.fn(async () => ratings),
      setRating,
    });

    await wrap(
      <LibraryScreen
        catalog={catalog}
        sources={[]}
        refreshToken={0}
        onPlay={jest.fn()}
        onOpenDetail={jest.fn()}
      />,
    );

    await fireEvent.press(await screen.findByTestId('library-tab-likes'));
    await waitFor(() => {
      expect(screen.getByTestId('library-rail-liked')).toBeTruthy();
      expect(screen.getByTestId('library-rail-disliked')).toBeTruthy();
    });

    // Long-press Liked card -> Remove like optimistically removes from Liked rail
    await fireEvent(screen.getByTestId('library-card-liked-movie:s1:1'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('library-context-like')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('library-context-like'));

    await waitFor(() => {
      expect(screen.queryByTestId('library-rail-liked')).toBeNull();
    });
    expect(setRating).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: 'movie:s1:1', kind: 'movie' }),
      null,
    );
  });

  it('switches to Watched tab and optimistically removes title on Mark as unwatched', async () => {
    const watchedMovies: WatchProgressRow[] = [
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'movie:s1:5',
        kind: 'movie',
        title: 'Blade Runner',
        subtitle: null,
        logo: null,
        seriesKey: null,
        season: null,
        episode: null,
        positionMs: 7200_000,
        durationMs: 7200_000,
        watched: true,
        updatedAt: 500,
      },
    ];
    const setWatched = jest.fn(async () => ok(undefined));
    const catalog = createMockCatalog({
      listWatched: jest.fn(async (_limit, _pid, opts) =>
        opts?.kind === 'movie' ? watchedMovies : [],
      ),
      setWatched,
    });

    await wrap(
      <LibraryScreen
        catalog={catalog}
        sources={[]}
        refreshToken={0}
        onPlay={jest.fn()}
        onOpenDetail={jest.fn()}
      />,
    );

    await fireEvent.press(await screen.findByTestId('library-tab-watched'));
    await waitFor(() => {
      expect(screen.getByTestId('library-rail-watched-movies')).toBeTruthy();
    });

    await fireEvent(screen.getByTestId('library-card-watched-movies-movie:s1:5'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('library-context-watched')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('library-context-watched'));

    await waitFor(() => {
      expect(screen.getByTestId('library-empty-watched')).toBeTruthy();
    });
    expect(setWatched).toHaveBeenCalledWith('movie:s1:5', false);
  });

  it('renders Downloads tab with active strip, movies rail, grouped series X/Y count, background refresh, and episode drill-down', async () => {
    const activeRec = makeDownload({
      id: 'dl-active',
      itemKey: 'movie:s1:99',
      title: 'Downloading Film',
      status: 'downloading',
      localUri: null,
      bytesDownloaded: 200_000_000,
      totalBytes: 1_000_000_000,
    });
    const movieRec = makeDownload({
      id: 'dl-movie',
      itemKey: 'movie:s1:1',
      title: 'Offline Dune',
      localUri: 'file:///dl/dune.mp4',
      totalBytes: 500_000_000,
    });
    const ep1 = makeDownload({
      id: 'dl-ep1',
      sourceId: 's1',
      itemKey: 'x:s1:episode:42:1:1',
      kind: 'episode',
      title: 'Pilot',
      seriesTitle: 'Severance',
      season: 1,
      episodeNum: 1,
      localUri: 'file:///dl/s1e1.mp4',
      totalBytes: 250_000_000,
    });
    const ep2 = makeDownload({
      id: 'dl-ep2',
      sourceId: 's1',
      itemKey: 'x:s1:episode:42:1:2',
      kind: 'episode',
      title: 'Half Loop',
      seriesTitle: 'Severance',
      season: 1,
      episodeNum: 2,
      localUri: 'file:///dl/s1e2.mp4',
      totalBytes: 250_000_000,
    });

    const unplayed: SeriesUnplayedSummary[] = [
      { seriesKey: 'x:s1:series:42', total: 11, unplayed: 4, watched: false },
    ];
    const refreshMyListNewEpisodes = jest.fn(async () =>
      ok({ checkedSeriesCount: 1, newlyDetectedCount: 0 }),
    );
    const catalog = createMockCatalog({
      listSeriesUnplayedCounts: jest.fn(async () => unplayed),
      refreshMyListNewEpisodes,
    });
    const manager = createMockManager([activeRec, movieRec, ep2, ep1], true);
    const onPlay = jest.fn();
    const onOpenDetail = jest.fn();

    await wrap(
      <LibraryScreen
        catalog={catalog}
        sources={[]}
        refreshToken={0}
        isPlaybackActive={false}
        onPlay={onPlay}
        onOpenDetail={onOpenDetail}
      />,
      { manager },
    );

    await fireEvent.press(await screen.findByTestId('library-tab-downloads'));

    await waitFor(() => {
      expect(screen.getByTestId('library-downloads-storage-badge')).toBeTruthy();
      expect(screen.getByTestId('library-downloads-active-strip')).toBeTruthy();
      expect(screen.getByTestId('library-rail-downloaded-movies')).toBeTruthy();
      expect(screen.getByTestId('library-rail-downloaded-series')).toBeTruthy();
      expect(screen.getByText('2 / 11 episodes downloaded')).toBeTruthy();
    });

    expect(refreshMyListNewEpisodes).toHaveBeenCalledWith(undefined, {
      extraSeriesKeys: ['x:s1:series:42'],
    });

    // Click downloaded movie -> plays offline with isLocalOffline: true
    await fireEvent.press(screen.getByTestId('library-card-downloaded-movies-dl-movie'));
    expect(onPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'movie:s1:1',
        isLocalOffline: true,
        localFileUri: 'file:///dl/dune.mp4',
      }),
    );

    // Click grouped series -> drills into downloaded episodes view
    await fireEvent.press(screen.getByTestId('library-card-downloaded-series-x:s1:series:42'));
    await waitFor(() => {
      expect(screen.getByTestId('library-downloaded-series-view-x:s1:series:42')).toBeTruthy();
      expect(screen.getByTestId('library-downloaded-episode-row-x:s1:episode:42:1:1')).toBeTruthy();
      expect(screen.getByTestId('library-downloaded-episode-row-x:s1:episode:42:1:2')).toBeTruthy();
    });

    await fireEvent.press(
      screen.getByTestId('library-downloaded-episode-body-x:s1:episode:42:1:1'),
    );
    expect(onPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'x:s1:episode:42:1:1',
        isLocalOffline: true,
        localFileUri: 'file:///dl/s1e1.mp4',
      }),
    );

    // Go to details button
    await fireEvent.press(screen.getByTestId('library-series-downloads-detail'));
    expect(onOpenDetail).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: 'x:s1:series:42', kind: 'series' }),
    );

    // Back returns to Downloads tab
    await fireEvent.press(screen.getByTestId('library-series-downloads-back'));
    expect(screen.queryByTestId('library-downloaded-series-view-x:s1:series:42')).toBeNull();
  });

  it('supports 10-ft TV D-pad navigation across sub-tabs and rails', async () => {
    const favorites: FavoriteRow[] = [
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'live:s1:1',
        kind: 'live',
        title: 'BBC World',
        logo: null,
        year: null,
        rating: null,
        addedAt: 100,
      },
    ];
    const catalog = createMockCatalog({
      listFavorites: jest.fn(async () => favorites),
    });
    const dispatcher = createTvRemoteDispatcher();
    const onPlay = jest.fn();
    const onFocusTopNav = jest.fn();

    await wrap(
      <LibraryScreen
        catalog={catalog}
        sources={[]}
        refreshToken={0}
        onPlay={onPlay}
        onOpenDetail={jest.fn()}
        onFocusTopNav={onFocusTopNav}
      />,
      { isTv: true, dispatcher },
    );

    await waitFor(() => {
      expect(screen.getByTestId('library-rail-live')).toBeTruthy();
    });

    // Down enters first rail, Select plays focused live channel
    await act(async () => {
      dispatcher.dispatch({ key: 'down', action: 'press', time: 10 }, false);
    });
    await act(async () => {
      dispatcher.dispatch({ key: 'select', action: 'press', time: 20 }, false);
    });
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ itemKey: 'live:s1:1' }));

    // Back returns to tabs, Back again focuses top nav
    await act(async () => {
      dispatcher.dispatch({ key: 'back', action: 'press', time: 30 }, false);
    });
    await act(async () => {
      dispatcher.dispatch({ key: 'back', action: 'press', time: 40 }, false);
    });
    expect(onFocusTopNav).toHaveBeenCalledTimes(1);
  });

  it('offers Go to details in downloaded-episode context menu (pointer long-press and 10-ft TV D-pad) navigating to parent series detail', async () => {
    const ep1 = makeDownload({
      id: 'dl-ep1',
      sourceId: 's1',
      itemKey: 'x:s1:episode:42:1:1',
      kind: 'episode',
      title: 'Pilot',
      seriesTitle: 'Severance',
      season: 1,
      episodeNum: 1,
      localUri: 'file:///dl/s1e1.mp4',
    });
    const catalog = createMockCatalog();
    const manager = createMockManager([ep1], true);
    const onOpenDetail = jest.fn();

    await wrap(
      <LibraryScreen
        catalog={catalog}
        sources={[]}
        refreshToken={0}
        onPlay={jest.fn()}
        onOpenDetail={onOpenDetail}
      />,
      { manager },
    );

    await fireEvent.press(await screen.findByTestId('library-tab-downloads'));
    await waitFor(() => {
      expect(screen.getByTestId('library-card-downloaded-series-x:s1:series:42')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('library-card-downloaded-series-x:s1:series:42'));
    await waitFor(() => {
      expect(
        screen.getByTestId('library-downloaded-episode-body-x:s1:episode:42:1:1'),
      ).toBeTruthy();
    });

    await fireEvent(
      screen.getByTestId('library-downloaded-episode-body-x:s1:episode:42:1:1'),
      'longPress',
    );
    await waitFor(() => {
      expect(screen.getByTestId('library-context-detail')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('library-context-detail'));
    expect(onOpenDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'x:s1:series:42',
        sourceId: 's1',
        kind: 'series',
        title: 'Severance',
      }),
    );

    // Also verify 10-ft TV D-pad menu trigger on downloaded episode offers Go to details
    const dispatcher = createTvRemoteDispatcher();
    const onOpenDetailTv = jest.fn();
    const tvView = await wrap(
      <LibraryScreen
        catalog={catalog}
        sources={[]}
        refreshToken={0}
        onPlay={jest.fn()}
        onOpenDetail={onOpenDetailTv}
      />,
      { manager, isTv: true, dispatcher },
    );
    await fireEvent.press(await tvView.findByTestId('library-tab-downloads'));
    await waitFor(() => {
      expect(tvView.getByTestId('library-card-downloaded-series-x:s1:series:42')).toBeTruthy();
    });
    await fireEvent.press(tvView.getByTestId('library-card-downloaded-series-x:s1:series:42'));
    await waitFor(() => {
      expect(
        tvView.getByTestId('library-downloaded-episode-body-x:s1:episode:42:1:1'),
      ).toBeTruthy();
    });
    await act(async () => {
      dispatcher.dispatch({ key: 'menu', action: 'press', time: 100 }, false);
    });
    await waitFor(() => {
      expect(tvView.getByTestId('library-context-detail')).toBeTruthy();
    });
    await fireEvent.press(tvView.getByTestId('library-context-detail'));
    expect(onOpenDetailTv).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'x:s1:series:42',
        sourceId: 's1',
        kind: 'series',
        title: 'Severance',
      }),
    );
  });

  it('retries failed extra-series refresh and refreshes newly downloaded series keys without re-fetching already refreshed keys', async () => {
    const ep1 = makeDownload({
      id: 'dl-ep1',
      sourceId: 's1',
      itemKey: 'x:s1:episode:42:1:1',
      kind: 'episode',
      title: 'Pilot',
      seriesTitle: 'Severance',
      season: 1,
      episodeNum: 1,
      localUri: 'file:///dl/s1e1.mp4',
    });
    const ep2 = makeDownload({
      id: 'dl-ep2',
      sourceId: 's1',
      itemKey: 'x:s1:episode:99:1:1',
      kind: 'episode',
      title: 'Opening',
      seriesTitle: 'Silo',
      season: 1,
      episodeNum: 1,
      localUri: 'file:///dl/silo1.mp4',
    });

    let records: DownloadRecord[] = [ep1];
    const listeners = new Set<(next: readonly DownloadRecord[]) => void>();
    const manager: DownloadManagerPort = {
      supported: true,
      list: jest.fn(async () => records),
      get: jest.fn(async (key) => records.find((r) => r.itemKey === key) ?? null),
      enqueue: jest.fn(async () => ok(ep1)),
      pause: jest.fn(async () => ok(undefined)),
      resume: jest.fn(async () => ok(undefined)),
      cancel: jest.fn(async () => ok(undefined)),
      remove: jest.fn(async () => ok(undefined)),
      notifyOnlinePlaybackActive: jest.fn(),
      subscribe: jest.fn((cb) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      }),
    };

    let attempt = 0;
    const refreshMyListNewEpisodes = jest.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('transient network failure');
      }
      return ok({ checkedSeriesCount: 1, newlyDetectedCount: 0 });
    });
    const catalog = createMockCatalog({
      refreshMyListNewEpisodes,
    });

    await wrap(
      <LibraryScreen
        catalog={catalog}
        sources={[]}
        refreshToken={0}
        isPlaybackActive={false}
        onPlay={jest.fn()}
        onOpenDetail={jest.fn()}
      />,
      { manager },
    );

    // 1st visit to Downloads: fails transiently -> must NOT mark series 42 as refreshed
    await fireEvent.press(await screen.findByTestId('library-tab-downloads'));
    await waitFor(() => {
      expect(refreshMyListNewEpisodes).toHaveBeenCalledTimes(1);
    });
    expect(refreshMyListNewEpisodes).toHaveBeenNthCalledWith(1, undefined, {
      extraSeriesKeys: ['x:s1:series:42'],
    });

    // Leave and revisit Downloads: retries series 42 and succeeds
    await fireEvent.press(screen.getByTestId('library-tab-following'));
    await fireEvent.press(screen.getByTestId('library-tab-downloads'));
    await waitFor(() => {
      expect(refreshMyListNewEpisodes).toHaveBeenCalledTimes(2);
    });
    expect(refreshMyListNewEpisodes).toHaveBeenNthCalledWith(2, undefined, {
      extraSeriesKeys: ['x:s1:series:42'],
    });

    // A second series is downloaded later in the session -> refreshes ONLY the new key
    records = [ep1, ep2];
    await act(async () => {
      for (const listener of listeners) listener(records);
    });
    await waitFor(() => {
      expect(refreshMyListNewEpisodes).toHaveBeenCalledTimes(3);
    });
    expect(refreshMyListNewEpisodes).toHaveBeenNthCalledWith(3, undefined, {
      extraSeriesKeys: ['x:s1:series:99'],
    });
  });
});
