import type { CatalogService, ItemRow, ListItemsOptions } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, RemoteKeysProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import type { CatalogLayoutMetrics, DisplayCategory } from '../../shared';
import { CatalogDiscoveryScreen } from '../CatalogDiscoveryScreen';
import { CategoryGridView } from '../CategoryGridView';
import {
  createAndroidSource,
  KEYCODE_DPAD_CENTER,
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

describe('Catalog CategoryGridView alphabetical sort (#125)', () => {
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

    const sortBtn = screen.getByTestId('catalog-grid-sort');
    await fireEvent.press(sortBtn);
    expect(onToggleSort).toHaveBeenCalledTimes(1);

    await view.rerender(renderGrid('alpha'));
    await waitFor(() => {
      expect(screen.getByTestId('catalog-grid-item-0').props.accessibilityLabel).toContain(
        'The Arrival',
      );
    });
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
    jest.restoreAllMocks();
  });
});
