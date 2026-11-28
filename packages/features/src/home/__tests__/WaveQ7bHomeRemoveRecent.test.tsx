import type { CatalogService, CategoryRow, ItemRow, SourceRow } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { CatalogUiCacheProvider, createCatalogUiCache } from '../../shared';
import { HomeScreen } from '../HomeScreen';

const SOURCE: SourceRow = {
  id: 'src-1',
  name: 'Demo Source',
  kind: 'xtream',
  needsImport: false,
  createdAt: 1_700_000_000_000,
} as SourceRow;

function makeLiveItem(id: number, key: string, name: string): ItemRow {
  return {
    id,
    key,
    kind: 'live',
    sourceId: 'src-1',
    providerId: String(id),
    name,
    logo: null,
    rating: null,
    year: null,
    num: id,
  };
}

describe('MAJOR-6: HomeScreen per-item Remove from Recent on unified Live TV rail', () => {
  it('shows Remove from Recent for recent channels, calls removeRecentChannel, clears home cache, and removes card from rail', async () => {
    const recentCh = makeLiveItem(5, 'x:src-1:live:rec-1', 'Recent News');
    const onNowCh = makeLiveItem(1, 'x:src-1:live:on-1', 'On Now Sports');
    const removeRecentChannel = jest.fn(async () => true);
    const liveCat: CategoryRow = {
      id: 'cat-live',
      sourceId: 'src-1',
      kind: 'live',
      name: 'General',
      itemCount: 1,
      position: 0,
    };
    const catalog = {
      listSources: jest.fn(async () => [SOURCE]),
      categories: jest.fn(async (_srcId, kind) => (kind === 'live' ? [liveCat] : [])),
      items: jest.fn(async () => [onNowCh]),
      listContinueWatching: jest.fn(async () => []),
      listRecentChannels: jest.fn(async () => [recentCh]),
      removeRecentChannel,
      listFavorites: jest.fn(async () => []),
      listFavoriteKeys: jest.fn(async () => []),
      getProgress: jest.fn(async () => null),
    } as unknown as CatalogService;

    const cache = createCatalogUiCache();
    const clearHomeSpy = jest.spyOn(cache, 'clearHome');

    const view = await render(
      <CatalogUiCacheProvider cache={cache}>
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider reduceMotion>
            <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
              <HomeScreen
                catalog={catalog}
                sources={[SOURCE]}
                refreshToken={0}
                onPlay={jest.fn()}
                onOpenTab={jest.fn()}
                onOpenSources={jest.fn()}
              />
            </ViewportProvider>
          </ThemeProvider>
        </I18nProvider>
      </CatalogUiCacheProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('home-live-item-0')).toBeTruthy();
      expect(screen.getByTestId('home-live-item-1')).toBeTruthy();
    });

    // Item 0 is the Recent channel -> context menu MUST include Remove from Recent
    await fireEvent(screen.getByTestId('home-live-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('home-context-remove-recent')).toBeTruthy();
    });

    await act(async () => {
      await fireEvent.press(screen.getByTestId('home-context-remove-recent'));
    });

    await waitFor(() => {
      expect(removeRecentChannel).toHaveBeenCalledWith(recentCh.key);
      expect(clearHomeSpy).toHaveBeenCalled();
      expect(screen.queryByTestId('home-live-item-1')).toBeNull();
    });

    // Remaining item 0 is On-Now (not recent) -> context menu MUST NOT include Remove from Recent
    await fireEvent(screen.getByTestId('home-live-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('home-context-play')).toBeTruthy();
    });
    expect(screen.queryByTestId('home-context-remove-recent')).toBeNull();

    await view.unmount();
  });
});
