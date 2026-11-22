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
import { UiAdaptersProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppProviders, AppShell } from '../index';
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

const LIVE_HTTP: HttpClient = {
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
      return ok(jsonResponse([{ category_id: '1', category_name: 'News' }]));
    }
    if (action === 'get_live_streams') {
      return ok(jsonResponse([{ stream_id: 101, name: 'News One', category_id: '1', num: 1 }]));
    }
    return ok(jsonResponse([]));
  },
};

const EMPTY_HTTP: HttpClient = {
  async get() {
    return err(elvError('network', 'http-404'));
  },
};

const EMPTY_VIDEO_HOST: VideoHost = {
  open() {
    return null;
  },
};

describe('AppShell preference synchronization (#405)', () => {
  it('syncs artworkCacheLimitMb preference to UiAdapters.artworkCache.setLimitBytes on mount and updates', async () => {
    const driver = testDb();
    await openCatalog(driver.db);
    let nextId = 1;
    const catalog = createCatalogService({
      db: driver.db,
      secrets: memorySecrets(),
      http: EMPTY_HTTP,
      scheduler: countingScheduler(),
      clock: () => 1_700_000_000_000,
      newId: () => `src-${nextId++}`,
    });
    const preferencesStore = createMemoryPreferencesStore({ artworkCacheLimitMb: 64 });
    const setLimitBytes = jest.fn(async () => undefined);
    const clear = jest.fn(async () => undefined);

    await render(
      <UiAdaptersProvider adapters={{ artworkCache: { setLimitBytes, clear } }}>
        <ViewportProvider
          value={{
            formFactor: 'desktop',
            orientation: 'landscape',
            inputModality: 'pointer',
            width: 1280,
            height: 800,
          }}
        >
          <AppProviders preferencesStore={preferencesStore}>
            <AppShell catalog={catalog} videoHost={EMPTY_VIDEO_HOST} />
          </AppProviders>
        </ViewportProvider>
      </UiAdaptersProvider>,
    );

    await waitFor(() => {
      expect(setLimitBytes).toHaveBeenCalledWith(64 * 1024 * 1024);
    });

    await act(async () => {
      await preferencesStore.update({ artworkCacheLimitMb: 256 });
    });

    await waitFor(() => {
      expect(setLimitBytes).toHaveBeenCalledWith(256 * 1024 * 1024);
    });

    await catalog.close();
    driver.close();
  });

  it('opens Live TV on the persisted defaultLiveMode preference and updates when changed outside Live TV (#401)', async () => {
    const driver = testDb();
    await openCatalog(driver.db);
    let nextId = 1;
    const catalog = createCatalogService({
      db: driver.db,
      secrets: memorySecrets(),
      http: LIVE_HTTP,
      scheduler: countingScheduler(),
      clock: () => 1_700_000_000_000,
      newId: () => `src-${nextId++}`,
    });
    const added = await catalog.addSource({
      kind: 'xtream',
      name: 'Live Source',
      server: 'http://sim.example.test:8080',
      username: 'demo',
      password: ['de', 'mo'].join(''),
    });
    if (!added.ok) throw new Error('addSource failed');
    await catalog.importSource(added.value.id);

    const preferencesStore = createMemoryPreferencesStore({ defaultLiveMode: 'epg' });

    const view = await render(
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      >
        <AppProviders preferencesStore={preferencesStore}>
          <AppShell catalog={catalog} videoHost={EMPTY_VIDEO_HOST} />
        </AppProviders>
      </ViewportProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('nav-tab-home').props.accessibilityState.selected).toBe(true);
    });

    // Opening Live TV lands on TV Guide ('epg') from preferences
    await fireEvent.press(screen.getByTestId('nav-tab-live'));
    await waitFor(() => {
      expect(screen.getByTestId('live-epg-view')).toBeTruthy();
    });

    // Changing defaultLiveMode while away from Live TV applies on next Live TV visit
    await fireEvent.press(screen.getByTestId('nav-tab-home'));
    await act(async () => {
      await preferencesStore.update({ defaultLiveMode: 'channels' });
    });

    await fireEvent.press(screen.getByTestId('nav-tab-live'));
    await waitFor(() => {
      expect(screen.getByTestId('live-channels-grid')).toBeTruthy();
    });

    // Manual mode change inside Live TV is preserved across Home <-> Live tab switches
    await fireEvent.press(screen.getByTestId('live-mode-epg'));
    await waitFor(() => {
      expect(screen.getByTestId('live-epg-view')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('nav-tab-home'));
    await fireEvent.press(screen.getByTestId('nav-tab-live'));
    await waitFor(() => {
      expect(screen.getByTestId('live-epg-view')).toBeTruthy();
    });

    await view.unmount();
    await catalog.close();
    driver.close();
  });
});
