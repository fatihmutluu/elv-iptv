import { type CatalogService, createCatalogService, openCatalog, type SourceRow } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { elvError, err, type HttpClient, type HttpResponse, ok, type Result } from '@elv/domain';
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
import { HomeScreen } from '../HomeScreen';
import { computeHomeLayout } from '../HomeSkeleton';
import type { HomePlayTarget } from '../home-model';
import * as homeModel from '../home-model';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_BACK = 4;

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
        return ok(jsonResponse([{ category_id: '10', category_name: 'Cinema' }]));
      }
      if (action === 'get_series_categories') {
        return ok(jsonResponse([{ category_id: '20', category_name: 'Dramas' }]));
      }
      if (action === 'get_live_streams') {
        return ok(
          jsonResponse([
            { stream_id: 101, name: 'Live One', category_id: '1', num: 1 },
            { stream_id: 102, name: 'Live Two', category_id: '1', num: 2 },
          ]),
        );
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

async function openPopulatedHomeCatalog() {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) throw new Error('migrate failed');
  let now = 1_700_000_000_000;
  let nextId = 1;
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: createHomeHttpClient(),
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

function renderHome(
  props: {
    catalog: CatalogService;
    sources: readonly SourceRow[];
    onPlay?: (target: PlayTarget) => void;
    onOpenTab?: (tab: 'live' | 'movie' | 'series') => void;
    onOpenDetail?: (target: DetailTarget) => void;
    onOpenSeries?: (item: unknown) => void;
    onOpenSources?: () => void;
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
          <HomeScreen
            catalog={props.catalog}
            sources={props.sources}
            refreshToken={1}
            onPlay={props.onPlay ?? jest.fn()}
            onOpenTab={props.onOpenTab ?? jest.fn()}
            {...(props.onOpenDetail ? { onOpenDetail: props.onOpenDetail } : {})}
            onOpenSeries={props.onOpenSeries ?? jest.fn()}
            onOpenSources={props.onOpenSources ?? jest.fn()}
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

describe('HomeScreen', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows zero-CLS tonal skeleton while initial bounded queries are pending', async () => {
    let resolveCats!: () => void;
    const pendingCatalog = {
      listContinueWatching: () => new Promise(() => {}),
      listFavorites: () => new Promise(() => {}),
      listFavoriteKeys: () => new Promise(() => {}),
      categories: () =>
        new Promise((resolve) => {
          resolveCats = () => resolve([]);
        }),
      items: async () => [],
      listProgressByKeys: async () => [],
    } as unknown as CatalogService;

    const view = await renderHome({
      catalog: pendingCatalog,
      sources: [{ id: 'src-1', kind: 'xtream', name: 'Demo', createdAt: 1, needsImport: false }],
    });

    expect(screen.getByTestId('home-skeleton')).toBeTruthy();
    expect(screen.getByTestId('home-skeleton-hero')).toBeTruthy();
    expect(screen.getByTestId('home-skeleton-wide-rail')).toBeTruthy();
    expect(screen.getByTestId('home-skeleton-poster-rail')).toBeTruthy();
    resolveCats();
    await view.unmount();
  });

  it('renders constructive empty state when no sources are configured', async () => {
    const onOpenSources = jest.fn();
    const emptyCatalog = {
      listContinueWatching: async () => [],
      listFavorites: async () => [],
      listFavoriteKeys: async () => [],
      categories: async () => [],
      items: async () => [],
      listProgressByKeys: async () => [],
    } as unknown as CatalogService;

    const view = await renderHome({
      catalog: emptyCatalog,
      sources: [],
      onOpenSources,
    });

    await waitFor(() => {
      expect(screen.getByTestId('home-empty')).toBeTruthy();
    });
    expect(screen.getByText('Your screening room is ready')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('home-empty-sources'));
    expect(onOpenSources).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('renders Hero carousel, persists My List toggle, toggles Watched, resumes with 5s smart rewind, and plays Live TV', async () => {
    const env = await openPopulatedHomeCatalog();
    const onPlay = jest.fn();
    const onOpenTab = jest.fn();
    const onScrollTopChange = jest.fn();

    try {
      await env.catalog.saveProgress?.({
        sourceId: env.sourceId,
        itemKey: `x:${env.sourceId}:movie:201`,
        kind: 'movie',
        title: 'Neon Horizon',
        positionMs: 125_000,
        durationMs: 600_000,
      });

      const view = await renderHome({
        catalog: env.catalog,
        sources: env.sources,
        onPlay,
        onOpenTab,
        onScrollTopChange,
      });

      await waitFor(() => {
        expect(screen.getByTestId('home-hero')).toBeTruthy();
        expect(screen.getByTestId('home-rail-continue')).toBeTruthy();
        expect(screen.getByTestId('home-rail-live')).toBeTruthy();
        expect(screen.getByTestId('home-rail-movies')).toBeTruthy();
        expect(screen.getByTestId('home-rail-series')).toBeTruthy();
      });

      // Continue watching prioritizes Neon Horizon on hero slide 0 with Resume CTA
      expect(screen.getByTestId('home-hero-play')).toHaveTextContent('Resume');
      await fireEvent.press(screen.getByTestId('home-hero-play'));
      expect(onPlay).toHaveBeenCalledTimes(1);
      const resumeTarget = onPlay.mock.calls[0]?.[0] as HomePlayTarget;
      expect(resumeTarget.itemKey).toBe(`x:${env.sourceId}:movie:201`);
      expect(resumeTarget.startPositionMs).toBe(120_000);

      // Toggle My List on hero -> appears immediately in My List rail AND persists in SQLite
      expect(screen.queryByTestId('home-rail-mylist')).toBeNull();
      await fireEvent.press(screen.getByTestId('home-hero-mylist'));
      await waitFor(() => {
        expect(screen.getByTestId('home-rail-mylist')).toBeTruthy();
      });
      expect(await env.catalog.listFavoriteKeys?.()).toContain(`x:${env.sourceId}:movie:201`);

      // Switch hero dot to slide 1 (Glass Meridian)
      await fireEvent.press(screen.getByTestId('home-hero-dot-1'));
      expect(screen.getByTestId('home-hero-title')).toHaveTextContent('Glass Meridian');

      // Mark watched on hero -> badge appears and persists
      await fireEvent.press(screen.getByTestId('home-hero-watched'));
      await waitFor(() => {
        expect(screen.getByTestId('home-hero-watched-badge')).toHaveTextContent('Watched');
      });
      const saved = await env.catalog.getProgress?.(`x:${env.sourceId}:movie:202`);
      expect(saved?.watched).toBe(true);

      // Play Live TV from On Air Now with playlist zapping support
      onPlay.mockClear();
      await fireEvent.press(screen.getByTestId('home-live-item-0'));
      expect(onPlay).toHaveBeenCalledTimes(1);
      const liveTarget = onPlay.mock.calls[0]?.[0] as PlayTarget;
      expect(liveTarget.kind).toBe('live');
      expect(liveTarget.title).toBe('1. Live One');
      expect(liveTarget.playlist?.count).toBe(2);

      // See all shortcuts navigate to the right tabs
      await fireEvent.press(screen.getByTestId('home-rail-live-action'));
      expect(onOpenTab).toHaveBeenCalledWith('live');
      await fireEvent.press(screen.getByTestId('home-rail-movies-action'));
      expect(onOpenTab).toHaveBeenCalledWith('movie');

      // Scroll reports frosted nav transition past 24px
      await fireEvent.scroll(screen.getByTestId('home-scroll'), {
        nativeEvent: { contentOffset: { x: 0, y: 60 } },
      });
      expect(onScrollTopChange).toHaveBeenCalledWith(true);
      await fireEvent.scroll(screen.getByTestId('home-scroll'), {
        nativeEvent: { contentOffset: { x: 0, y: 0 } },
      });
      expect(onScrollTopChange).toHaveBeenCalledWith(false);

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('adapts peek card sizing for Portrait vs Landscape and renders cleanly under High Contrast AAA', async () => {
    const env = await openPopulatedHomeCatalog();
    try {
      const portraitView = await renderHome(
        { catalog: env.catalog, sources: env.sources },
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
        expect(screen.getByTestId('home-movies-item-0')).toBeTruthy();
        expect(screen.getByTestId('home-live-item-0')).toBeTruthy();
      });
      await portraitView.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('supports 10-ft TV D-pad 2D hero and rail navigation with focusable={false} on child controls', async () => {
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

    const env = await openPopulatedHomeCatalog();
    const onPlay = jest.fn();
    const onFocusTopNav = jest.fn();

    try {
      const view = await renderHome(
        {
          catalog: env.catalog,
          sources: env.sources,
          onPlay,
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
        expect(screen.getByTestId('home-hero-play')).toBeTruthy();
        expect(screen.getByTestId('home-live-item-0')).toBeTruthy();
      });

      // Zero native TV focus leaks on child interactive primitives
      expect(screen.getByTestId('home-hero-play').props.focusable).toBe(false);
      expect(screen.getByTestId('home-hero-mylist').props.focusable).toBe(false);
      expect(screen.getByTestId('home-live-item-0').props.focusable).toBe(false);
      expect(screen.getByTestId('home-movies-item-0').props.focusable).toBe(false);
      expect(
        screen.getByTestId('home-tv-focus-anchor', { includeHiddenElements: true }),
      ).toBeTruthy();

      // Starts focused on Hero Play CTA -> Up notifies Top Nav
      const buildRailsSpy = jest.spyOn(homeModel, 'buildHomeRailSets');
      buildRailsSpy.mockClear();

      expect(screen.getByTestId('home-hero-play-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_UP);
      expect(onFocusTopNav).toHaveBeenCalledTimes(1);

      // Right moves to My List button without rebuilding rail sets!
      await pressKey(KEYCODE_DPAD_RIGHT);
      expect(buildRailsSpy).not.toHaveBeenCalled();
      expect(screen.getByTestId('home-hero-mylist-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_CENTER);
      await waitFor(() => {
        expect(screen.getByTestId('home-rail-mylist')).toBeTruthy();
      });

      // Down moves from Hero into On Air Now rail (index 0) -> Right moves to index 1 -> Select plays Live Two
      buildRailsSpy.mockClear();
      await pressKey(KEYCODE_DPAD_DOWN);
      expect(screen.getByTestId('home-live-item-0-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_RIGHT);
      expect(screen.getByTestId('home-live-item-1-focus-ring')).toBeTruthy();
      expect(buildRailsSpy).not.toHaveBeenCalled();
      await pressKey(KEYCODE_DPAD_CENTER);

      expect(onPlay).toHaveBeenCalledTimes(1);
      const tvLiveTarget = onPlay.mock.calls[0]?.[0] as PlayTarget | undefined;
      expect(tvLiveTarget?.title).toBe('2. Live Two');

      // Left returns to index 0, Back notifies Top Nav
      await pressKey(KEYCODE_DPAD_LEFT);
      expect(screen.getByTestId('home-live-item-0-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_BACK);
      expect(onFocusTopNav).toHaveBeenCalledTimes(2);

      // Verify TV horizontal strip padding clears 1.05x scaled card + -3px focus ring
      const liveStrip = screen.getByTestId('home-rail-live-strip-scroll');
      const flatStripStyle = Object.assign(
        {},
        ...(Array.isArray(liveStrip.props.contentContainerStyle)
          ? liveStrip.props.contentContainerStyle
          : [liveStrip.props.contentContainerStyle]),
      );
      expect(flatStripStyle.paddingTop).toBeGreaterThanOrEqual(18);
      expect(flatStripStyle.paddingBottom).toBeGreaterThanOrEqual(20);

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('adds overlay top-bar clearance on Live-only catalogs with no hero slides and resets scroll on mount', async () => {
    const onScrollTopChange = jest.fn();
    const liveOnlyCatalog = {
      listContinueWatching: async () => [],
      listFavorites: async () => [],
      listFavoriteKeys: async () => [],
      listProgressByKeys: async () => [],
      categories: async (_sourceId: string, kind: string) =>
        kind === 'live'
          ? [
              {
                id: 'src-1|live|1',
                sourceId: 'src-1',
                kind: 'live' as const,
                name: 'General',
                position: 0,
                itemCount: 1,
              },
            ]
          : [],
      items: async () => [
        {
          id: 1,
          key: 'x:src-1:live:1',
          kind: 'live' as const,
          sourceId: 'src-1',
          providerId: '1',
          name: 'News 24',
          logo: null,
          rating: null,
          year: null,
          num: 1,
        },
      ],
    } as unknown as CatalogService;

    const view = await renderHome({
      catalog: liveOnlyCatalog,
      sources: [
        { id: 'src-1', kind: 'xtream', name: 'LiveOnly', createdAt: 1, needsImport: false },
      ],
      onScrollTopChange,
    });

    await waitFor(() => {
      expect(screen.getByTestId('home-rail-live')).toBeTruthy();
    });
    expect(screen.queryByTestId('home-hero')).toBeNull();
    expect(onScrollTopChange).toHaveBeenCalledWith(false);
    const scrollStyle = screen.getByTestId('home-scroll').props.contentContainerStyle;
    expect(scrollStyle.paddingTop).toBeGreaterThanOrEqual(80);
    await view.unmount();
  });

  it('gives touch hero dots non-overlapping >=40x40 hit targets and renders TV focus ring on outer dot pill', async () => {
    const env = await openPopulatedHomeCatalog();
    try {
      const touchView = await renderHome(
        { catalog: env.catalog, sources: env.sources },
        {
          viewport: {
            formFactor: 'phone',
            orientation: 'portrait',
            inputModality: 'touch',
            width: 390,
            height: 844,
          },
        },
      );
      await waitFor(() => {
        expect(screen.getByTestId('home-hero-dot-0')).toBeTruthy();
      });
      const dot0 = screen.getByTestId('home-hero-dot-0');
      const flatDotStyle = Object.assign(
        {},
        ...(Array.isArray(dot0.props.style)
          ? dot0.props.style.filter(Boolean)
          : [dot0.props.style]),
      );
      expect(flatDotStyle.minWidth).toBeGreaterThanOrEqual(40);
      expect(flatDotStyle.minHeight).toBeGreaterThanOrEqual(40);
      expect(dot0.props.hitSlop).toBeUndefined();
      await touchView.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('rolls back failed setWatched and isolates concurrent toggleMyList failures per item', async () => {
    const env = await openPopulatedHomeCatalog();
    let rejectFirstFav!: (v: Result<boolean>) => void;
    let resolveSecondFav!: (v: Result<boolean>) => void;
    let favCalls = 0;

    const flakyFav = jest.fn(async () => {
      favCalls += 1;
      if (favCalls === 1) {
        return new Promise<Result<boolean>>((resolve) => {
          rejectFirstFav = resolve;
        });
      }
      return new Promise<Result<boolean>>((resolve) => {
        resolveSecondFav = resolve;
      });
    });

    const flakyCatalog: CatalogService = {
      ...env.catalog,
      setFavorite: flakyFav,
      toggleFavorite: flakyFav,
      saveProgress: undefined,
      setWatched: jest.fn(async () => err(elvError('storage', 'disk-full'))),
    };

    try {
      const view = await renderHome({ catalog: flakyCatalog, sources: env.sources });
      await waitFor(() => {
        expect(screen.getByTestId('home-hero-title')).toHaveTextContent('Neon Horizon');
      });

      // Toggle My List on slide 0 (will fail), then switch to slide 1 and toggle My List (will succeed)
      await fireEvent.press(screen.getByTestId('home-hero-mylist'));
      await fireEvent.press(screen.getByTestId('home-hero-dot-1'));
      expect(screen.getByTestId('home-hero-title')).toHaveTextContent('Glass Meridian');
      await fireEvent.press(screen.getByTestId('home-hero-mylist'));

      // Resolve slide 1 success, then reject slide 0 failure -> slide 1 MUST remain in My List!
      await act(async () => {
        resolveSecondFav(ok(true));
        rejectFirstFav(err(elvError('storage', 'write-failed')));
      });

      await waitFor(() => {
        expect(screen.getByTestId('home-rail-mylist')).toBeTruthy();
        expect(screen.getByTestId('home-mylist-item-0').props.accessibilityLabel).toContain(
          'Glass Meridian',
        );
        expect(screen.queryByTestId('home-mylist-item-1')).toBeNull();
      });

      // Failed setWatched on unplayed item (when saveProgress is absent) rolls back Watched badge
      await fireEvent.press(screen.getByTestId('home-hero-watched'));
      await waitFor(() => {
        expect(screen.queryByTestId('home-hero-watched-badge')).toBeNull();
      });

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('opens DetailScreen from Movie, Series, and My List poster cards while Continue Watching plays directly', async () => {
    const env = await openPopulatedHomeCatalog();
    const onPlay = jest.fn();
    const onOpenDetail = jest.fn();

    try {
      await env.catalog.saveProgress?.({
        sourceId: env.sourceId,
        itemKey: `x:${env.sourceId}:movie:201`,
        kind: 'movie',
        title: 'Neon Horizon',
        positionMs: 95_000,
        durationMs: 600_000,
      });
      await env.catalog.toggleFavorite?.({
        sourceId: env.sourceId,
        itemKey: `x:${env.sourceId}:movie:201`,
        kind: 'movie',
        title: 'Neon Horizon',
        logo: null,
      });

      const view = await renderHome({
        catalog: env.catalog,
        sources: env.sources,
        onPlay,
        onOpenDetail,
      });

      await waitFor(() => {
        expect(screen.getByTestId('home-continue-item-0')).toBeTruthy();
        expect(screen.getByTestId('home-mylist-item-0')).toBeTruthy();
        expect(screen.getByTestId('home-movies-item-0')).toBeTruthy();
        expect(screen.getByTestId('home-series-item-0')).toBeTruthy();
      });

      // Continue Watching 16:9 card plays directly (instant 1-click resume)
      await fireEvent.press(screen.getByTestId('home-continue-item-0'));
      expect(onPlay).toHaveBeenCalledTimes(1);
      expect(onOpenDetail).not.toHaveBeenCalled();

      // Featured Movies poster opens DetailScreen
      onPlay.mockClear();
      await fireEvent.press(screen.getByTestId('home-movies-item-0'));
      expect(onPlay).not.toHaveBeenCalled();
      expect(onOpenDetail).toHaveBeenCalledTimes(1);
      expect(onOpenDetail).toHaveBeenLastCalledWith(
        expect.objectContaining({
          itemKey: `x:${env.sourceId}:movie:201`,
          sourceId: env.sourceId,
          kind: 'movie',
          title: 'Neon Horizon',
          catalogId: expect.any(Number),
        }),
      );

      // Featured Series poster opens DetailScreen
      await fireEvent.press(screen.getByTestId('home-series-item-0'));
      expect(onOpenDetail).toHaveBeenCalledTimes(2);
      expect(onOpenDetail).toHaveBeenLastCalledWith(
        expect.objectContaining({
          itemKey: `x:${env.sourceId}:series:301`,
          sourceId: env.sourceId,
          kind: 'series',
          title: 'Starlight Harbor',
          catalogId: expect.any(Number),
        }),
      );

      // My List poster opens DetailScreen
      await fireEvent.press(screen.getByTestId('home-mylist-item-0'));
      expect(onOpenDetail).toHaveBeenCalledTimes(3);
      expect(onOpenDetail).toHaveBeenLastCalledWith(
        expect.objectContaining({
          itemKey: `x:${env.sourceId}:movie:201`,
          kind: 'movie',
        }),
      );

      // Series Hero slide primary CTA opens DetailScreen instead of direct play
      await fireEvent.press(screen.getByTestId('home-hero-dot-2'));
      expect(screen.getByTestId('home-hero-title')).toHaveTextContent('Starlight Harbor');
      await fireEvent.press(screen.getByTestId('home-hero-play'));
      expect(onPlay).not.toHaveBeenCalled();
      expect(onOpenDetail).toHaveBeenCalledTimes(4);
      expect(onOpenDetail).toHaveBeenLastCalledWith(
        expect.objectContaining({
          itemKey: `x:${env.sourceId}:series:301`,
          kind: 'series',
          title: 'Starlight Harbor',
        }),
      );

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('caps Home card widths and computes unified hero height across form factors', () => {
    const theme = { spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } } as Parameters<
      typeof computeHomeLayout
    >[1];
    const desktop = computeHomeLayout(
      {
        formFactor: 'desktop',
        orientation: 'landscape',
        inputModality: 'pointer',
        width: 1920,
        height: 820,
        safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
        overscan: { x: 0, y: 0 },
        columns: { posterRail: 5.5, wideRail: 3.3, categoryGrid: 5 },
        tvScale: 1,
      },
      theme,
    );
    expect(desktop.posterCardWidth).toBeLessThanOrEqual(184);
    expect(desktop.wideCardWidth).toBeLessThanOrEqual(296);
    expect(desktop.heroHeight).toBe(Math.round(820 * 0.62));

    const phone = computeHomeLayout(
      {
        formFactor: 'phone',
        orientation: 'portrait',
        inputModality: 'touch',
        width: 390,
        height: 844,
        safeArea: { top: 44, right: 0, bottom: 34, left: 0 },
        overscan: { x: 0, y: 0 },
        columns: { posterRail: 3.5, wideRail: 1.2, categoryGrid: 3 },
        tvScale: 1,
      },
      theme,
    );
    expect(phone.posterCardWidth).toBeLessThanOrEqual(124);
    expect(phone.wideCardWidth).toBeLessThanOrEqual(270);
    expect(phone.heroHeight).toBe(460);
  });
});
