import { createCatalogService, openCatalog, resolveAccountPoolKey } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import {
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  elvError,
  err,
  type HttpClient,
  type HttpResponse,
  ok,
  type PreferencesPatch,
  type PreferencesSnapshot,
} from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createConnectionTracker } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  FormFactorProvider,
  I18nProvider,
  ThemeProvider,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { type ReactElement, useEffect, useState } from 'react';
import { View } from 'react-native';
import { AppProviders, AppShell, PlaybackSettingsPanel } from '..';
import { buildPlayTargetFromPopoutDock, buildPopoutLaunchPayload } from '../app-shell-desktop';
import type { DesktopWindowPort, PopoutDockPayload } from '../ports/desktop-window-host';
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
  return {
    catalog,
    async cleanup() {
      await catalog.close();
      handle.close();
    },
  };
}

function SettingsHarness({ viewport }: { readonly viewport: ViewportOverride }): ReactElement {
  const [store] = useState(() => createMemoryPreferencesStore());
  const [i18n] = useState(() => createAppI18n('en'));
  const [prefs, setPrefs] = useState<PreferencesSnapshot>(DEFAULT_PREFERENCES);

  useEffect(() => {
    let active = true;
    const unsub = store.subscribe((next) => {
      if (active) setPrefs(next);
    });
    void store.load().then((loaded) => {
      if (active) setPrefs(loaded);
    });
    return () => {
      active = false;
      unsub();
    };
  }, [store]);

  return (
    <FormFactorProvider value={viewport.formFactor}>
      <ViewportProvider value={viewport}>
        <I18nProvider i18n={i18n}>
          <ThemeProvider preset="obsidianCrimson">
            <PlaybackSettingsPanel
              preferences={{
                preferences: prefs,
                updatePreferences: (patch: PreferencesPatch) => store.update(patch),
                resetPreferences: () => store.reset(),
              }}
            />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    </FormFactorProvider>
  );
}

