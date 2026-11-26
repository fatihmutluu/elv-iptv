import type { CatalogService, FavoriteRow, ItemRow, SourceRow } from '@elv/data';
import { elvError, err, ok, type Result } from '@elv/domain';
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
  onFavoritesMutated,
  onState,
}: {
  catalog: CatalogService;
  refreshToken: number;
  onFavoritesMutated?: () => void;
  onState: (state: LiveFavoritesState) => void;
}) {
  const state = useLiveFavorites({
    catalog,
    sources: SOURCES,
    refreshToken,
    ...(onFavoritesMutated !== undefined ? { onFavoritesMutated } : {}),
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

  it('optimistically reorders favorites, persists via catalog.reorderFavorites, and rolls back on failure', async () => {
    const channel2: ItemRow = {
      ...CHANNEL_1,
      id: 2,
      key: 'x:src-1:live:102',
      providerId: '102',
      name: 'Channel 102',
      num: 102,
    };
    const channel3: ItemRow = {
      ...CHANNEL_1,
      id: 3,
      key: 'x:src-1:live:103',
      providerId: '103',
      name: 'Channel 103',
      num: 103,
    };
    const rows: FavoriteRow[] = [
      FAV_ROW_1,
      { ...FAV_ROW_1, itemKey: channel2.key, title: channel2.name, addedAt: 900 },
      { ...FAV_ROW_1, itemKey: channel3.key, title: channel3.name, addedAt: 800 },
    ];
    const byKey = new Map<string, ItemRow>([
      [CHANNEL_1.key, CHANNEL_1],
      [channel2.key, channel2],
      [channel3.key, channel3],
    ]);
    const cache = createCatalogUiCache();
    const onFavoritesMutated = jest.fn();
    const reorderFavorites = jest.fn(
      async (_keys: readonly string[]): Promise<Result<void>> => ok(undefined),
    );
    const catalog = {
      listFavoriteKeys: jest.fn(async () => rows.map((r) => r.itemKey)),
      listFavorites: jest.fn(async () => rows),
      itemDetail: jest.fn(async (key: string) => {
        const ch = byKey.get(key);
        return ch ? { ...ch, plot: null } : null;
      }),
      reorderFavorites,
    } as unknown as CatalogService;

    const holder: { current: LiveFavoritesState | null } = { current: null };
    const view = await render(
      <CatalogUiCacheProvider cache={cache}>
        <FavoritesHarness
          catalog={catalog}
          refreshToken={0}
          onFavoritesMutated={onFavoritesMutated}
          onState={(s) => {
            holder.current = s;
          }}
        />
      </CatalogUiCacheProvider>,
    );

    await waitFor(() => {
      expect(holder.current?.favoriteChannels.map((c) => c.key)).toEqual([
        CHANNEL_1.key,
        channel2.key,
        channel3.key,
      ]);
    });

    await act(async () => {
      await holder.current?.reorderFavorite(2, 0);
    });

    expect(holder.current?.favoriteChannels.map((c) => c.key)).toEqual([
      channel3.key,
      CHANNEL_1.key,
      channel2.key,
    ]);
    expect(cache.getLive()?.favoriteChannels.map((c) => c.key)).toEqual([
      channel3.key,
      CHANNEL_1.key,
      channel2.key,
    ]);
    expect(reorderFavorites).toHaveBeenCalledWith([channel3.key, CHANNEL_1.key, channel2.key]);
    expect(onFavoritesMutated).toHaveBeenCalledTimes(1);

    // Failure rolls back cleanly to last committed order
    reorderFavorites.mockResolvedValueOnce(err(elvError('storage', 'write-failed')));
    await act(async () => {
      await holder.current?.reorderFavorite(0, 2);
    });

    expect(holder.current?.favoriteChannels.map((c) => c.key)).toEqual([
      channel3.key,
      CHANNEL_1.key,
      channel2.key,
    ]);
    expect(cache.getLive()?.favoriteChannels.map((c) => c.key)).toEqual([
      channel3.key,
      CHANNEL_1.key,
      channel2.key,
    ]);
    expect(onFavoritesMutated).toHaveBeenCalledTimes(1);

    await view.unmount();
  });
});
