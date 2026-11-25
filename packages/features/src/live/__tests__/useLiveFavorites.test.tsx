import type { CatalogService, FavoriteRow, ItemRow, SourceRow } from '@elv/data';
import { act, render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { CatalogUiCacheProvider, createCatalogUiCache } from '../../shared';
import { type LiveFavoritesState, useLiveFavorites } from '../useLiveFavorites';

const SOURCE: SourceRow = {
  id: 'src-1',
  kind: 'xtream',
  name: 'Demo Live',
  createdAt: 1,
  needsImport: false,
  credentialFingerprint: 'fp-demo',
};

const SOURCES: readonly SourceRow[] = [SOURCE];

const CHANNEL_1: ItemRow = {
  id: 1,
  key: 'x:src-1:live:101',
  kind: 'live',
  sourceId: 'src-1',
  providerId: '101',
  name: 'Channel 101',
  logo: null,
  rating: null,
  year: null,
  num: 101,
};

const FAV_ROW_1: FavoriteRow = {
  profileId: 'default',
  sourceId: 'src-1',
  itemKey: CHANNEL_1.key,
  kind: 'live',
  title: CHANNEL_1.name,
  logo: null,
  year: null,
  rating: null,
  addedAt: 1000,
};

function FavoritesHarness({
  catalog,
  refreshToken,
  onState,
}: {
  catalog: CatalogService;
  refreshToken: number;
  onState: (state: LiveFavoritesState) => void;
}) {
  const state = useLiveFavorites({
    catalog,
    sources: SOURCES,
    refreshToken,
  });
  onState(state);
  return <Text testID="fav-count">{state.favoriteChannels.length}</Text>;
}

describe('useLiveFavorites', () => {
  it('requests up to 200 favorites and preserves hydrated cache when listFavorites rejects', async () => {
    const cache = createCatalogUiCache();
    cache.setLiveFavorites(new Set([CHANNEL_1.key]), [CHANNEL_1]);

    const holder: { current: LiveFavoritesState | null } = { current: null };
    const capture = (state: LiveFavoritesState) => {
      holder.current = state;
    };
    const listFavorites = jest.fn(async (_limit?: number): Promise<FavoriteRow[]> => {
      throw new Error('invalid-request');
    });
    const listFavoriteKeys = jest.fn(async () => [CHANNEL_1.key]);
    const catalog = {
      listFavoriteKeys,
      listFavorites,
      itemDetail: jest.fn(async () => ({ ...CHANNEL_1, plot: null })),
    } as unknown as CatalogService;

    const view = await render(
      <CatalogUiCacheProvider cache={cache}>
        <FavoritesHarness catalog={catalog} refreshToken={0} onState={capture} />
      </CatalogUiCacheProvider>,
    );

    await waitFor(() => {
      expect(listFavorites).toHaveBeenCalledWith(200);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Hydrated favorites must NOT be wiped by a transient listFavorites rejection
    expect(holder.current?.favoriteChannels).toHaveLength(1);
    expect(holder.current?.favoriteChannels[0]?.key).toBe(CHANNEL_1.key);
    expect(cache.getLive()?.favoriteChannels).toHaveLength(1);

    // When listFavorites subsequently succeeds with an actual empty list, it updates cleanly
    listFavorites.mockResolvedValueOnce([]);
    listFavoriteKeys.mockResolvedValueOnce([]);
    await view.rerender(
      <CatalogUiCacheProvider cache={cache}>
        <FavoritesHarness catalog={catalog} refreshToken={1} onState={capture} />
      </CatalogUiCacheProvider>,
    );

    await waitFor(() => {
      expect(holder.current?.favoriteChannels).toHaveLength(0);
    });
    expect(cache.getLive()?.favoriteChannels).toHaveLength(0);

    // When listFavorites resolves with rows, it hydrates them cleanly
    listFavorites.mockResolvedValueOnce([FAV_ROW_1]);
    listFavoriteKeys.mockResolvedValueOnce([CHANNEL_1.key]);
    await view.rerender(
      <CatalogUiCacheProvider cache={cache}>
        <FavoritesHarness catalog={catalog} refreshToken={2} onState={capture} />
      </CatalogUiCacheProvider>,
    );

    await waitFor(() => {
      expect(holder.current?.favoriteChannels).toHaveLength(1);
      expect(holder.current?.favoriteChannels[0]?.key).toBe(CHANNEL_1.key);
    });
    await view.unmount();
  });
});
