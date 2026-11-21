import type { CatalogService, ItemRow } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, VirtualizedList } from 'react-native';
import type { CatalogLayoutMetrics, DisplayCategory } from '../../shared';
import { CategoryGridView } from '../CategoryGridView';

function makeItems(count: number): readonly ItemRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    key: `movie:src-1:${i + 1}`,
    sourceId: 'src-1',
    providerId: String(i + 1),
    kind: 'movie' as const,
    name: `Film ${i + 1}`,
    logo: null,
    rating: null,
    year: 2025,
    num: null,
  }));
}

function makeCatalog(items: readonly ItemRow[]): CatalogService {
  return {
    listSources: jest.fn(async () => []),
    addSource: jest.fn(),
    addSourceFromLink: jest.fn(),
    removeSource: jest.fn(),
    importSource: jest.fn(),
    categories: jest.fn(async () => []),
    items: jest.fn(async (_catId: string, offset: number, limit: number) =>
      items.slice(offset, offset + limit),
    ),
    seasons: jest.fn(async () => []),
    episodes: jest.fn(async () => []),
    resolveStream: jest.fn(),
    listProgressByKeys: jest.fn(async () => new Map()),
    close: jest.fn(async () => undefined),
  } as unknown as CatalogService;
}

const CATEGORY: DisplayCategory = {
  row: {
    id: 'src-1|movie|cat-1',
    sourceId: 'src-1',
    kind: 'movie',
    name: 'Action',
    position: 0,
    itemCount: 40,
  },
  label: 'Action',
};

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
    gridColumns: 4,
    gridCardWidth: 160,
    gridRowHeight: 200,
    visibleGridRows: 3,
    ...overrides,
  };
}

describe('CategoryGridView layout, padding/border math, and resize handling (#166)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('aligns getItemLayout and contentContainerStyle paddingTop/borderTopWidth, captures viewportHeight onLayout, and preserves scrollOffset across resize', async () => {
    const scrollToOffsetSpy = jest
      .spyOn(VirtualizedList.prototype, 'scrollToOffset')
      .mockImplementation(() => undefined);

    const catalog = makeCatalog(makeItems(40));
    const renderGrid = (
      layout: CatalogLayoutMetrics,
      focusedGridPos: { row: number; col: number } | null,
    ) => (
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
            <CategoryGridView
              kind="movie"
              category={CATEGORY}
              catalog={catalog}
              watchFilter="all"
              refreshToken={0}
              userStateVersion={0}
              layout={layout}
              backFocused={false}
              filterResetFocused={false}
              focusedGridPos={focusedGridPos}
              contentPaddingTop={16}
              borderTopWidth={4}
              onBack={jest.fn()}
              onResetFilter={jest.fn()}
              onOpenDetail={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    const layout4Cols = makeLayout({ gridColumns: 4, visibleGridRows: 3 });
    const view = await render(renderGrid(layout4Cols, null));

    const list = screen.getByTestId('catalog-grid-list');

    // contentContainerStyle applies matching paddingTop and borderTopWidth
    const contentStyle = StyleSheet.flatten(list.props.contentContainerStyle);
    expect(contentStyle.paddingTop).toBe(16);
    expect(contentStyle.borderTopWidth).toBe(4);

    // getItemLayout includes paddingTop + borderTopWidth (16 + 4 = 20)
    expect(list.props.getItemLayout(undefined, 0)).toEqual({ length: 200, offset: 20, index: 0 });
    expect(list.props.getItemLayout(undefined, 3)).toEqual({ length: 200, offset: 620, index: 3 });

    // onLayout captures viewportHeight before any scroll event so align: 'nearest' works immediately
    await act(async () => {
      fireEvent(list, 'layout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 600 } },
      });
    });

    // Focus row 3 ([620, 820]) with viewport=600, currentOffset=0 -> nearest bottom = 820 - 600 = 220 (not start=620!)
    scrollToOffsetSpy.mockClear();
    await act(async () => {
      await view.rerender(renderGrid(layout4Cols, { row: 3, col: 0 }));
    });
    expect(scrollToOffsetSpy).toHaveBeenCalledWith({ offset: 220, animated: false });

    // Scroll to y=500, then resize visibleGridRows/gridColumns -> must NOT reset scrollOffsetRef to 0
    await act(async () => {
      fireEvent.scroll(list, {
        nativeEvent: {
          contentOffset: { x: 0, y: 500 },
          contentSize: { width: 1200, height: 4000 },
          layoutMeasurement: { width: 1200, height: 600 },
        },
      });
    });

    const layout5Cols = makeLayout({ gridColumns: 5, visibleGridRows: 4 });
    scrollToOffsetSpy.mockClear();
    await act(async () => {
      // Row 3 ([620, 820]) is already fully visible inside [500, 1100] -> nearest keeps 500!
      await view.rerender(renderGrid(layout5Cols, { row: 3, col: 1 }));
    });
    expect(screen.getByTestId('catalog-grid-list').props.extraData.cols).toBe(5);
    expect(scrollToOffsetSpy).toHaveBeenCalledWith({ offset: 500, animated: false });

    await view.unmount();
  });
});
