import type { ItemRow, WatchProgressRow } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, type ViewportOverride, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, ScrollView, StyleSheet } from 'react-native';
import { CatalogDiscoveryScreen } from '../CatalogDiscoveryScreen';
import * as catalogModel from '../catalog-model';
import {
  createAndroidSource,
  createMockCatalog,
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

describe('CatalogDiscoveryScreen — grid hydration, touch, and TV focus', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses >= 40x40 touch targets on Portrait touch and quantizes grid scroll prefetch without duplicating progress keys', async () => {
    const bigCat = makeCategory(0, { name: 'Documentaries', itemCount: 1_500 });
    const { catalog, itemsCalls, progressCalls } = createMockCatalog({
      categories: [bigCat],
      itemsByCategory: new Map(),
      dynamicCategory: { id: bigCat.id, count: 1_500, kind: 'movie' },
    });

    const view = await renderCatalog(
      { catalog, sources: [makeSource()] },
      {
        viewport: {
          formFactor: 'phone',
          orientation: 'portrait',
          inputModality: 'touch',
          width: 390,
          height: 844,
        },
      },
    );

    await waitFor(() => {
      expect(screen.getByTestId('catalog-rail-see-all-0')).toBeTruthy();
    });

    const seeAllStyle = StyleSheet.flatten(
      screen.getByTestId('catalog-rail-see-all-0').props.style,
    );
    expect(seeAllStyle.minHeight).toBeGreaterThanOrEqual(40);
    expect(seeAllStyle.minWidth).toBeGreaterThanOrEqual(40);

    await fireEvent.press(screen.getByTestId('catalog-rail-see-all-0'));
    await waitFor(() => {
      expect(screen.getByTestId('catalog-grid-back')).toBeTruthy();
      expect(screen.getByTestId('catalog-grid-item-0')).toBeTruthy();
    });

    const backStyle = StyleSheet.flatten(screen.getByTestId('catalog-grid-back').props.style);
    expect(backStyle.minHeight).toBeGreaterThanOrEqual(40);
    expect(backStyle.minWidth).toBeGreaterThanOrEqual(40);

    const callsBefore = itemsCalls.length;
    const progressBefore = progressCalls.length;
    const list = screen.getByTestId('catalog-grid-list');
    await fireEvent.scroll(list, {
      nativeEvent: {
        contentOffset: { x: 0, y: 10 },
        contentSize: { width: 390, height: 100_000 },
        layoutMeasurement: { width: 390, height: 600 },
      },
    });
    await fireEvent.scroll(list, {
      nativeEvent: {
        contentOffset: { x: 0, y: 20 },
        contentSize: { width: 390, height: 100_000 },
        layoutMeasurement: { width: 390, height: 600 },
      },
    });
    expect(itemsCalls.length).toBe(callsBefore);
    expect(progressCalls.length).toBe(progressBefore);

    await view.unmount();
  });

  it('recovers cleanly to Discovery rails when memory holds a stale selectedCategoryId', async () => {
    const cat0 = makeCategory(0, { name: 'Sci-Fi', itemCount: 2 });
    const items = [makeItem(0, 0), makeItem(0, 1)];
    const { catalog } = createMockCatalog({
      categories: [cat0],
      itemsByCategory: new Map([[cat0.id, items]]),
    });

    const onMemoryChange = jest.fn();
    const view = await renderCatalog({
      catalog,
      sources: [makeSource()],
      memory: {
        selectedCategoryId: 'src-1|movie|deleted-category',
        visibleCategoryCount: 8,
      },
      onMemoryChange,
    });

    await waitFor(() => {
      expect(screen.getByTestId('catalog-rail-0-item-0')).toBeTruthy();
    });
    expect(screen.queryByTestId('catalog-grid')).toBeNull();
    expect(onMemoryChange).toHaveBeenCalledWith(
      expect.objectContaining({ selectedCategoryId: null }),
    );

    await view.unmount();
  });

  it('re-hydrates visible CategoryGridView watch progress immediately when userStateVersion increments without scrolling', async () => {
    const cat0 = makeCategory(0, { name: 'Drama', itemCount: 2 });
    const item0 = makeItem(0, 0);
    const item1 = makeItem(0, 1);
    const progressMap = new Map<string, WatchProgressRow>();
    const { catalog } = createMockCatalog({
      categories: [cat0],
      itemsByCategory: new Map([[cat0.id, [item0, item1]]]),
      progressByKey: progressMap,
    });

    const stableSources = [makeSource()];
    const stableViewport: ViewportOverride = {
      formFactor: 'desktop',
      orientation: 'landscape',
      inputModality: 'pointer',
      width: 1280,
      height: 800,
    };
    const stableI18n = createAppI18n('en');
    const stableMemory = {
      selectedCategoryId: cat0.id,
      visibleCategoryCount: 8,
    };
    const onOpenDetail = jest.fn();
    const onOpenSources = jest.fn();

    const buildTree = (userStateVersion: number) => (
      <ViewportProvider value={stableViewport}>
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={stableI18n}>
            <CatalogDiscoveryScreen
              kind="movie"
              catalog={catalog}
              sources={stableSources}
              refreshToken={1}
              userStateVersion={userStateVersion}
              memory={stableMemory}
              onOpenDetail={onOpenDetail}
              onOpenSources={onOpenSources}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    const view = await render(buildTree(1));
    await waitFor(() => {
      expect(screen.getByTestId('catalog-grid-item-0')).toBeTruthy();
    });
    expect(screen.queryByTestId('catalog-grid-item-0-badge')).toBeNull();

    progressMap.set(
      item0.key,
      makeProgress(item0.key, { positionMs: 3_600_000, durationMs: 3_600_000, watched: true }),
    );
    await view.rerender(buildTree(2));

    await waitFor(() => {
      expect(screen.getByTestId('catalog-grid-item-0-badge')).toBeTruthy();
    });

    await view.unmount();
  });

  it('memoizes TV grid row slices across Left/Right focus, auto-scrolls TV category chips, and scrolls Load More into view', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const scrollToSpy = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
    const scrollToEndSpy = jest
      .spyOn(ScrollView.prototype, 'scrollToEnd')
      .mockImplementation(() => {});

    const categories = Array.from({ length: 10 }, (_, i) =>
      makeCategory(i, { name: `Genre ${i}`, itemCount: 10 }),
    );
    const itemsByCategory = new Map<string, ItemRow[]>(
      categories.map((c, i) => [c.id, Array.from({ length: 10 }, (_, j) => makeItem(i, j))]),
    );
    const { catalog } = createMockCatalog({ categories, itemsByCategory });
    const { source: androidSource, sendKey } = createAndroidSource();

    const view = await renderCatalog(
      { catalog, sources: [makeSource()] },
      {
        androidSource,
        viewport: {
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1280,
          height: 720,
        },
      },
    );

    await waitFor(() => {
      expect(screen.getByTestId('catalog-rail-7-item-0')).toBeTruthy();
      expect(screen.getByTestId('catalog-load-more')).toBeTruthy();
    });

    await fireEvent(screen.getByTestId('catalog-cat-chip-1'), 'layout', {
      nativeEvent: { layout: { x: 240, y: 0, width: 100, height: 40 } },
    });
    scrollToSpy.mockClear();
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_RIGHT);
    expect(scrollToSpy).toHaveBeenCalled();

    scrollToEndSpy.mockClear();
    for (let step = 0; step < 9; step++) {
      await sendKey(KEYCODE_DPAD_DOWN);
    }
    expect(scrollToEndSpy).toHaveBeenCalled();

    for (let step = 0; step < 9; step++) {
      await sendKey(KEYCODE_DPAD_UP);
    }
    await sendKey(KEYCODE_DPAD_CENTER);

    await waitFor(() => {
      expect(screen.getByTestId('catalog-grid-tv-viewport')).toBeTruthy();
      expect(screen.getByTestId('catalog-grid-item-0')).toBeTruthy();
    });

    const chunkSpy = jest.spyOn(catalogModel, 'chunkRowItems');
    chunkSpy.mockClear();
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_LEFT);
    expect(chunkSpy).not.toHaveBeenCalled();

    await view.unmount();
  });

  it('mounts debounced AmbientBackdrop on TV focus over catalog rails (#414)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const actionCat = makeCategory(0, { name: 'Action', itemCount: 2 });
    const categories = [actionCat];
    const itemsByCategory = new Map<string, ItemRow[]>([
      [
        actionCat.id,
        [
          { ...makeItem(0, 0), logo: 'https://cdn.example/cat-0.jpg' },
          { ...makeItem(0, 1), logo: 'https://cdn.example/cat-1.jpg' },
        ],
      ],
    ]);
    const { catalog } = createMockCatalog({ categories, itemsByCategory });
    const { source: androidSource, sendKey } = createAndroidSource();

    const view = await renderCatalog(
      { catalog, sources: [makeSource()] },
      {
        androidSource,
        viewport: {
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1280,
          height: 720,
        },
      },
    );

    await waitFor(() => {
      expect(screen.getByTestId('catalog-rail-0-item-0')).toBeTruthy();
    });

    jest.useFakeTimers();
    try {
      expect(screen.queryByTestId('catalog-ambient-backdrop-movie')).toBeNull();
      await sendKey(KEYCODE_DPAD_DOWN);
      await sendKey(KEYCODE_DPAD_RIGHT);
      expect(screen.queryByTestId('catalog-ambient-backdrop-movie')).toBeNull();

      await act(async () => {
        jest.advanceTimersByTime(500);
      });
      expect(screen.getByTestId('catalog-ambient-backdrop-movie')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }

    await view.unmount();
  });
});
