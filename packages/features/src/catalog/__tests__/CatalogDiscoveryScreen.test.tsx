import type { CatalogService, CategoryRow, ItemRow, WatchProgressRow } from '@elv/data';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';
import type { DetailTarget } from '../../shared';
import { GRID_PAGE_SIZE } from '../catalog-model';
import {
  createAndroidSource,
  createMockCatalog,
  KEYCODE_BACK,
  KEYCODE_DPAD_CENTER,
  KEYCODE_DPAD_DOWN,
  KEYCODE_DPAD_LEFT,
  KEYCODE_DPAD_RIGHT,
  KEYCODE_DPAD_UP,
  makeCategory,
  makeItem,
  makeProgress,
  makeSource,
  renderCatalog,
} from './catalog-test-fixtures';

describe('CatalogDiscoveryScreen', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows tonal skeleton while initial categories load, then renders Discovery rails with progress and Watched badge', async () => {
    let resolveCats!: (rows: CategoryRow[]) => void;
    const cat0 = makeCategory(0, { name: 'Sci-Fi', itemCount: 2 });
    const item0 = makeItem(0, 0);
    const item1 = makeItem(0, 1);
    const pendingCatalog = {
      categories: jest.fn(
        () =>
          new Promise<CategoryRow[]>((resolve) => {
            resolveCats = resolve;
          }),
      ),
      items: jest.fn(async () => [item0, item1]),
      listProgressByKeys: jest.fn(async () => [
        makeProgress(item0.key, { positionMs: 1_800_000, durationMs: 3_600_000, watched: false }),
        makeProgress(item1.key, { positionMs: 3_600_000, durationMs: 3_600_000, watched: true }),
      ]),
    } as unknown as CatalogService;

    const onOpenDetail = jest.fn<void, [DetailTarget]>();
    const view = await renderCatalog({
      catalog: pendingCatalog,
      sources: [makeSource()],
      onOpenDetail,
    });

    expect(screen.getByTestId('catalog-screen-movie')).toBeTruthy();
    expect(screen.getByTestId('catalog-skeleton')).toBeTruthy();
    // Non-overlay CatalogSkeleton must use tight top padding (not heroTopClearance >= 80)
    const skelStyle = StyleSheet.flatten(screen.getByTestId('catalog-skeleton').props.style);
    expect(skelStyle.paddingTop).toBeLessThanOrEqual(16);

    await act(async () => {
      resolveCats([cat0]);
    });

    await waitFor(() => {
      expect(screen.getByTestId('catalog-rail-0-item-0')).toBeTruthy();
    });

    expect(screen.getByTestId('catalog-rail-0-item-0-progress')).toBeTruthy();
    expect(screen.getByTestId('catalog-rail-0-item-1-badge')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('catalog-rail-0-item-0'));
    expect(onOpenDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: item0.key,
        catalogId: item0.id,
        categoryId: cat0.id,
        kind: 'movie',
        title: item0.name,
      }),
    );

    await view.unmount();
  });

  it('drills into O(1)-memory CategoryGridView via See all or category chip without fetching all 5,000 items', async () => {
    const bigCat = makeCategory(0, { name: 'All Cinema', itemCount: 5_000 });
    const { catalog, itemsCalls } = createMockCatalog({
      categories: [bigCat],
      itemsByCategory: new Map(),
      dynamicCategory: { id: bigCat.id, count: 5_000, kind: 'movie' },
    });

    const onOpenDetail = jest.fn<void, [DetailTarget]>();
    const view = await renderCatalog({
      catalog,
      sources: [makeSource()],
      onOpenDetail,
    });

    await waitFor(() => {
      expect(screen.getByTestId('catalog-rail-see-all-0')).toBeTruthy();
    });

    itemsCalls.length = 0;
    await fireEvent.press(screen.getByTestId('catalog-rail-see-all-0'));

    await waitFor(() => {
      expect(screen.getByTestId('catalog-grid')).toBeTruthy();
      expect(screen.getByTestId('catalog-grid-item-0')).toBeTruthy();
    });

    // Must ONLY request bounded initial page(s) (<= GRID_PAGE_SIZE), NEVER all 5,000 items!
    expect(itemsCalls.length).toBeGreaterThanOrEqual(1);
    expect(itemsCalls.length).toBeLessThanOrEqual(2);
    for (const call of itemsCalls) {
      expect(call.limit).toBeLessThanOrEqual(GRID_PAGE_SIZE);
    }

    await fireEvent.press(screen.getByTestId('catalog-grid-item-0'));
    expect(onOpenDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'movie:c0:i0',
        categoryId: bigCat.id,
        catalogId: 1,
      }),
    );

    // Back button returns cleanly to Discovery Mode
    await fireEvent.press(screen.getByTestId('catalog-grid-back'));
    await waitFor(() => {
      expect(screen.getByTestId('catalog-rail-0')).toBeTruthy();
    });

    // Category chip also opens CategoryGridView and All chip returns to Discovery Mode
    await fireEvent.press(screen.getByTestId('catalog-cat-chip-0'));
    await waitFor(() => {
      expect(screen.getByTestId('catalog-grid')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('catalog-cat-chip-all'));
    await waitFor(() => {
      expect(screen.getByTestId('catalog-rail-0')).toBeTruthy();
    });

    await view.unmount();
  });

  it('renders top 16:9 Continue watching rail filtered by kind, uses EditorialCategoryBar, and omits watch-status pill chips', async () => {
    const categories = Array.from({ length: 8 }, (_, i) => makeCategory(i, { itemCount: 2 }));
    const itemsByCategory = new Map<string, ItemRow[]>(
      categories.map((c, i) => [c.id, [makeItem(i, 0), makeItem(i, 1)]]),
    );
    const continueWatching: WatchProgressRow[] = [
      makeProgress('movie:resume-1', {
        kind: 'movie',
        title: 'Resumed Film',
        positionMs: 1_200_000,
        durationMs: 3_600_000,
      }),
      makeProgress('ep:resume-1', {
        kind: 'episode',
        seriesKey: 'series:resume-1',
        title: 'Resumed Show',
        subtitle: 'S1 E2',
        positionMs: 900_000,
        durationMs: 2_700_000,
      }),
    ];

    const { catalog } = createMockCatalog({ categories, itemsByCategory, continueWatching });
    const onOpenDetail = jest.fn<void, [DetailTarget]>();
    const view = await renderCatalog({ catalog, sources: [makeSource()], onOpenDetail });

    await waitFor(() => {
      expect(screen.getByTestId('catalog-continue-rail')).toBeTruthy();
      expect(screen.getByTestId('catalog-continue-item-0')).toBeTruthy();
    });

    // Only the movie continue-watching item appears on Movies tab; zero watch-status pill chips
    expect(screen.queryByTestId('catalog-continue-item-1')).toBeNull();
    expect(screen.queryByTestId('catalog-status-all')).toBeNull();
    expect(screen.queryByTestId('catalog-status-watched')).toBeNull();

    // EditorialCategoryBar renders with Categories dropdown trigger when > 6 categories
    expect(screen.getByTestId('catalog-category-chips')).toBeTruthy();
    expect(screen.getByTestId('catalog-category-chips-picker-trigger')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('catalog-continue-item-0'));
    expect(onOpenDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'movie:resume-1',
        kind: 'movie',
        title: 'Resumed Film',
      }),
    );

    await view.unmount();
  });

  it('progressively loads only the first 8 categories and expands on Load more categories', async () => {
    const categories = Array.from({ length: 12 }, (_, i) => makeCategory(i, { itemCount: 2 }));
    const itemsByCategory = new Map<string, ItemRow[]>(
      categories.map((c, i) => [c.id, [makeItem(i, 0), makeItem(i, 1)]]),
    );
    const { catalog, itemsCalls } = createMockCatalog({ categories, itemsByCategory });

    const view = await renderCatalog({ catalog, sources: [makeSource()] });

    await waitFor(() => {
      expect(screen.getByTestId('catalog-rail-7-item-0')).toBeTruthy();
      expect(screen.getByTestId('catalog-load-more')).toBeTruthy();
    });

    expect(itemsCalls).toHaveLength(8);
    expect(screen.queryByTestId('catalog-rail-8')).toBeNull();

    await fireEvent.press(screen.getByTestId('catalog-load-more'));

    await waitFor(() => {
      expect(screen.getByTestId('catalog-rail-11-item-0')).toBeTruthy();
    });
    expect(itemsCalls).toHaveLength(12);
    expect(screen.queryByTestId('catalog-load-more')).toBeNull();

    await view.unmount();
  });

  it('renders constructive empty states when no sources or no categories exist', async () => {
    const onOpenSources = jest.fn();
    const { catalog } = createMockCatalog({ categories: [], itemsByCategory: new Map() });

    const view1 = await renderCatalog({ catalog, sources: [], onOpenSources });
    await waitFor(() => {
      expect(screen.getByTestId('catalog-empty-sources')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('catalog-open-sources'));
    expect(onOpenSources).toHaveBeenCalledTimes(1);
    await view1.unmount();

    const view2 = await renderCatalog({ catalog, sources: [makeSource()] });
    await waitFor(() => {
      expect(screen.getByTestId('catalog-empty-categories')).toBeTruthy();
    });
    await view2.unmount();
  });

  it('supports 10-ft TV D-pad navigation across Discovery rails and O(1) 2D TV Grid with focusable={false} and non-clipping strip padding', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    {
      const bigCat = makeCategory(0, { name: 'Action', itemCount: 5_000 });
      const { catalog } = createMockCatalog({
        categories: [bigCat],
        itemsByCategory: new Map(),
        dynamicCategory: { id: bigCat.id, count: 5_000, kind: 'movie' },
      });

      const { source: androidSource, sendKey } = createAndroidSource();
      const onOpenDetail = jest.fn<void, [DetailTarget]>();
      const onFocusTopNav = jest.fn();

      const view = await renderCatalog(
        { catalog, sources: [makeSource()], onOpenDetail, onFocusTopNav },
        {
          androidSource,
          viewport: {
            formFactor: 'tv',
            orientation: 'landscape',
            inputModality: 'tv',
            width: 1920,
            height: 1080,
          },
        },
      );

      await waitFor(() => {
        expect(
          screen.getByTestId('catalog-tv-focus-anchor-movie', { includeHiddenElements: true }),
        ).toBeTruthy();
        expect(screen.getByTestId('catalog-rail-0-item-1')).toBeTruthy();
      });

      // Every interactive element uses focusable={false} on TV and rail strip has non-clipping TV padding
      expect(screen.getByTestId('catalog-cat-chip-all').props.focusable).toBe(false);
      expect(screen.getByTestId('catalog-rail-see-all-0').props.focusable).toBe(false);
      expect(screen.getByTestId('catalog-rail-0-item-0').props.focusable).toBe(false);

      const stripStyle = StyleSheet.flatten(
        screen.getByTestId('catalog-rail-0-strip-scroll').props.contentContainerStyle,
      );
      expect(stripStyle.paddingTop).toBeGreaterThanOrEqual(18);
      expect(stripStyle.paddingBottom).toBeGreaterThanOrEqual(20);

      // Up from top row (catChips) hands focus to Top Nav
      await sendKey(KEYCODE_DPAD_UP);
      expect(onFocusTopNav).toHaveBeenCalledTimes(1);

      // Navigate down -> rail-0 -> right -> item 1 -> select
      await sendKey(KEYCODE_DPAD_DOWN);
      await sendKey(KEYCODE_DPAD_RIGHT);
      await sendKey(KEYCODE_DPAD_CENTER);

      expect(onOpenDetail).toHaveBeenCalledWith(
        expect.objectContaining({ itemKey: 'movie:c0:i1', categoryId: bigCat.id }),
      );

      // Navigate back up to catChips, move right to Action chip, select -> enters O(1) TV Grid
      await sendKey(KEYCODE_DPAD_UP);
      await sendKey(KEYCODE_DPAD_RIGHT);
      await sendKey(KEYCODE_DPAD_CENTER);

      await waitFor(() => {
        expect(screen.getByTestId('catalog-grid-tv-viewport')).toBeTruthy();
        expect(screen.getByTestId('catalog-grid-item-0')).toBeTruthy();
      });

      // O(1) TV viewport must mount only a small bounded window (never row 100!)
      expect(screen.queryByTestId('catalog-grid-item-500')).toBeNull();

      // 2D TV Grid navigation: right -> right -> left -> (0,1), down -> (1,1) = index 10 in 9-column 1920px TV grid, select!
      onOpenDetail.mockClear();
      await sendKey(KEYCODE_DPAD_RIGHT);
      await sendKey(KEYCODE_DPAD_RIGHT);
      await sendKey(KEYCODE_DPAD_LEFT);
      await sendKey(KEYCODE_DPAD_DOWN);
      await sendKey(KEYCODE_DPAD_CENTER);

      expect(onOpenDetail).toHaveBeenCalledWith(
        expect.objectContaining({ itemKey: 'movie:c0:i10', categoryId: bigCat.id }),
      );

      // Back in Grid returns cleanly to Discovery Mode (without calling onFocusTopNav)
      onFocusTopNav.mockClear();
      await sendKey(KEYCODE_BACK);
      await waitFor(() => {
        expect(screen.getByTestId('catalog-rail-0')).toBeTruthy();
      });
      expect(onFocusTopNav).not.toHaveBeenCalled();

      // Back in Discovery hands focus to Top Nav
      await sendKey(KEYCODE_BACK);
      expect(onFocusTopNav).toHaveBeenCalledTimes(1);

      await view.unmount();
    }
  });

  it('renders cleanly in Series mode and under High Contrast (AAA) theme', async () => {
    const seriesCat = makeCategory(0, { kind: 'series', name: 'Dramas', itemCount: 2 });
    const items = [makeItem(0, 0, 'series'), makeItem(0, 1, 'series')];
    const { catalog } = createMockCatalog({
      categories: [seriesCat],
      itemsByCategory: new Map([[seriesCat.id, items]]),
    });

    const view = await renderCatalog(
      { kind: 'series', catalog, sources: [makeSource()] },
      { preset: 'highContrast' },
    );

    await waitFor(() => {
      expect(screen.getByTestId('catalog-screen-series')).toBeTruthy();
      expect(screen.getByText('Series')).toBeTruthy();
      expect(screen.getByTestId('catalog-rail-0-item-0')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('catalog-cat-chip-0'));
    await waitFor(() => {
      expect(screen.getByTestId('catalog-grid-back')).toBeTruthy();
      expect(screen.getByText('Back to Series')).toBeTruthy();
    });

    await view.unmount();
  });
});
