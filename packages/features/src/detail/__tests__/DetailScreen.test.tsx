import { type CatalogService, createCatalogService, openCatalog } from '@elv/data';
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
import { Platform } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { DetailTarget } from '../../shared';
import { DetailScreen } from '../DetailScreen';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_BACK = 4;

function requireFirst<T>(items: readonly T[], label: string): T {
  const item = items[0];
  if (item === undefined) throw new Error(`Missing test fixture: ${label}`);
  return item;
}

function requireAt<T>(items: readonly T[], index: number, label: string): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Missing test fixture[${index}]: ${label}`);
  return item;
}

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

function createDetailHttpClient(opts: { failSeriesInfoOnce?: boolean } = {}): HttpClient {
  let seriesInfoAttempts = 0;
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
      if (action === 'get_live_streams') return ok(jsonResponse([]));
      if (action === 'get_vod_streams') {
        return ok(
          jsonResponse([
            {
              stream_id: 201,
              name: 'Neon Horizon',
              category_id: '10',
              container_extension: 'mp4',
              rating: '8.6',
              year: '2026',
            },
            {
              stream_id: 202,
              name: 'Glass Meridian',
              category_id: '10',
              container_extension: 'mp4',
              rating: '7.9',
              year: '2025',
            },
            {
              stream_id: 203,
              name: 'Amber Drift',
              category_id: '10',
              container_extension: 'mp4',
              rating: '8.1',
              year: '2024',
            },
          ]),
        );
      }
      if (action === 'get_series') {
        return ok(
          jsonResponse([
            {
              series_id: 301,
              name: 'Starlight Harbor',
              category_id: '20',
              rating: '8.9',
              year: '2025',
              plot: 'An orbital lighthouse crew investigates an anomalous tide across deep space.',
            },
            {
              series_id: 302,
              name: 'Harbor Echoes',
              category_id: '20',
              rating: '8.2',
              year: '2024',
              plot: 'A quiet anthology set along a misty northern coast.',
            },
          ]),
        );
      }
      if (action === 'get_series_info') {
        seriesInfoAttempts += 1;
        if (opts.failSeriesInfoOnce && seriesInfoAttempts === 1) {
          return err(elvError('network', 'timeout'));
        }
        return ok(
          jsonResponse({
            info: {
              name: 'Starlight Harbor',
              plot: 'An orbital lighthouse crew investigates an anomalous tide across deep space.',
            },
            episodes: {
              '1': [
                {
                  id: '9001',
                  episode_num: 1,
                  title: 'Arrival',
                  container_extension: 'mp4',
                  info: { duration_secs: 2880 },
                },
                {
                  id: '9002',
                  episode_num: 2,
                  title: 'Low Tide',
                  container_extension: 'mp4',
                  info: { duration_secs: 3120 },
                },
              ],
              '2': [
                {
                  id: '9003',
                  episode_num: 1,
                  title: 'North Beacon',
                  container_extension: 'mp4',
                  info: { duration_secs: 5520 },
                },
              ],
            },
          }),
        );
      }
      return ok(jsonResponse([]));
    },
  };
}

async function openDetailCatalog(opts: { failSeriesInfoOnce?: boolean } = {}) {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) throw new Error('migrate failed');
  let now = 1_700_000_000_000;
  let nextId = 1;
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: createDetailHttpClient(opts),
    clock: () => {
      now += 100;
      return now;
    },
    newId: () => `src-${nextId++}`,
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
  const sourceId = added.value.id;
  const movies = await catalog.items(`${sourceId}|movie|10`, 0, 10);
  const series = await catalog.items(`${sourceId}|series|20`, 0, 10);
  return {
    catalog,
    sourceId,
    movies,
    series,
    async cleanup() {
      await catalog.close();
      handle.close();
    },
  };
}

function renderDetail(
  props: {
    target: DetailTarget;
    catalog: CatalogService;
    refreshToken?: number;
    userStateVersion?: number;
    onBack?: () => void;
    onPlay?: (target: PlayTarget) => void;
    onOpenDetail?: (target: DetailTarget) => void;
    onScrollTopChange?: (scrolled: boolean) => void;
    onFocusTopNav?: () => void;
    isActiveScope?: boolean;
  },
  opts: {
    viewport?: ViewportOverride;
    preset?: 'obsidianCrimson' | 'highContrast';
    androidSource?: AndroidKeySource;
  } = {},
) {
  const content = (
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
      <ThemeProvider preset={opts.preset ?? 'obsidianCrimson'}>
        <I18nProvider i18n={createAppI18n('en')}>
          <DetailScreen
            target={props.target}
            catalog={props.catalog}
            refreshToken={props.refreshToken ?? 1}
            {...(props.userStateVersion !== undefined
              ? { userStateVersion: props.userStateVersion }
              : {})}
            onBack={props.onBack ?? jest.fn()}
            onPlay={props.onPlay ?? jest.fn()}
            onOpenDetail={props.onOpenDetail ?? jest.fn()}
            {...(props.onScrollTopChange ? { onScrollTopChange: props.onScrollTopChange } : {})}
            {...(props.onFocusTopNav ? { onFocusTopNav: props.onFocusTopNav } : {})}
            {...(props.isActiveScope !== undefined ? { isActiveScope: props.isActiveScope } : {})}
          />
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>
  );

  if (opts.androidSource) {
    return render(<RemoteKeysProvider android={opts.androidSource}>{content}</RemoteKeysProvider>);
  }
  return render(content);
}

describe('DetailScreen', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders 2-column Movie Detail with Resume CTA, progress bar, My List/Watched persistence, and More Like This', async () => {
    const env = await openDetailCatalog();
    const onBack = jest.fn();
    const onPlay = jest.fn();
    const onOpenDetail = jest.fn();
    const onScrollTopChange = jest.fn();

    try {
      const movie = requireFirst(env.movies, 'movie');
      await env.catalog.saveProgress?.({
        sourceId: env.sourceId,
        itemKey: movie.key,
        kind: 'movie',
        title: movie.name,
        positionMs: 185_000,
        durationMs: 6_000_000,
      });

      const target: DetailTarget = {
        itemKey: movie.key,
        sourceId: env.sourceId,
        kind: 'movie',
        title: movie.name,
        posterUri: movie.logo,
        backdropUri: movie.logo,
        year: movie.year,
        rating: movie.rating,
        catalogId: movie.id,
        categoryId: `${env.sourceId}|movie|10`,
      };

      const view = await renderDetail({
        target,
        catalog: env.catalog,
        onBack,
        onPlay,
        onOpenDetail,
        onScrollTopChange,
      });

      await waitFor(() => {
        expect(screen.getByTestId('detail-play')).toHaveTextContent('Resume');
        expect(screen.getByTestId('detail-play-progress')).toBeTruthy();
        expect(screen.getByTestId('detail-related-rail')).toBeTruthy();
      });

      // 2-column landscape hero bottom
      const heroBottom = screen.getByTestId('detail-hero-bottom');
      const flatBottom = Object.assign(
        {},
        ...(Array.isArray(heroBottom.props.style)
          ? heroBottom.props.style.filter(Boolean)
          : [heroBottom.props.style]),
      );
      expect(flatBottom.flexDirection).toBe('row');

      // Rating without third-party brand labels + fallback synopsis
      expect(screen.getByTestId('detail-rating')).toHaveTextContent('★ 8.6');
      expect(screen.getByTestId('detail-synopsis')).toHaveTextContent(
        'No synopsis available from this source.',
      );

      // Resume plays with 5s smart rewind
      await fireEvent.press(screen.getByTestId('detail-play'));
      expect(onPlay).toHaveBeenCalledTimes(1);
      const played = onPlay.mock.calls[0]?.[0] as PlayTarget;
      expect(played.itemKey).toBe(movie.key);
      expect(played.itemKind).toBe('movie');
      expect(played.startPositionMs).toBe(180_000);

      // Toggle My List persists to SQLite
      await fireEvent.press(screen.getByTestId('detail-mylist'));
      await waitFor(async () => {
        expect(await env.catalog.listFavoriteKeys?.()).toContain(movie.key);
      });
      expect(screen.getByTestId('detail-mylist').props.accessibilityState?.selected).toBe(true);

      // Toggle Watched switches Resume -> Play and shows Watched badge
      await fireEvent.press(screen.getByTestId('detail-watched'));
      await waitFor(() => {
        expect(screen.getByTestId('detail-watched-badge')).toHaveTextContent('Watched');
        expect(screen.getByTestId('detail-play')).toHaveTextContent('Play');
      });

      // More Like This excludes current movie and opens detail on press
      expect(screen.getByTestId('detail-related-item-0').props.accessibilityLabel).toContain(
        'Glass Meridian',
      );
      await fireEvent.press(screen.getByTestId('detail-related-item-0'));
      expect(onOpenDetail).toHaveBeenCalledTimes(1);
      const relatedOpened = onOpenDetail.mock.calls[0]?.[0] as DetailTarget | undefined;
      expect(relatedOpened?.title).toBe('Glass Meridian');

      // Back button & frosted scroll transition
      await fireEvent.press(screen.getByTestId('detail-back'));
      expect(onBack).toHaveBeenCalledTimes(1);
      await fireEvent.scroll(screen.getByTestId('detail-scroll'), {
        nativeEvent: { contentOffset: { x: 0, y: 48 } },
      });
      expect(onScrollTopChange).toHaveBeenCalledWith(true);

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('rolls back optimistic My List and Watched toggles when persistence fails', async () => {
    const env = await openDetailCatalog();
    const movie = requireFirst(env.movies, 'movie');
    const flakyCatalog: CatalogService = {
      ...env.catalog,
      toggleFavorite: jest.fn(async () => err(elvError('storage', 'write-failed'))),
      saveProgress: undefined,
      setWatched: jest.fn(async () => err(elvError('storage', 'disk-full'))),
    };

    try {
      const view = await renderDetail({
        target: {
          itemKey: movie.key,
          sourceId: env.sourceId,
          kind: 'movie',
          title: movie.name,
          posterUri: null,
          backdropUri: null,
          year: 2026,
          rating: 8.6,
          catalogId: movie.id,
        },
        catalog: flakyCatalog,
      });

      await waitFor(() => {
        expect(screen.getByTestId('detail-mylist')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('detail-mylist'));
      await waitFor(() => {
        expect(screen.getByTestId('detail-mylist').props.accessibilityState?.selected).toBe(false);
      });

      await fireEvent.press(screen.getByTestId('detail-watched'));
      await waitFor(() => {
        expect(screen.queryByTestId('detail-watched-badge')).toBeNull();
      });

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('hydrates Series plot, smart Resume S1 E2 CTA, season switching, episode playback, and §3 section order with Cast', async () => {
    const env = await openDetailCatalog();
    const onPlay = jest.fn();

    try {
      const show = requireFirst(env.series, 'series');
      // Prime episodes and mark E1 watched, E2 in progress
      const seasonsRes = await env.catalog.seasons(show.id);
      if (!seasonsRes.ok) throw new Error('seasons failed');
      const s1Eps = await env.catalog.episodes(show.id, 1);
      const ep1 = requireAt(s1Eps, 0, 's1 ep1');
      const ep2 = requireAt(s1Eps, 1, 's1 ep2');
      await env.catalog.saveProgress?.({
        sourceId: env.sourceId,
        itemKey: ep1.key,
        kind: 'episode',
        title: 'Starlight Harbor — E1 · Arrival',
        seriesKey: show.key,
        season: 1,
        episode: 1,
        positionMs: 2_880_000,
        durationMs: 2_880_000,
        watched: true,
      });
      await env.catalog.saveProgress?.({
        sourceId: env.sourceId,
        itemKey: ep2.key,
        kind: 'episode',
        title: 'Starlight Harbor — E2 · Low Tide',
        seriesKey: show.key,
        season: 1,
        episode: 2,
        positionMs: 605_000,
        durationMs: 3_120_000,
      });

      const view = await renderDetail({
        target: {
          itemKey: show.key,
          sourceId: env.sourceId,
          kind: 'series',
          title: show.name,
          posterUri: show.logo,
          backdropUri: show.logo,
          year: show.year,
          rating: show.rating,
          cast: [{ name: 'Leyla Demir', role: 'Commander' }],
        },
        catalog: env.catalog,
        onPlay,
      });

      await waitFor(() => {
        expect(screen.getByTestId('detail-play')).toHaveTextContent('Resume S1 E2');
        expect(screen.getByTestId('detail-season-1')).toBeTruthy();
        expect(screen.getByTestId('detail-season-2')).toBeTruthy();
        expect(screen.getByTestId('detail-episode-0-watched')).toBeTruthy();
        expect(screen.getByTestId('detail-episode-1-progress')).toBeTruthy();
        expect(screen.getByTestId('detail-related-rail')).toBeTruthy();
      });

      // Hydrated synopsis from itemDetail (series.plot) + seasons count + no movie-only watched toggle
      expect(screen.getByTestId('detail-synopsis')).toHaveTextContent(/orbital lighthouse crew/);
      expect(screen.getByTestId('detail-seasons-count')).toHaveTextContent('2 seasons');
      expect(screen.queryByTestId('detail-watched')).toBeNull();
      expect(screen.getByTestId('detail-cast')).toBeTruthy();

      // Exact §3 order: Hero -> Cast -> Episodes -> More Like This
      const serialized = JSON.stringify(view.toJSON());
      const heroIdx = serialized.indexOf('"detail-hero"');
      const castIdx = serialized.indexOf('"detail-cast"');
      const epIdx = serialized.indexOf('"detail-episodes"');
      const relIdx = serialized.indexOf('"detail-related-rail"');
      expect(heroIdx).toBeGreaterThan(-1);
      expect(castIdx).toBeGreaterThan(heroIdx);
      expect(epIdx).toBeGreaterThan(castIdx);
      expect(relIdx).toBeGreaterThan(epIdx);

      // Clicking Episode 2 calls onPlay with full episode metadata and 5s rewind
      await fireEvent.press(screen.getByTestId('detail-episode-1'));
      expect(onPlay).toHaveBeenCalledTimes(1);
      expect(onPlay.mock.calls[0]?.[0]).toMatchObject({
        itemKey: ep2.key,
        kind: 'vod',
        itemKind: 'episode',
        seriesKey: show.key,
        season: 1,
        episode: 2,
        startPositionMs: 600_000,
      });

      // Switch to Season 2
      await fireEvent.press(screen.getByTestId('detail-season-2'));
      await waitFor(() => {
        expect(screen.getByTestId('detail-episode-0')).toHaveTextContent(/North Beacon/);
        expect(screen.getByTestId('detail-episode-0-duration')).toHaveTextContent('1h 32m');
        expect(screen.getByTestId('detail-play')).toHaveTextContent('Play S2 E1');
      });

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('displays localized seasons error and recovers cleanly via Retry button', async () => {
    const env = await openDetailCatalog({ failSeriesInfoOnce: true });
    try {
      const show = requireFirst(env.series, 'series');
      const view = await renderDetail({
        target: {
          itemKey: show.key,
          sourceId: env.sourceId,
          kind: 'series',
          title: show.name,
          posterUri: null,
          backdropUri: null,
          year: 2025,
          rating: 8.9,
          catalogId: show.id,
        },
        catalog: env.catalog,
      });

      await waitFor(() => {
        expect(screen.getByTestId('detail-seasons-error')).toBeTruthy();
        expect(screen.getByTestId('detail-retry-seasons')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('detail-retry-seasons'));

      await waitFor(() => {
        expect(screen.getByTestId('detail-season-1')).toBeTruthy();
        expect(screen.getByTestId('detail-episode-0')).toHaveTextContent(/Arrival/);
      });

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('stacks Hero bottom on Portrait and renders cleanly under High Contrast (AAA) theme', async () => {
    const env = await openDetailCatalog();
    try {
      const movie = requireFirst(env.movies, 'movie');
      const view = await renderDetail(
        {
          target: {
            itemKey: movie.key,
            sourceId: env.sourceId,
            kind: 'movie',
            title: movie.name,
            posterUri: null,
            backdropUri: null,
            year: 2026,
            rating: 8.6,
            catalogId: movie.id,
          },
          catalog: env.catalog,
        },
        {
          viewport: {
            formFactor: 'phone',
            orientation: 'portrait',
            inputModality: 'touch',
            width: 390,
            height: 844,
          },
          preset: 'highContrast',
        },
      );

      await waitFor(() => {
        expect(screen.getByTestId('detail-hero-bottom')).toBeTruthy();
      });

      const heroBottom = screen.getByTestId('detail-hero-bottom');
      const flatBottom = Object.assign(
        {},
        ...(Array.isArray(heroBottom.props.style)
          ? heroBottom.props.style.filter(Boolean)
          : [heroBottom.props.style]),
      );
      expect(flatBottom.flexDirection).toBe('column');

      // Back button meets >= 40x40 touch target
      const backBtn = screen.getByTestId('detail-back');
      const flatBack = Object.assign(
        {},
        ...(Array.isArray(backBtn.props.style)
          ? backBtn.props.style.filter(Boolean)
          : [backBtn.props.style]),
      );
      expect(flatBack.minHeight).toBeGreaterThanOrEqual(40);
      expect(flatBack.minWidth).toBeGreaterThanOrEqual(40);

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('supports 10-ft TV D-pad: initial focus on detail-play, immediate Select play, seasons/episodes/related traversal, and Back', async () => {
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

    const env = await openDetailCatalog();
    const onPlay = jest.fn();
    const onBack = jest.fn();
    const onOpenDetail = jest.fn();
    const onFocusTopNav = jest.fn();

    try {
      const show = requireFirst(env.series, 'series');
      const view = await renderDetail(
        {
          target: {
            itemKey: show.key,
            sourceId: env.sourceId,
            kind: 'series',
            title: show.name,
            posterUri: null,
            backdropUri: null,
            year: 2025,
            rating: 8.9,
            catalogId: show.id,
            categoryId: `${env.sourceId}|series|20`,
          },
          catalog: env.catalog,
          onPlay,
          onBack,
          onOpenDetail,
          onFocusTopNav,
          isActiveScope: true,
        },
        {
          viewport: {
            formFactor: 'tv',
            orientation: 'landscape',
            inputModality: 'tv',
            width: 1920,
            height: 1080,
          },
          androidSource,
        },
      );

      await waitFor(() => {
        expect(screen.getByTestId('detail-season-1')).toBeTruthy();
        expect(screen.getByTestId('detail-episode-0')).toBeTruthy();
        expect(screen.getByTestId('detail-related-item-0')).toBeTruthy();
      });

      // Zero native TV focus leaks + anchor mounted
      expect(screen.getByTestId('detail-back').props.focusable).toBe(false);
      expect(screen.getByTestId('detail-mylist').props.focusable).toBe(false);
      expect(screen.getByTestId('detail-play').props.focusable).toBe(false);
      expect(screen.getByTestId('detail-season-1').props.focusable).toBe(false);
      expect(screen.getByTestId('detail-episode-0').props.focusable).toBe(false);
      expect(screen.getByTestId('detail-related-item-0').props.focusable).toBe(false);
      expect(
        screen.getByTestId('detail-tv-focus-anchor', { includeHiddenElements: true }),
      ).toBeTruthy();

      // Initial focus lands directly on detail-play -> Select plays immediately!
      expect(screen.getByTestId('detail-play-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_CENTER);
      expect(onPlay).toHaveBeenCalledTimes(1);
      const firstPlayed = onPlay.mock.calls[0]?.[0] as PlayTarget | undefined;
      expect(firstPlayed?.episode).toBe(1);

      // Up -> hero-actions (mylist), Up -> back, Up -> onFocusTopNav
      await pressKey(KEYCODE_DPAD_UP);
      expect(screen.getByTestId('detail-mylist-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_UP);
      expect(screen.getByTestId('detail-back-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_UP);
      expect(onFocusTopNav).toHaveBeenCalledTimes(1);

      // Down -> mylist -> play -> seasons -> Right to Season 2 -> Left back to Season 1 -> Right to Season 2 -> Select
      await pressKey(KEYCODE_DPAD_DOWN);
      await pressKey(KEYCODE_DPAD_DOWN);
      await pressKey(KEYCODE_DPAD_DOWN);
      expect(screen.getByTestId('detail-season-1-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_RIGHT);
      expect(screen.getByTestId('detail-season-2-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_LEFT);
      expect(screen.getByTestId('detail-season-1-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_RIGHT);
      await pressKey(KEYCODE_DPAD_CENTER);
      await waitFor(() => {
        expect(screen.getByTestId('detail-episode-0')).toHaveTextContent(/North Beacon/);
      });

      // Down -> episode 0 -> Down -> related item 0 -> Select calls onOpenDetail
      await pressKey(KEYCODE_DPAD_DOWN);
      expect(screen.getByTestId('detail-episode-0-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_DOWN);
      expect(screen.getByTestId('detail-related-item-0-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_CENTER);
      expect(onOpenDetail).toHaveBeenCalledTimes(1);
      const tvRelated = onOpenDetail.mock.calls[0]?.[0] as DetailTarget | undefined;
      expect(tvRelated?.title).toBe('Harbor Echoes');

      // Back calls onBack immediately
      await pressKey(KEYCODE_BACK);
      expect(onBack).toHaveBeenCalledTimes(1);

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });
});
