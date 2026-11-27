import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { elvError, err, type HttpClient, type HttpResponse, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';
import { RouteActiveProvider } from '../../shared';
import { buildHeroActionIds, HomeHero } from '../HomeHero';
import { HOME_HERO_AUTO_ROTATE_MS, HomeScreen } from '../HomeScreen';
import type { HomeHeroSlide } from '../home-model';

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

function makeSlide(overrides: Partial<HomeHeroSlide> = {}): HomeHeroSlide {
  return {
    sourceId: 's1',
    itemKey: 'x:s1:movie:201',
    kind: 'movie',
    title: 'Neon Horizon',
    subtitle: null,
    backdropUri: 'https://img.example/bg-1.jpg',
    posterUri: 'https://img.example/p-1.jpg',
    year: 2026,
    rating: 8.4,
    durationMs: 0,
    positionMs: 0,
    watched: false,
    isContinueWatching: false,
    ...overrides,
  };
}

function createHomeHttp(): HttpClient {
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
      if (action === 'get_series_categories') {
        return ok(jsonResponse([{ category_id: '20', category_name: 'Dramas' }]));
      }
      if (action === 'get_vod_streams') {
        return ok(
          jsonResponse([
            {
              stream_id: 201,
              name: 'Neon Horizon',
              category_id: '10',
              container_extension: 'mp4',
              rating: '8.4',
            },
            {
              stream_id: 202,
              name: 'Glass Meridian',
              category_id: '10',
              container_extension: 'mp4',
              rating: '7.9',
            },
          ]),
        );
      }
      if (action === 'get_series') {
        return ok(
          jsonResponse([
            { series_id: 301, name: 'Starlight Harbor', category_id: '20', rating: '8.7' },
          ]),
        );
      }
      return ok(jsonResponse([]));
    },
  };
}

async function openHomeFixture() {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) throw new Error('migrate failed');
  let now = 1_700_000_000_000;
  let seq = 1;
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: createHomeHttp(),
    clock: () => {
      now += 100;
      return now;
    },
    newId: () => `src-${seq++}`,
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
  const sources = await catalog.listSources();
  return {
    catalog,
    sources,
    sourceId: added.value.id,
    async cleanup() {
      await catalog.close();
      handle.close();
    },
  };
}

