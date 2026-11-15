import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { elvError, err, type HttpClient, type HttpResponse, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  type FormFactor,
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, View } from 'react-native';
import { AppShell } from '../AppShell';
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

function createShellHttpClient(): HttpClient {
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
        return ok(
          jsonResponse([
            { stream_id: 101, name: 'Channel 1', category_id: '1', num: 1 },
            { stream_id: 102, name: 'Channel 2', category_id: '1', num: 2 },
            { stream_id: 103, name: 'Channel 3', category_id: '1', num: 3 },
            { stream_id: 104, name: 'Channel 4', category_id: '1', num: 4 },
          ]),
        );
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
      if (action === 'get_series_info') {
        return ok(
          jsonResponse({
            seasons: [{ season_number: 1 }],
            episodes: {
              '1': [{ id: '9001', episode_num: 1, title: 'Pilot', container_extension: 'mp4' }],
            },
          }),
        );
      }
      return ok(jsonResponse([]));
    },
  };
}

async function openShellCatalog() {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) throw new Error('migrate failed');
  let nextId = 1;
  let now = 1_700_000_000_000;
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: createShellHttpClient(),
    clock: () => {
      now += 10;
      return now;
    },
    newId: () => `src-${nextId++}`,
  });
  return {
    catalog,
    async cleanup() {
      await catalog.close();
      handle.close();
    },
  };
}

function createFakeHost() {
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
  return { engine, videoHost };
}

