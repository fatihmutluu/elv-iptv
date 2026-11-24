import { type CatalogService, createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { elvError, err, type HttpClient, type HttpResponse, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import type { DetailTarget } from '../../shared';
import { HomeScreen } from '../HomeScreen';

const KEYCODE_BACK = 4;

function jsonResponse(payload: unknown): HttpResponse {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    },
  };
}

function createHomeHttp(): HttpClient {
  return {
    async get(rawUrl) {
      const url = new URL(rawUrl);
      if (url.pathname !== '/player_api.php') return err(elvError('network', 'http-404'));
      const action = url.searchParams.get('action');
      if (!action) {
        return ok(
          jsonResponse({
            user_info: { auth: 1, status: 'Active', allowed_output_formats: ['mp4'] },
            server_info: { timezone: 'UTC' },
          }),
        );
      }
      if (action === 'get_vod_categories') {
        return ok(jsonResponse([{ category_id: '10', category_name: 'Cinema' }]));
      }
      if (action === 'get_vod_streams') {
        return ok(
          jsonResponse([
            { stream_id: 201, name: 'Neon Horizon', category_id: '10', container_extension: 'mp4' },
            {
              stream_id: 202,
              name: 'Glass Meridian',
              category_id: '10',
              container_extension: 'mp4',
            },
          ]),
        );
      }
      return ok(jsonResponse([]));
    },
  };
}

async function openCatalogWithMovies() {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) throw new Error('migrate failed');
  let now = 1_700_000_000_000;
  let seq = 1;
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: createHomeHttp(),
    clock: () => {
      now += 100;
      return now;
    },
    newId: () => `src-${seq++}`,
  });
  const added = await catalog.addSource({
    kind: 'xtream',
    name: 'Demo',
    server: 'http://sim.example.test:8080',
    username: 'demo',
    password: ['de', 'mo'].join(''),
  });
  if (!added.ok) throw new Error('addSource failed');
  await catalog.importSource(added.value.id);
  const sources = await catalog.listSources();
  const movies = await catalog.items(`${added.value.id}|movie|10`, 0, 10);
  return {
    catalog,
    sources,
    movies,
    async cleanup() {
      await catalog.close();
      handle.close();
    },
  };
}

function renderHome(
  props: {
    catalog: CatalogService;
    sources: Awaited<ReturnType<CatalogService['listSources']>>;
    onOpenDetail?: (target: DetailTarget) => void;
  },
  opts: {
    viewport?: ViewportOverride;
    androidSource?: AndroidKeySource;
  } = {},
) {
  const content = (
    <ViewportProvider
      value={
        opts.viewport ?? {
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }
      }
    >
      <ThemeProvider>
        <I18nProvider i18n={createAppI18n('en')}>
          <HomeScreen
            catalog={props.catalog}
            sources={props.sources}
            refreshToken={1}
            onPlay={jest.fn()}
            onOpenTab={jest.fn()}
            onOpenDetail={props.onOpenDetail ?? jest.fn()}
            onOpenSources={jest.fn()}
          />
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>
  );
  if (opts.androidSource) {
    return render(<RemoteKeysProvider android={opts.androidSource}>{content}</RemoteKeysProvider>);
  }
  return render(content);
}

