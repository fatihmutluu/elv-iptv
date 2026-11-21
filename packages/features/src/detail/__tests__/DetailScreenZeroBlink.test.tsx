import type {
  CatalogService,
  EpisodeRow,
  ItemDetailRow,
  SeasonRow,
  WatchProgressRow,
} from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { CatalogUiCacheProvider, createCatalogUiCache, type DetailTarget } from '../../shared';
import { DetailScreen } from '../DetailScreen';

function makeEpisode(seriesId: number, season: number, epNum: number, title: string): EpisodeRow {
  return {
    id: season * 100 + epNum,
    key: `x:src-1:episode:${seriesId}:${season}:${epNum}`,
    season,
    episode: epNum,
    title,
    durationSec: 2400,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const SERIES_TARGET: DetailTarget = {
  itemKey: 'x:src-1:series:301',
  sourceId: 'src-1',
  kind: 'series',
  title: 'Starlight Harbor',
  posterUri: null,
  backdropUri: null,
  year: 2025,
  rating: 8.9,
  catalogId: 301,
  categoryId: 'src-1|series|20',
};

const MOVIE_TARGET: DetailTarget = {
  itemKey: 'x:src-1:movie:201',
  sourceId: 'src-1',
  kind: 'movie',
  title: 'Neon Horizon',
  posterUri: null,
  backdropUri: null,
  year: 2026,
  rating: 8.6,
  catalogId: 201,
  categoryId: 'src-1|movie|10',
};

const SERIES_DETAIL: ItemDetailRow = {
  id: 301,
  key: SERIES_TARGET.itemKey,
  sourceId: 'src-1',
  providerId: '301',
  kind: 'series',
  name: 'Starlight Harbor',
  logo: null,
  rating: 8.9,
  year: 2025,
  num: null,
  plot: 'Deep space lighthouse mystery.',
};

function createStubCatalog(overrides: Partial<CatalogService> = {}): CatalogService {
  return {
    listSources: jest.fn(async () => []),
    addSource: jest.fn(),
    addSourceFromLink: jest.fn(),
    removeSource: jest.fn(),
    importSource: jest.fn(),
    categories: jest.fn(async () => []),
    items: jest.fn(async () => []),
    itemDetail: jest.fn(async () => SERIES_DETAIL),
    seasons: jest.fn(async () => ok<readonly SeasonRow[]>([])),
    episodes: jest.fn(async () => []),
    resolveStream: jest.fn(),
    listFavoriteKeys: jest.fn(async () => []),
    listProgressByKeys: jest.fn(async () => []),
    getProgress: jest.fn(async () => null),
    setFavorite: jest.fn(async (_input, active) => ok(active)),
    toggleFavorite: jest.fn(async () => ok(true)),
    setWatched: jest.fn(async () => ok(undefined)),
    saveProgress: jest.fn(async () => ok(undefined)),
    close: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as CatalogService;
}

function wrap(ui: React.ReactElement, cache = createCatalogUiCache({ locale: 'en' })) {
  return (
    <ViewportProvider
      value={{
        formFactor: 'desktop',
        orientation: 'landscape',
        inputModality: 'pointer',
        width: 1280,
        height: 800,
      }}
    >
      <ThemeProvider>
        <I18nProvider i18n={createAppI18n('en')}>
          <CatalogUiCacheProvider cache={cache}>{ui}</CatalogUiCacheProvider>
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>
  );
}

describe('DetailScreen zero-blink season switching, player-return preservation & rapid toggles (#445, #230)', () => {
  it('prewarms adjacent seasons for frame-0 switching and keeps previous episodes visible for uncached seasons without skeleton flash', async () => {
    const seasons: SeasonRow[] = [1, 2, 3, 4, 5, 6].map((n) => ({ season: n, episodeCount: 1 }));
    const s6Gate = deferred<EpisodeRow[]>();
    const episodesMock = jest.fn(
      async (seriesId: number, season: number): Promise<EpisodeRow[]> => {
        if (season === 6) return s6Gate.promise;
        return [makeEpisode(seriesId, season, 1, `Season ${season} Opener`)];
      },
    );
    const catalog = createStubCatalog({
      seasons: jest.fn(async () => ok(seasons)),
      episodes: episodesMock,
    });
    const uiCache = createCatalogUiCache({ locale: 'en' });

    const view = await render(
      wrap(
        <DetailScreen
          target={SERIES_TARGET}
          catalog={catalog}
          refreshToken={1}
          onBack={jest.fn()}
          onPlay={jest.fn()}
          onOpenDetail={jest.fn()}
        />,
        uiCache,
      ),
    );

    // Wait for Season 1 and background prewarm of Season 2
    await waitFor(() => {
      expect(screen.getByTestId('detail-episode-0')).toHaveTextContent(/Season 1 Opener/);
      expect(uiCache.getDetail(SERIES_TARGET.itemKey)?.episodesBySeason.has(2)).toBe(true);
    });

    // Switching to prewarmed Season 2 updates synchronously with ZERO skeleton rows
    await fireEvent.press(screen.getByTestId('detail-season-2'));
    expect(screen.queryByTestId('detail-episodes-skeleton')).toBeNull();
    expect(screen.getByTestId('detail-episode-0')).toHaveTextContent(/Season 2 Opener/);

    // Switching to uncached Season 6 keeps Season 2 episodes rendered (ZERO skeleton flash!) until Season 6 resolves
    await fireEvent.press(screen.getByTestId('detail-season-6'));
    expect(screen.queryByTestId('detail-episodes-skeleton')).toBeNull();
    expect(screen.getByTestId('detail-episode-0')).toHaveTextContent(/Season 2 Opener/);

    await act(async () => {
      s6Gate.resolve([makeEpisode(301, 6, 1, 'Season 6 Finale')]);
    });
    await waitFor(() => {
      expect(screen.getByTestId('detail-episode-0')).toHaveTextContent(/Season 6 Finale/);
    });

    await view.unmount();

    // Re-opening the same series hydrates synchronously on frame 0 from CatalogUiCache!
    const blockedSeasons =
      deferred<ReturnType<CatalogService['seasons']> extends Promise<infer R> ? R : never>();
    const blockedCatalog = createStubCatalog({
      seasons: jest.fn(() => blockedSeasons.promise),
      episodes: jest.fn(() => new Promise(() => undefined)),
    });
    const warmView = await render(
      wrap(
        <DetailScreen
          target={SERIES_TARGET}
          catalog={blockedCatalog}
          refreshToken={1}
          onBack={jest.fn()}
          onPlay={jest.fn()}
          onOpenDetail={jest.fn()}
        />,
        uiCache,
      ),
    );
    // Blocked promises never resolve — episodes MUST already be rendered from CatalogUiCache!
    expect(screen.queryByTestId('detail-episodes-skeleton')).toBeNull();
    expect(screen.getByTestId('detail-episode-0')).toHaveTextContent(/Season 6 Finale/);
    await warmView.unmount();
  });

  it('preserves seasons and episodes with zero skeleton blink when returning from Player (userStateVersion bump)', async () => {
    const s1Ep = makeEpisode(301, 1, 1, 'Pilot');
    const seasonsGate =
      deferred<ReturnType<CatalogService['seasons']> extends Promise<infer R> ? R : never>();
    let seasonsCalls = 0;
    const progressGate = deferred<WatchProgressRow[]>();
    let progCalls = 0;

    const catalog = createStubCatalog({
      seasons: jest.fn(async () => {
        seasonsCalls += 1;
        if (seasonsCalls === 1) return ok([{ season: 1, episodeCount: 1 }]);
        return seasonsGate.promise;
      }),
      episodes: jest.fn(async () => [s1Ep]),
      listProgressByKeys: jest.fn(async (): Promise<WatchProgressRow[]> => {
        progCalls += 1;
        if (progCalls === 1) return [];
        return progressGate.promise;
      }),
    });
    const uiCache = createCatalogUiCache({ locale: 'en' });

    const view = await render(
      wrap(
        <DetailScreen
          target={SERIES_TARGET}
          catalog={catalog}
          refreshToken={1}
          userStateVersion={0}
          onBack={jest.fn()}
          onPlay={jest.fn()}
          onOpenDetail={jest.fn()}
        />,
        uiCache,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('detail-episode-0')).toHaveTextContent(/Pilot/);
    });

    // Simulate returning from PlayerScreen -> userStateVersion increments
    await view.rerender(
      wrap(
        <DetailScreen
          target={SERIES_TARGET}
          catalog={catalog}
          refreshToken={1}
          userStateVersion={1}
          onBack={jest.fn()}
          onPlay={jest.fn()}
          onOpenDetail={jest.fn()}
        />,
        uiCache,
      ),
    );

    // Episodes MUST remain rendered with ZERO skeleton blink while revalidation is pending!
    expect(screen.queryByTestId('detail-episodes-skeleton')).toBeNull();
    expect(screen.getByTestId('detail-season-1')).toBeTruthy();
    expect(screen.getByTestId('detail-episode-0')).toHaveTextContent(/Pilot/);

    await act(async () => {
      seasonsGate.resolve(ok([{ season: 1, episodeCount: 1 }]));
      progressGate.resolve([
        {
          profileId: 'default',
          sourceId: 'src-1',
          itemKey: s1Ep.key,
          kind: 'episode',
          title: 'Pilot',
          subtitle: null,
          logo: null,
          seriesKey: SERIES_TARGET.itemKey,
          season: 1,
          episode: 1,
          positionMs: 2400_000,
          durationMs: 2400_000,
          watched: true,
          updatedAt: 500,
        },
      ]);
    });

    await waitFor(() => {
      expect(screen.getByTestId('detail-episode-0-watched')).toBeTruthy();
    });

    await view.unmount();
  });

  it('does not drop rapid My List or Watched presses and dispatches desired state via setFavorite', async () => {
    const firstFav =
      deferred<
        ReturnType<NonNullable<CatalogService['setFavorite']>> extends Promise<infer R> ? R : never
      >();
    const setFavoriteMock = jest.fn(async (_input, active: boolean) => {
      if (setFavoriteMock.mock.calls.length === 1) return firstFav.promise;
      return ok(active);
    });
    const setWatchedMock = jest.fn(async (_itemKey: string, _watched: boolean) => ok(undefined));
    const catalog = createStubCatalog({
      itemDetail: jest.fn(async () => ({
        ...SERIES_DETAIL,
        id: 201,
        key: MOVIE_TARGET.itemKey,
        kind: 'movie' as const,
        name: 'Neon Horizon',
      })),
      setFavorite: setFavoriteMock,
      saveProgress: undefined,
      setWatched: setWatchedMock,
    });

    const view = await render(
      wrap(
        <DetailScreen
          target={MOVIE_TARGET}
          catalog={catalog}
          refreshToken={1}
          onBack={jest.fn()}
          onPlay={jest.fn()}
          onOpenDetail={jest.fn()}
        />,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('detail-mylist')).toBeTruthy();
    });

    // 3 rapid presses: false -> true -> false -> true (NO press dropped!)
    await fireEvent.press(screen.getByTestId('detail-mylist'));
    await fireEvent.press(screen.getByTestId('detail-mylist'));
    await fireEvent.press(screen.getByTestId('detail-mylist'));

    expect(setFavoriteMock).toHaveBeenCalledTimes(3);
    expect(setFavoriteMock.mock.calls.map((c) => c[1])).toEqual([true, false, true]);
    expect(screen.getByTestId('detail-mylist').props.accessibilityState?.selected).toBe(true);

    // 2 rapid Watched presses: false -> true -> false (NO press dropped!)
    await fireEvent.press(screen.getByTestId('detail-watched'));
    await fireEvent.press(screen.getByTestId('detail-watched'));
    expect(setWatchedMock).toHaveBeenCalledTimes(2);
    expect(setWatchedMock.mock.calls.map((c) => c[1])).toEqual([true, false]);

    await act(async () => {
      firstFav.resolve(ok(true));
    });
    await view.unmount();
  });

  it('rolls back even-count rapid toggle failure to committed baseline and preserves ready seasons on transient refresh error', async () => {
    const firstFav = deferred<{ ok: false; error: { category: 'storage'; code: string } }>();
    const secondFav = deferred<{ ok: false; error: { category: 'storage'; code: string } }>();
    let calls = 0;
    const setFavoriteMock = jest.fn(async () => {
      calls += 1;
      return calls === 1 ? firstFav.promise : secondFav.promise;
    });

    const movieCatalog = createStubCatalog({
      itemDetail: jest.fn(async () => ({
        ...SERIES_DETAIL,
        id: 201,
        key: MOVIE_TARGET.itemKey,
        kind: 'movie' as const,
        name: 'Neon Horizon',
      })),
      setFavorite: setFavoriteMock as unknown as CatalogService['setFavorite'],
    });

    const movieView = await render(
      wrap(
        <DetailScreen
          target={MOVIE_TARGET}
          catalog={movieCatalog}
          refreshToken={1}
          onBack={jest.fn()}
          onPlay={jest.fn()}
          onOpenDetail={jest.fn()}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByTestId('detail-mylist')).toBeTruthy());

    // Committed baseline is false. Rapid even-count burst: false -> true -> false. Both fail.
    // Final state MUST roll back to committed false (NOT unpersisted true!).
    await fireEvent.press(screen.getByTestId('detail-mylist'));
    await fireEvent.press(screen.getByTestId('detail-mylist'));
    await act(async () => {
      firstFav.resolve({ ok: false, error: { category: 'storage', code: 'write-failed' } });
      secondFav.resolve({ ok: false, error: { category: 'storage', code: 'write-failed' } });
    });
    expect(screen.getByTestId('detail-mylist').props.accessibilityState?.selected).toBe(false);
    await movieView.unmount();

    // Transient seasons error during background player-return preserves already-ready seasons/episodes
    let seasonCalls = 0;
    const s1Ep = makeEpisode(301, 1, 1, 'Pilot');
    const seriesCatalog = createStubCatalog({
      seasons: jest.fn(async () => {
        seasonCalls += 1;
        if (seasonCalls === 1) return ok([{ season: 1, episodeCount: 1 }]);
        return { ok: false as const, error: { category: 'network' as const, code: 'timeout' } };
      }),
      episodes: jest.fn(async () => [s1Ep]),
    });
    const uiCache = createCatalogUiCache({ locale: 'en' });
    const seriesView = await render(
      wrap(
        <DetailScreen
          target={SERIES_TARGET}
          catalog={seriesCatalog}
          refreshToken={1}
          userStateVersion={0}
          onBack={jest.fn()}
          onPlay={jest.fn()}
          onOpenDetail={jest.fn()}
        />,
        uiCache,
      ),
    );
    await waitFor(() => expect(screen.getByTestId('detail-episode-0')).toHaveTextContent(/Pilot/));

    await seriesView.rerender(
      wrap(
        <DetailScreen
          target={SERIES_TARGET}
          catalog={seriesCatalog}
          refreshToken={1}
          userStateVersion={1}
          onBack={jest.fn()}
          onPlay={jest.fn()}
          onOpenDetail={jest.fn()}
        />,
        uiCache,
      ),
    );
    await waitFor(() => expect(seasonCalls).toBe(2));
    expect(screen.queryByTestId('detail-seasons-error')).toBeNull();
    expect(screen.getByTestId('detail-episode-0')).toHaveTextContent(/Pilot/);
    await seriesView.unmount();
  });
});
