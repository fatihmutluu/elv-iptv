import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { elvError, err, type HttpClient, type HttpResponse, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import { AppShell } from '../index';
import type { PickedPlaylistFile, SourceImportHost } from '../ports/source-import-host';
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
      if (action === 'get_live_streams') {
        return ok(jsonResponse([{ stream_id: 101, name: 'Channel 1', category_id: '1', num: 1 }]));
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

describe('AppShell OS playlist file opening (#259)', () => {
  it('drains pending and live OS-opened local playlists, switches to Settings -> Sources, and stages the file', async () => {
    const env = await openShellCatalog();
    const { videoHost } = createFakeHost();
    let openListener: ((file: PickedPlaylistFile) => void) | null = null;
    const coldStartFile: PickedPlaylistFile = {
      name: 'cold-start.m3u8',
      bytes: new TextEncoder().encode('#EXTM3U\n#EXTINF:-1,Cold\nhttp://a/1.ts\n'),
    };
    const liveFile: PickedPlaylistFile = {
      name: 'second-instance.m3u',
      bytes: new TextEncoder().encode('#EXTM3U\n#EXTINF:-1,Live\nhttp://a/2.ts\n'),
    };
    const sourceImportHost: SourceImportHost = {
      consumePendingPlaylistFiles: jest.fn(async () => [coldStartFile]),
      onOpenPlaylistFile: (listener) => {
        openListener = listener;
        return () => {
          openListener = null;
        };
      },
    };

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      const added = await env.catalog.addSource({
        kind: 'xtream',
        name: 'Existing IPTV',
        server: 'http://sim.example.test:8080',
        username: 'demo',
        password: ['de', 'mo'].join(''),
      });
      if (!added.ok) throw new Error('addSource failed');
      await env.catalog.importSource(added.value.id);

      view = await render(
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <AppShell
              catalog={env.catalog}
              videoHost={videoHost}
              sourceImportHost={sourceImportHost}
            />
          </I18nProvider>
        </FormFactorProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('sources-screen')).toBeTruthy();
        expect(screen.getByTestId('sources-local-file-selected')).toHaveTextContent(
          'File: cold-start.m3u8',
        );
        expect(screen.getByTestId('sources-input-name').props.value).toBe('cold-start');
      });

      // Switch away to Home, then push a live second-instance playlist event
      await fireEvent.press(screen.getByTestId('nav-tab-home'));
      await waitFor(() => {
        expect(screen.getByTestId('home-screen')).toBeTruthy();
      });

      await act(async () => {
        openListener?.(liveFile);
      });

      await waitFor(() => {
        expect(screen.getByTestId('sources-screen')).toBeTruthy();
        expect(screen.getByTestId('sources-local-file-selected')).toHaveTextContent(
          'File: second-instance.m3u',
        );
        expect(screen.getByTestId('sources-input-name').props.value).toBe('second-instance');
      });
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });
});
