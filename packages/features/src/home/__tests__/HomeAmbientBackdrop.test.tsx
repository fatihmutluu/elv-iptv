import { type CatalogService, createCatalogService, openCatalog, type SourceRow } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { elvError, err, type HttpClient, type HttpResponse, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  UiAdaptersProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import { Platform, View } from 'react-native';
import { AMBIENT_BACKDROP_DEBOUNCE_MS } from '../../shared/AmbientBackdrop';
import { HomeScreen } from '../HomeScreen';
import { useTvHomeNavigation } from '../useTvHomeNavigation';

const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_RIGHT = 22;

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

function createHomeHttpClient(): HttpClient {
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
      if (action === 'get_live_categories') return ok(jsonResponse([]));
      if (action === 'get_vod_categories') {
        return ok(jsonResponse([{ category_id: '10', category_name: 'Cinema' }]));
      }
      if (action === 'get_series_categories') return ok(jsonResponse([]));
      if (action === 'get_live_streams') return ok(jsonResponse([]));
      if (action === 'get_vod_streams') {
        return ok(
          jsonResponse([
            {
              stream_id: 201,
              name: 'Dune Drift',
              category_id: '10',
              stream_icon: 'https://cdn.example/dune-poster.jpg',
              rating: '8.4',
            },
            {
              stream_id: 202,
              name: 'Solar Echo',
              category_id: '10',
              stream_icon: 'https://cdn.example/solar-poster.jpg',
              rating: '7.9',
            },
          ]),
        );
      }
      if (action === 'get_series') return ok(jsonResponse([]));
      return err(elvError('network', 'http-404'));
    },
  };
}

async function openCatalogWithMovies(): Promise<{
  catalog: CatalogService;
  sources: SourceRow[];
  cleanup: () => Promise<void>;
}> {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) throw new Error('migrate failed');
  let now = 1_700_000_000_000;
  let nextId = 1;
  const service = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    http: createHomeHttpClient(),
    scheduler: countingScheduler(),
    clock: () => {
      now += 100;
      return now;
    },
    newId: () => `src-${nextId++}`,
  });
  const added = await service.addSource({
    kind: 'xtream',
    name: 'Demo',
    server: 'http://provider.test',
    username: 'u',
    password: ['p', 'w'].join(''),
  });
  if (!added.ok) throw new Error('addSource failed');
  await service.importSource(added.value.id);
  const sources = await service.listSources();
  return {
    catalog: service,
    sources,
    cleanup: async () => {
      await service.close();
      await handle.close();
    },
  };
}

describe('HomeScreen TV ambient backdrop & unified live rail navigation (#414)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('tracks live rail focus and horizontal selection in useTvHomeNavigation', async () => {
    const onActivate = jest.fn();
    const { result, unmount } = await renderHook(() =>
      useTvHomeNavigation({
        isTv: true,
        isActiveScope: true,
        rows: [
          { id: 'hero', count: 1 },
          { id: 'live', count: 3 },
        ],
        onActivate,
      }),
    );

    expect(result.current.focusedRowId).toBe('hero');
    await act(async () => {
      result.current.handleTvKey({ key: 'down', kind: 'press', time: 10 });
    });
    expect(result.current.focusedRowId).toBe('live');
    expect(result.current.focusedCol).toBe(0);

    await act(async () => {
      result.current.handleTvKey({ key: 'right', kind: 'press', time: 20 });
    });
    expect(result.current.focusedCol).toBe(1);

    await act(async () => {
      result.current.handleTvKey({ key: 'select', kind: 'press', time: 30 });
    });
    expect(onActivate).toHaveBeenCalledWith('live', 1);

    await unmount();
  });

  it('mounts AmbientBackdrop on TV when focus moves from Hero to a rail and updates after 500ms debounce', async () => {
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
    const pressKey = async (keyCode: number) => {
      await act(async () => {
        keyListener?.({ action: 'down', keyCode, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode, canceled: false, ageMs: 10 });
      });
    };

    const env = await openCatalogWithMovies();
    try {
      const view = await render(
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider reduceMotion>
            <UiAdaptersProvider
              adapters={{
                renderImage: (props) => <View testID={`home-img:${props.uri}`} />,
              }}
            >
              <ViewportProvider
                value={{
                  formFactor: 'tv',
                  orientation: 'landscape',
                  inputModality: 'tv',
                  width: 1920,
                  height: 1080,
                }}
              >
                <RemoteKeysProvider android={androidSource}>
                  <HomeScreen
                    catalog={env.catalog}
                    sources={env.sources}
                    refreshToken={0}
                    onPlay={() => undefined}
                    onOpenTab={() => undefined}
                    onOpenSources={() => undefined}
                    isActiveScope
                  />
                </RemoteKeysProvider>
              </ViewportProvider>
            </UiAdaptersProvider>
          </ThemeProvider>
        </I18nProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('home-movies-item-0')).toBeTruthy();
      });

      jest.useFakeTimers();

      // Still on Hero -> no ambient backdrop
      expect(screen.queryByTestId('home-ambient-backdrop')).toBeNull();

      // Move down to movies rail item 0, then quickly right to item 1 before 500ms
      await pressKey(KEYCODE_DPAD_DOWN);
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      await pressKey(KEYCODE_DPAD_RIGHT);

      expect(screen.queryByTestId('home-ambient-backdrop')).toBeNull();

      await act(async () => {
        jest.advanceTimersByTime(AMBIENT_BACKDROP_DEBOUNCE_MS);
      });

      expect(screen.getByTestId('home-ambient-backdrop')).toBeTruthy();
      expect(
        screen.getAllByTestId('home-img:https://cdn.example/solar-poster.jpg', {
          includeHiddenElements: true,
        }).length,
      ).toBeGreaterThanOrEqual(1);

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });
});
