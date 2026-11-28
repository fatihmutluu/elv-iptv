import type {
  CatalogService,
  CategoryRow,
  ItemRow,
  SeriesUnplayedSummary,
  SourceRow,
} from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import { CatalogDiscoveryScreen, DetailScreen, HomeScreen } from '../index';
import type { PlayTarget } from '../ports/play-target';
import type { DetailTarget } from '../shared';
import { PosterHoverPreviewProvider } from '../shared/PosterHoverPreviewContext';
import { PosterHoverPreviewHost } from '../shared/PosterHoverPreviewHost';
import { HOVER_PREVIEW_OPEN_DELAY_MS } from '../shared/poster-hover-preview-model';

const SOURCE: SourceRow = {
  id: 's1',
  kind: 'xtream',
  name: 'Demo',
  createdAt: 1,
  needsImport: false,
};

const MOVIE_CAT: CategoryRow = {
  id: 's1|movie|c1',
  sourceId: 's1',
  kind: 'movie',
  name: 'Sci-Fi',
  position: 0,
  itemCount: 2,
};

const SERIES_CAT: CategoryRow = {
  id: 's1|series|c1',
  sourceId: 's1',
  kind: 'series',
  name: 'Drama Series',
  position: 0,
  itemCount: 2,
};

const MOVIE_1: ItemRow = {
  id: 101,
  key: 'x:s1:movie:101',
  kind: 'movie',
  sourceId: 's1',
  providerId: '101',
  name: 'Dune',
  logo: 'https://art.example.test/dune.jpg',
  rating: 8.5,
  year: 2024,
  num: null,
};

const SERIES_1: ItemRow = {
  id: 201,
  key: 'x:s1:series:201',
  kind: 'series',
  sourceId: 's1',
  providerId: '201',
  name: 'Severance',
  logo: 'https://art.example.test/sev.jpg',
  rating: 8.7,
  year: 2022,
  num: null,
};

const SERIES_2: ItemRow = {
  id: 202,
  key: 'x:s1:series:202',
  kind: 'series',
  sourceId: 's1',
  providerId: '202',
  name: 'Andor',
  logo: 'https://art.example.test/andor.jpg',
  rating: 8.4,
  year: 2022,
  num: null,
};

