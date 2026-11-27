import type {
  CatalogService,
  ElvGenreBucket,
  ElvItemEnrichment,
  ElvRecommendedItem,
  ItemRow,
} from '@elv/data';
import { DEFAULT_ELV_MODE_PREFERENCES, type ElvModePreferences, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { CatalogDiscoveryScreen } from '../CatalogDiscoveryScreen';
import {
  createMockCatalog,
  makeCategory,
  makeItem,
  makeSource,
  renderCatalog,
} from './catalog-test-fixtures';

const ELV_IMDB_PREFS: ElvModePreferences = {
  ...DEFAULT_ELV_MODE_PREFERENCES,
  elvModeEnabled: true,
  elvCategorySource: 'imdb',
  elvEnrichMetadata: true,
  elvTitleFormat: 'system',
  elvSmartRecommendations: true,
};

function makeEnrichment(item: ItemRow, title: string, posterUrl: string): ElvItemEnrichment {
  return {
    itemKey: item.key,
    sourceId: item.sourceId,
    mediaType: item.kind === 'series' ? 'series' : 'movie',
    imdbId: `tt000${item.id}`,
    confidence: 0.98,
    manualLock: false,
    title: {
      imdbId: `tt000${item.id}`,
      mediaType: item.kind === 'series' ? 'series' : 'movie',
      originalTitle: title,
      englishTitle: title,
      localizedTitles: { tr: `${title} (TR)` },
      year: 2024,
      rating: 8.8,
      votes: 120_000,
      runtimeMin: 128,
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
      detailFetchedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
  };
}

describe('CatalogDiscoveryScreen — Wave E2 IMDb Genres & ELV Picks (#512)', () => {
  it('loads IMDb genres when elvCategorySource === "imdb", renders localized genre labels + counts, and paginates genre grid via listElvItemsByImdbGenre', async () => {
    const providerCat = makeCategory(0, { name: 'Provider Folder', itemCount: 1 });
    const sciFiItem = makeItem(0, 0, 'movie');
    const sciFiEnrichment = makeEnrichment(
      sciFiItem,
      'Interstellar',
      'https://img.example.test/interstellar.jpg',
    );
    const genreBuckets: readonly ElvGenreBucket[] = [
      { id: 'imdb-genre:Sci-Fi', name: 'Sci-Fi', count: 12 },
      { id: 'imdb-genre:Action', name: 'Action', count: 7 },
    ];

    const { catalog: baseCatalog } = createMockCatalog({
      categories: [providerCat],
      itemsByCategory: new Map([[providerCat.id, [sciFiItem]]]),
    });

    const listElvImdbGenres = jest.fn(async () => genreBuckets);
    const listElvItemsByImdbGenre = jest.fn(async () => [sciFiItem]);
    const getElvEnrichmentForKeys = jest.fn(
      async () => new Map<string, ElvItemEnrichment>([[sciFiItem.key, sciFiEnrichment]]),
    );

    const catalog = {
      ...baseCatalog,
      listElvImdbGenres,
      listElvItemsByImdbGenre,
      getElvEnrichmentForKeys,
    } as unknown as CatalogService;

    const view = await renderCatalog(
      {
        kind: 'movie',
        catalog,
        sources: [makeSource()],
        elvPreferences: ELV_IMDB_PREFS,
      },
      { locale: 'tr' },
    );

    await waitFor(() => {
      expect(listElvImdbGenres).toHaveBeenCalledWith('movie');
      expect(screen.getByTestId('catalog-cat-chip-0')).toBeTruthy();
      expect(screen.getByTestId('catalog-rail-0-item-0')).toBeTruthy();
    });

    // Provider categories were NOT used when IMDb genres returned non-empty buckets
    expect(baseCatalog.categories).not.toHaveBeenCalled();
    expect(listElvItemsByImdbGenre).toHaveBeenCalledWith('movie', 'imdb-genre:Sci-Fi', {
      offset: 0,
      limit: 18,
    });
    // Localized Turkish genre label & item count rendered cleanly; no provider folder text
    expect(screen.queryByText('Provider Folder')).toBeNull();
    expect(screen.getAllByText('Bilim Kurgu').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('12 yapım')).toBeTruthy();
    expect(screen.getAllByText('Interstellar (TR)').length).toBeGreaterThanOrEqual(1);

    // Selecting the first IMDb genre chip drills into CategoryGridView via listElvItemsByImdbGenre
    await fireEvent.press(screen.getByTestId('catalog-cat-chip-0'));
    await waitFor(() => {
      expect(screen.getByTestId('catalog-grid')).toBeTruthy();
      expect(screen.getAllByText('Interstellar (TR)').length).toBeGreaterThanOrEqual(1);
    });
    expect(listElvItemsByImdbGenre).toHaveBeenCalledWith(
      'movie',
      'imdb-genre:Sci-Fi',
      expect.objectContaining({ offset: 0 }),
    );

    await view.unmount();
  });

  it('gracefully falls back to provider categories when listElvImdbGenres returns empty', async () => {
    const providerCat = makeCategory(0, { name: 'Provider Movies', itemCount: 1 });
    const movie0 = makeItem(0, 0, 'movie');
    const { catalog: baseCatalog } = createMockCatalog({
      categories: [providerCat],
      itemsByCategory: new Map([[providerCat.id, [movie0]]]),
    });

    const listElvImdbGenres = jest.fn(async () => []);
    const catalog = {
      ...baseCatalog,
      listElvImdbGenres,
    } as unknown as CatalogService;

    const view = await renderCatalog({
      kind: 'movie',
      catalog,
      sources: [makeSource()],
      elvPreferences: ELV_IMDB_PREFS,
    });

    await waitFor(() => {
      expect(listElvImdbGenres).toHaveBeenCalledWith('movie');
      expect(baseCatalog.categories).toHaveBeenCalled();
      expect(screen.getByTestId('catalog-rail-0-item-0')).toBeTruthy();
    });
    expect(screen.getByTestId('catalog-cat-chip-0')).toHaveTextContent('Provider Movies');

    await view.unmount();
  });

  it('auto-enables ELV Picks when elvSmartRecommendations is active, renders reason badges, warm empty state, and refreshes reactively', async () => {
    const providerCat = makeCategory(0, { name: 'Drama', itemCount: 1 });
    const movie0 = makeItem(0, 0, 'movie');
    const movie1 = makeItem(0, 1, 'movie');
    const enrich0 = makeEnrichment(movie0, 'Arrival', 'https://img.example.test/arrival.jpg');
    const enrich1 = makeEnrichment(movie1, 'Dune', 'https://img.example.test/dune.jpg');

    const { catalog: baseCatalog } = createMockCatalog({
      categories: [providerCat],
      itemsByCategory: new Map([[providerCat.id, [movie0]]]),
    });

    const recBatch1: readonly ElvRecommendedItem[] = [
      { item: movie0, enrichment: enrich0, score: 0.92, reason: 'more_like_this' },
    ];
    const recBatch2: readonly ElvRecommendedItem[] = [
      { item: movie1, enrichment: enrich1, score: 0.95, reason: 'trending' },
    ];

    const getElvRecommendations = jest
      .fn<Promise<readonly ElvRecommendedItem[]>, [unknown]>()
      .mockResolvedValueOnce(recBatch1)
      .mockResolvedValueOnce(recBatch2)
      .mockResolvedValueOnce([]);

    const catalog = {
      ...baseCatalog,
      getElvRecommendations,
    } as unknown as CatalogService;

    const smartPrefs: ElvModePreferences = {
      ...DEFAULT_ELV_MODE_PREFERENCES,
      elvModeEnabled: true,
      elvEnrichMetadata: true,
      elvSmartRecommendations: true,
      elvCategorySource: 'provider',
    };

    const renderSmartScreen = (userStateVersion: number) => (
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      >
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={createAppI18n('en')}>
            <CatalogDiscoveryScreen
              kind="movie"
              catalog={catalog}
              sources={[makeSource()]}
              refreshToken={1}
              userStateVersion={userStateVersion}
              elvPreferences={smartPrefs}
              onOpenDetail={jest.fn()}
              onOpenSources={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    const view = await render(renderSmartScreen(0));

    await waitFor(() => {
      expect(screen.getByTestId('catalog-filter-elv-picks')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('catalog-filter-elv-picks'));

    await waitFor(() => {
      expect(getElvRecommendations).toHaveBeenCalledWith({
        profile: 'elv_picks',
        kind: 'movie',
        profileId: 'default',
        limit: 30,
      });
      expect(screen.getByTestId('catalog-quick-filter-grid-elvPicks')).toBeTruthy();
      expect(screen.getByText('Arrival')).toBeTruthy();
      expect(screen.getByText('Because of your likes')).toBeTruthy();
    });

    // Bumping userStateVersion refreshes ELV Picks reactively without flicker
    await view.rerender(renderSmartScreen(1));
    await waitFor(() => {
      expect(screen.getByText('Dune')).toBeTruthy();
      expect(screen.getByText('Trending now')).toBeTruthy();
    });
    await view.unmount();

    // Verify warm empty state when recommendations return empty
    const emptyRecsCatalog = {
      ...baseCatalog,
      getElvRecommendations: jest.fn(async () => []),
    } as unknown as CatalogService;

    const emptyView = await renderCatalog({
      kind: 'movie',
      catalog: emptyRecsCatalog,
      sources: [makeSource()],
      elvPreferences: smartPrefs,
    });

    await waitFor(() => {
      expect(screen.getByTestId('catalog-filter-elv-picks')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('catalog-filter-elv-picks'));

    await waitFor(() => {
      expect(screen.getByTestId('catalog-empty-elv-picks')).toBeTruthy();
      expect(screen.getByText('Building your personal picks')).toBeTruthy();
      expect(
        screen.getByText(
          'Like, star, or watch a few titles and ELV Mode will tailor picks from your library.',
        ),
      ).toBeTruthy();
    });

    await emptyView.unmount();
  });

  it('re-translates IMDb genre labels immediately on live locale switch without refreshToken bump and forwards sortBy: "alpha" on IMDb genre grid', async () => {
    const sciFiItem = makeItem(0, 0, 'movie');
    const genreBuckets: readonly ElvGenreBucket[] = [
      { id: 'imdb-genre:Sci-Fi', name: 'Sci-Fi', count: 5 },
    ];
    const { catalog: baseCatalog } = createMockCatalog({
      categories: [],
      itemsByCategory: new Map(),
    });
    const listElvImdbGenres = jest.fn(async () => genreBuckets);
    const listElvItemsByImdbGenre = jest.fn(async () => [sciFiItem]);
    const catalog = {
      ...baseCatalog,
      listElvImdbGenres,
      listElvItemsByImdbGenre,
    } as unknown as CatalogService;

    const stableSources = [makeSource()];
    const renderWithLocale = (locale: 'en' | 'tr') => (
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      >
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={createAppI18n(locale)}>
            <CatalogDiscoveryScreen
              kind="movie"
              catalog={catalog}
              sources={stableSources}
              refreshToken={1}
              elvPreferences={ELV_IMDB_PREFS}
              onOpenDetail={jest.fn()}
              onOpenSources={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    const view = await render(renderWithLocale('en'));
    await waitFor(() => {
      expect(screen.getAllByText('Sci-Fi').length).toBeGreaterThanOrEqual(1);
    });

    // Switch locale from 'en' -> 'tr' without bumping refreshToken
    await view.rerender(renderWithLocale('tr'));
    await waitFor(() => {
      expect(screen.getAllByText('Bilim Kurgu').length).toBeGreaterThanOrEqual(1);
    });

    // Open IMDb genre grid and press header Sort button -> forwards sortBy: 'alpha'
    await fireEvent.press(screen.getByTestId('catalog-cat-chip-0'));
    await waitFor(() => {
      expect(screen.getByTestId('catalog-grid-sort')).toBeTruthy();
    });
    listElvItemsByImdbGenre.mockClear();
    await fireEvent.press(screen.getByTestId('catalog-grid-sort'));
    await waitFor(() => {
      expect(listElvItemsByImdbGenre).toHaveBeenCalledWith(
        'movie',
        'imdb-genre:Sci-Fi',
        expect.objectContaining({ offset: 0, sortBy: 'alpha' }),
      );
    });

    await view.unmount();
  });

  it('awaits setWatched and setRating persistence before refreshing ELV Picks so recommendations never race ahead of writes', async () => {
    const providerCat = makeCategory(0, { name: 'Drama', itemCount: 1 });
    const movie0 = makeItem(0, 0, 'movie');
    const movie1 = makeItem(0, 1, 'movie');
    const enrich0 = makeEnrichment(movie0, 'Arrival', 'https://img.example.test/arrival.jpg');
    const enrich1 = makeEnrichment(movie1, 'Dune', 'https://img.example.test/dune.jpg');

    const { catalog: baseCatalog } = createMockCatalog({
      categories: [providerCat],
      itemsByCategory: new Map([[providerCat.id, [movie0]]]),
    });

    let resolveWatched!: (val: ReturnType<typeof ok<void>>) => void;
    let resolveRating!: (val: ReturnType<typeof ok<'like'>>) => void;
    const setWatched = jest.fn(
      () =>
        new Promise<ReturnType<typeof ok<void>>>((resolve) => {
          resolveWatched = resolve;
        }),
    );
    const setRating = jest.fn(
      () =>
        new Promise<ReturnType<typeof ok<'like'>>>((resolve) => {
          resolveRating = resolve;
        }),
    );
    const getElvRecommendations = jest
      .fn<Promise<readonly ElvRecommendedItem[]>, [unknown]>()
      .mockResolvedValueOnce([
        { item: movie0, enrichment: enrich0, score: 0.9, reason: 'more_like_this' },
      ])
      .mockResolvedValue([{ item: movie1, enrichment: enrich1, score: 0.95, reason: 'trending' }]);

    const catalog = {
      ...baseCatalog,
      setWatched,
      setRating,
      getElvRecommendations,
    } as unknown as CatalogService;

    const smartPrefs: ElvModePreferences = {
      ...DEFAULT_ELV_MODE_PREFERENCES,
      elvModeEnabled: true,
      elvEnrichMetadata: true,
      elvSmartRecommendations: true,
      elvCategorySource: 'provider',
    };

    const view = await render(
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      >
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={createAppI18n('en')}>
            <CatalogDiscoveryScreen
              kind="movie"
              catalog={catalog}
              sources={[makeSource()]}
              refreshToken={1}
              userStateVersion={0}
              elvPreferences={smartPrefs}
              onOpenDetail={jest.fn()}
              onOpenSources={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('catalog-filter-elv-picks')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('catalog-filter-elv-picks'));
    await waitFor(() => {
      expect(screen.getByTestId('catalog-quick-filter-item-0')).toBeTruthy();
      expect(getElvRecommendations).toHaveBeenCalledTimes(1);
    });

    // Trigger Mark Watched via context menu while setWatched promise is pending -> MUST NOT re-query yet
    await fireEvent(screen.getByTestId('catalog-quick-filter-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('context-menu-watched')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('context-menu-watched'));
    expect(setWatched).toHaveBeenCalledTimes(1);
    expect(getElvRecommendations).toHaveBeenCalledTimes(1);

    // Resolve setWatched -> now ELV Picks refreshes!
    await act(async () => {
      resolveWatched(ok(undefined));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(getElvRecommendations).toHaveBeenCalledTimes(2);
    });

    // Open context menu on ELV Picks item and trigger Like while setRating is pending
    await fireEvent(screen.getByTestId('catalog-quick-filter-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('context-menu-like')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('context-menu-like'));
    expect(setRating).toHaveBeenCalledTimes(1);
    expect(getElvRecommendations).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveRating(ok('like'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(getElvRecommendations).toHaveBeenCalledTimes(3);
    });

    await view.unmount();
  });
});
