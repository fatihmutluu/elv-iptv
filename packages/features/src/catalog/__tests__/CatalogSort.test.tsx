import type { CatalogService, ItemRow, ListItemsOptions } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { CatalogLayoutMetrics, DisplayCategory } from '../../shared';
import { CategoryGridView } from '../CategoryGridView';

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
});
