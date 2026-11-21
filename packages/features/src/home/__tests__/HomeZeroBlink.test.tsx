import type { CatalogService, CategoryRow, ItemRow, SourceRow } from '@elv/data';
import { elvError, err, type Result } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { CatalogUiCacheProvider, createCatalogUiCache } from '../../shared';
import { HomeScreen } from '../HomeScreen';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const SOURCE: SourceRow = {
  id: 'src-1',
  kind: 'xtream',
  name: 'Demo',
  createdAt: 100,
  needsImport: false,
};

const MOVIE_CAT: CategoryRow = {
  id: 'src-1|movie|1',
  sourceId: 'src-1',
  kind: 'movie',
  name: 'Movies',
  position: 0,
  itemCount: 1,
};

const MOVIE: ItemRow = {
  id: 201,
  key: 'x:src-1:movie:201',
  sourceId: 'src-1',
  providerId: '201',
  kind: 'movie',
  name: 'Neon Horizon',
  logo: null,
  rating: 8.6,
  year: 2026,
  num: null,
};

describe('HomeScreen optimistic toggle safety (#230, #445)', () => {
  it('preserves in-flight optimistic My List toggle across background revalidation and rolls back even-count rapid toggle failure to committed baseline', async () => {
    const fav1 = deferred<Result<boolean>>();
    const fav2 = deferred<Result<boolean>>();
    let favCalls = 0;
    const setFavoriteMock = jest.fn(async () => {
      favCalls += 1;
      return favCalls === 1 ? fav1.promise : fav2.promise;
    });

    const catalog = {
      categories: jest.fn(async (_srcId: string, kind: string) =>
        kind === 'movie' ? [MOVIE_CAT] : [],
      ),
      items: jest.fn(async () => [MOVIE]),
      listContinueWatching: jest.fn(async () => []),
      listFavorites: jest.fn(async () => []),
      listFavoriteKeys: jest.fn(async () => []),
      listProgressByKeys: jest.fn(async () => []),
      setFavorite: setFavoriteMock,
      toggleFavorite: setFavoriteMock,
    } as unknown as CatalogService;

    const uiCache = createCatalogUiCache({ locale: 'en' });
    const renderHome = (userStateVersion: number) => (
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
            <CatalogUiCacheProvider cache={uiCache}>
              <HomeScreen
                catalog={catalog}
                sources={[SOURCE]}
                refreshToken={1}
                userStateVersion={userStateVersion}
                onPlay={jest.fn()}
                onOpenTab={jest.fn()}
                onOpenSources={jest.fn()}
              />
            </CatalogUiCacheProvider>
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    const view = await render(renderHome(0));
    await waitFor(() => {
      expect(screen.getByTestId('home-hero-title')).toHaveTextContent('Neon Horizon');
    });

    // Press 1: false -> true (in-flight). Background revalidation returns [] from DB.
    // Optimistic true MUST NOT be clobbered while in-flight!
    await fireEvent.press(screen.getByTestId('home-hero-mylist'));
    expect(screen.getByTestId('home-hero-mylist').props.accessibilityState?.selected).toBe(true);

    await view.rerender(renderHome(1));
    await waitFor(() => {
      expect((catalog.listFavoriteKeys as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByTestId('home-hero-mylist').props.accessibilityState?.selected).toBe(true);

    // Press 2: true -> false (even-count rapid toggle). Both writes fail -> rolls back to committed false!
    await fireEvent.press(screen.getByTestId('home-hero-mylist'));
    expect(screen.getByTestId('home-hero-mylist').props.accessibilityState?.selected).toBe(false);

    await act(async () => {
      fav1.resolve(err(elvError('storage', 'write-failed')));
      fav2.resolve(err(elvError('storage', 'write-failed')));
    });
    expect(screen.getByTestId('home-hero-mylist').props.accessibilityState?.selected).toBe(false);

    await view.unmount();
  });
});
