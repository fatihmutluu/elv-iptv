import type { CatalogService, CategoryRow, ItemRow, SourceRow } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import {
  type CatalogLayoutMetrics,
  CatalogUiCacheProvider,
  createCatalogUiCache,
  type DisplayCategory,
} from '../../shared';
import { CatalogDiscoveryScreen } from '../CatalogDiscoveryScreen';
import { CategoryGridView } from '../CategoryGridView';

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

const CAT_A: CategoryRow = {
  id: 'src-1|movie|cat-a',
  sourceId: 'src-1',
  kind: 'movie',
  name: 'Action',
  position: 0,
  itemCount: 40,
};

const CAT_B: CategoryRow = {
  id: 'src-1|movie|cat-b',
  sourceId: 'src-1',
  kind: 'movie',
  name: 'Sci-Fi',
  position: 1,
  itemCount: 40,
};

function makeItems(prefix: string, count: number): ItemRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    key: `x:src-1:movie:${prefix}-${i + 1}`,
    sourceId: 'src-1',
    providerId: `${prefix}-${i + 1}`,
    kind: 'movie',
    name: `${prefix} Movie ${i + 1}`,
    logo: null,
    rating: 8.1,
    year: 2025,
    num: null,
  }));
}

function makeLayout(overrides?: Partial<CatalogLayoutMetrics>): CatalogLayoutMetrics {
  return {
    isTv: false,
    isPortrait: false,
    isTouch: false,
    padX: 24,
    railGap: 14,
    gridGap: 14,
    heroTopClearance: 64,
    posterRailWidth: 160,
    wideRailWidth: 280,
    gridColumns: 4,
    gridCardWidth: 160,
    gridRowHeight: 200,
    visibleGridRows: 3,
    ...overrides,
  };
}

