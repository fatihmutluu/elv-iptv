import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { elvError, err, type HttpClient, type HttpResponse, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, View } from 'react-native';
import { AppShell } from '../index';
import type { VideoHost } from '../ports/video-host';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

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

function createWaveR1HttpClient(): HttpClient {
  return {
    async get(rawUrl) {
      const url = new URL(rawUrl);
      if (url.pathname !== '/player_api.php') {
        return err(elvError('network', 'http-404'));
      }
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
      if (action === 'get_series_categories') {
        return ok(jsonResponse([{ category_id: '20', category_name: 'Shows' }]));
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
      if (action === 'get_series') {
        return ok(
          jsonResponse([{ series_id: 301, name: 'Synthetic Series One', category_id: '20' }]),
        );
      }
      return ok(jsonResponse([]));
    },
  };
}

async function openWaveR1ShellEnv() {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) throw new Error('migrate failed');
  let nextId = 1;
  let now = 1_700_000_000_000;
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: createWaveR1HttpClient(),
    clock: () => {
      now += 10;
      return now;
    },
    newId: () => `src-${nextId++}`,
  });
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

describe('AppShell Wave R1 navigation, search popup, and profile menu integration', () => {
  it('opens SearchPopupOverlay from nav-utility-search, flows via View all into SearchScreen preserving query, opens DetailScreen, and wires Library + Profile menu', async () => {
    const env = await openWaveR1ShellEnv();

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      const added = await env.catalog.addSource({
        kind: 'xtream',
        name: 'SearchDemo',
        server: 'http://sim.example.test:8080',
        username: 'demo',
        password: ['de', 'mo'].join(''),
      });
      if (!added.ok) throw new Error('addSource failed');
      await env.catalog.importSource(added.value.id);

      view = await render(
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <AppShell catalog={env.catalog} videoHost={env.videoHost} />
          </I18nProvider>
        </FormFactorProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('home-screen')).toBeTruthy();
      });

      // Library top-right bookmark utility opens LibraryScreen cleanly
      await fireEvent.press(screen.getByTestId('nav-utility-library'));
      await waitFor(() => {
        expect(screen.getByTestId('library-screen')).toBeTruthy();
        expect(screen.getByTestId('nav-utility-library').props.accessibilityState.selected).toBe(
          true,
        );
      });

      // Search icon opens SearchPopupOverlay instead of navigating straight to SearchScreen
      await fireEvent.press(screen.getByTestId('nav-utility-search'));
      await waitFor(() => {
        expect(screen.getByTestId('search-popup-overlay')).toBeTruthy();
        expect(
          screen.getByTestId('nav-utility-search', { includeHiddenElements: true }).props
            .accessibilityState.selected,
        ).toBe(true);
      });

      await fireEvent.changeText(screen.getByTestId('search-popup-input'), 'Synthetic Movie');
      await waitFor(() => {
        expect(screen.getByTestId('search-popup-movie-0')).toBeTruthy();
        expect(screen.getByTestId('search-popup-view-all')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('search-popup-view-all'));
      await waitFor(() => {
        expect(screen.queryByTestId('search-popup-overlay')).toBeNull();
        expect(screen.getByTestId('search-screen')).toBeTruthy();
        expect(screen.getByTestId('search-input').props.value).toBe('Synthetic Movie');
        expect(screen.getByTestId('search-movie-item-0')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('search-scope-movie'));
      expect(screen.getByTestId('search-scope-movie').props.accessibilityState.selected).toBe(true);

      await fireEvent.press(screen.getByTestId('search-movie-item-0'));
      await waitFor(() => {
        expect(screen.getByTestId('detail-screen')).toBeTruthy();
        expect(screen.getByTestId('detail-title')).toHaveTextContent('Synthetic Movie One');
      });

      await fireEvent.press(screen.getByTestId('detail-back'));
      await waitFor(() => {
        expect(screen.getByTestId('search-screen')).toBeTruthy();
        expect(screen.getByTestId('search-input').props.value).toBe('Synthetic Movie');
        expect(screen.getByTestId('search-scope-movie').props.accessibilityState.selected).toBe(
          true,
        );
        expect(screen.getByTestId('search-movie-item-0')).toBeTruthy();
      });

      // Profile dropdown Edit profiles navigates directly to Settings -> Profiles
      await fireEvent.press(screen.getByTestId('nav-utility-profile'));
      await fireEvent.press(screen.getByTestId('profile-menu-edit-profiles'));
      await waitFor(() => {
        expect(screen.getByTestId('settings-screen')).toBeTruthy();
        expect(screen.getByTestId('settings-panel-profiles')).toBeTruthy();
      });

      // Profile dropdown + Add new opens 2-step add profile flow directly; Sign out (local) opens picker
      await fireEvent.press(screen.getByTestId('nav-utility-profile'));
      await fireEvent.press(screen.getByTestId('profile-menu-add-new'));
      await waitFor(() => {
        expect(screen.getByTestId('profile-picker-overlay')).toBeTruthy();
        expect(screen.getByTestId('profile-add-type-modal')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('profile-picker-close'));

      await fireEvent.press(screen.getByTestId('nav-utility-profile'));
      await fireEvent.press(screen.getByTestId('profile-menu-sign-out'));
      await waitFor(() => {
        expect(screen.getByTestId('profile-picker-overlay')).toBeTruthy();
      });
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('exits top-nav focus cleanly on 10-ft TV when opening Settings from ProfileDropdownMenu', async () => {
    const osReplacer = jest.replaceProperty(Platform, 'OS', 'android');
    const isTvSpy = jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    let keyListener: ((event: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (listener) => {
        keyListener = listener;
        return {
          remove: () => {
            keyListener = undefined;
          },
        };
      },
    };
    const sendKey = async (keyCode: number) => {
      await act(async () => {
        keyListener?.({ keyCode, action: 'down', canceled: false, ageMs: 0 });
        keyListener?.({ keyCode, action: 'up', canceled: false, ageMs: 10 });
      });
    };

    const env = await openWaveR1ShellEnv();
    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      const added = await env.catalog.addSource({
        kind: 'xtream',
        name: 'TvNavDemo',
        server: 'http://sim.example.test:8080',
        username: 'demo',
        password: ['de', 'mo'].join(''),
      });
      if (!added.ok) throw new Error('addSource failed');
      await env.catalog.importSource(added.value.id);

      view = await render(
        <RemoteKeysProvider android={androidSource}>
          <FormFactorProvider value="tv">
            <I18nProvider i18n={createAppI18n('en')}>
              <AppShell catalog={env.catalog} videoHost={env.videoHost} />
            </I18nProvider>
          </FormFactorProvider>
        </RemoteKeysProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('home-screen')).toBeTruthy();
      });

      // Up moves TV focus into Top Nav; Right x6 navigates Home -> Live -> Movies -> Series -> Search -> Library -> Profile
      await sendKey(KEYCODE_DPAD_UP);
      expect(
        screen.getByTestId('nav-tv-focus-anchor', { includeHiddenElements: true }),
      ).toBeTruthy();

      for (let i = 0; i < 6; i += 1) {
        await sendKey(KEYCODE_DPAD_RIGHT);
      }
      await sendKey(KEYCODE_DPAD_CENTER);
      await waitFor(() => {
        expect(screen.getByTestId('profile-dropdown-menu')).toBeTruthy();
      });

      // Menu items: [0: Profile, 1: + Add new, 2: Edit profiles, 3: Settings] -> Down x3 -> Select Settings
      await sendKey(KEYCODE_DPAD_DOWN);
      await sendKey(KEYCODE_DPAD_DOWN);
      await sendKey(KEYCODE_DPAD_DOWN);
      await sendKey(KEYCODE_DPAD_CENTER);

      await waitFor(() => {
        expect(screen.getByTestId('settings-screen')).toBeTruthy();
        expect(
          screen.queryByTestId('nav-tv-focus-anchor', { includeHiddenElements: true }),
        ).toBeNull();
        expect(
          screen.getByTestId('settings-tv-focus-anchor', { includeHiddenElements: true }),
        ).toBeTruthy();
      });
    } finally {
      isTvSpy.mockRestore();
      osReplacer.restore();
      await view?.unmount();
      await env.cleanup();
    }
  });
});
