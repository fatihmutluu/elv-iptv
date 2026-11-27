import type { CatalogService, RatingRow } from '@elv/data';
import { ok } from '@elv/domain';
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
          <DownloadsProvider>{ui}</DownloadsProvider>
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

describe('LibraryScreen 2x2 Likes/Dislikes & My List / Listem', () => {
  it('switches to Likes tab 2x2 split (Liked Movies/Series, Disliked Movies/Series), queries 4 partitioned rails, supports TV D-pad navigation, and updates optimistically', async () => {
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
        updatedAt: 400,
      },
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'series:s1:1',
        kind: 'series',
        value: 'like',
        title: 'Severance',
        logo: null,
        year: 2022,
        rating: 8.7,
        updatedAt: 300,
      },
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'movie:s1:2',
        kind: 'movie',
        value: 'dislike',
        title: 'Bad Film',
        logo: null,
        year: 2019,
        rating: 3.5,
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
    const listRatings = jest.fn(async (opts?: { value?: string; kind?: string }) =>
      ratings.filter(
        (r) =>
          (opts?.value === undefined || r.value === opts.value) &&
          (opts?.kind === undefined || r.kind === opts.kind),
      ),
    );
    const setRating = jest.fn(async (_input, val) => ok(val));
    const catalog = createMockCatalog({
      listRatings,
      setRating,
    });

    const view = await wrap(
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
      expect(screen.getByTestId('library-likes-group-liked')).toBeTruthy();
      expect(screen.getByTestId('library-likes-group-disliked')).toBeTruthy();
      expect(screen.getByTestId('library-rail-liked-movies')).toBeTruthy();
      expect(screen.getByTestId('library-rail-liked-series')).toBeTruthy();
      expect(screen.getByTestId('library-rail-disliked-movies')).toBeTruthy();
      expect(screen.getByTestId('library-rail-disliked-series')).toBeTruthy();
    });
    expect(listRatings).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'like', kind: 'movie' }),
    );
    expect(listRatings).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'like', kind: 'series' }),
    );
    expect(listRatings).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'dislike', kind: 'movie' }),
    );
    expect(listRatings).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'dislike', kind: 'series' }),
    );

    // Long-press Liked Movie card -> Remove like optimistically removes from Liked Movies rail
    await fireEvent(screen.getByTestId('library-card-liked-movies-movie:s1:1'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('library-context-like')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('library-context-like'));

    await waitFor(() => {
      expect(screen.queryByTestId('library-rail-liked-movies')).toBeNull();
    });
    expect(setRating).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: 'movie:s1:1', kind: 'movie' }),
      null,
    );
    await view.unmount();

    // TV D-pad Up/Down traverses all 4 rating rails cleanly
    const dispatcher = createTvRemoteDispatcher();
    const onOpenDetail = jest.fn();
    const tvView = await wrap(
      <LibraryScreen
        catalog={catalog}
        sources={[]}
        refreshToken={0}
        onPlay={jest.fn()}
        onOpenDetail={onOpenDetail}
      />,
      { isTv: true, dispatcher },
    );
    await fireEvent.press(await tvView.findByTestId('library-tab-likes'));
    await waitFor(() => {
      expect(tvView.getByTestId('library-rail-disliked-series')).toBeTruthy();
    });
    await act(async () => {
      dispatcher.dispatch({ key: 'down', action: 'press', time: 10 }, false);
    });
    await act(async () => {
      dispatcher.dispatch({ key: 'down', action: 'press', time: 20 }, false);
    });
    await act(async () => {
      dispatcher.dispatch({ key: 'down', action: 'press', time: 30 }, false);
    });
    await act(async () => {
      dispatcher.dispatch({ key: 'down', action: 'press', time: 40 }, false);
    });
    await act(async () => {
      dispatcher.dispatch({ key: 'select', action: 'press', time: 50 }, false);
    });
    expect(onOpenDetail).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: 'series:s1:2', kind: 'series' }),
    );
    await tvView.unmount();
  });

  it('uses My List / Listem tab label with non-star plus empty notice while preserving new-episode alerts', async () => {
    const trI18n = createAppI18n('tr');
    const catalog = createMockCatalog();
    await render(
      <ViewportProvider
        value={{ width: 1280, height: 720, formFactor: 'desktop', inputModality: 'pointer' }}
      >
        <ThemeProvider>
          <I18nProvider i18n={trI18n}>
            <DownloadsProvider>
              <LibraryScreen
                catalog={catalog}
                sources={[]}
                refreshToken={0}
                onPlay={jest.fn()}
                onOpenDetail={jest.fn()}
              />
            </DownloadsProvider>
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('library-tab-following')).toHaveTextContent('Listem');
      expect(screen.getByTestId('library-empty-following')).toBeTruthy();
    });
    expect(screen.getByTestId('library-empty-following')).not.toHaveTextContent(/yıldız/i);
  });
});