describe('CatalogDiscovery & CategoryGridView zero-blink + tvOS edge fade (#445, #230)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps existing rails and categories visible during refreshToken bump instead of wiping to skeleton', async () => {
    const refreshCatsGate = deferred<readonly CategoryRow[]>();
    let catCalls = 0;
    const catalog = {
      listSources: jest.fn(async () => [SOURCE]),
      categories: jest.fn(async () => {
        catCalls += 1;
        if (catCalls === 1) return [CAT_A];
        return refreshCatsGate.promise;
      }),
      items: jest.fn(async () => makeItems('Action', 3)),
      listContinueWatching: jest.fn(async () => []),
      listProgressByKeys: jest.fn(async () => []),
      close: jest.fn(async () => undefined),
    } as unknown as CatalogService;

    const uiCache = createCatalogUiCache({ locale: 'en' });
    const renderScreen = (refreshToken: number) => (
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
              <CatalogDiscoveryScreen
                kind="movie"
                catalog={catalog}
                sources={[SOURCE]}
                refreshToken={refreshToken}
                onOpenDetail={jest.fn()}
                onOpenSources={jest.fn()}
              />
            </CatalogUiCacheProvider>
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    const view = await render(renderScreen(1));
    await waitFor(() => {
      expect(screen.getByText('Action Movie 1')).toBeTruthy();
    });

    // Bump refreshToken while new categories are still pending -> MUST keep existing rails visible!
    await view.rerender(renderScreen(2));
    expect(screen.queryByTestId('catalog-skeleton')).toBeNull();
    expect(screen.getByText('Action Movie 1')).toBeTruthy();

    await act(async () => {
      refreshCatsGate.resolve([CAT_A]);
    });
    await view.unmount();
  });

  it('hydrates CategoryGridView page 0 synchronously from CatalogUiCache and renders TvScrollEdgeFade on tvOS', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const uiCache = createCatalogUiCache({ locale: 'en' });
    const cachedAction = makeItems('CachedAction', 40);
    uiCache.setGridFirstPage('movie', CAT_A.id, cachedAction);

    const catBGate = deferred<readonly ItemRow[]>();
    const catalog = {
      items: jest.fn((catId: string) =>
        catId === CAT_B.id ? catBGate.promise : Promise.resolve(cachedAction),
      ),
      listProgressByKeys: jest.fn(async () => []),
    } as unknown as CatalogService;

    const displayA: DisplayCategory = { row: CAT_A, label: CAT_A.name };
    const displayB: DisplayCategory = { row: CAT_B, label: CAT_B.name };

    const renderGrid = (category: DisplayCategory, focusedRow: number) => (
      <ViewportProvider
        value={{
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        }}
      >
        <ThemeProvider>
          <I18nProvider i18n={createAppI18n('en')}>
            <CatalogUiCacheProvider cache={uiCache}>
              <CategoryGridView
                kind="movie"
                category={category}
                catalog={catalog}
                refreshToken={1}
                userStateVersion={0}
                layout={makeLayout({ isTv: true, gridColumns: 4, visibleGridRows: 3 })}
                backFocused={false}
                focusedGridPos={{ row: focusedRow, col: 0 }}
                onBack={jest.fn()}
                onOpenDetail={jest.fn()}
              />
            </CatalogUiCacheProvider>
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    // Frame 0: CachedAction Movie 1 renders synchronously and bottom edge fade shows (not top)
    const view = await render(renderGrid(displayA, 0));
    expect(screen.getByText('CachedAction Movie 1')).toBeTruthy();
    expect(screen.queryByTestId('catalog-grid-edge-fade-top')).toBeNull();
    expect(screen.getByTestId('catalog-grid-edge-fade-bottom')).toBeTruthy();

    // Scroll down to row 4 -> BOTH top and bottom edge fades appear
    await view.rerender(renderGrid(displayA, 4));
    expect(screen.getByTestId('catalog-grid-edge-fade-top')).toBeTruthy();
    expect(screen.getByTestId('catalog-grid-edge-fade-bottom')).toBeTruthy();

    // Switch to uncached Category B -> keeps previous rows rendered until Category B page 0 resolves
    await view.rerender(renderGrid(displayB, 0));
    expect(screen.getByText('CachedAction Movie 1')).toBeTruthy();

    await act(async () => {
      catBGate.resolve(makeItems('SciFi', 40));
    });
    await waitFor(() => {
      expect(screen.getByText('SciFi Movie 1')).toBeTruthy();
    });
    expect(uiCache.getGridFirstPage('movie', CAT_B.id)?.[0]?.name).toBe('SciFi Movie 1');

    await view.unmount();
  });

  it('invalidates stale CatalogUiCache and refetches when groupVodVersions toggles on discovery and grid (#404)', async () => {
    const makeMovie = (id: number, key: string, name: string, versionCount?: number): ItemRow => ({
      id,
      key,
      sourceId: 'src-1',
      providerId: String(id),
      kind: 'movie',
      name,
      logo: null,
      rating: 8.1,
      year: 2025,
      num: null,
      ...(versionCount !== undefined ? { versionCount } : {}),
    });
    const ungroupedRows = [
      makeMovie(1, 'x:src-1:movie:Dune4K-1', 'Dune [4K]'),
      makeMovie(2, 'x:src-1:movie:Dune1080-2', 'Dune [1080p]'),
    ];
    const groupedRows = [makeMovie(1, 'x:src-1:movie:DuneGrouped-1', 'Dune (Grouped)', 2)];

    const catalog = {
      listSources: jest.fn(async () => [SOURCE]),
      categories: jest.fn(
        async (_srcId: string, _kind: string, opts?: { groupVersions?: boolean }) => [
          { ...CAT_A, itemCount: opts?.groupVersions ? 1 : 2 },
        ],
      ),
      items: jest.fn(
        async (_catId: string, _off: number, _lim: number, opts?: { groupVersions?: boolean }) =>
          opts?.groupVersions ? groupedRows : ungroupedRows,
      ),
      listContinueWatching: jest.fn(async () => []),
      listProgressByKeys: jest.fn(async () => []),
      close: jest.fn(async () => undefined),
    } as unknown as CatalogService;

    const uiCache = createCatalogUiCache({ locale: 'en' });
    const renderDiscovery = (groupVersions: boolean) => (
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
              <CatalogDiscoveryScreen
                kind="movie"
                catalog={catalog}
                sources={[SOURCE]}
                refreshToken={1}
                groupVersions={groupVersions}
                onOpenDetail={jest.fn()}
                onOpenSources={jest.fn()}
              />
            </CatalogUiCacheProvider>
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    const view1 = await render(renderDiscovery(false));
    await waitFor(() => {
      expect(screen.getByText('Dune [4K]')).toBeTruthy();
      expect(screen.getByText('Dune [1080p]')).toBeTruthy();
    });
    await view1.unmount();

    // Re-mounting Movies discovery after toggling groupVersions=true must NOT hydrate stale ungrouped cache
    const view2 = await render(renderDiscovery(true));
    await waitFor(() => {
      expect(screen.getByText('Dune (Grouped)')).toBeTruthy();
    });
    expect(screen.queryByText('Dune [1080p]')).toBeNull();
    await view2.unmount();

    // CategoryGridView live toggle from false -> true must pass groupVersions: true and update rows
    const displayA: DisplayCategory = { row: { ...CAT_A, itemCount: 2 }, label: 'Action' };
    const renderGrid = (groupVersions: boolean) => (
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
              <CategoryGridView
                kind="movie"
                category={displayA}
                catalog={catalog}
                refreshToken={1}
                userStateVersion={0}
                groupVersions={groupVersions}
                layout={makeLayout()}
                backFocused={false}
                focusedGridPos={null}
                onBack={jest.fn()}
                onOpenDetail={jest.fn()}
              />
            </CatalogUiCacheProvider>
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    const gridView = await render(renderGrid(false));
    await waitFor(() => {
      expect(screen.getByText('Dune [1080p]')).toBeTruthy();
    });
    await gridView.rerender(renderGrid(true));
    await waitFor(() => {
      expect(screen.getByText('Dune (Grouped)')).toBeTruthy();
    });
    await gridView.unmount();
  });
});