describe('HomeHero crossfade, Details CTA & auto-rotation (#399) + Watched cleanup (#125)', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('orders hero TV action ids as play -> details -> mylist -> watched -> dots when details is enabled', () => {
    expect(buildHeroActionIds(makeSlide({ kind: 'movie' }), 3, true)).toEqual([
      'play',
      'details',
      'mylist',
      'watched',
      'dot-0',
      'dot-1',
      'dot-2',
    ]);
    expect(buildHeroActionIds(makeSlide({ kind: 'movie' }), 2, false)).toEqual([
      'play',
      'mylist',
      'watched',
      'dot-0',
      'dot-1',
    ]);
    expect(buildHeroActionIds(makeSlide({ kind: 'live' }), 2, true)).toEqual([
      'play',
      'mylist',
      'dot-0',
      'dot-1',
    ]);
  });

  it('renders Details CTA for movies/series, fires hover callbacks, and crossfades backdrops safely', async () => {
    const onOpenDetails = jest.fn();
    const onHoverChange = jest.fn();
    const slides = [
      makeSlide({ itemKey: 'm1', title: 'Neon Horizon', backdropUri: 'https://img.example/1.jpg' }),
      makeSlide({
        itemKey: 'm2',
        title: 'Glass Meridian',
        backdropUri: 'https://img.example/2.jpg',
      }),
    ];

    const renderHero = (activeIndex: number, reduceMotion: boolean) => (
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion={reduceMotion}>
          <HomeHero
            slides={slides}
            activeIndex={activeIndex}
            onSelectIndex={jest.fn()}
            inMyList={false}
            onPlaySlide={jest.fn()}
            onOpenDetails={onOpenDetails}
            onToggleMyList={jest.fn()}
            onToggleWatched={jest.fn()}
            onHoverChange={onHoverChange}
            isTv={false}
            isTouch={false}
            isPortrait={false}
            topClearance={64}
            minHeight={420}
            padX={48}
            focusedAction={null}
          />
        </ThemeProvider>
      </I18nProvider>
    );

    const view = await render(renderHero(0, false));
    const detailsBtn = screen.getByTestId('home-hero-details');
    expect(detailsBtn).toHaveTextContent('Details');
    const dotsFooterStyle = StyleSheet.flatten(screen.getByTestId('home-hero-dots').props.style);
    expect(dotsFooterStyle).toMatchObject({
      width: '100%',
      alignItems: 'center',
      justifyContent: 'center',
    });
    await fireEvent.press(detailsBtn);
    expect(onOpenDetails).toHaveBeenCalledWith(slides[0]);

    // Hover events pause & resume auto-rotation cleanly
    await fireEvent(screen.getByTestId('home-hero'), 'hoverIn');
    expect(onHoverChange).toHaveBeenLastCalledWith(true);
    await fireEvent(screen.getByTestId('home-hero'), 'hoverOut');
    expect(onHoverChange).toHaveBeenLastCalledWith(false);

    // Switching slide with motion enabled mounts previous backdrop behind crossfading current slide
    await view.rerender(renderHero(1, false));
    expect(
      screen.getByTestId('home-hero-backdrop-prev', { includeHiddenElements: true }),
    ).toBeTruthy();

    // Switching with reduceMotion: true skips the crossfade animation once incoming backdrop loads
    await view.rerender(renderHero(0, true));
    await fireEvent(
      screen.getByTestId('home-hero-backdrop-img', { includeHiddenElements: true }),
      'load',
    );
    expect(
      screen.queryByTestId('home-hero-backdrop-prev', { includeHiddenElements: true }),
    ).toBeNull();
    await view.unmount();
  });

  it('auto-rotates HomeHero every 7500 ms and pauses on hover, route blur, reduceMotion, or TV hero focus', async () => {
    const env = await openHomeFixture();
    jest.useFakeTimers({
      doNotFake: ['setTimeout', 'clearTimeout', 'nextTick', 'setImmediate', 'queueMicrotask'],
    });
    try {
      const renderTree = (opts: {
        reduceMotion?: boolean;
        routeActive?: boolean;
        viewport?: ViewportOverride;
      }) => (
        <ViewportProvider
          value={
            opts.viewport ?? {
              formFactor: 'desktop',
              orientation: 'landscape',
              inputModality: 'pointer',
              width: 1280,
              height: 800,
            }
          }
        >
          <ThemeProvider reduceMotion={opts.reduceMotion ?? false}>
            <I18nProvider i18n={createAppI18n('en')}>
              <RouteActiveProvider active={opts.routeActive ?? true}>
                <HomeScreen
                  catalog={env.catalog}
                  sources={env.sources}
                  refreshToken={1}
                  onPlay={jest.fn()}
                  onOpenTab={jest.fn()}
                  onOpenDetail={jest.fn()}
                  onOpenSources={jest.fn()}
                />
              </RouteActiveProvider>
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>
      );

      const view = await render(renderTree({}));
      await waitFor(() => {
        expect(screen.getByTestId('home-hero-title')).toHaveTextContent('Neon Horizon');
      });

      // Advances after HOME_HERO_AUTO_ROTATE_MS (7500 ms)
      await act(async () => {
        jest.advanceTimersByTime(HOME_HERO_AUTO_ROTATE_MS);
      });
      expect(screen.getByTestId('home-hero-title')).toHaveTextContent('Glass Meridian');

      // Pauses while hovered
      await fireEvent(screen.getByTestId('home-hero'), 'hoverIn');
      await act(async () => {
        jest.advanceTimersByTime(HOME_HERO_AUTO_ROTATE_MS * 2);
      });
      expect(screen.getByTestId('home-hero-title')).toHaveTextContent('Glass Meridian');

      // Resumes when pointer leaves
      await fireEvent(screen.getByTestId('home-hero'), 'hoverOut');
      await act(async () => {
        jest.advanceTimersByTime(HOME_HERO_AUTO_ROTATE_MS);
      });
      expect(screen.getByTestId('home-hero-title')).toHaveTextContent('Starlight Harbor');

      // Pauses on desktop keyboard focus and resumes on blur (#399)
      await fireEvent(screen.getByTestId('home-hero'), 'focus');
      await act(async () => {
        jest.advanceTimersByTime(HOME_HERO_AUTO_ROTATE_MS * 2);
      });
      expect(screen.getByTestId('home-hero-title')).toHaveTextContent('Starlight Harbor');

      await fireEvent(screen.getByTestId('home-hero'), 'blur');
      await act(async () => {
        jest.advanceTimersByTime(HOME_HERO_AUTO_ROTATE_MS);
      });
      expect(screen.getByTestId('home-hero-title')).toHaveTextContent('Neon Horizon');

      // Pauses when routeActive is false
      await view.rerender(renderTree({ routeActive: false }));
      await act(async () => {
        jest.advanceTimersByTime(HOME_HERO_AUTO_ROTATE_MS * 2);
      });
      expect(screen.getByTestId('home-hero-title')).toHaveTextContent('Neon Horizon');

      // Pauses when reduceMotion is true
      await view.rerender(renderTree({ routeActive: true, reduceMotion: true }));
      await act(async () => {
        jest.advanceTimersByTime(HOME_HERO_AUTO_ROTATE_MS * 2);
      });
      expect(screen.getByTestId('home-hero-title')).toHaveTextContent('Neon Horizon');

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('navigates TV D-pad play -> details and opens DetailScreen on Select', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    let listener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        listener = l;
        return {
          remove: () => {
            listener = undefined;
          },
        };
      },
    };
    const pressKey = async (keyCode: number) => {
      await act(async () => {
        listener?.({ action: 'down', keyCode, canceled: false, ageMs: 0 });
        listener?.({ action: 'up', keyCode, canceled: false, ageMs: 10 });
      });
    };

    const env = await openHomeFixture();
    const onOpenDetail = jest.fn();
    try {
      const view = await render(
        <RemoteKeysProvider android={androidSource}>
          <ViewportProvider
            value={{
              formFactor: 'tv',
              orientation: 'landscape',
              inputModality: 'tv',
              width: 1920,
              height: 1080,
            }}
          >
            <ThemeProvider>
              <I18nProvider i18n={createAppI18n('en')}>
                <HomeScreen
                  catalog={env.catalog}
                  sources={env.sources}
                  refreshToken={1}
                  onPlay={jest.fn()}
                  onOpenTab={jest.fn()}
                  onOpenDetail={onOpenDetail}
                  onOpenSources={jest.fn()}
                  isActiveScope
                />
              </I18nProvider>
            </ThemeProvider>
          </ViewportProvider>
        </RemoteKeysProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('home-hero-details')).toBeTruthy();
      });

      expect(screen.getByTestId('home-hero-play-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_RIGHT);
      expect(screen.getByTestId('home-hero-details-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_CENTER);

      expect(onOpenDetail).toHaveBeenCalledWith(
        expect.objectContaining({
          itemKey: `x:${env.sourceId}:movie:201`,
          kind: 'movie',
          title: 'Neon Horizon',
        }),
      );
      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('excludes watched items from Home Featured Movies/Series rails while keeping My List intact (#125)', async () => {
    const env = await openHomeFixture();
    const itemsSpy = jest.spyOn(env.catalog, 'items');
    try {
      await env.catalog.saveProgress?.({
        sourceId: env.sourceId,
        itemKey: `x:${env.sourceId}:movie:201`,
        kind: 'movie',
        title: 'Neon Horizon',
        positionMs: 600_000,
        durationMs: 600_000,
        watched: true,
      });
      await env.catalog.toggleFavorite?.({
        sourceId: env.sourceId,
        itemKey: `x:${env.sourceId}:movie:201`,
        kind: 'movie',
        title: 'Neon Horizon',
        logo: null,
      });

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
          <ThemeProvider>
            <I18nProvider i18n={createAppI18n('en')}>
              <HomeScreen
                catalog={env.catalog}
                sources={env.sources}
                refreshToken={1}
                onPlay={jest.fn()}
                onOpenTab={jest.fn()}
                onOpenSources={jest.fn()}
              />
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('home-movies-item-0')).toBeTruthy();
        expect(screen.getByTestId('home-mylist-item-0')).toBeTruthy();
      });

      // Watched movie 201 is excluded from Featured Movies discovery rail (Glass Meridian is item 0)
      expect(screen.getByTestId('home-movies-item-0').props.accessibilityLabel).toContain(
        'Glass Meridian',
      );
      expect(screen.queryByTestId('home-movies-item-1')).toBeNull();
      // My List still keeps watched favorites
      expect(screen.getByTestId('home-mylist-item-0').props.accessibilityLabel).toContain(
        'Neon Horizon',
      );
      // Verify catalog.items received { excludeWatched: true } for VOD discovery rails
      expect(itemsSpy).toHaveBeenCalledWith(
        `${env.sourceId}|movie|10`,
        0,
        18,
        expect.objectContaining({ excludeWatched: true }),
      );
      expect(itemsSpy).toHaveBeenCalledWith(
        `${env.sourceId}|series|20`,
        0,
        18,
        expect.objectContaining({ excludeWatched: true }),
      );
      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });
});
