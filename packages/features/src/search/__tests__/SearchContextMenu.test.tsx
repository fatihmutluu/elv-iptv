import type { CatalogService, ItemRow, SearchResults } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { DetailTarget } from '../../shared';
import { SearchScreen } from '../SearchScreen';

function makeItem(overrides: Partial<ItemRow> & Pick<ItemRow, 'key' | 'kind' | 'name'>): ItemRow {
  return {
    id: 1,
    sourceId: 'src-1',
    providerId: 'p-1',
    logo: 'https://img.test/poster.jpg',
    year: 2024,
    rating: 8.2,
    num: overrides.kind === 'live' ? 12 : null,
    ...overrides,
  };
}

describe('SearchScreen — Universal Context Menus', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens context menus on Live and Movie search result cards and dispatches Play, Details, Favorite, and Watched', async () => {
    const liveItem = makeItem({ key: 'live:1', kind: 'live', name: 'BBC World' });
    const movieItem = makeItem({ key: 'movie:1', kind: 'movie', name: 'Inception' });
    const results: SearchResults = {
      live: [liveItem],
      movies: [movieItem],
      series: [],
      epg: [],
      episodes: [],
    };

    const setFavorite = jest.fn(async () => ({ ok: true as const, value: true }));
    const setWatched = jest.fn(async () => ({ ok: true as const, value: undefined }));
    const catalog = {
      search: jest.fn(async () => results),
      listProgressByKeys: jest.fn(async () => []),
      listFavoriteKeys: jest.fn(async () => []),
      setFavorite,
      setWatched,
    } as unknown as CatalogService;

    const onPlay = jest.fn<void, [PlayTarget]>();
    const onOpenDetail = jest.fn<void, [DetailTarget]>();

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
            <SearchScreen
              catalog={catalog}
              refreshToken={1}
              initialQuery="in"
              onPlay={onPlay}
              onOpenDetail={onOpenDetail}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('search-live-item-0')).toBeTruthy();
      expect(screen.getByTestId('search-movie-item-0')).toBeTruthy();
    });

    // Long-press Live card -> Add to My List
    await fireEvent(screen.getByTestId('search-live-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('context-menu-play')).toBeTruthy();
      expect(screen.getByTestId('context-menu-favorite')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('context-menu-favorite'));
    expect(setFavorite).toHaveBeenCalledWith(expect.objectContaining({ itemKey: 'live:1' }), true);

    // Long-press Movie card -> Play
    await fireEvent(screen.getByTestId('search-movie-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('context-menu-play')).toBeTruthy();
      expect(screen.getByTestId('context-menu-details')).toBeTruthy();
      expect(screen.getByTestId('context-menu-watched')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('context-menu-play'));
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ itemKey: 'movie:1' }));

    // Long-press Movie card -> Go to details
    await fireEvent(screen.getByTestId('search-movie-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('context-menu-details')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('context-menu-details'));
    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ itemKey: 'movie:1' }));

    // Long-press Movie card -> Mark as watched
    await fireEvent(screen.getByTestId('search-movie-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('context-menu-watched')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('context-menu-watched'));
    expect(setWatched).toHaveBeenCalledWith('movie:1', true);

    await view.unmount();
  });
});
