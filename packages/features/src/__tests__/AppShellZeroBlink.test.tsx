import type { CatalogService, CategoryRow, ItemRow, SourceRow } from '@elv/data';
import { createMemoryPreferencesStore, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import { AppProviders, AppShell } from '../index';
import type { AppLifecyclePort, AppLifecycleState } from '../ports/app-lifecycle';
import type { VideoHost } from '../ports/video-host';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const DEMO_SOURCE: SourceRow = {
  id: 'src-1',
  kind: 'xtream',
  name: 'Demo',
  createdAt: 100,
  needsImport: false,
};

function makeCat(kind: 'live' | 'movie' | 'series'): CategoryRow {
  return {
    id: `src-1|${kind}|1`,
    sourceId: 'src-1',
    kind,
    name: `${kind}-cat`,
    position: 0,
    itemCount: 1,
  };
}

function makeItem(kind: 'live' | 'movie' | 'series', name: string): ItemRow {
  return {
    id: kind === 'live' ? 101 : kind === 'movie' ? 201 : 301,
    key: `x:src-1:${kind}:1`,
    sourceId: 'src-1',
    providerId: '1',
    kind,
    name,
    logo: null,
    rating: 8.5,
    year: 2025,
    num: kind === 'live' ? 1 : null,
  };
}

function createFakeHost(): VideoHost {
  const engine = createFakePlayerEngine({
    now: () => performance.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  return {
    open: () => ({
      engine,
      renderSurface: ({ testID }) => <View testID={testID ?? 'shell-surface'} />,
    }),
  };
}

function createStubCatalog(overrides: Partial<CatalogService> = {}): CatalogService {
  return {
    listSources: jest.fn(async () => [DEMO_SOURCE]),
    addSource: jest.fn(),
    addSourceFromLink: jest.fn(),
    removeSource: jest.fn(),
    importSource: jest.fn(),
    categories: jest.fn(async (_srcId: string, kind: 'live' | 'movie' | 'series') => [
      makeCat(kind),
    ]),
    items: jest.fn(async (catId: string) => {
      if (catId.includes('|live|')) return [makeItem('live', 'Live News One')];
      if (catId.includes('|movie|')) return [makeItem('movie', 'Warm Movie One')];
      return [makeItem('series', 'Warm Series One')];
    }),
    itemDetail: jest.fn(async () => null),
    seasons: jest.fn(async () => ok([])),
    episodes: jest.fn(async () => []),
    resolveStream: jest.fn(),
    listContinueWatching: jest.fn(async () => []),
    listFavorites: jest.fn(async () => []),
    listFavoriteKeys: jest.fn(async () => []),
    listProgressByKeys: jest.fn(async () => []),
    search: jest.fn(async () => ({
      live: [],
      movies: [makeItem('movie', 'Warm Movie One')],
      series: [],
    })),
    nowNext: jest.fn(async () => []),
    epgWindow: jest.fn(async () => ({})),
    setFavorite: jest.fn(async (_input, active) => ok(active)),
    toggleFavorite: jest.fn(async () => ok(true)),
    flushPendingWrites: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as CatalogService;
}

describe('AppShell zero-blink prewarm, startup anti-flash & background/unmount flush (#445, #230)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not flash Settings while initial listSources() is pending and lands directly on Home', async () => {
    const sourcesGate = deferred<SourceRow[]>();
    const catalog = createStubCatalog({ listSources: jest.fn(() => sourcesGate.promise) });

    const view = await render(
      <FormFactorProvider value="desktop">
        <I18nProvider i18n={createAppI18n('en')}>
          <AppShell catalog={catalog} videoHost={createFakeHost()} />
        </I18nProvider>
      </FormFactorProvider>,
    );

    // While listSources() is resolving, SettingsScreen must NOT flash
    expect(screen.queryByTestId('settings-screen')).toBeNull();
    expect(screen.getByTestId('app-shell-boot')).toBeTruthy();

    await act(async () => {
      sourcesGate.resolve([DEMO_SOURCE]);
    });

    await waitFor(() => {
      expect(screen.getByTestId('home-screen')).toBeTruthy();
      expect(screen.queryByTestId('settings-screen')).toBeNull();
    });

    await view.unmount();
  });

  it('prewarms Live, Movies, and Series for frame-0 tab switches with zero skeleton flash even while background refresh is pending', async () => {
    let blockSubsequentReads = false;
    const base = createStubCatalog();
    const catalog = createStubCatalog({
      categories: jest.fn((srcId, kind) =>
        blockSubsequentReads ? new Promise(() => undefined) : base.categories(srcId, kind),
      ),
      items: jest.fn((catId, offset, limit) =>
        blockSubsequentReads ? new Promise(() => undefined) : base.items(catId, offset, limit),
      ),
    });

    const view = await render(
      <FormFactorProvider value="desktop">
        <I18nProvider i18n={createAppI18n('en')}>
          <AppShell catalog={catalog} videoHost={createFakeHost()} />
        </I18nProvider>
      </FormFactorProvider>,
    );

    // Wait for Home + background prewarm of Live, Movies, and Series to settle
    await waitFor(() => {
      expect(screen.getByTestId('home-hero')).toBeTruthy();
      expect((catalog.items as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    // Now block ALL future DB reads — every tab switch must still render synchronously from CatalogUiCache!
    blockSubsequentReads = true;

    await fireEvent.press(screen.getByTestId('nav-tab-live'));
    expect(screen.queryByTestId('live-loading-skeleton')).toBeNull();
    await fireEvent.press(screen.getByTestId('live-mode-channels'));
    expect(screen.queryByTestId('live-loading-skeleton')).toBeNull();
    expect(screen.getByTestId('live-channels-grid')).toBeTruthy();
    expect(screen.getByText('Live News One')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('nav-tab-movie'));
    expect(screen.queryByTestId('catalog-skeleton')).toBeNull();
    expect(screen.getByTestId('catalog-screen-movie')).toBeTruthy();
    expect(screen.getByText('Warm Movie One')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('nav-tab-series'));
    expect(screen.queryByTestId('catalog-skeleton')).toBeNull();
    expect(screen.getByTestId('catalog-screen-series')).toBeTruthy();
    expect(screen.getByText('Warm Series One')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('nav-tab-home'));
    expect(screen.queryByTestId('home-skeleton')).toBeNull();
    expect(screen.getByTestId('home-hero')).toBeTruthy();

    await view.unmount();
  });

  it('hydrates Search results synchronously when returning from Detail without re-searching', async () => {
    const searchMock = jest.fn(async () => ({
      live: [],
      movies: [makeItem('movie', 'Warm Movie One')],
      series: [],
    }));
    const catalog = createStubCatalog({ search: searchMock });

    const view = await render(
      <FormFactorProvider value="desktop">
        <I18nProvider i18n={createAppI18n('en')}>
          <AppShell catalog={catalog} videoHost={createFakeHost()} />
        </I18nProvider>
      </FormFactorProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('home-screen')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('nav-tab-search'));
    await fireEvent.changeText(screen.getByTestId('search-input'), 'Warm Movie');

    await waitFor(() => {
      expect(screen.getByTestId('search-movie-item-0')).toBeTruthy();
    });
    expect(searchMock).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('search-movie-item-0'));
    await waitFor(() => expect(screen.getByTestId('detail-screen')).toBeTruthy());

    // Block future search calls: returning from Detail MUST render synchronously from CatalogUiCache
    // while silently revalidating VOD watch progress in the background!
    searchMock.mockImplementation(() => new Promise(() => undefined));
    const listProgressMock = catalog.listProgressByKeys as jest.Mock;
    const progressCallsBeforeReturn = listProgressMock.mock.calls.length;
    await fireEvent.press(screen.getByTestId('detail-back'));
    expect(screen.getByTestId('search-screen')).toBeTruthy();
    expect(screen.getByTestId('search-movie-item-0')).toBeTruthy();
    expect(searchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(listProgressMock.mock.calls.length).toBeGreaterThan(progressCallsBeforeReturn);
    });

    await view.unmount();
  });

  it('flushes catalog.flushPendingWrites and preferencesStore.flush on appLifecycle background and unmount even if catalog flush rejects', async () => {
    const flushCatalog = jest.fn(async () => {
      throw new Error('transient flush error');
    });
    const flushPrefs = jest.fn(async () => undefined);
    const catalog = createStubCatalog({ flushPendingWrites: flushCatalog });
    const basePrefs = createMemoryPreferencesStore();
    const preferencesStore = { ...basePrefs, flush: flushPrefs };

    let lifecycleListener: ((s: AppLifecycleState) => void) | null = null;
    const appLifecycle: AppLifecyclePort = {
      subscribe(listener) {
        lifecycleListener = listener;
        return () => {
          lifecycleListener = null;
        };
      },
    };

    const view = await render(
      <AppProviders preferencesStore={preferencesStore} systemLocale="en">
        <AppShell catalog={catalog} videoHost={createFakeHost()} appLifecycle={appLifecycle} />
      </AppProviders>,
    );

    await waitFor(() => expect(screen.getByTestId('home-screen')).toBeTruthy());
    expect(flushCatalog).not.toHaveBeenCalled();
    expect(flushPrefs).not.toHaveBeenCalled();

    await act(async () => {
      lifecycleListener?.('background');
    });
    expect(flushCatalog).toHaveBeenCalledTimes(1);
    expect(flushPrefs).toHaveBeenCalledTimes(1);

    await view.unmount();
    expect(flushCatalog).toHaveBeenCalledTimes(2);
    expect(flushPrefs.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