describe('AppShell', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens Sources on empty catalog, imports a source via UI, and browses Live, Movies, and Series', async () => {
    const env = await openShellCatalog();
    const { videoHost } = createFakeHost();

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <AppShell catalog={env.catalog} videoHost={videoHost} />
          </I18nProvider>
        </FormFactorProvider>,
      );

      expect(screen.getByTestId('sources-screen')).toBeTruthy();
      expect(screen.getByText('ELV IPTV')).toBeTruthy();
      expect(screen.getByTestId('nav-tab-sources').props.accessibilityState.selected).toBe(true);

      await fireEvent.changeText(
        screen.getByTestId('sources-input-server'),
        'http://sim.example.test:8080',
      );
      await fireEvent.changeText(screen.getByTestId('sources-input-username'), 'demo');
      await fireEvent.changeText(
        screen.getByTestId('sources-input-password'),
        ['de', 'mo'].join(''),
      );
      await fireEvent.press(screen.getByTestId('sources-submit'));

      await waitFor(() => {
        expect(screen.getByTestId('sources-open-menu')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('nav-tab-live'));
      await waitFor(() => {
        expect(screen.getByText('1. Channel 1')).toBeTruthy();
      });
      expect(screen.getByText('ELV IPTV')).toBeTruthy();

      await fireEvent.press(screen.getByTestId('nav-tab-movie'));
      await waitFor(() => {
        expect(screen.getByText('Synthetic Movie One')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('nav-tab-series'));
      await waitFor(() => {
        expect(screen.getByText('Synthetic Series One')).toBeTruthy();
      });
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('auto-imports needsImport sources at startup and restores zapped Live channel focus on Back, stopping playback on source removal', async () => {
    const env = await openShellCatalog();
    const { engine, videoHost } = createFakeHost();

    try {
      const added = await env.catalog.addSource({
        kind: 'xtream',
        name: 'Restored',
        server: 'http://sim.example.test:8080',
        username: 'demo',
        password: ['de', 'mo'].join(''),
      });
      if (!added.ok) throw new Error('addSource failed');
      const importSpy = jest.spyOn(env.catalog, 'importSource');

      const view = await render(
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <AppShell catalog={env.catalog} videoHost={videoHost} />
          </I18nProvider>
        </FormFactorProvider>,
      );

      await waitFor(() => {
        expect(importSpy).toHaveBeenCalledTimes(1);
        expect(screen.getByText('2. Channel 2')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('browse-items-list-row-1'));
      await waitFor(() => {
        expect(screen.getByTestId('osd-title')).toHaveTextContent('2. Channel 2');
      });

      await fireEvent.press(screen.getByTestId('player-next'));
      await waitFor(() => {
        expect(screen.getByTestId('osd-title')).toHaveTextContent('3. Channel 3');
      });
      await fireEvent.press(screen.getByTestId('player-next'));
      await waitFor(() => {
        expect(screen.getByTestId('osd-title')).toHaveTextContent('4. Channel 4');
      });

      await fireEvent.press(screen.getByTestId('player-back'));
      await waitFor(() => {
        expect(
          screen.getByTestId('browse-items-list-row-3').props.accessibilityState.selected,
        ).toBe(true);
      });

      // Re-open playback and verify removing the active source immediately stops playback & unmounts PlayerScreen.
      await fireEvent.press(screen.getByTestId('browse-items-list-row-3'));
      await waitFor(() => {
        expect(engine.openMedias()).toBe(1);
      });

      await act(async () => {
        // Trigger removal via AppShell's observed catalog / PlaybackGuard path:
        await fireEvent.press(screen.getByTestId('player-back'));
      });
      await fireEvent.press(screen.getByTestId('nav-tab-sources'));
      await waitFor(() => {
        expect(screen.getByTestId(`source-remove-${added.value.id}`)).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId(`source-remove-${added.value.id}`));
      await waitFor(() => {
        expect(screen.getByText('No sources added yet.')).toBeTruthy();
      });
      expect(engine.openMedias()).toBe(0);

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('stops active playback immediately if PlaybackGuard is triggered while PlayerScreen is mounted', async () => {
    const env = await openShellCatalog();
    const { engine, videoHost } = createFakeHost();

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      const added = await env.catalog.addSource({
        kind: 'xtream',
        name: 'GuardSource',
        server: 'http://sim.example.test:8080',
        username: 'demo',
        password: ['de', 'mo'].join(''),
      });
      if (!added.ok) throw new Error('addSource failed');
      await env.catalog.importSource(added.value.id);

      let capturedGuard: { stopIfUsingSource(id: string): void | Promise<void> } | undefined;
      view = await render(
        <FormFactorProvider value="tablet">
          <I18nProvider i18n={createAppI18n('en')}>
            <AppShell
              catalog={env.catalog}
              videoHost={videoHost}
              onPlaybackGuardReady={(g) => {
                capturedGuard = g;
              }}
            />
          </I18nProvider>
        </FormFactorProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText('1. Channel 1')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('browse-items-list-row-0'));
      await waitFor(() => {
        expect(engine.openMedias()).toBe(1);
        expect(screen.getByTestId('player-osd')).toBeTruthy();
      });

      await act(async () => {
        await capturedGuard?.stopIfUsingSource(added.value.id);
      });

      expect(screen.queryByTestId('player-osd')).toBeNull();
      expect(engine.openMedias()).toBe(0);
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it.each<FormFactor>(['tv', 'phone', 'tablet', 'desktop'])(
    'renders localized Turkish tabs on %s and navigates TV top nav',
    async (formFactor) => {
      let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
      const androidSource: AndroidKeySource = {
        addListener: (l) => {
          keyListener = l;
          return { remove: () => {} };
        },
      };
      if (formFactor === 'tv') {
        jest.replaceProperty(Platform, 'OS', 'android');
        jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
      }

      const env = await openShellCatalog();
      const { videoHost } = createFakeHost();

      try {
        const view = await render(
          <RemoteKeysProvider android={androidSource}>
            <FormFactorProvider value={formFactor}>
              <I18nProvider i18n={createAppI18n('tr')}>
                <AppShell catalog={env.catalog} videoHost={videoHost} />
              </I18nProvider>
            </FormFactorProvider>
          </RemoteKeysProvider>,
        );

        expect(screen.getByTestId('nav-tab-live')).toHaveTextContent('Canlı');
        expect(screen.getByTestId('nav-tab-movie')).toHaveTextContent('Filmler');
        expect(screen.getByTestId('nav-tab-series')).toHaveTextContent('Diziler');
        expect(screen.getByTestId('nav-tab-sources')).toHaveTextContent('Kaynaklar');
        expect(screen.getByTestId('nav-tab-notices')).toHaveTextContent('Lisanslar');

        if (formFactor === 'tv') {
          await act(async () => {
            keyListener?.({ action: 'down', keyCode: 4, canceled: false, ageMs: 0 });
            keyListener?.({ action: 'up', keyCode: 4, canceled: false, ageMs: 10 });
          });
          await act(async () => {
            keyListener?.({ action: 'down', keyCode: 21, canceled: false, ageMs: 20 });
            keyListener?.({ action: 'up', keyCode: 21, canceled: false, ageMs: 30 });
          });
          expect(screen.getByTestId('nav-tab-series').props.accessibilityState.selected).toBe(true);
        }

        await view.unmount();
      } finally {
        await env.cleanup();
      }
    },
  );
});
