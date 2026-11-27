import type {
  CatalogService,
  CategoryRow,
  ElvItemEnrichment,
  ElvRecommendedItem,
  ItemRow,
  RatingValue,
  SourceRow,
  WatchProgressRow,
} from '@elv/data';
import { DEFAULT_ELV_MODE_PREFERENCES, type ElvModePreferences, ok } from '@elv/domain';
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

const ELV_SMART_PREFS: ElvModePreferences = {
  ...DEFAULT_ELV_MODE_PREFERENCES,
  elvModeEnabled: true,
  elvEnrichMetadata: true,
  elvSmartRecommendations: true,
};

function makeItem(overrides: Partial<ItemRow>): ItemRow {
  return {
    id: 1,
    key: 'x:src-1:movie:1',
    kind: 'movie',
    sourceId: 'src-1',
    providerId: '1',
    name: 'Demo Movie',
    logo: null,
    rating: 8.0,
    year: 2024,
    num: null,
    ...overrides,
  };
}

function makeEnrichment(item: ItemRow, cleanTitle: string, posterUrl: string): ElvItemEnrichment {
  return {
    itemKey: item.key,
    sourceId: item.sourceId,
    mediaType: item.kind === 'series' ? 'series' : 'movie',
    imdbId: `tt100000${item.id}`,
    confidence: 0.99,
    manualLock: false,
    title: {
      imdbId: `tt100000${item.id}`,
      mediaType: item.kind === 'series' ? 'series' : 'movie',
      originalTitle: cleanTitle,
      englishTitle: cleanTitle,
      localizedTitles: {},
      year: 2025,
      rating: 8.9,
      votes: 300_000,
      runtimeMin: 120,
      genres: ['Sci-Fi'],
      posterUrl,
      backdropUrl: null,
      synopses: {},
      director: null,
      cast: [],
      trailerStreamUrl: null,
      trailerYoutubeId: null,
      mltImdbIds: [],
      franchiseKey: null,
      franchiseName: null,
      franchiseOrder: null,
      detailFetchedAt: 100,
      updatedAt: 100,
    },
  };
}

