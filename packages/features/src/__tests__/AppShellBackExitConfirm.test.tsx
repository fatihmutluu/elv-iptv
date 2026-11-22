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
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { BackHandler, Platform, View } from 'react-native';
import { createExitBackConfirmGuard, DEFAULT_EXIT_BACK_CONFIRM_MS } from '../app-shell-state';
import { AppearancePanel, AppProviders, AppShell } from '../index';
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

function createSimpleHttp(): HttpClient {
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
      if (action === 'get_vod_categories') {
        return ok(jsonResponse([{ category_id: '10', category_name: 'Movies' }]));
      }
      if (action === 'get_vod_streams') {
        return ok(
          jsonResponse([
            {
              stream_id: 201,
              name: 'Sample Film',
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
    http: createSimpleHttp(),
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

describe('TV Root Back Exit Confirmation (#55)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('createExitBackConfirmGuard arms for 2 500 ms, exits on second press, resets on timeout, and bypasses when disabled', () => {
    let scheduled: (() => void) | undefined;
    const visibility: boolean[] = [];
    const setTimeoutFn = jest.fn((fn: () => void, ms: number) => {
      expect(ms).toBe(DEFAULT_EXIT_BACK_CONFIRM_MS);
      scheduled = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimeoutFn = jest.fn(() => {
      scheduled = undefined;
    });

    const guard = createExitBackConfirmGuard(DEFAULT_EXIT_BACK_CONFIRM_MS, {
      onVisibleChange: (v) => visibility.push(v),
      setTimeoutFn,
      clearTimeoutFn,
    });

    // Disabled -> immediately returns false with no toast
    expect(guard.onRootBack(false)).toBe(false);
    expect(visibility).toEqual([]);

    // Enabled -> 1st press arms & returns true
    expect(guard.onRootBack(true)).toBe(true);
    expect(visibility).toEqual([true]);

    // 2nd press within window -> disarms, hides toast, returns false
    expect(guard.onRootBack(true)).toBe(false);
    expect(visibility).toEqual([true, false]);
    expect(clearTimeoutFn).toHaveBeenCalledTimes(1);

    // Timeout resets window so later Back re-asks
    expect(guard.onRootBack(true)).toBe(true);
    expect(visibility).toEqual([true, false, true]);
    scheduled?.();
    expect(visibility).toEqual([true, false, true, false]);
    expect(guard.onRootBack(true)).toBe(true);
    expect(visibility).toEqual([true, false, true, false, true]);

    guard.reset();
    expect(visibility).toEqual([true, false, true, false, true, false]);
    guard.dispose();
  });

  it('shows exit toast on first root Back, exits cleanly on second Back within 2.5s, and resets after timeout', async () => {
    jest.useFakeTimers();
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

    const triggerHardwareBack = async (): Promise<boolean | null | undefined> => {
      let result: boolean | null | undefined;
      await act(async () => {
        result = (backCb as (() => boolean | null | undefined) | undefined)?.();
      });
      return result;
    };

    const env = await createSeededShellEnv();
    const store = createMemoryPreferencesStore({ confirmExitOnBack: true });
    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <RemoteKeysProvider android={androidSource}>
          <ViewportProvider
            value={{ formFactor: 'tv', orientation: 'landscape', width: 1920, height: 1080 }}
          >
            <AppProviders preferencesStore={store} systemLocale="en">
              <AppShell catalog={env.catalog} videoHost={env.videoHost} />
            </AppProviders>
          </ViewportProvider>
        </RemoteKeysProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('home-screen')).toBeTruthy();
      });

      // Back from Home content focuses Top Nav
      expect(await triggerHardwareBack()).toBe(true);
      expect(screen.queryByTestId('shell-exit-confirm-toast')).toBeNull();

      // 1st Back on root Home top-nav shows toast and consumes event
      expect(await triggerHardwareBack()).toBe(true);
      expect(screen.getByTestId('shell-exit-confirm-toast')).toHaveTextContent(
        'Press Back again to exit',
      );

      // Timeout expires -> toast hides and next Back asks again
      await act(async () => {
        jest.advanceTimersByTime(DEFAULT_EXIT_BACK_CONFIRM_MS + 50);
      });
      expect(screen.queryByTestId('shell-exit-confirm-toast')).toBeNull();

      // 1st Back again -> shows toast
      expect(await triggerHardwareBack()).toBe(true);
      expect(screen.getByTestId('shell-exit-confirm-toast')).toBeTruthy();

      // 2nd Back within 2.5s -> clears toast and returns false so Android TV exits cleanly!
      expect(await triggerHardwareBack()).toBe(false);
      expect(screen.queryByTestId('shell-exit-confirm-toast')).toBeNull();
      expect(keyListener).toBeDefined();
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('exits immediately on first root Back with zero toast when confirmExitOnBack is false', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const androidSource: AndroidKeySource = {
      addListener: () => ({ remove: () => undefined }),
    };
    let backCb: Parameters<typeof BackHandler.addEventListener>[1] | undefined;
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_ev, handler) => {
      backCb = handler;
      return { remove: jest.fn() };
    });

    const triggerHardwareBack = async (): Promise<boolean | null | undefined> => {
      let result: boolean | null | undefined;
      await act(async () => {
        result = (backCb as (() => boolean | null | undefined) | undefined)?.();
      });
      return result;
    };

    const env = await createSeededShellEnv();
    const store = createMemoryPreferencesStore({ confirmExitOnBack: false });
    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <RemoteKeysProvider android={androidSource}>
          <ViewportProvider
            value={{ formFactor: 'tv', orientation: 'landscape', width: 1920, height: 1080 }}
          >
            <AppProviders preferencesStore={store} systemLocale="en">
              <AppShell catalog={env.catalog} videoHost={env.videoHost} />
            </AppProviders>
          </ViewportProvider>
        </RemoteKeysProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('home-screen')).toBeTruthy();
      });

      // Back from Home content focuses Top Nav
      expect(await triggerHardwareBack()).toBe(true);
      // 1st Back at root Home top-nav returns false immediately with zero toast
      expect(await triggerHardwareBack()).toBe(false);
      expect(screen.queryByTestId('shell-exit-confirm-toast')).toBeNull();
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('toggles and persists confirmExitOnBack inside AppearancePanel', async () => {
    const store = createMemoryPreferencesStore({ confirmExitOnBack: true });
    let snapshot = await store.load();
    const updatePreferences = jest.fn(async (patch) => {
      const res = await store.update(patch);
      if (res.ok) snapshot = res.value;
      return res;
    });

    await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider>
          <ViewportProvider value={{ formFactor: 'desktop', orientation: 'landscape' }}>
            <AppearancePanel
              preferences={{
                preferences: snapshot,
                updatePreferences,
                resetPreferences: () => store.reset(),
              }}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    const toggle = screen.getByTestId('settings-toggle-confirm-exit');
    expect(toggle.props.accessibilityRole).toBe('switch');
    expect(toggle.props.accessibilityState.checked).toBe(true);

    await fireEvent.press(toggle);
    expect(updatePreferences).toHaveBeenCalledWith({ confirmExitOnBack: false });
    expect((await store.load()).confirmExitOnBack).toBe(false);
  });
});
