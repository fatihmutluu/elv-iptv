import { type CatalogService, createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { elvError, err, type HttpClient, type HttpResponse, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, type ViewportOverride, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { DetailTarget } from '../../shared';
import { HomeScreen } from '../HomeScreen';

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
  } = {},
) {
  return render(
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
    </ViewportProvider>,
  );
}

describe('Wave F5B / Wave P8 HomeScreen Collections (#403, #508)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders non-empty custom collection rails on Home, hides empty collections, and omits Manage collections button (#508)', async () => {
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

      // Home "Manage collections" button and overlay are completely removed (curation lives in Library)
      expect(screen.queryByTestId('home-collections-manage-btn')).toBeNull();
      expect(screen.queryByTestId('home-collections-header')).toBeNull();
      expect(screen.queryByTestId('collection-manager-overlay')).toBeNull();

      // Clicking a collection rail poster opens DetailScreen
      await fireEvent.press(screen.getByTestId(`home-collection-${c1.value.id}-item-0`));
      expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ itemKey: m1.key }));

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('renders nothing for Collections section when no non-empty collections exist (#508)', async () => {
    const env = await openCatalogWithMovies();
    try {
      const view = await renderHome({
        catalog: env.catalog,
        sources: env.sources,
      });

      await waitFor(() => {
        expect(screen.getByTestId('home-rail-movies')).toBeTruthy();
      });
      expect(screen.queryByTestId('home-collections-manage-btn')).toBeNull();
      expect(screen.queryByTestId('home-collections-header')).toBeNull();
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