describe('HomeScreen — Wave E2 ELV Showcase & Dislike Filtering (#512)', () => {
  it('triggers background refreshElvFeeds once, renders mixed Movies + Series ELV Showcase rail below Continue Watching with reason badges', async () => {
    const cwRow: WatchProgressRow = {
      profileId: 'default',
      sourceId: 'src-1',
      itemKey: 'x:src-1:movie:cw-1',
      kind: 'movie',
      title: 'Continue Movie',
      subtitle: null,
      logo: null,
      seriesKey: null,
      season: null,
      episode: null,
      positionMs: 120_000,
      durationMs: 600_000,
      watched: false,
      updatedAt: 1_700_000_000_000,
    };
    const movieCat: CategoryRow = {
      id: 'cat-movie',
      sourceId: 'src-1',
      kind: 'movie',
      name: 'Movies',
      itemCount: 1,
      position: 0,
    };
    const recMovie = makeItem({
      id: 10,
      key: 'x:src-1:movie:rec-1',
      kind: 'movie',
      name: 'RAW MOVIE [4K]',
    });
    const recSeries = makeItem({
      id: 11,
      key: 'x:src-1:series:rec-2',
      kind: 'series',
      name: 'RAW SERIES [HD]',
    });
    const recommendations: readonly ElvRecommendedItem[] = [
      {
        item: recMovie,
        enrichment: makeEnrichment(recMovie, 'Dune: Part Two', 'https://img.test/dune2.jpg'),
        score: 0.95,
        reason: 'trending',
      },
      {
        item: recSeries,
        enrichment: makeEnrichment(recSeries, 'Severance', 'https://img.test/severance.jpg'),
        score: 0.91,
        reason: 'more_like_this',
      },
    ];

    const refreshElvFeeds = jest.fn(async () => false);
    const getElvRecommendations = jest.fn(async () => recommendations);
    const onOpenDetail = jest.fn();

    const catalog = {
      listSources: jest.fn(async () => [SOURCE]),
      categories: jest.fn(async (_s: string, kind: string) => (kind === 'movie' ? [movieCat] : [])),
      items: jest.fn(async () => [
        makeItem({ id: 1, key: 'x:src-1:movie:m-1', name: 'Movie One' }),
      ]),
      listContinueWatching: jest.fn(async () => [cwRow]),
      listRecentChannels: jest.fn(async () => []),
      listFavorites: jest.fn(async () => []),
      listFavoriteKeys: jest.fn(async () => []),
      listProgressByKeys: jest.fn(async () => []),
      listRatingMap: jest.fn(async () => ({})),
      refreshElvFeeds,
      getElvRecommendations,
    } as unknown as CatalogService;

    const view = await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <HomeScreen
              catalog={catalog}
              sources={[SOURCE]}
              refreshToken={1}
              elvPreferences={ELV_SMART_PREFS}
              onPlay={jest.fn()}
              onOpenDetail={onOpenDetail}
              onOpenTab={jest.fn()}
              onOpenSources={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('home-rail-elv-showcase')).toBeTruthy();
      expect(screen.getByTestId('home-elv-showcase-item-0')).toBeTruthy();
      expect(screen.getByTestId('home-elv-showcase-item-1')).toBeTruthy();
    });

    expect(refreshElvFeeds).toHaveBeenCalledTimes(1);
    expect(getElvRecommendations).toHaveBeenCalledWith({
      profile: 'home',
      profileId: 'default',
      limit: 24,
    });
    expect(screen.getByText('Trending & Picks for You')).toBeTruthy();
    expect(screen.getByText('Dune: Part Two')).toBeTruthy();
    expect(screen.getByText('Trending now')).toBeTruthy();
    expect(screen.getByText('Severance')).toBeTruthy();
    expect(screen.getByText('Because of your likes')).toBeTruthy();

    // Positioned right after Continue Watching and before Featured Movies
    const serialized = JSON.stringify(view.toJSON());
    const idxContinue = serialized.indexOf('"home-rail-continue"');
    const idxShowcase = serialized.indexOf('"home-rail-elv-showcase"');
    const idxMovies = serialized.indexOf('"home-rail-movies"');
    expect(idxContinue).toBeLessThan(idxShowcase);
    expect(idxShowcase).toBeLessThan(idxMovies);

    // Pressing a showcase card opens Detail
    await fireEvent.press(screen.getByTestId('home-elv-showcase-item-1'));
    expect(onOpenDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'x:src-1:series:rec-2',
        kind: 'series',
        title: 'Severance',
      }),
    );

    await view.unmount();
  });

  it('hides user-disliked items from Home discovery rails while keeping Continue Watching intact', async () => {
    const cwDisliked: WatchProgressRow = {
      profileId: 'default',
      sourceId: 'src-1',
      itemKey: 'x:src-1:movie:disliked-cw',
      kind: 'movie',
      title: 'Continue Disliked',
      subtitle: null,
      logo: null,
      seriesKey: null,
      season: null,
      episode: null,
      positionMs: 120_000,
      durationMs: 600_000,
      watched: false,
      updatedAt: 1_700_000_000_000,
    };
    const movieCat: CategoryRow = {
      id: 'cat-movie',
      sourceId: 'src-1',
      kind: 'movie',
      name: 'Movies',
      itemCount: 2,
      position: 0,
    };
    const goodMovie = makeItem({ id: 1, key: 'x:src-1:movie:good', name: 'Good Film' });
    const badMovie = makeItem({ id: 2, key: 'x:src-1:movie:bad', name: 'Bad Film' });
    const setRating = jest.fn(async (_input: unknown, next: RatingValue | null) => ok(next));

    const catalog = {
      listSources: jest.fn(async () => [SOURCE]),
      categories: jest.fn(async (_s: string, kind: string) => (kind === 'movie' ? [movieCat] : [])),
      items: jest.fn(async () => [goodMovie, badMovie]),
      listContinueWatching: jest.fn(async () => [cwDisliked]),
      listRecentChannels: jest.fn(async () => []),
      listFavorites: jest.fn(async () => []),
      listFavoriteKeys: jest.fn(async () => []),
      listProgressByKeys: jest.fn(async () => []),
      listRatingMap: jest.fn(async () => ({
        'x:src-1:movie:bad': 'dislike' as RatingValue,
        'x:src-1:movie:disliked-cw': 'dislike' as RatingValue,
      })),
      setRating,
    } as unknown as CatalogService;

    const view = await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <HomeScreen
              catalog={catalog}
              sources={[SOURCE]}
              refreshToken={1}
              onPlay={jest.fn()}
              onOpenTab={jest.fn()}
              onOpenSources={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('home-movies-item-0')).toBeTruthy();
      expect(screen.getByTestId('home-continue-item-0')).toBeTruthy();
    });

    // Bad Film is filtered out of Home discovery Movies rail
    expect(screen.getByText('Good Film')).toBeTruthy();
    expect(screen.queryByText('Bad Film')).toBeNull();
    // Continue Watching is NOT broken by dislike filtering
    expect(screen.getAllByText('Continue Disliked').length).toBeGreaterThanOrEqual(1);

    // Disliking Good Film interactively via context menu hides it immediately from discovery rail
    await fireEvent(screen.getByTestId('home-movies-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('home-context-dislike')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('home-context-dislike'));
    await waitFor(() => {
      expect(setRating).toHaveBeenCalledWith(
        expect.objectContaining({ itemKey: 'x:src-1:movie:good', kind: 'movie' }),
        'dislike',
      );
      expect(screen.queryByText('Good Film')).toBeNull();
    });

    await view.unmount();
  });
});
