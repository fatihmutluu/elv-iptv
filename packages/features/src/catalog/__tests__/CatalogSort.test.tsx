import type { AlphabetBucket, CatalogService, ItemRow, ListItemsOptions } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, RemoteKeysProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, VirtualizedList } from 'react-native';
import type { CatalogLayoutMetrics, DisplayCategory } from '../../shared';
import { CatalogDiscoveryScreen } from '../CatalogDiscoveryScreen';
import { CategoryGridView } from '../CategoryGridView';
import {
  createAndroidSource,
  KEYCODE_BACK,
  KEYCODE_DPAD_CENTER,
  KEYCODE_DPAD_DOWN,
  KEYCODE_DPAD_LEFT,
  KEYCODE_DPAD_RIGHT,
  KEYCODE_DPAD_UP,
  makeSource,
} from './catalog-test-fixtures';

const ITEMS_DEFAULT: readonly ItemRow[] = [
  {
    id: 1,
    key: 'm:1',
    sourceId: 's1',
    providerId: '1',
    kind: 'movie',
    name: 'Zebra Crossing',
    logo: null,
    rating: 7.4,
    year: 2024,
    num: null,
  },
  {
    id: 2,
    key: 'm:2',
    sourceId: 's1',
    providerId: '2',
    kind: 'movie',
    name: 'The Arrival',
    logo: null,
    rating: 8.8,
    year: 2025,
    num: null,
  },
];

const ITEMS_ALPHA: readonly ItemRow[] = [...ITEMS_DEFAULT].reverse();

const CATEGORY: DisplayCategory = {
  row: {
    id: 's1|movie|10',
    sourceId: 's1',
    kind: 'movie',
    name: 'Cinema',
    position: 0,
    itemCount: 2,
  },
  label: 'Cinema',
};

const LAYOUT: CatalogLayoutMetrics = {
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
  gridRowHeight: 240,
  visibleGridRows: 3,
};

function makeAlphaMovie(index: number): ItemRow {
  return {
    id: index + 1,
    key: `m:${index}`,
    sourceId: 's1',
    providerId: String(index + 1),
    kind: 'movie',
    name: `Film ${index}`,
    logo: null,
    rating: 8.1,
    year: 2025,
    num: null,
  };
}

const LARGE_BUCKETS: readonly AlphabetBucket[] = [
  { letter: 'A', offset: 0, count: 180 },
  { letter: 'D', offset: 180, count: 360 },
  { letter: 'M', offset: 540, count: 260 },
  { letter: 'Z', offset: 800, count: 200 },
];

