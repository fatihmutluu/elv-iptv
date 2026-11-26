import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import {
  createMemoryPreferencesStore,
  elvError,
  err,
  type HttpClient,
  type HttpResponse,
  ok,
} from '@elv/domain';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import { AppProviders, AppShell } from '..';
import type { DesktopWindowPort } from '../ports/desktop-window-host';
import type { VideoHost } from '../ports/video-host';

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

function createTestHttp(): HttpClient {
  return {
    async get(rawUrl) {
      const url = new URL(rawUrl);
      if (url.pathname !== '/player_api.php') return err(elvError('network', 'http-404'));
      const action = url.searchParams.get('action');
      if (!action) {
        return ok(
          jsonResponse({
            user_info: {
              auth: 1,
              status: 'Active',
              max_connections: '4',
              allowed_output_formats: ['m3u8'],
            },
            server_info: { timezone: 'UTC' },
          }),
        );
      }
      if (action === 'get_live_categories') {
        return ok(jsonResponse([{ category_id: '1', category_name: 'News' }]));
      }
      if (action === 'get_live_streams') {
        return ok(
          jsonResponse([
            { stream_id: 101, name: 'Alpha News', category_id: '1', num: 1 },
            { stream_id: 102, name: 'Beta News', category_id: '1', num: 2 },
          ]),
        );
      }
      return ok(jsonResponse([]));
    },
  };
}

function createMultiViewVideoHost(): VideoHost {
  return {
    supportsMultiView: true,
    open: jest.fn(async () => ({
      engine: createFakePlayerEngine({
        now: () => performance.now(),
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      }),
      renderSurface: () => <View testID="fake-video-surface" />,
    })),
  };
}

async function createSeededCatalog() {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) throw new Error('migrate failed');
  let now = 1_700_000_000_000;
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: createTestHttp(),
    clock: () => {
      now += 10;
      return now;
    },
    newId: () => 'src-1',
  });
  const added = await catalog.addSource({
    kind: 'xtream',
    name: 'Demo',
    server: 'https://demo.example.test',
    username: 'u',
    password: ['p', 'w'].join(''),
  });
  if (!added.ok) throw new Error('add source failed');
  const imp = await catalog.importSource(added.value.id);
  if (!imp.ok) throw new Error('import failed');
  await catalog.setFavorite?.(
    {
      sourceId: added.value.id,
      itemKey: 'x:src-1:live:101',
      kind: 'live',
      title: 'Alpha News',
      logo: null,
    },
    true,
  );
  await catalog.setFavorite?.(
    {
      sourceId: added.value.id,
      itemKey: 'x:src-1:live:102',
      kind: 'live',
      title: 'Beta News',
      logo: null,
    },
    true,
  );
  await catalog.reorderFavorites?.(['x:src-1:live:101', 'x:src-1:live:102']);
  return { catalog, handle };
}

describe('Wave P4 AppShell review fixes (P0-1 Multi-View/Popout & P0-2 Favorites sync)', () => {
  it('wires onOpenMultiView and onOpenPopout from AppShell into HomeScreen context menus', async () => {
    const { catalog, handle } = await createSeededCatalog();
    const openPopout = jest.fn(async () => true);
    const desktopWindow: DesktopWindowPort = { openPopout };
    const videoHost = createMultiViewVideoHost();
    const store = createMemoryPreferencesStore();

    try {
      const view = await render(
        <AppProviders preferencesStore={store}>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <AppShell catalog={catalog} videoHost={videoHost} desktopWindow={desktopWindow} />
          </ViewportProvider>
        </AppProviders>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('home-live-item-0')).toBeTruthy();
      });

      await fireEvent(screen.getByTestId('home-live-item-0'), 'longPress');
      await waitFor(() => {
        expect(screen.getByTestId('home-context-multiview')).toBeTruthy();
        expect(screen.getByTestId('home-context-popout')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('home-context-popout'));
      await waitFor(() => {
        expect(openPopout).toHaveBeenCalledWith(
          expect.objectContaining({
            itemKey: 'x:src-1:live:101',
            kind: 'live',
            sourceId: 'src-1',
          }),
        );
      });

      await fireEvent(screen.getByTestId('home-live-item-0'), 'longPress');
      await waitFor(() => {
        expect(screen.getByTestId('home-context-multiview')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('home-context-multiview'));
      await waitFor(() => {
        expect(screen.getByTestId('multiview-stage')).toBeTruthy();
      });

      await view.unmount();
    } finally {
      handle.close();
    }
  });

  it('invalidates Home cache and refreshes Home Live rail order after reordering favorites in LiveScreen', async () => {
    const { catalog, handle } = await createSeededCatalog();
    const videoHost = createMultiViewVideoHost();
    const store = createMemoryPreferencesStore();

    try {
      const view = await render(
        <AppProviders preferencesStore={store}>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <AppShell catalog={catalog} videoHost={videoHost} />
          </ViewportProvider>
        </AppProviders>,
      );

      // Home loads with Alpha News first, Beta News second
      await waitFor(() => {
        expect(screen.getByTestId('home-live-item-0')).toBeTruthy();
      });
      expect(screen.getByTestId('home-live-item-0').props.accessibilityLabel).toContain(
        'Alpha News',
      );

      // Navigate to Live -> Favorites mode and move Beta News up via LiveContextMenu
      await fireEvent.press(screen.getByTestId('nav-tab-live'));
      await waitFor(() => {
        expect(screen.getByTestId('live-zap-row-1')).toBeTruthy();
      });

      await fireEvent(screen.getByTestId('live-zap-row-1'), 'longPress');
      await waitFor(() => {
        expect(screen.getByTestId('live-context-move-up')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('live-context-move-up'));

      await waitFor(() => {
        expect(screen.getByTestId('live-zap-row-0').props.accessibilityLabel).toContain(
          'Beta News',
        );
      });

      // Return to Home -> must immediately reflect Beta News first with zero stale cache flash
      await fireEvent.press(screen.getByTestId('nav-tab-home'));
      await waitFor(() => {
        expect(screen.getByTestId('home-live-item-0').props.accessibilityLabel).toContain(
          'Beta News',
        );
      });

      await view.unmount();
    } finally {
      handle.close();
    }
  });
});