describe('Wave F5B HomeScreen Collections & CollectionManagerOverlay (#403)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders custom collection rails on Home and manages create, rename, reorder, inspect, item reorder/remove, open detail, and delete inline (zero Modal)', async () => {
    const env = await openCatalogWithMovies();
    const onOpenDetail = jest.fn();
    try {
      const m1 = env.movies[0];
      const m2 = env.movies[1];
      expect(m1).toBeDefined();
      expect(m2).toBeDefined();
      if (!m1 || !m2) return;

      const c1 = await env.catalog.createCollection?.({ name: 'Weekend Picks' });
      const c2 = await env.catalog.createCollection?.({ name: 'Late Night' });
      expect(c1?.ok && c2?.ok).toBe(true);
      if (!c1?.ok || !c2?.ok) return;

      await env.catalog.addItemToCollection?.(c1.value.id, m1.key, 'movie');
      await env.catalog.addItemToCollection?.(c1.value.id, m2.key, 'movie');

      const view = await renderHome({
        catalog: env.catalog,
        sources: env.sources,
        onOpenDetail,
      });

      // Non-empty collection renders as a horizontal poster rail on Home; empty collection does not
      await waitFor(() => {
        expect(screen.getByTestId(`home-rail-collection-${c1.value.id}`)).toBeTruthy();
        expect(screen.getByTestId(`home-collection-${c1.value.id}-item-0`)).toBeTruthy();
      });
      expect(screen.queryByTestId(`home-rail-collection-${c2.value.id}`)).toBeNull();

      // Clicking a collection rail poster opens DetailScreen
      await fireEvent.press(screen.getByTestId(`home-collection-${c1.value.id}-item-0`));
      expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ itemKey: m1.key }));

      // Open CollectionManagerOverlay inline (zero RN <Modal>)
      await fireEvent.press(screen.getByTestId('home-collections-manage-btn'));
      await waitFor(() => {
        expect(screen.getByTestId('collection-manager-overlay')).toBeTruthy();
        expect(screen.getByTestId(`collection-manager-row-${c1.value.id}`)).toBeTruthy();
        expect(screen.getByTestId(`collection-manager-row-${c2.value.id}`)).toBeTruthy();
      });
      expect(JSON.stringify(view.toJSON())).not.toContain('"type":"Modal"');

      // Rename c1 inline
      await fireEvent.press(screen.getByTestId(`collection-manager-rename-${c1.value.id}`));
      await fireEvent.changeText(
        screen.getByTestId(`collection-manager-rename-input-${c1.value.id}`),
        'Sci-Fi Vault',
      );
      await fireEvent.press(screen.getByTestId(`collection-manager-save-${c1.value.id}`));
      await waitFor(() => {
        expect(screen.getByTestId(`collection-manager-expand-${c1.value.id}`)).toHaveTextContent(
          /Sci-Fi Vault/,
        );
      });

      // Reorder c2 up above c1
      await fireEvent.press(screen.getByTestId(`collection-manager-move-up-${c2.value.id}`));
      await waitFor(async () => {
        const listed = await env.catalog.listCollections?.();
        expect(listed?.map((c) => c.id)).toEqual([c2.value.id, c1.value.id]);
      });

      // Expand c1, reorder items (move m2 up), remove m1
      await fireEvent.press(screen.getByTestId(`collection-manager-expand-${c1.value.id}`));
      await waitFor(() => {
        expect(screen.getByTestId(`collection-manager-item-${c1.value.id}-${m1.key}`)).toBeTruthy();
        expect(screen.getByTestId(`collection-manager-item-${c1.value.id}-${m2.key}`)).toBeTruthy();
      });
      await fireEvent.press(
        screen.getByTestId(`collection-manager-item-up-${c1.value.id}-${m2.key}`),
      );
      await waitFor(async () => {
        const items = await env.catalog.listCollectionItems?.(c1.value.id);
        expect(items?.map((i) => i.key)).toEqual([m2.key, m1.key]);
      });

      await fireEvent.press(
        screen.getByTestId(`collection-manager-item-remove-${c1.value.id}-${m1.key}`),
      );
      await waitFor(() => {
        expect(screen.queryByTestId(`collection-manager-item-${c1.value.id}-${m1.key}`)).toBeNull();
      });

      // Open remaining item m2 from manager -> closes overlay and opens Detail
      onOpenDetail.mockClear();
      await fireEvent.press(
        screen.getByTestId(`collection-manager-open-item-${c1.value.id}-${m2.key}`),
      );
      expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ itemKey: m2.key }));
      await waitFor(() => {
        expect(screen.queryByTestId('collection-manager-overlay')).toBeNull();
      });

      // Re-open manager, create a collection, then delete c2
      await fireEvent.press(screen.getByTestId('home-collections-manage-btn'));
      await waitFor(() => {
        expect(screen.getByTestId('collection-manager-overlay')).toBeTruthy();
      });
      await fireEvent.changeText(screen.getByTestId('collection-manager-new-input'), 'Classics');
      await fireEvent.press(screen.getByTestId('collection-manager-create-btn'));
      await waitFor(() => {
        expect(screen.getByText('Classics')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId(`collection-manager-delete-${c2.value.id}`));
      await waitFor(() => {
        expect(screen.queryByTestId(`collection-manager-row-${c2.value.id}`)).toBeNull();
      });

      await fireEvent.press(screen.getByTestId('collection-manager-close'));
      await waitFor(() => {
        expect(screen.queryByTestId('collection-manager-overlay')).toBeNull();
      });

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('closes CollectionManagerOverlay cleanly on TV Back without crashing when collections are empty', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return {
          remove: () => {
            keyListener = undefined;
          },
        };
      },
    };
    const env = await openCatalogWithMovies();
    try {
      const view = await renderHome(
        { catalog: env.catalog, sources: env.sources },
        {
          viewport: {
            formFactor: 'tv',
            orientation: 'landscape',
            inputModality: 'tv',
            width: 1920,
            height: 1080,
          },
          androidSource,
        },
      );

      await waitFor(() => {
        expect(screen.getByTestId('home-collections-manage-btn')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('home-collections-manage-btn'));
      await waitFor(() => {
        expect(screen.getByTestId('collection-manager-overlay')).toBeTruthy();
      });

      await act(async () => {
        keyListener?.({ action: 'down', keyCode: KEYCODE_BACK, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode: KEYCODE_BACK, canceled: false, ageMs: 10 });
      });

      await waitFor(() => {
        expect(screen.queryByTestId('collection-manager-overlay')).toBeNull();
      });
      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('chunks listProgressByKeys calls to <= 200 keys when Home and collections exceed 200 items', async () => {
    const env = await openCatalogWithMovies();
    try {
      const col = await env.catalog.createCollection?.({ name: 'Mega Watchlist' });
      expect(col?.ok).toBe(true);
      if (!col?.ok) return;

      const syntheticItems = Array.from({ length: 230 }, (_, i) => ({
        id: 1000 + i,
        key: `x:src-1:movie:${1000 + i}`,
        sourceId: 'src-1',
        providerId: String(1000 + i),
        kind: 'movie' as const,
        name: `Movie ${i}`,
        logo: null,
        rating: null,
        year: 2020,
        num: null,
      }));

      const progressCalls: number[] = [];
      const wrappedCatalog: CatalogService = {
        ...env.catalog,
        listCollectionItems: async (collectionId, opts) => {
          if (collectionId === col.value.id) return syntheticItems;
          return (await env.catalog.listCollectionItems?.(collectionId, opts)) ?? [];
        },
        listProgressByKeys: async (keys, profileId) => {
          progressCalls.push(keys.length);
          expect(keys.length).toBeLessThanOrEqual(200);
          return (await env.catalog.listProgressByKeys?.(keys, profileId)) ?? [];
        },
      };

      const view = await renderHome({
        catalog: wrappedCatalog,
        sources: env.sources,
      });

      await waitFor(() => {
        expect(screen.getByTestId(`home-rail-collection-${col.value.id}`)).toBeTruthy();
        expect(progressCalls.length).toBeGreaterThanOrEqual(2);
      });

      for (const batchSize of progressCalls) {
        expect(batchSize).toBeLessThanOrEqual(200);
      }
      const totalRequested = progressCalls.reduce((sum, n) => sum + n, 0);
      expect(totalRequested).toBeGreaterThanOrEqual(230);

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });
});