describe('Catalog CategoryGridView alphabetical sort & A-Z Jump Rail (#125, #407)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('toggles A-Z alphabetical sort and forwards { sortBy: "alpha" } to catalog.items', async () => {
    const itemsMock = jest.fn(
      async (_catId: string, _offset: number, _limit: number, opts?: ListItemsOptions) =>
        opts?.sortBy === 'alpha' ? ITEMS_ALPHA : ITEMS_DEFAULT,
    );
    const catalog = {
      items: itemsMock,
      listProgressByKeys: jest.fn(async () => []),
    } as unknown as CatalogService;

    const onToggleSort = jest.fn();
    const renderGrid = (sortBy: 'default' | 'alpha') => (
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
              refreshToken={1}
              userStateVersion={0}
              layout={LAYOUT}
              backFocused={false}
              focusedGridPos={null}
              sortBy={sortBy}
              onToggleSort={onToggleSort}
              onBack={jest.fn()}
              onOpenDetail={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    const view = await render(renderGrid('default'));
    await waitFor(() => {
      expect(screen.getByTestId('catalog-grid-item-0').props.accessibilityLabel).toContain(
        'Zebra Crossing',
      );
    });

    // Total is 2 (< 40), so A-Z jump rail must remain hidden even when sorted alphabetically
    expect(screen.queryByTestId('alphabet-jump-rail')).toBeNull();

    const sortBtn = screen.getByTestId('catalog-grid-sort');
    await fireEvent.press(sortBtn);
    expect(onToggleSort).toHaveBeenCalledTimes(1);

    await view.rerender(renderGrid('alpha'));
    await waitFor(() => {
      expect(screen.getByTestId('catalog-grid-item-0').props.accessibilityLabel).toContain(
        'The Arrival',
      );
    });
    expect(screen.queryByTestId('alphabet-jump-rail')).toBeNull();
    expect(itemsMock).toHaveBeenCalledWith(
      's1|movie|10',
      0,
      expect.any(Number),
      expect.objectContaining({ sortBy: 'alpha' }),
    );
    await view.unmount();
  });

  it('reaches catalog-grid-sort via 10-ft TV D-pad (Up -> Right -> Select) and localizes labels', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const itemsMock = jest.fn(
      async (_catId: string, _offset: number, _limit: number, opts?: ListItemsOptions) =>
        opts?.sortBy === 'alpha' ? ITEMS_ALPHA : ITEMS_DEFAULT,
    );
    const catalog = {
      categories: jest.fn(async () => [CATEGORY.row]),
      items: itemsMock,
      listContinueWatching: jest.fn(async () => []),
      listProgressByKeys: jest.fn(async () => []),
    } as unknown as CatalogService;
    const { source: androidSource, sendKey } = createAndroidSource();

    const view = await render(
      <RemoteKeysProvider android={androidSource}>
        <ViewportProvider
          value={{
            formFactor: 'tv',
            orientation: 'landscape',
            inputModality: 'tv',
            width: 1280,
            height: 720,
          }}
        >
          <ThemeProvider>
            <I18nProvider i18n={createAppI18n('en')}>
              <CatalogDiscoveryScreen
                kind="movie"
                catalog={catalog}
                sources={[makeSource()]}
                refreshToken={1}
                memory={{ selectedCategoryId: CATEGORY.row.id, visibleCategoryCount: 8 }}
                onOpenDetail={jest.fn()}
                onOpenSources={jest.fn()}
                isActiveScope
              />
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>
      </RemoteKeysProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('catalog-grid-item-0').props.accessibilityLabel).toContain(
        'Zebra Crossing',
      );
      expect(screen.getByTestId('catalog-grid-sort')).toBeTruthy();
    });

    expect(screen.getByTestId('catalog-grid-sort').props.accessibilityLabel).toBe(
      'Sort alphabetically',
    );

    // Entering grid mode focuses grid item 0 -> Up moves to grid header (Back) -> Right moves to A–Z Sort
    await sendKey(KEYCODE_DPAD_UP);
    await sendKey(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('catalog-grid-sort-focus-ring')).toBeTruthy();

    // Select toggles alphabetical sort via sort_title
    await sendKey(KEYCODE_DPAD_CENTER);
    await waitFor(() => {
      expect(screen.getByTestId('catalog-grid-item-0').props.accessibilityLabel).toContain(
        'The Arrival',
      );
      expect(screen.getByTestId('catalog-grid-sort').props.accessibilityLabel).toBe(
        'Default order',
      );
    });

    await view.unmount();
  });

  it('renders AlphabetJumpRail only when sortBy === "alpha" and total >= 40, and jumps directly to target offset without loading intermediate pages (#407)', async () => {
    const scrollToIndexSpy = jest
      .spyOn(VirtualizedList.prototype, 'scrollToIndex')
      .mockImplementation(() => undefined);

    const itemsCalls: Array<{ offset: number; limit: number }> = [];
    const alphabetIndex = jest.fn(async () => LARGE_BUCKETS);
    const catalog = {
      items: jest.fn(async (_catId: string, offset: number, limit: number) => {
        itemsCalls.push({ offset, limit });
        return Array.from({ length: limit }, (_, i) => makeAlphaMovie(offset + i));
      }),
      alphabetIndex,
      listProgressByKeys: jest.fn(async () => []),
    } as unknown as CatalogService;

    const largeCategory: DisplayCategory = {
      row: {
        id: 's1|movie|100',
        sourceId: 's1',
        kind: 'movie',
        name: 'All Films',
        position: 0,
        itemCount: 1_000,
      },
      label: 'All Films',
    };

    const renderGrid = (sortBy: 'default' | 'alpha', itemCount = 1_000) => (
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
              category={{
                ...largeCategory,
                row: { ...largeCategory.row, itemCount },
              }}
              catalog={catalog}
              refreshToken={1}
              userStateVersion={0}
              layout={LAYOUT}
              backFocused={false}
              focusedGridPos={null}
              sortBy={sortBy}
              groupVersions
              onBack={jest.fn()}
              onOpenDetail={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    // Hidden when sortBy === 'default' even with 1,000 items
    const view = await render(renderGrid('default', 1_000));
    expect(screen.queryByTestId('alphabet-jump-rail')).toBeNull();

    // Hidden when sortBy === 'alpha' but total < 40 (39 items)
    await view.rerender(renderGrid('alpha', 39));
    expect(screen.queryByTestId('alphabet-jump-rail')).toBeNull();

    // Visible when sortBy === 'alpha' and total >= 40 (1,000 items)
    await view.rerender(renderGrid('alpha', 1_000));
    await waitFor(() => {
      expect(screen.getByTestId('alphabet-jump-rail')).toBeTruthy();
    });
    expect(alphabetIndex).toHaveBeenCalledWith({
      sourceId: 's1',
      kind: 'movie',
      categoryId: 's1|movie|100',
      groupVersions: true,
    });

    // Clear initial page 0 calls, then jump directly to letter 'M' (offset = 540, page = 3, row = 540 / 4 = 135)
    itemsCalls.length = 0;
    scrollToIndexSpy.mockClear();
    await fireEvent.press(screen.getByTestId('alphabet-jump-rail-letter-M'));

    expect(scrollToIndexSpy).toHaveBeenCalledWith({ index: 135, animated: false });
    // Must load target page 3 (offset 540) directly and NEVER intermediate pages 1 (180) or 2 (360)
    expect(itemsCalls).toContainEqual({ offset: 540, limit: 180 });
    expect(itemsCalls.some((c) => c.offset === 180 || c.offset === 360)).toBe(false);

    await view.unmount();
  });

  it('supports 10-ft TV D-pad entry into AlphabetJumpRail from rightmost column, Up/Down across available letters, Select jump, and Left/Back exit (#407)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const itemsCalls: Array<{ offset: number; limit: number }> = [];
    const largeRow = {
      id: 's1|movie|100',
      sourceId: 's1',
      kind: 'movie' as const,
      name: 'All Films',
      position: 0,
      itemCount: 1_000,
    };
    const catalog = {
      categories: jest.fn(async () => [largeRow]),
      items: jest.fn(async (_catId: string, offset: number, limit: number) => {
        itemsCalls.push({ offset, limit });
        return Array.from({ length: limit }, (_, i) => makeAlphaMovie(offset + i));
      }),
      alphabetIndex: jest.fn(async () => LARGE_BUCKETS),
      listContinueWatching: jest.fn(async () => []),
      listProgressByKeys: jest.fn(async () => []),
    } as unknown as CatalogService;

    const { source: androidSource, sendKey } = createAndroidSource();
    const onOpenDetail = jest.fn();

    const view = await render(
      <RemoteKeysProvider android={androidSource}>
        <ViewportProvider
          value={{
            formFactor: 'tv',
            orientation: 'landscape',
            inputModality: 'tv',
            width: 1280,
            height: 720,
          }}
        >
          <ThemeProvider>
            <I18nProvider i18n={createAppI18n('en')}>
              <CatalogDiscoveryScreen
                kind="movie"
                catalog={catalog}
                sources={[makeSource('s1')]}
                refreshToken={1}
                memory={{
                  selectedCategoryId: largeRow.id,
                  visibleCategoryCount: 8,
                  sortBy: 'alpha',
                }}
                onOpenDetail={onOpenDetail}
                onOpenSources={jest.fn()}
                isActiveScope
              />
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>
      </RemoteKeysProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('alphabet-jump-rail')).toBeTruthy();
      expect(screen.getByTestId('catalog-grid-item-0')).toBeTruthy();
    });

    // On 1280x720 TV viewport, gridColumns = 6 (cols 0..5). Move Right x5 to rightmost column (col 5), then Right once more to enter AlphabetJumpRail!
    for (let i = 0; i < 5; i++) {
      await sendKey(KEYCODE_DPAD_RIGHT);
    }
    expect(screen.queryByTestId('alphabet-jump-rail-letter-A-focus-ring')).toBeNull();

    await sendKey(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('alphabet-jump-rail-letter-A-focus-ring')).toBeTruthy();

    // Left exits rail back to grid without jumping
    await sendKey(KEYCODE_DPAD_LEFT);
    expect(screen.queryByTestId('alphabet-jump-rail-letter-A-focus-ring')).toBeNull();
    expect(screen.getByTestId('catalog-grid')).toBeTruthy();

    // Re-enter rail -> Back also exits rail back to grid without leaving Grid Mode
    await sendKey(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('alphabet-jump-rail-letter-A-focus-ring')).toBeTruthy();
    await sendKey(KEYCODE_BACK);
    expect(screen.queryByTestId('alphabet-jump-rail-letter-A-focus-ring')).toBeNull();
    expect(screen.getByTestId('catalog-grid')).toBeTruthy();

    // Re-enter rail -> Down skips empty B/C and lands on D -> Down lands on M (offset 540) -> Select jumps directly to offset 540!
    itemsCalls.length = 0;
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('alphabet-jump-rail-letter-D-focus-ring')).toBeTruthy();
    await sendKey(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('alphabet-jump-rail-letter-M-focus-ring')).toBeTruthy();

    await sendKey(KEYCODE_DPAD_CENTER);
    // Focus exited rail and jumped grid directly to item 540 without loading intermediate pages 180 or 360
    expect(screen.queryByTestId('alphabet-jump-rail-letter-M-focus-ring')).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('catalog-grid-item-540')).toBeTruthy();
    });
    expect(itemsCalls).toContainEqual({ offset: 540, limit: 180 });
    expect(itemsCalls.some((c) => c.offset === 180 || c.offset === 360)).toBe(false);

    // Pressing Select on the jumped grid focus opens detail for item 540
    await act(async () => {
      await sendKey(KEYCODE_DPAD_CENTER);
    });
    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ itemKey: 'm:540' }));

    await view.unmount();
  });
});