function createTestCatalog(overrides: Partial<CatalogService> = {}): CatalogService {
  const unplayed: SeriesUnplayedSummary[] = [
    { seriesKey: SERIES_1.key, total: 10, unplayed: 4, watched: false },
    { seriesKey: SERIES_2.key, total: 12, unplayed: 0, watched: true },
  ];

  return {
    addSource: jest.fn(),
    addSourceFromLink: jest.fn(),
    removeSource: jest.fn(),
    importSource: jest.fn(),
    listSources: jest.fn(async () => [SOURCE]),
    categories: jest.fn(async (_src, kind) =>
      kind === 'movie' ? [MOVIE_CAT] : kind === 'series' ? [SERIES_CAT] : [],
    ),
    items: jest.fn(async (catId) => {
      if (catId === MOVIE_CAT.id) return [MOVIE_1];
      if (catId === SERIES_CAT.id) return [SERIES_1, SERIES_2];
      return [];
    }),
    seasons: jest.fn(async () => ok([])),
    episodes: jest.fn(async () => []),
    resolveStream: jest.fn(),
    listContinueWatching: jest.fn(async () => []),
    listFavorites: jest.fn(async () => []),
    listFavoriteKeys: jest.fn(async () => []),
    listProgressByKeys: jest.fn(async () => []),
    listSeriesUnplayedCounts: jest.fn(async (keys: readonly string[]) =>
      unplayed.filter((u) => keys.includes(u.seriesKey)),
    ),
    toggleFavorite: jest.fn(async () => ok(true)),
    setWatched: jest.fn(async () => ok(undefined)),
    close: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as CatalogService;
}

function DesktopHoverShell({
  catalog,
  onPlay = jest.fn(),
  onOpenDetail = jest.fn(),
  children,
}: {
  readonly catalog: CatalogService;
  readonly onPlay?: (target: PlayTarget) => void;
  readonly onOpenDetail?: (target: DetailTarget) => void;
  readonly children: ReactNode;
}) {
  const i18n = createAppI18n('en');
  return (
    <I18nProvider i18n={i18n}>
      <ThemeProvider>
        <ViewportProvider
          value={{ formFactor: 'desktop', orientation: 'landscape', inputModality: 'pointer' }}
        >
          <PosterHoverPreviewProvider catalog={catalog} catalogRevision={1}>
            {children}
            <PosterHoverPreviewHost onPlay={onPlay} onOpenDetail={onOpenDetail} />
          </PosterHoverPreviewProvider>
        </ViewportProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}

describe('Desktop card hover preview & series watched badges (#409, #502, Wave R3)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('shows all-watched checkmark without numeric unplayed counts on Series cards and opens Expanded Hover Preview without legacy bottom-right buttons', async () => {
    const osReplacer = jest.replaceProperty(Platform, 'OS', 'web');
    const catalog = createTestCatalog();
    const onPlay = jest.fn();
    const onOpenDetail = jest.fn();

    try {
      await render(
        <DesktopHoverShell catalog={catalog} onPlay={onPlay} onOpenDetail={onOpenDetail}>
          <HomeScreen
            catalog={catalog}
            sources={[SOURCE]}
            refreshToken={0}
            onPlay={onPlay}
            onOpenTab={jest.fn()}
            onOpenDetail={onOpenDetail}
            onOpenSources={jest.fn()}
          />
        </DesktopHoverShell>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('home-series-item-1-watched-badge')).toBeTruthy();
      });
      expect(screen.queryByTestId('home-series-item-0-unplayed')).toBeNull();
      expect(screen.queryByTestId('home-series-item-0-watched-badge')).toBeNull();
      expect(screen.queryByTestId('home-series-item-1-unplayed')).toBeNull();

      const movieCard = screen.getByTestId('home-movies-item-0');
      await fireEvent(movieCard, 'pointerEnter');
      expect(screen.queryByTestId('home-movies-item-0-quick-play')).toBeNull();
      expect(screen.queryByTestId('home-movies-item-0-quick-favorite')).toBeNull();
      expect(screen.queryByTestId('home-movies-item-0-quick-watched')).toBeNull();

      await act(async () => {
        jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS);
        await Promise.resolve();
      });

      const playBtn = screen.getByTestId('hover-preview-play');
      await fireEvent.press(playBtn);
      expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ itemKey: MOVIE_1.key }));
      expect(onOpenDetail).not.toHaveBeenCalled();
    } finally {
      osReplacer.restore();
    }
  });

  it('unwatches an all-episodes-watched series via Hover Preview with optimistic badge clear and rollback on failure', async () => {
    const osReplacer = jest.replaceProperty(Platform, 'OS', 'web');
    let rejectUnwatch!: (err: Error) => void;
    const setWatched = jest.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectUnwatch = reject;
        }),
    );
    const catalog = createTestCatalog({ setWatched });

    try {
      await render(
        <DesktopHoverShell catalog={catalog}>
          <HomeScreen
            catalog={catalog}
            sources={[SOURCE]}
            refreshToken={0}
            onPlay={jest.fn()}
            onOpenTab={jest.fn()}
            onOpenDetail={jest.fn()}
            onOpenSources={jest.fn()}
          />
        </DesktopHoverShell>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('home-series-item-1-watched-badge')).toBeTruthy();
      });

      await fireEvent(screen.getByTestId('home-series-item-1'), 'pointerEnter');
      await act(async () => {
        jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS);
        await Promise.resolve();
      });

      const watchedBtn = screen.getByTestId('hover-preview-watched');
      expect(watchedBtn.props.accessibilityState?.selected).toBe(true);

      await fireEvent.press(watchedBtn);
      expect(setWatched).toHaveBeenCalledWith(SERIES_2.key, false);
      expect(screen.queryByTestId('home-series-item-1-watched-badge')).toBeNull();
      expect(screen.queryByTestId('home-series-item-1-unplayed')).toBeNull();

      await act(async () => {
        rejectUnwatch(new Error('sqlite-busy'));
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(screen.getByTestId('home-series-item-1-watched-badge')).toBeTruthy();
      });
    } finally {
      osReplacer.restore();
    }
  });

  it('optimistically toggles Favorite & Watched via Hover Preview on CatalogDiscoveryScreen and rolls back on rejection', async () => {
    const osReplacer = jest.replaceProperty(Platform, 'OS', 'web');
    let rejectFav!: (err: Error) => void;
    let rejectWatched!: (err: Error) => void;
    const toggleFavorite = jest.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectFav = reject;
        }),
    );
    const setWatched = jest.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectWatched = reject;
        }),
    );
    const catalog = createTestCatalog({ toggleFavorite, setWatched });
    const onPlay = jest.fn();
    const onOpenDetail = jest.fn();

    try {
      await render(
        <DesktopHoverShell catalog={catalog} onPlay={onPlay} onOpenDetail={onOpenDetail}>
          <CatalogDiscoveryScreen
            kind="movie"
            catalog={catalog}
            sources={[SOURCE]}
            refreshToken={0}
            onPlay={onPlay}
            onOpenDetail={onOpenDetail}
            onOpenSources={jest.fn()}
          />
        </DesktopHoverShell>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('catalog-rail-0-item-0')).toBeTruthy();
      });

      await fireEvent(screen.getByTestId('catalog-rail-0-item-0'), 'pointerEnter');
      expect(screen.queryByTestId('catalog-rail-0-item-0-quick-play')).toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS);
        await Promise.resolve();
      });

      // Optimistic Favorite toggle -> true -> rollback on rejection -> false
      const favBtn = screen.getByTestId('hover-preview-mylist');
      expect(favBtn.props.accessibilityState?.selected).toBe(false);
      await fireEvent.press(favBtn);
      expect(screen.getByTestId('hover-preview-mylist').props.accessibilityState?.selected).toBe(
        true,
      );

      await act(async () => {
        rejectFav(new Error('sqlite-busy'));
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(screen.getByTestId('hover-preview-mylist').props.accessibilityState?.selected).toBe(
          false,
        );
      });

      // Optimistic Watched toggle -> true -> rollback on rejection -> false
      const watchedBtn = screen.getByTestId('hover-preview-watched');
      expect(watchedBtn.props.accessibilityState?.selected).toBe(false);
      await fireEvent.press(watchedBtn);
      expect(screen.getByTestId('hover-preview-watched').props.accessibilityState?.selected).toBe(
        true,
      );

      await act(async () => {
        rejectWatched(new Error('sqlite-busy'));
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(screen.getByTestId('hover-preview-watched').props.accessibilityState?.selected).toBe(
          false,
        );
      });

      // Play button on hover preview plays movie directly without opening DetailScreen
      await fireEvent.press(screen.getByTestId('hover-preview-play'));
      expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ itemKey: MOVIE_1.key }));
      expect(onOpenDetail).not.toHaveBeenCalled();
    } finally {
      osReplacer.restore();
    }
  });

  it('shows all-watched checkmarks without numeric unplayed counts in CatalogDiscoveryScreen rails, CategoryGridView, and DetailRelatedRail', async () => {
    const catalog = createTestCatalog();
    const i18n = createAppI18n('en');

    const catalogView = await render(
      <I18nProvider i18n={i18n}>
        <ThemeProvider>
          <ViewportProvider value={{ formFactor: 'desktop', orientation: 'landscape' }}>
            <CatalogDiscoveryScreen
              kind="series"
              catalog={catalog}
              sources={[SOURCE]}
              refreshToken={0}
              onOpenDetail={jest.fn()}
              onOpenSources={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('catalog-rail-0-item-1-watched-badge')).toBeTruthy();
    });
    expect(screen.queryByTestId('catalog-rail-0-item-0-unplayed')).toBeNull();
    expect(screen.queryByTestId('catalog-rail-0-item-0-watched-badge')).toBeNull();

    // Drill into CategoryGridView via See All
    await fireEvent.press(screen.getByTestId('catalog-rail-see-all-0'));
    await waitFor(() => {
      expect(screen.getByTestId('catalog-grid-item-1-watched-badge')).toBeTruthy();
    });
    expect(screen.queryByTestId('catalog-grid-item-0-unplayed')).toBeNull();
    expect(screen.queryByTestId('catalog-grid-item-0-watched-badge')).toBeNull();
    await catalogView.unmount();

    // DetailScreen related rail for series shows watched checkmark without numeric unplayed pill
    await render(
      <I18nProvider i18n={i18n}>
        <ThemeProvider>
          <ViewportProvider value={{ formFactor: 'desktop', orientation: 'landscape' }}>
            <DetailScreen
              target={{
                kind: 'series',
                itemKey: 'x:s1:series:999',
                sourceId: 's1',
                title: 'Root Show',
                categoryId: SERIES_CAT.id,
                posterUri: null,
                backdropUri: null,
                year: null,
                rating: null,
              }}
              catalog={catalog}
              refreshToken={0}
              onBack={jest.fn()}
              onPlay={jest.fn()}
              onOpenDetail={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('detail-related-item-1-watched-badge')).toBeTruthy();
    });
    expect(screen.queryByTestId('detail-related-item-0-unplayed')).toBeNull();
    expect(screen.queryByTestId('detail-related-item-0-watched-badge')).toBeNull();
  });
});
