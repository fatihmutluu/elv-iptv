import type { CatalogService, CategoryRow, ItemRow, RatingValue, SourceRow } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  I18nProvider,
  ICON_PATHS,
  ThemeProvider,
  UiAdaptersProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import { HomeHero } from '../HomeHero';
import { HomeScreen } from '../HomeScreen';
import { buildHomeCardContextMenuItems } from '../home-context-menu';
import type { HomeRailEntry } from '../home-model';

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
    name: 'Blade Runner',
    logo: null,
    rating: 8.1,
    year: 1982,
    num: null,
    ...overrides,
  };
}

describe('Wave P6 HomeScreen — Star unification & Like/Dislike context menus', () => {
  it('exposes Like/Dislike on Movie & Series context menus and NEVER on Live TV context menus', () => {
    const t = (key: string) => key;
    const onToggleRating = jest.fn();
    const movieEntry: HomeRailEntry = {
      itemKey: 'x:src-1:movie:1',
      sourceId: 'src-1',
      kind: 'movie',
      title: 'Blade Runner',
      subtitle: null,
      posterUri: null,
      backdropUri: null,
      year: 1982,
      rating: 8.1,
      positionMs: 0,
      durationMs: 0,
      watched: false,
      live: false,
    };
    const liveEntry: HomeRailEntry = {
      ...movieEntry,
      itemKey: 'x:src-1:live:1',
      kind: 'live',
      title: 'News 24',
      live: true,
    };

    const movieActions = buildHomeCardContextMenuItems({
      railId: 'movies',
      entry: movieEntry,
      index: 0,
      isFavorite: false,
      isWatched: false,
      currentRating: 'like',
      t: t as never,
      onPlay: jest.fn(),
      onToggleFavorite: jest.fn(),
      onToggleRating,
    });
    expect(movieActions.find((a) => a.id === 'mylist')).toMatchObject({
      icon: 'plus',
    });
    const movieFavActions = buildHomeCardContextMenuItems({
      railId: 'movies',
      entry: movieEntry,
      index: 0,
      isFavorite: true,
      isWatched: false,
      currentRating: 'like',
      t: t as never,
      onPlay: jest.fn(),
      onToggleFavorite: jest.fn(),
      onToggleRating,
    });
    expect(movieFavActions.find((a) => a.id === 'mylist')).toMatchObject({
      icon: 'check',
    });
    expect(movieActions.find((a) => a.id === 'like')).toMatchObject({
      icon: 'likeFilled',
      label: 'rating.clearLike',
    });
    expect(movieActions.find((a) => a.id === 'dislike')).toMatchObject({
      icon: 'dislike',
      label: 'rating.dislike',
    });

    const liveActions = buildHomeCardContextMenuItems({
      railId: 'live',
      entry: liveEntry,
      index: 0,
      isFavorite: false,
      isWatched: false,
      t: t as never,
      onPlay: jest.fn(),
      onToggleFavorite: jest.fn(),
      onToggleRating,
    });
    expect(liveActions.some((a) => a.id === 'like' || a.id === 'dislike')).toBe(false);
    expect(liveActions.find((a) => a.id === 'favorite')).toMatchObject({ icon: 'star' });
  });

  it('HomeHero uses plus/check for VOD My List and preserves star for Live slides', async () => {
    const renderedIcons: unknown[] = [];
    const slide: HomeRailEntry = {
      itemKey: 'x:src-1:movie:1',
      sourceId: 'src-1',
      kind: 'movie',
      title: 'Blade Runner',
      subtitle: null,
      posterUri: null,
      backdropUri: null,
      year: 1982,
      rating: 8.1,
      positionMs: 0,
      durationMs: 0,
      watched: false,
    };
    const wrapHero = (inMyList: boolean, kind: 'movie' | 'live' = 'movie') => (
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
            <UiAdaptersProvider
              adapters={{
                renderSvg: ({ spec }) => {
                  renderedIcons.push(spec);
                  return <View />;
                },
              }}
            >
              <HomeHero
                slides={[{ ...slide, kind, isContinueWatching: false }]}
                activeIndex={0}
                onSelectIndex={jest.fn()}
                inMyList={inMyList}
                onPlaySlide={jest.fn()}
                onToggleMyList={jest.fn()}
                onToggleWatched={jest.fn()}
                isTv={false}
                isTouch={false}
                isPortrait={false}
                topClearance={64}
                minHeight={420}
                padX={32}
                focusedAction={null}
              />
            </UiAdaptersProvider>
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    const view = await render(wrapHero(false, 'movie'));
    expect(renderedIcons).toContain(ICON_PATHS.plus);
    expect(renderedIcons).not.toContain(ICON_PATHS.star);

    renderedIcons.length = 0;
    await view.rerender(wrapHero(true, 'movie'));
    expect(renderedIcons).toContain(ICON_PATHS.check);
    expect(renderedIcons).not.toContain(ICON_PATHS.starFilled);

    renderedIcons.length = 0;
    await view.rerender(wrapHero(false, 'live'));
    expect(renderedIcons).toContain(ICON_PATHS.star);
    await view.unmount();
  });

  it('HomeScreen renders HomeHero mylist button and dispatches setRating from Movie context menu only', async () => {
    const setRating = jest.fn(async (_input: unknown, next: RatingValue | null) => ok(next));
    const liveCat: CategoryRow = {
      id: 'cat-live',
      sourceId: 'src-1',
      kind: 'live',
      name: 'Live',
      itemCount: 1,
      position: 0,
    };
    const movieCat: CategoryRow = {
      id: 'cat-movie',
      sourceId: 'src-1',
      kind: 'movie',
      name: 'Movies',
      itemCount: 1,
      position: 0,
    };
    const catalog = {
      listSources: jest.fn(async () => [SOURCE]),
      categories: jest.fn(async (_srcId: string, kind: string) =>
        kind === 'live' ? [liveCat] : kind === 'movie' ? [movieCat] : [],
      ),
      items: jest.fn(async (catId: string) =>
        catId === 'cat-live'
          ? [makeItem({ id: 2, key: 'x:src-1:live:1', kind: 'live', name: 'News 24', num: 1 })]
          : [makeItem({ id: 1, key: 'x:src-1:movie:1', kind: 'movie', name: 'Blade Runner' })],
      ),
      listContinueWatching: jest.fn(async () => []),
      listRecentChannels: jest.fn(async () => []),
      listFavorites: jest.fn(async () => []),
      listFavoriteKeys: jest.fn(async () => []),
      listRatingMap: jest.fn(async () => ({})),
      listProgressByKeys: jest.fn(async () => []),
      setRating,
    } as unknown as CatalogService;

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
            <HomeScreen
              catalog={catalog}
              sources={[SOURCE]}
              refreshToken={1}
              onPlay={jest.fn()}
              onOpenTab={jest.fn()}
              onOpenSources={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-mylist')).toBeTruthy();
      expect(screen.getByTestId('home-movies-item-0')).toBeTruthy();
      expect(screen.getByTestId('home-live-item-0')).toBeTruthy();
    });

    // Live TV card context menu never has Like/Dislike
    await fireEvent(screen.getByTestId('home-live-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('home-context-play')).toBeTruthy();
    });
    expect(screen.queryByTestId('home-context-like')).toBeNull();
    expect(screen.queryByTestId('home-context-dislike')).toBeNull();
    await fireEvent.press(screen.getByTestId('context-menu-backdrop'));
    await waitFor(() => {
      expect(screen.queryByTestId('context-menu-panel')).toBeNull();
    });

    // Movie card context menu exposes Like & Dislike and dispatches setRating
    await fireEvent(screen.getByTestId('home-movies-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('home-context-like')).toBeTruthy();
      expect(screen.getByTestId('home-context-dislike')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('home-context-like'));
    await waitFor(() => {
      expect(setRating).toHaveBeenCalledWith(
        expect.objectContaining({ itemKey: 'x:src-1:movie:1', kind: 'movie' }),
        'like',
      );
    });

    await view.unmount();
  });
});