describe('Wave F6 Desktop Tray & Popout (#158), Persistent Mini-Player (#233) & Settings Toggles', () => {
  it('maps Popout launch and dock payloads cleanly without leaking credentials', () => {
    const launch = buildPopoutLaunchPayload(
      {
        itemKey: 'vod:src-1:9',
        sourceId: 'src-1',
        title: 'Episode 1',
        subtitle: 'S1 E1',
        kind: 'vod',
        itemKind: 'episode',
      },
      42_500.4,
    );
    expect(launch).toEqual({
      itemKey: 'vod:src-1:9',
      kind: 'episode',
      title: 'Episode 1',
      subtitle: 'S1 E1',
      sourceId: 'src-1',
      resumePositionMs: 42_500,
    });

    const docked = buildPlayTargetFromPopoutDock({
      itemKey: 'vod:src-1:9',
      kind: 'episode',
      title: 'Episode 1',
      sourceId: 'src-1',
      positionMs: 55_000,
    });
    expect(docked).toMatchObject({
      itemKey: 'vod:src-1:9',
      sourceId: 'src-1',
      kind: 'vod',
      itemKind: 'episode',
      startPositionMs: 55_000,
    });
  });

  it('wires tray sync, hidden-to-tray connection release, popout teardown-before-open, dock re-open, and zero-reconnect mini-player in AppShell', async () => {
    const env = await createSeededEnv();
    const sources = await env.catalog.listSources();
    const firstSource = sources[0];
    if (firstSource === undefined) throw new Error('expected seeded source');
    const accountKey = resolveAccountPoolKey(firstSource);
    const tracker = createConnectionTracker();
    const prefsStore = createMemoryPreferencesStore({ minimizeToTray: true });
    let hiddenToTrayCb: (() => void) | undefined;
    let restoredCb: (() => void) | undefined;
    let dockedCb: ((payload: PopoutDockPayload) => void) | undefined;

    const setMinimizeToTray = jest.fn();
    let trackerCountAtPopoutOpen = -1;
    const openPopout = jest.fn(async () => {
      trackerCountAtPopoutOpen = tracker.activeCount(accountKey);
      return true;
    });

    const desktopWindow: DesktopWindowPort = {
      setMinimizeToTray,
      openPopout,
      onHiddenToTray: (cb) => {
        hiddenToTrayCb = cb;
        return () => {
          hiddenToTrayCb = undefined;
        };
      },
      onWindowRestored: (cb) => {
        restoredCb = cb;
        return () => {
          restoredCb = undefined;
        };
      },
      onPopoutDocked: (cb) => {
        dockedCb = cb;
        return () => {
          dockedCb = undefined;
        };
      },
    };

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

      await waitFor(() => {
        expect(screen.getByTestId('home-live-item-0')).toBeTruthy();
        expect(setMinimizeToTray).toHaveBeenCalledWith(true);
      });

      // Launch live channel -> full player active
      await fireEvent.press(screen.getByTestId('home-live-item-0'));
      await waitFor(() => expect(screen.getByTestId('player-minimize-button')).toBeTruthy());
      expect(openEngineSpy).toHaveBeenCalledTimes(1);
      expect(tracker.activeCount(accountKey)).toBe(1);

      // Minimize to floating corner mini-player -> browse shell renders alongside mini-player with ZERO stream reconnect!
      await fireEvent.press(screen.getByTestId('player-minimize-button'));
      await waitFor(() => {
        expect(screen.getByTestId('app-shell')).toBeTruthy();
        expect(screen.getByTestId('floating-mini-player')).toBeTruthy();
      });
      expect(openEngineSpy).toHaveBeenCalledTimes(1);

      // Expand back to fullscreen -> still ZERO stream reconnect!
      await fireEvent.press(screen.getByTestId('mini-player-expand'));
      await waitFor(() => expect(screen.getByTestId('player-popout-button')).toBeTruthy());
      expect(openEngineSpy).toHaveBeenCalledTimes(1);

      // Trigger desktop window restored -> OSD remains visible
      await act(async () => {
        restoredCb?.();
      });
      expect(screen.getByTestId('player-osd')).toBeTruthy();

      // Popout player -> local connection slot MUST be 0 before openPopout runs!
      await fireEvent.press(screen.getByTestId('player-popout-button'));
      await waitFor(() => expect(openPopout).toHaveBeenCalledTimes(1));
      expect(trackerCountAtPopoutOpen).toBe(0);
      expect(screen.getByTestId('app-shell')).toBeTruthy();

      // Dock from popout -> re-opens playTarget in main AppShell
      await act(async () => {
        dockedCb?.({
          itemKey: 'live:src-1:101',
          kind: 'live',
          title: 'Live News',
          sourceId: 'src-1',
          positionMs: 0,
        });
      });
      await waitFor(() => expect(screen.getByTestId('player-osd')).toBeTruthy());
      expect(tracker.activeCount(accountKey)).toBe(1);

      // Hide to tray while backgroundAudioPlayback is false -> stops stream & frees connection slot!
      await act(async () => {
        hiddenToTrayCb?.();
      });
      await waitFor(() => expect(screen.queryByTestId('player-osd')).toBeNull());
      expect(tracker.activeCount(accountKey)).toBe(0);
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('shows autoEnterPip on mobile/tablet/TV and minimizeToTray on desktop with persistence', async () => {
    const mobileView = await render(
      <SettingsHarness
        viewport={{
          formFactor: 'phone',
          orientation: 'portrait',
          inputModality: 'touch',
          width: 393,
          height: 852,
        }}
      />,
    );
    const pipToggle = screen.getByTestId('settings-playback-toggle-auto-enter-pip');
    expect(pipToggle.props.accessibilityState?.checked).toBe(true);
    expect(screen.queryByTestId('settings-playback-toggle-minimize-to-tray')).toBeNull();
    await fireEvent.press(pipToggle);
    await waitFor(() => {
      expect(
        screen.getByTestId('settings-playback-toggle-auto-enter-pip').props.accessibilityState
          ?.checked,
      ).toBe(false);
    });
    await mobileView.unmount();

    const desktopView = await render(
      <SettingsHarness
        viewport={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      />,
    );
    const trayToggle = screen.getByTestId('settings-playback-toggle-minimize-to-tray');
    expect(trayToggle.props.accessibilityState?.checked).toBe(false);
    expect(screen.queryByTestId('settings-playback-toggle-auto-enter-pip')).toBeNull();
    await fireEvent.press(trayToggle);
    await waitFor(() => {
      expect(
        screen.getByTestId('settings-playback-toggle-minimize-to-tray').props.accessibilityState
          ?.checked,
      ).toBe(true);
    });
    await desktopView.unmount();
  });
});
