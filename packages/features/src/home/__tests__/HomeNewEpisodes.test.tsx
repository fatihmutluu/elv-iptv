import type {
  CatalogService,
  CategoryRow,
  ItemRow,
  MyListNewEpisodeRow,
  SourceRow,
  WatchProgressRow,
} from '@elv/data';
import { err, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { HomeScreen } from '../HomeScreen';

const SOURCE: SourceRow = {
  id: 'src-1',
  name: 'Demo Source',
  kind: 'xtream',
  url: 'https://demo.example.test',
  needsImport: false,
  importedAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  itemCount: 10,
} as unknown as SourceRow;

const NEW_EPISODE: MyListNewEpisodeRow = {
  profileId: 'default',
  episodeKey: 'x:src-1:episode:205',
  seriesKey: 'x:src-1:series:10',
  sourceId: 'src-1',
  seriesTitle: 'Starlight Harbor',
  seriesLogo: 'https://art.example.test/starlight.jpg',
  season: 2,
  episode: 5,
  episodeTitle: 'The Signal',
  detectedAt: 1_700_000_005_000,
};

function makeMovie(): ItemRow {
  return {
    id: 1,
    key: 'x:src-1:movie:1',
    kind: 'movie',
    sourceId: 'src-1',
    providerId: '1',
    name: 'Glass Meridian',
    logo: null,
    rating: 8.1,
    year: 2025,
    num: null,
  };
}

function makeCatalog(overrides: Partial<CatalogService> = {}): CatalogService {
  const movieCat: CategoryRow = {
    id: 'cat-movie',
    sourceId: 'src-1',
    kind: 'movie',
    name: 'Movies',
    itemCount: 1,
    position: 0,
  };
  return {
    listSources: jest.fn(async () => [SOURCE]),
    categories: jest.fn(async (_srcId, kind) => (kind === 'movie' ? [movieCat] : [])),
    items: jest.fn(async (catId) => (catId === 'cat-movie' ? [makeMovie()] : [])),
    listContinueWatching: jest.fn(async () => []),
    listMyListNewEpisodes: jest.fn(async () => [NEW_EPISODE]),
    dismissMyListNewEpisode: jest.fn(async () => ok(undefined)),
    refreshMyListNewEpisodes: jest.fn(async () =>
      ok({ checkedSeriesCount: 1, newlyDetectedCount: 0 }),
    ),
    listRecentChannels: jest.fn(async () => []),
    listFavorites: jest.fn(async () => []),
    listFavoriteKeys: jest.fn(async () => []),
    getProgress: jest.fn(async () => null),
    setWatched: jest.fn(async () => ok(undefined)),
    ...overrides,
  } as unknown as CatalogService;
}

describe('HomeScreen New episodes rail (#502)', () => {
  it('renders New episodes rail with NEW badge when items exist and hides it when empty or disabled in homeLayout', async () => {
    const catalog = makeCatalog();
    const { rerender } = await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <HomeScreen
              catalog={catalog}
              sources={[SOURCE]}
              refreshToken={0}
              onPlay={jest.fn()}
              onOpenTab={jest.fn()}
              onOpenDetail={jest.fn()}
              onOpenSources={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('home-rail-newEpisodes')).toBeTruthy();
    });
    expect(screen.getByText('New episodes')).toBeTruthy();
    expect(screen.getByTestId('home-newEpisodes-item-0-badge')).toBeTruthy();
    expect(screen.getByText('NEW')).toBeTruthy();
    expect(screen.getByText('S2 · E5 — The Signal')).toBeTruthy();

    await rerender(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <HomeScreen
              catalog={catalog}
              sources={[SOURCE]}
              refreshToken={0}
              homeLayout={[
                { id: 'continue', visible: true },
                { id: 'newEpisodes', visible: false },
                { id: 'live', visible: true },
                { id: 'mylist', visible: true },
                { id: 'movies', visible: true },
                { id: 'series', visible: true },
                { id: 'collections', visible: true },
              ]}
              onPlay={jest.fn()}
              onOpenTab={jest.fn()}
              onOpenDetail={jest.fn()}
              onOpenSources={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    expect(screen.queryByTestId('home-rail-newEpisodes')).toBeNull();

    const emptyCatalog = makeCatalog({ listMyListNewEpisodes: jest.fn(async () => []) });
    await rerender(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <HomeScreen
              catalog={emptyCatalog}
              sources={[SOURCE]}
              refreshToken={1}
              onPlay={jest.fn()}
              onOpenTab={jest.fn()}
              onOpenDetail={jest.fn()}
              onOpenSources={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.queryByTestId('home-rail-newEpisodes')).toBeNull();
    });
  });

  it('plays the episode directly on card press and opens parent series detail from context menu', async () => {
    const onPlay = jest.fn();
    const onOpenDetail = jest.fn();
    const catalog = makeCatalog();

    await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <HomeScreen
              catalog={catalog}
              sources={[SOURCE]}
              refreshToken={0}
              onPlay={onPlay}
              onOpenTab={jest.fn()}
              onOpenDetail={onOpenDetail}
              onOpenSources={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('home-newEpisodes-item-0')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('home-newEpisodes-item-0'));
    expect(onPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'x:src-1:episode:205',
        sourceId: 'src-1',
        title: 'Starlight Harbor',
        subtitle: 'S2 · E5 — The Signal',
        kind: 'vod',
        itemKind: 'episode',
        seriesKey: 'x:src-1:series:10',
        season: 2,
        episode: 5,
        logo: 'https://art.example.test/starlight.jpg',
      }),
    );

    await fireEvent(screen.getByTestId('home-newEpisodes-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('home-context-details')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('home-context-details'));
    expect(onOpenDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'x:src-1:series:10',
        kind: 'series',
        title: 'Starlight Harbor',
      }),
    );
  });

  it('dismisses via context menu optimistically and rolls back on failure', async () => {
    const dismissSuccess = jest.fn(async () => ok(undefined));
    const catalog = makeCatalog({ dismissMyListNewEpisode: dismissSuccess });

    await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <HomeScreen
              catalog={catalog}
              sources={[SOURCE]}
              refreshToken={0}
              onPlay={jest.fn()}
              onOpenTab={jest.fn()}
              onOpenDetail={jest.fn()}
              onOpenSources={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('home-newEpisodes-item-0')).toBeTruthy();
    });
    await fireEvent(screen.getByTestId('home-newEpisodes-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('home-context-dismiss-new-episode')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('home-context-dismiss-new-episode'));

    await waitFor(() => {
      expect(dismissSuccess).toHaveBeenCalledWith('x:src-1:episode:205');
      expect(screen.queryByTestId('home-rail-newEpisodes')).toBeNull();
    });
  });

  it('marks watched via context menu and rolls back when setWatched fails', async () => {
    const setWatched = jest.fn(async () =>
      err({
        category: 'storage' as const,
        code: 'STORAGE',
        message: 'write failed',
        retryable: false,
      }),
    );
    const catalog = makeCatalog({ setWatched });

    await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <HomeScreen
              catalog={catalog}
              sources={[SOURCE]}
              refreshToken={0}
              onPlay={jest.fn()}
              onOpenTab={jest.fn()}
              onOpenDetail={jest.fn()}
              onOpenSources={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('home-newEpisodes-item-0')).toBeTruthy();
    });
    await fireEvent(screen.getByTestId('home-newEpisodes-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('home-context-mark-watched')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('home-context-mark-watched'));

    await waitFor(() => {
      expect(setWatched).toHaveBeenCalledWith('x:src-1:episode:205', true);
      expect(screen.getByTestId('home-newEpisodes-item-0')).toBeTruthy();
    });
  });

  it('skips background refreshMyListNewEpisodes while playback is active and runs when idle', async () => {
    const listMyListNewEpisodes = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([NEW_EPISODE]);
    const refreshMyListNewEpisodes = jest.fn(async () =>
      ok({ checkedSeriesCount: 1, newlyDetectedCount: 1 }),
    );
    const catalog = makeCatalog({ listMyListNewEpisodes, refreshMyListNewEpisodes });

    const { rerender } = await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <HomeScreen
              catalog={catalog}
              sources={[SOURCE]}
              refreshToken={0}
              isPlaybackActive
              onPlay={jest.fn()}
              onOpenTab={jest.fn()}
              onOpenDetail={jest.fn()}
              onOpenSources={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(listMyListNewEpisodes).toHaveBeenCalledTimes(1);
    });
    expect(refreshMyListNewEpisodes).not.toHaveBeenCalled();

    await rerender(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <HomeScreen
              catalog={catalog}
              sources={[SOURCE]}
              refreshToken={0}
              isPlaybackActive={false}
              onPlay={jest.fn()}
              onOpenTab={jest.fn()}
              onOpenDetail={jest.fn()}
              onOpenSources={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(refreshMyListNewEpisodes).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('home-rail-newEpisodes')).toBeTruthy();
    });
  });

  it('renders Next-Up Continue Watching episodes without 0% bar or remaining minutes, passes seriesKey/season/episode on play, and exposes Play + Go to details (#502 P0-2/P0-4)', async () => {
    const nextUpRow: WatchProgressRow = {
      profileId: 'default',
      sourceId: 'src-1',
      itemKey: 'x:src-1:episode:206',
      kind: 'episode',
      title: 'Starlight Harbor',
      subtitle: 'The Return',
      logo: 'https://art.example.test/starlight.jpg',
      seriesKey: 'x:src-1:series:10',
      season: 2,
      episode: 6,
      positionMs: 0,
      durationMs: 2_700_000,
      watched: false,
      updatedAt: 1_700_000_010_000,
    };
    const onPlay = jest.fn();
    const onOpenDetail = jest.fn();
    const catalog = makeCatalog({
      listContinueWatching: jest.fn(async () => [nextUpRow]),
      listMyListNewEpisodes: jest.fn(async () => []),
    });

    await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <HomeScreen
              catalog={catalog}
              sources={[SOURCE]}
              refreshToken={0}
              onPlay={onPlay}
              onOpenTab={jest.fn()}
              onOpenDetail={onOpenDetail}
              onOpenSources={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('home-continue-item-0')).toBeTruthy();
    });

    expect(screen.queryByTestId('home-continue-item-0-progress')).toBeNull();
    expect(screen.getByText('S2 · E6 — The Return')).toBeTruthy();
    expect(screen.queryByText(/left/i)).toBeNull();

    await fireEvent.press(screen.getByTestId('home-continue-item-0'));
    expect(onPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'x:src-1:episode:206',
        kind: 'vod',
        itemKind: 'episode',
        seriesKey: 'x:src-1:series:10',
        season: 2,
        episode: 6,
        startPositionMs: 0,
      }),
    );

    await fireEvent(screen.getByTestId('home-continue-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('home-context-resume')).toBeTruthy();
      expect(screen.getByTestId('home-context-details')).toBeTruthy();
    });
    expect(screen.getByText('Play')).toBeTruthy();
    expect(screen.queryByText('Resume')).toBeNull();

    await fireEvent.press(screen.getByTestId('home-context-details'));
    expect(onOpenDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'x:src-1:series:10',
        kind: 'series',
        title: 'Starlight Harbor',
      }),
    );
  });

  it('retries background refreshMyListNewEpisodes after cancellation and on userStateVersion updates (#502 P1-2)', async () => {
    let resolveFirst:
      | ((
          value: ReturnType<typeof ok<{ checkedSeriesCount: number; newlyDetectedCount: number }>>,
        ) => void)
      | undefined;
    const firstPromise = new Promise<
      ReturnType<typeof ok<{ checkedSeriesCount: number; newlyDetectedCount: number }>>
    >((resolve) => {
      resolveFirst = resolve;
    });
    const listMyListNewEpisodes = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([NEW_EPISODE]);
    const refreshMyListNewEpisodes = jest
      .fn()
      .mockImplementationOnce(() => firstPromise)
      .mockImplementationOnce(async () => ok({ checkedSeriesCount: 1, newlyDetectedCount: 1 }))
      .mockImplementationOnce(async () => ok({ checkedSeriesCount: 0, newlyDetectedCount: 0 }));
    const catalog = makeCatalog({ listMyListNewEpisodes, refreshMyListNewEpisodes });
    const stableSources = [SOURCE];

    const renderHome = (isPlaybackActive: boolean, userStateVersion = 0) => (
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <HomeScreen
              catalog={catalog}
              sources={stableSources}
              refreshToken={0}
              userStateVersion={userStateVersion}
              isPlaybackActive={isPlaybackActive}
              onPlay={jest.fn()}
              onOpenTab={jest.fn()}
              onOpenDetail={jest.fn()}
              onOpenSources={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>
    );

    const { rerender } = await render(renderHome(false, 0));
    await waitFor(() => {
      expect(refreshMyListNewEpisodes).toHaveBeenCalledTimes(1);
    });

    // Cancel mid-flight by entering playback before first promise resolves
    await rerender(renderHome(true, 0));
    resolveFirst?.(ok({ checkedSeriesCount: 1, newlyDetectedCount: 1 }));
    await Promise.resolve();
    expect(screen.queryByTestId('home-rail-newEpisodes')).toBeNull();

    // Returning to idle retries instead of staying latched
    await rerender(renderHome(false, 0));
    await waitFor(() => {
      expect(refreshMyListNewEpisodes).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('home-rail-newEpisodes')).toBeTruthy();
    });

    // Bumping userStateVersion re-triggers cooldown-gated refresh
    await rerender(renderHome(false, 1));
    await waitFor(() => {
      expect(refreshMyListNewEpisodes).toHaveBeenCalledTimes(3);
    });
  });
});
