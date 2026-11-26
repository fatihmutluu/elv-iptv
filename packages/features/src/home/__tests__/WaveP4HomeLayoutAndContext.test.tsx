import type {
  CatalogService,
  CategoryRow,
  FavoriteRow,
  ItemRow,
  SourceRow,
  WatchProgressRow,
} from '@elv/data';
import { ok } from '@elv/domain';
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

function makeItem(overrides: Partial<ItemRow>): ItemRow {
  return {
    id: 1,
    key: 'x:src-1:movie:1',
    kind: 'movie',
    sourceId: 'src-1',
    providerId: '1',
    name: 'Demo Title',
    logo: null,
    rating: 8.0,
    year: 2025,
    num: null,
    ...overrides,
  };
}

function makeCatalog(overrides: Partial<CatalogService> = {}): CatalogService {
  const liveCat: CategoryRow = {
    id: 'cat-live',
    sourceId: 'src-1',
    kind: 'live',
    name: 'General',
    itemCount: 3,
    position: 0,
  };
  const movieCat: CategoryRow = {
    id: 'cat-movie',
    sourceId: 'src-1',
    kind: 'movie',
    name: 'Movies',
    itemCount: 2,
    position: 0,
  };
  const cwRows: WatchProgressRow[] = [
    {
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
    },
  ];
  const favRows: FavoriteRow[] = [
    {
      profileId: 'default',
      sourceId: 'src-1',
      itemKey: 'x:src-1:live:fav-1',
      kind: 'live',
      title: 'Fav Channel',
      logo: null,
      year: null,
      rating: null,
      addedAt: 100,
    },
  ];
  return {
    listSources: jest.fn(async () => [SOURCE]),
    categories: jest.fn(async (_srcId, kind) => {
      if (kind === 'live') return [liveCat];
      if (kind === 'movie') return [movieCat];
      return [];
    }),
    items: jest.fn(async (catId) => {
      if (catId === 'cat-live') {
        return [
          makeItem({ id: 1, key: 'x:src-1:live:on-1', kind: 'live', name: 'On Now One', num: 1 }),
        ];
      }
      if (catId === 'cat-movie') {
        return [makeItem({ id: 2, key: 'x:src-1:movie:m-1', kind: 'movie', name: 'Movie One' })];
      }
      return [];
    }),
    listContinueWatching: jest.fn(async () => cwRows),
    listRecentChannels: jest.fn(async () => [
      makeItem({ id: 3, key: 'x:src-1:live:rec-1', kind: 'live', name: 'Recent One', num: 5 }),
    ]),
    listFavorites: jest.fn(async () => favRows),
    listFavoriteKeys: jest.fn(async () => favRows.map((f) => f.itemKey)),
    getProgress: jest.fn(async () => null),
    clearProgress: jest.fn(async () => ok(undefined)),
    setFavorite: jest.fn(async (_input, next) => ok(next)),
    setWatched: jest.fn(async () => ok(undefined)),
    ...overrides,
  } as unknown as CatalogService;
}

