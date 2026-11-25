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
import { createAppI18n } from '@elv/i18n';
import { createConnectionTracker } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
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
              max_connections: '1',
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
        return ok(jsonResponse([{ stream_id: 101, name: 'Live News', category_id: '1', num: 1 }]));
      }
      if (action === 'get_vod_categories') {
        return ok(jsonResponse([{ category_id: '10', category_name: 'Sci-Fi' }]));
      }
      if (action === 'get_vod_streams') {
        return ok(
          jsonResponse([
            {
              stream_id: 501,
              name: 'Cinema Film',
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

async function createSeededEnv() {
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
    server: 'http://sim.example.test:8080',
    username: 'demo',
    password: ['de', 'mo'].join(''),
  });
  if (!added.ok) throw new Error('addSource failed');
  await catalog.importSource(added.value.id);
  const cats = await catalog.categories(added.value.id, 'live');
  if (cats[0]) {
    const liveItems = await catalog.items(cats[0].id, 0, 10);
    if (liveItems[0]) {
      await catalog.setFavorite?.(
        {
          itemKey: liveItems[0].key,
          sourceId: liveItems[0].sourceId,
          kind: 'live',
          title: liveItems[0].name,
          logo: liveItems[0].logo ?? null,
        },
        true,
      );
    }
  }
  return {
    catalog,
    async cleanup() {
      await catalog.close();
      handle.close();
    },
  };
}

describe('Wave F6 regressions: Live preview suppression (HIGH #3) & cache/detailStack preservation (HIGH #4)', () => {
  it('suppresses Live embedded preview when navigating to Live -> Favorites while Floating Mini-Player is active (HIGH #3)', async () => {
    const env = await createSeededEnv();
    const prefsStore = createMemoryPreferencesStore({ defaultLiveMode: 'favorites' });
    const openEngineSpy = jest.fn(() => {
      const engine = createFakePlayerEngine({
        now: () => performance.now(),
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      });
      return {
        engine,
        overlayMode: 'floating' as const,
        renderSurface: ({ testID }: { testID?: string }) => (
          <View testID={testID ?? 'shell-surface'} />
        ),
      };
    });
    const videoHost: VideoHost = { open: openEngineSpy, supportsMultiView: true };

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <AppProviders preferencesStore={prefsStore}>
          <FormFactorProvider value="desktop">
            <ViewportProvider
              value={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 800 }}
            >
              <I18nProvider i18n={createAppI18n('en')}>
                <AppShell catalog={env.catalog} videoHost={videoHost} />
              </I18nProvider>
            </ViewportProvider>
          </FormFactorProvider>
        </AppProviders>,
      );

      await waitFor(() => expect(screen.getByTestId('home-live-item-0')).toBeTruthy());

      // Start live playback -> 1st videoHost.open()
      await fireEvent.press(screen.getByTestId('home-live-item-0'));
      await waitFor(() => expect(screen.getByTestId('player-minimize-button')).toBeTruthy());
      expect(openEngineSpy).toHaveBeenCalledTimes(1);

      // Minimize to Floating Mini-Player -> still 1 engine open
      await fireEvent.press(screen.getByTestId('player-minimize-button'));
      await waitFor(() => expect(screen.getByTestId('floating-mini-player')).toBeTruthy());
      expect(openEngineSpy).toHaveBeenCalledTimes(1);

      // Navigate to Live TV -> Favorites while mini-player is active
      await fireEvent.press(screen.getByTestId('nav-tab-live'));
      await waitFor(() => expect(screen.getByTestId('live-screen')).toBeTruthy());

      // Allow any microtasks/effects in LiveScreen to flush
      await act(async () => {
        await new Promise((r) => setTimeout(r, 80));
      });

      // LiveScreen MUST NOT open a second preview engine while mini-player is playing!
      expect(openEngineSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('floating-mini-player')).toBeTruthy();
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('preserves detailStack and stops active player cleanly before Desktop Popout without wiping source caches (HIGH #4)', async () => {
    const env = await createSeededEnv();
    const tracker = createConnectionTracker();
    const stopSpy = jest.fn();
    let stopCalledBeforePopout = false;
    const openPopout = jest.fn(async () => {
      stopCalledBeforePopout = stopSpy.mock.calls.length > 0;
      return true;
    });
    const desktopWindow: DesktopWindowPort = { openPopout };

    const openEngineSpy = jest.fn(() => {
      const engine = createFakePlayerEngine({
        now: () => performance.now(),
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      });
      const origStop = engine.stop.bind(engine);
      engine.stop = (attempt) => {
        stopSpy();
        origStop(attempt);
      };
      return {
        engine,
        overlayMode: 'floating' as const,
        renderSurface: ({ testID }: { testID?: string }) => (
          <View testID={testID ?? 'shell-surface'} />
        ),
      };
    });
    const videoHost: VideoHost = { open: openEngineSpy, supportsMultiView: true };

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <AppProviders>
          <FormFactorProvider value="desktop">
            <ViewportProvider
              value={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 800 }}
            >
              <I18nProvider i18n={createAppI18n('en')}>
                <AppShell
                  catalog={env.catalog}
                  videoHost={videoHost}
                  connectionTracker={tracker}
                  desktopWindow={desktopWindow}
                />
              </I18nProvider>
            </ViewportProvider>
          </FormFactorProvider>
        </AppProviders>,
      );

      // Navigate to Movies -> open Movie Detail (populates detailStack!)
      await waitFor(() => expect(screen.getByTestId('nav-tab-movie')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('nav-tab-movie'));
      await waitFor(() => expect(screen.getByTestId('catalog-rail-0-item-0')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('catalog-rail-0-item-0'));
      await waitFor(() => expect(screen.getByTestId('detail-play')).toBeTruthy());

      // Play movie from DetailScreen
      await fireEvent.press(screen.getByTestId('detail-play'));
      await waitFor(() => expect(screen.getByTestId('player-popout-button')).toBeTruthy());

      // Pop out player -> must stop active player before opening popout AND preserve detailStack!
      await fireEvent.press(screen.getByTestId('player-popout-button'));
      await waitFor(() => expect(openPopout).toHaveBeenCalledTimes(1));

      expect(stopCalledBeforePopout).toBe(true);
      // DetailScreen MUST still be on top of detailStack (not wiped by stopForSource!)
      expect(screen.getByTestId('detail-screen')).toBeTruthy();
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('stops active player cleanly before entering Multi-View without calling playbackGuard.stopIfUsingSource (HIGH #4)', async () => {
    const env = await createSeededEnv();
    const stopSpy = jest.fn();
    let stopCalledBeforeMultiViewOpen = false;
    let openCount = 0;

    const openEngineSpy = jest.fn(() => {
      openCount += 1;
      if (openCount === 2) {
        stopCalledBeforeMultiViewOpen = stopSpy.mock.calls.length > 0;
      }
      const engine = createFakePlayerEngine({
        now: () => performance.now(),
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      });
      const origStop = engine.stop.bind(engine);
      engine.stop = (attempt) => {
        stopSpy();
        origStop(attempt);
      };
      return {
        engine,
        overlayMode: 'floating' as const,
        renderSurface: ({ testID }: { testID?: string }) => (
          <View testID={testID ?? 'shell-surface'} />
        ),
      };
    });
    const videoHost: VideoHost = { open: openEngineSpy, supportsMultiView: true };
    let guardStopSpy: jest.SpyInstance | undefined;

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <AppProviders>
          <FormFactorProvider value="desktop">
            <ViewportProvider
              value={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 800 }}
            >
              <I18nProvider i18n={createAppI18n('en')}>
                <AppShell
                  catalog={env.catalog}
                  videoHost={videoHost}
                  onPlaybackGuardReady={(guard) => {
                    guardStopSpy = jest.spyOn(guard, 'stopIfUsingSource');
                  }}
                />
              </I18nProvider>
            </ViewportProvider>
          </FormFactorProvider>
        </AppProviders>,
      );

      await waitFor(() => expect(screen.getByTestId('home-live-item-0')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('home-live-item-0'));
      await waitFor(() => expect(screen.getByTestId('player-multiview-button')).toBeTruthy());

      await fireEvent.press(screen.getByTestId('player-multiview-button'));
      await waitFor(() => expect(screen.getByTestId('multiview-stage')).toBeTruthy());

      expect(stopCalledBeforeMultiViewOpen).toBe(true);
      expect(guardStopSpy).not.toHaveBeenCalled();
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });
});
