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
  type FormFactor,
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
  THEME_PRESETS,
  useTheme,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, StyleSheet, Text, View } from 'react-native';
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

function LiveThemeProbe() {
  const theme = useTheme();
  return (
    <View>
      <Text testID="shell-theme-preset">{theme.preset}</Text>
      <Text testID="shell-theme-canvas">{theme.colors.bgCanvas}</Text>
      <Text testID="shell-theme-font-scale">{String(theme.fontScale)}</Text>
      <Text testID="shell-theme-reduce-motion">{String(theme.reduceMotion)}</Text>
    </View>
  );
}

describe('AppShell', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens Settings -> Sources on empty catalog, imports a source via UI, and browses Live, Movies, and Series', async () => {
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

      expect(screen.getByTestId('settings-screen')).toBeTruthy();
      expect(screen.getByTestId('sources-screen')).toBeTruthy();
      expect(screen.getByText('ELV IPTV')).toBeTruthy();
      expect(screen.getByTestId('nav-tab-settings').props.accessibilityState.selected).toBe(true);
      expect(screen.queryByTestId('nav-tab-sources')).toBeNull();
      expect(screen.queryByTestId('nav-tab-notices')).toBeNull();

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

      await fireEvent.press(screen.getByTestId('nav-tab-home'));
      await waitFor(() => {
        expect(screen.getByTestId('home-hero')).toBeTruthy();
        expect(screen.getByTestId('home-live-item-0')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('nav-tab-live'));
      await waitFor(() => {
        expect(screen.getByTestId('live-screen')).toBeTruthy();
        expect(screen.getByTestId('live-channels-grid')).toBeTruthy();
        expect(screen.getByTestId('live-channel-card-0')).toBeTruthy();
        expect(screen.getByText('Channel 1')).toBeTruthy();
      });
      expect(screen.getByText('ELV IPTV')).toBeTruthy();

      await fireEvent.press(screen.getByTestId('nav-tab-movie'));
      await waitFor(() => {
        expect(screen.getByTestId('catalog-screen-movie')).toBeTruthy();
        expect(screen.getByText('Synthetic Movie One')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('nav-tab-series'));
      await waitFor(() => {
        expect(screen.getByTestId('catalog-screen-series')).toBeTruthy();
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
        expect(screen.getByTestId('nav-tab-home').props.accessibilityState.selected).toBe(true);
        expect(screen.getByTestId('home-live-item-1')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('nav-tab-live'));
      await waitFor(() => {
        expect(screen.getByTestId('live-screen')).toBeTruthy();
        expect(screen.getByTestId('live-channels-grid')).toBeTruthy();
        expect(screen.getByTestId('live-channel-card-1')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('live-mode-epg'));
      await waitFor(() => {
        expect(screen.getByTestId('live-epg-view')).toBeTruthy();
        expect(screen.getByTestId('epg-preview-header')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('live-mode-watch'));
      await waitFor(() => {
        expect(screen.getByTestId('live-watch-stage')).toBeTruthy();
        expect(screen.getByTestId('live-zap-drawer')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('live-mode-channels'));
      await waitFor(() => {
        expect(screen.getByTestId('live-channel-card-1')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('live-channel-card-1'));
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
        expect(screen.getByTestId('live-screen')).toBeTruthy();
        expect(screen.getByTestId('live-channel-card-3').props.accessibilityState.selected).toBe(
          true,
        );
      });

      await fireEvent.press(screen.getByTestId('live-channel-card-3'));
      await waitFor(() => {
        expect(engine.openMedias()).toBe(1);
      });

      await act(async () => {
        await fireEvent.press(screen.getByTestId('player-back'));
      });

      await fireEvent.press(screen.getByTestId('nav-tab-settings'));
      expect(screen.getByTestId('settings-panel-appearance')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('settings-tab-sources'));
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

  it('switches Language, Theme (High Contrast AAA), Font Scale, and Reduce Motion live inside Settings -> Appearance via AppProviders', async () => {
    const env = await openShellCatalog();
    const { videoHost } = createFakeHost();
    const store = createMemoryPreferencesStore();

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <AppProviders
          preferencesStore={store}
          systemLocale="en"
          viewport={{
            formFactor: 'desktop',
            orientation: 'landscape',
            inputModality: 'pointer',
            width: 1280,
            height: 800,
          }}
        >
          <LiveThemeProbe />
          <AppShell catalog={env.catalog} videoHost={videoHost} />
        </AppProviders>,
      );

      await fireEvent.press(screen.getByTestId('settings-tab-appearance'));
      expect(screen.getByTestId('settings-panel-appearance')).toBeTruthy();

      await fireEvent.press(screen.getByTestId('settings-lang-tr'));
      await waitFor(() => {
        expect(screen.getByTestId('nav-tab-home')).toHaveTextContent('Ana Sayfa');
        expect(screen.getByTestId('nav-tab-live')).toHaveTextContent('Canlı');
        expect(screen.getByTestId('nav-tab-settings').props.accessibilityLabel).toBe('Ayarlar');
      });

      await fireEvent.press(screen.getByTestId('settings-lang-en'));
      await waitFor(() => {
        expect(screen.getByTestId('nav-tab-home')).toHaveTextContent('Home');
        expect(screen.getByTestId('nav-tab-live')).toHaveTextContent('Live');
      });

      await fireEvent.press(screen.getByTestId('settings-theme-highContrast'));
      await waitFor(() => {
        expect(screen.getByTestId('shell-theme-preset')).toHaveTextContent('highContrast');
        expect(screen.getByTestId('shell-theme-canvas')).toHaveTextContent(
          THEME_PRESETS.highContrast.bgCanvas,
        );
      });

      await fireEvent.press(screen.getByTestId('settings-font-110'));
      await waitFor(() => {
        expect(screen.getByTestId('shell-theme-font-scale')).toHaveTextContent('1.1');
      });

      await fireEvent.press(screen.getByTestId('settings-toggle-reduce-motion'));
      await waitFor(() => {
        expect(screen.getByTestId('shell-theme-reduce-motion')).toHaveTextContent('true');
      });

      await fireEvent.press(screen.getByTestId('settings-reset-preferences'));
      await waitFor(() => {
        expect(screen.getByTestId('shell-theme-preset')).toHaveTextContent('obsidianCrimson');
        expect(screen.getByTestId('shell-theme-font-scale')).toHaveTextContent('1');
        expect(screen.getByTestId('shell-theme-reduce-motion')).toHaveTextContent('false');
      });
    } finally {
      await view?.unmount();
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
        expect(screen.getByTestId('home-live-item-0')).toBeTruthy();
      });

      // Scroll Home to frost top bar, then open Player and stop -> returning to Home at y=0 restores transparent top bar
      expect(
        StyleSheet.flatten(screen.getByTestId('app-top-nav').props.style).borderBottomWidth,
      ).toBeUndefined();
      await fireEvent.scroll(screen.getByTestId('home-scroll'), {
        nativeEvent: { contentOffset: { x: 0, y: 80 } },
      });
      expect(
        StyleSheet.flatten(screen.getByTestId('app-top-nav').props.style).borderBottomWidth,
      ).toBe(StyleSheet.hairlineWidth);

      await fireEvent.press(screen.getByTestId('home-live-item-0'));
      await waitFor(() => {
        expect(engine.openMedias()).toBe(1);
        expect(screen.getByTestId('player-osd')).toBeTruthy();
      });

      await act(async () => {
        await capturedGuard?.stopIfUsingSource(added.value.id);
      });

      expect(screen.queryByTestId('player-osd')).toBeNull();
      expect(engine.openMedias()).toBe(0);
      expect(
        StyleSheet.flatten(screen.getByTestId('app-top-nav').props.style).borderBottomWidth,
      ).toBeUndefined();
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

        expect(screen.getByTestId('nav-tab-home')).toHaveTextContent('Ana Sayfa');
        expect(screen.getByTestId('nav-tab-live')).toHaveTextContent('Canlı');
        expect(screen.getByTestId('nav-tab-movie')).toHaveTextContent('Filmler');
        expect(screen.getByTestId('nav-tab-series')).toHaveTextContent('Diziler');
        expect(screen.getByTestId('nav-tab-search').props.accessibilityLabel).toBe('Ara');
        expect(screen.getByTestId('nav-tab-settings').props.accessibilityLabel).toBe('Ayarlar');

        if (formFactor === 'tv') {
          // Empty catalog opens Settings -> Sources content pane; Back -> sidebar -> Back -> Top Nav -> Left hits Search, Right x2 wraps to Home
          await act(async () => {
            keyListener?.({ action: 'down', keyCode: 4, canceled: false, ageMs: 0 });
            keyListener?.({ action: 'up', keyCode: 4, canceled: false, ageMs: 10 });
          });
          expect(
            screen.getByTestId('settings-tv-focus-anchor', { includeHiddenElements: true }),
          ).toBeTruthy();

          await act(async () => {
            keyListener?.({ action: 'down', keyCode: 4, canceled: false, ageMs: 20 });
            keyListener?.({ action: 'up', keyCode: 4, canceled: false, ageMs: 30 });
          });
          await act(async () => {
            keyListener?.({ action: 'down', keyCode: 21, canceled: false, ageMs: 40 });
            keyListener?.({ action: 'up', keyCode: 21, canceled: false, ageMs: 50 });
          });
          expect(screen.getByTestId('nav-tab-search').props.accessibilityState.selected).toBe(true);
          await act(async () => {
            keyListener?.({ action: 'down', keyCode: 22, canceled: false, ageMs: 60 });
            keyListener?.({ action: 'up', keyCode: 22, canceled: false, ageMs: 70 });
            keyListener?.({ action: 'down', keyCode: 22, canceled: false, ageMs: 80 });
            keyListener?.({ action: 'up', keyCode: 22, canceled: false, ageMs: 90 });
          });
          expect(screen.getByTestId('nav-tab-home').props.accessibilityState.selected).toBe(true);
        }

        await view.unmount();
      } finally {
        await env.cleanup();
      }
    },
  );

  it('wires CatalogDiscoveryScreen and DetailScreen overlay stack from Home, Movies, and Series tabs', async () => {
    const env = await openShellCatalog();
    const { videoHost } = createFakeHost();

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      const added = await env.catalog.addSource({
        kind: 'xtream',
        name: 'CatalogDemo',
        server: 'http://sim.example.test:8080',
        username: 'demo',
        password: ['de', 'mo'].join(''),
      });
      if (!added.ok) throw new Error('addSource failed');
      await env.catalog.importSource(added.value.id);

      view = await render(
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <AppShell catalog={env.catalog} videoHost={videoHost} />
          </I18nProvider>
        </FormFactorProvider>,
      );

      // Home poster opens DetailScreen overlay and Back pops to Home
      await waitFor(() => {
        expect(screen.getByTestId('home-movies-item-0')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('home-movies-item-0'));
      await waitFor(() => {
        expect(screen.getByTestId('detail-screen')).toBeTruthy();
        expect(screen.getByTestId('detail-title')).toHaveTextContent('Synthetic Movie One');
      });
      await fireEvent.press(screen.getByTestId('detail-back'));
      await waitFor(() => {
        expect(screen.getByTestId('home-screen')).toBeTruthy();
      });

      // Movies tab renders CatalogDiscoveryScreen; clicking poster opens DetailScreen; Back pops to Movies
      await fireEvent.press(screen.getByTestId('nav-tab-movie'));
      await waitFor(() => {
        expect(screen.getByTestId('catalog-screen-movie')).toBeTruthy();
        expect(screen.getByTestId('catalog-rail-0-item-0')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('catalog-rail-0-item-0'));
      await waitFor(() => {
        expect(screen.getByTestId('detail-screen')).toBeTruthy();
        expect(screen.getByTestId('detail-title')).toHaveTextContent('Synthetic Movie One');
      });
      await fireEvent.press(screen.getByTestId('detail-back'));
      await waitFor(() => {
        expect(screen.getByTestId('catalog-screen-movie')).toBeTruthy();
      });

      // Series tab -> DetailScreen -> Season 1 / Episode 0 -> Player -> Back to DetailScreen -> Tab switch clears stack
      await fireEvent.press(screen.getByTestId('nav-tab-series'));
      await waitFor(() => {
        expect(screen.getByTestId('catalog-screen-series')).toBeTruthy();
        expect(screen.getByTestId('catalog-rail-0-item-0')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('catalog-rail-0-item-0'));
      await waitFor(() => {
        expect(screen.getByTestId('detail-screen')).toBeTruthy();
        expect(screen.getByTestId('detail-season-1')).toBeTruthy();
        expect(screen.getByTestId('detail-episode-0')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('detail-episode-0'));
      await waitFor(() => {
        expect(screen.getByTestId('player-osd')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('player-back'));
      await waitFor(() => {
        expect(screen.getByTestId('detail-screen')).toBeTruthy();
        expect(screen.getByTestId('detail-episode-0')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('nav-tab-home'));
      await waitFor(() => {
        expect(screen.getByTestId('home-screen')).toBeTruthy();
      });
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('wires SearchScreen via nav-tab-search, finds VOD hits, opens DetailScreen, and returns to SearchScreen on back', async () => {
    const env = await openShellCatalog();
    const { videoHost } = createFakeHost();

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
            <AppShell catalog={env.catalog} videoHost={videoHost} />
          </I18nProvider>
        </FormFactorProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('home-screen')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('nav-tab-search'));
      await waitFor(() => {
        expect(screen.getByTestId('search-screen')).toBeTruthy();
        expect(screen.getByTestId('nav-tab-search').props.accessibilityState.selected).toBe(true);
      });

      await fireEvent.changeText(screen.getByTestId('search-input'), 'Synthetic Movie');
      await waitFor(() => {
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
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });
});