describe('Wave P4 HomeScreen: unified Live TV rail, custom layout & context menus', () => {
  it('renders unified Live TV rail with Favorites -> Recent -> On-Now order and hides sections per homeLayout', async () => {
    const catalog = makeCatalog();
    await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <HomeScreen
              catalog={catalog}
              sources={[SOURCE]}
              refreshToken={0}
              homeLayout={[
                { id: 'live', visible: true },
                { id: 'movies', visible: false },
                { id: 'continue', visible: true },
                { id: 'mylist', visible: true },
                { id: 'series', visible: true },
                { id: 'collections', visible: false },
              ]}
              onPlay={jest.fn()}
              onOpenTab={jest.fn()}
              onOpenSources={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('home-rail-live')).toBeTruthy();
    });

    expect(screen.getByText('Live TV')).toBeTruthy();
    expect(screen.getByTestId('home-live-item-0')).toBeTruthy();
    expect(screen.getByTestId('home-live-item-1')).toBeTruthy();
    expect(screen.getByTestId('home-live-item-2')).toBeTruthy();
    expect(screen.queryByTestId('home-rail-movies')).toBeNull();
    expect(screen.queryByTestId('home-rail-recentChannels')).toBeNull();
  });

  it('removes item from Continue Watching immediately via long-press context menu and calls clearProgress', async () => {
    const clearProgress = jest.fn(async () => ok(undefined));
    const catalog = makeCatalog({ clearProgress });

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
      expect(screen.getByTestId('home-continue-item-0')).toBeTruthy();
    });

    await fireEvent(screen.getByTestId('home-continue-item-0'), 'longPress');

    await waitFor(() => {
      expect(screen.getByTestId('home-context-hide-continue')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('home-context-hide-continue'));

    await waitFor(() => {
      expect(clearProgress).toHaveBeenCalledWith('x:src-1:movie:cw-1');
      expect(screen.queryByTestId('home-continue-item-0')).toBeNull();
    });
  });

  it('opens Live TV context menu with Multi-View, Popout, and Favorite toggle', async () => {
    const onOpenMultiView = jest.fn();
    const onOpenPopout = jest.fn();
    const catalog = makeCatalog();

    await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <HomeScreen
              catalog={catalog}
              sources={[SOURCE]}
              refreshToken={0}
              onPlay={jest.fn()}
              onOpenMultiView={onOpenMultiView}
              onOpenPopout={onOpenPopout}
              onOpenTab={jest.fn()}
              onOpenSources={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('home-live-item-0')).toBeTruthy();
    });

    await fireEvent(screen.getByTestId('home-live-item-0'), 'longPress');

    await waitFor(() => {
      expect(screen.getByTestId('home-context-multiview')).toBeTruthy();
      expect(screen.getByTestId('home-context-popout')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('home-context-multiview'));
    expect(onOpenMultiView).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: 'x:src-1:live:fav-1', kind: 'live', itemKind: 'live' }),
    );
  });

  it('uses real liveItems index for On-Now channels and omits playlist for foreign favorites (P1-2)', async () => {
    const onPlay = jest.fn();
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
              onOpenSources={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('home-live-item-2')).toBeTruthy();
    });

    // Item 0 is favorite not in liveItems -> standalone PlayTarget (no playlist, itemKind: 'live')
    await fireEvent.press(screen.getByTestId('home-live-item-0'));
    expect(onPlay).toHaveBeenLastCalledWith(
      expect.objectContaining({
        itemKey: 'x:src-1:live:fav-1',
        kind: 'live',
        itemKind: 'live',
        logo: null,
      }),
    );
    expect(onPlay.mock.calls[0]?.[0]?.playlist).toBeUndefined();

    // Item 2 is On-Now item whose real index in liveItems is 0 (not unified rail index 2)
    await fireEvent.press(screen.getByTestId('home-live-item-2'));
    expect(onPlay.mock.calls[1]?.[0]?.itemKey).toBe('x:src-1:live:on-1');
    expect(onPlay.mock.calls[1]?.[0]?.playlist?.currentIndex).toBe(0);
  });

  it('suspends HomeTvKeyBridge while universal ContextMenu is open on TV (P0-5)', async () => {
    const catalog = makeCatalog();
    await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion>
          <ViewportProvider value={{ width: 1920, height: 1080, formFactor: 'tv' }}>
            <HomeScreen
              catalog={catalog}
              sources={[SOURCE]}
              refreshToken={0}
              onPlay={jest.fn()}
              onOpenTab={jest.fn()}
              onOpenSources={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId('home-tv-focus-anchor', { includeHiddenElements: true }),
      ).toBeTruthy();
      expect(screen.getByTestId('home-continue-item-0')).toBeTruthy();
    });

    await fireEvent(screen.getByTestId('home-continue-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('home-context-hide-continue')).toBeTruthy();
      expect(
        screen.queryByTestId('home-tv-focus-anchor', { includeHiddenElements: true }),
      ).toBeNull();
    });
  });
});
