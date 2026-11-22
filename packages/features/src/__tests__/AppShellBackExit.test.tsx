import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { elvError, err, type HttpClient, type HttpResponse, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  RemoteKeysProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { BackHandler, Platform, View } from 'react-native';
import { handleShellTopNavBack } from '../app-shell-state';
import { AppShell } from '../index';
import type { VideoHost } from '../ports/video-host';
import { RouteActiveProvider } from '../shared';

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

function createBackTestHttp(): HttpClient {
  return {
    async get(rawUrl) {
      const url = new URL(rawUrl);
      if (url.pathname !== '/player_api.php') return err(elvError('network', 'http-404'));
      const action = url.searchParams.get('action');
      if (!action) {
        return ok(
          jsonResponse({
            user_info: { auth: 1, status: 'Active', allowed_output_formats: ['ts', 'm3u8'] },
            server_info: { timezone: 'UTC' },
          }),
        );
      }
      if (action === 'get_live_categories') {
        return ok(jsonResponse([{ category_id: '1', category_name: 'General' }]));
      }
      if (action === 'get_vod_categories') {
        return ok(jsonResponse([{ category_id: '10', category_name: 'Feature Films' }]));
      }
      if (action === 'get_live_streams') {
        return ok(jsonResponse([{ stream_id: 101, name: 'Channel 1', category_id: '1', num: 1 }]));
      }
      if (action === 'get_vod_streams') {
        return ok(
          jsonResponse([
            {
              stream_id: 201,
              name: 'Synthetic Movie One',
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

async function createSeededShellEnv() {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) throw new Error('migrate failed');
  let now = 1_700_000_000_000;
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: createBackTestHttp(),
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

  const engine = createFakePlayerEngine({
    now: () => performance.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const videoHost: VideoHost = {
    open: () => ({
      engine,
      renderSurface: ({ testID }) => <View testID={testID ?? 'shell-surface'} />,
    }),
  };

  return {
    catalog,
    videoHost,
    async cleanup() {
      await catalog.close();
      handle.close();
    },
  };
}

describe('AppShell Android TV BackHandler exit (#425), TvFocusGuideRegions (#281), and hasTVPreferredFocus (#130)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('propagates BackHandler false at root Home top-nav, switches secondary tabs back to Home, and closes Detail/Player without exiting (#425)', async () => {
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
    let backCb: Parameters<typeof BackHandler.addEventListener>[1] | undefined;
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_ev, handler) => {
      backCb = handler;
      return { remove: jest.fn() };
    });

    const sendRawKey = async (keyCode: number) => {
      await act(async () => {
        keyListener?.({ action: 'down', keyCode, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode, canceled: false, ageMs: 10 });
      });
    };
    const triggerHardwareBack = async (): Promise<boolean | null | undefined> => {
      let result: boolean | null | undefined;
      await act(async () => {
        result = (backCb as (() => boolean | null | undefined) | undefined)?.();
      });
      return result;
    };

    const env = await createSeededShellEnv();
    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <RemoteKeysProvider android={androidSource}>
          <ViewportProvider
            value={{ formFactor: 'tv', orientation: 'landscape', width: 1920, height: 1080 }}
          >
            <I18nProvider i18n={createAppI18n('en')}>
              <AppShell catalog={env.catalog} videoHost={env.videoHost} />
            </I18nProvider>
          </ViewportProvider>
        </RemoteKeysProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('home-screen')).toBeTruthy();
        expect(screen.getByTestId('home-movies-item-0')).toBeTruthy();
      });

      // Home rails render per-rail sibling TvFocusGuideRegions (#281)
      expect(screen.getByTestId('home-rail-live-focus-guide')).toBeTruthy();
      expect(screen.getByTestId('home-rail-movies-focus-guide')).toBeTruthy();

      // 1. Open DetailScreen overlay -> hardware Back returns true and closes Detail without exiting
      await fireEvent.press(screen.getByTestId('home-movies-item-0'));
      await waitFor(() => expect(screen.getByTestId('detail-screen')).toBeTruthy());
      expect(await triggerHardwareBack()).toBe(true);
      await waitFor(() => expect(screen.getByTestId('home-screen')).toBeTruthy());

      // 2. Open PlayerScreen -> hardware Back returns true and exits Player without exiting app
      await fireEvent.press(screen.getByTestId('home-live-item-0'));
      await waitFor(() => expect(screen.getByTestId('player-osd')).toBeTruthy());
      expect(await triggerHardwareBack()).toBe(true);
      await waitFor(() => expect(screen.getByTestId('home-screen')).toBeTruthy());

      // 3. On Home content (!topNavFocused), Back moves focus to top nav and returns true
      expect(await triggerHardwareBack()).toBe(true);
      expect(
        screen.getByTestId('nav-tv-focus-anchor', { includeHiddenElements: true }),
      ).toBeTruthy();

      // 4. Move right twice to Movies tab while in top nav -> Catalog renders sibling rail focus guides
      await sendRawKey(22); // Live
      await sendRawKey(22); // Movies
      await waitFor(() => {
        expect(screen.getByTestId('catalog-screen-movie')).toBeTruthy();
        expect(screen.getByTestId('catalog-rail-0-focus-guide')).toBeTruthy();
      });

      // 5. Pressing Back from secondary tab top-nav returns true and switches to Home (keeping top-nav focused)
      expect(await triggerHardwareBack()).toBe(true);
      await waitFor(() => {
        expect(screen.getByTestId('home-screen')).toBeTruthy();
        expect(screen.getByTestId('nav-tab-home').props.accessibilityState.selected).toBe(true);
      });
      expect(
        screen.getByTestId('nav-tv-focus-anchor', { includeHiddenElements: true }),
      ).toBeTruthy();

      // 6. First Back at root Home top-nav shows exit confirmation toast (#55); second Back returns false so Android TV exits cleanly!
      expect(await triggerHardwareBack()).toBe(true);
      expect(screen.getByTestId('shell-exit-confirm-toast')).toBeTruthy();
      expect(await triggerHardwareBack()).toBe(false);
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('gates tab-root TvFocusAnchor hasTVPreferredFocus when routeActive is false (#130) and resolves top-nav Back states cleanly (#425)', async () => {
    const popDetail = jest.fn();
    const exitNavFocus = jest.fn();
    const selectHomeInTopNav = jest.fn();

    expect(
      handleShellTopNavBack({
        activeTab: 'home',
        hasActiveDetail: true,
        popDetail,
        exitNavFocus,
        selectHomeInTopNav,
      }),
    ).toBe(true);
    expect(popDetail).toHaveBeenCalledTimes(1);
    expect(exitNavFocus).toHaveBeenCalledTimes(1);

    expect(
      handleShellTopNavBack({
        activeTab: 'movie',
        hasActiveDetail: false,
        popDetail,
        exitNavFocus,
        selectHomeInTopNav,
      }),
    ).toBe(true);
    expect(selectHomeInTopNav).toHaveBeenCalledTimes(1);

    expect(
      handleShellTopNavBack({
        activeTab: 'home',
        hasActiveDetail: false,
        popDetail,
        exitNavFocus,
        selectHomeInTopNav,
      }),
    ).toBe(false);

    const env = await createSeededShellEnv();
    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <RouteActiveProvider active={false}>
          <ViewportProvider
            value={{ formFactor: 'tv', orientation: 'landscape', width: 1920, height: 1080 }}
          >
            <I18nProvider i18n={createAppI18n('en')}>
              <AppShell catalog={env.catalog} videoHost={env.videoHost} />
            </I18nProvider>
          </ViewportProvider>
        </RouteActiveProvider>,
      );

      await waitFor(() => {
        expect(
          screen.getByTestId('home-tv-focus-anchor', { includeHiddenElements: true }),
        ).toBeTruthy();
      });
      expect(
        screen.getByTestId('home-tv-focus-anchor', { includeHiddenElements: true }).props
          .hasTVPreferredFocus,
      ).toBe(false);
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });
});
