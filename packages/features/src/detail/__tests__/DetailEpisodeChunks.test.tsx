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

const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
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

function makeXtreamEpisodes(count: number, idBase: number, prefix: string) {
  return Array.from({ length: count }, (_, i) => ({
    id: String(idBase + i + 1),
    episode_num: i + 1,
    title: `${prefix} ${i + 1}`,
    container_extension: 'mp4',
    info: { duration_secs: 2700 },
  }));
}

function createLongSeasonHttpClient(seasonCounts: {
  readonly s1: number;
  readonly s2?: number;
}): HttpClient {
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
      if (action === 'get_live_categories' || action === 'get_vod_categories') {
        return ok(jsonResponse([]));
      }
      if (action === 'get_series_categories') {
        return ok(jsonResponse([{ category_id: '20', category_name: 'Long Dramas' }]));
      }
      if (action === 'get_live_streams' || action === 'get_vod_streams') {
        return ok(jsonResponse([]));
      }
      if (action === 'get_series') {
        return ok(
          jsonResponse([
            {
              series_id: 401,
              name: 'Endless Chronicle',
              category_id: '20',
              rating: '9.1',
              year: '2025',
            },
            {
              series_id: 402,
              name: 'Related Saga',
              category_id: '20',
              rating: '8.4',
              year: '2024',
            },
          ]),
        );
      }
      if (action === 'get_series_info') {
        const episodes: Record<string, unknown[]> = {
          '1': makeXtreamEpisodes(seasonCounts.s1, 10000, 'Chapter'),
        };
        if (seasonCounts.s2 !== undefined) {
          episodes['2'] = makeXtreamEpisodes(seasonCounts.s2, 20000, 'Arc');
        }
        return ok(
          jsonResponse({
            info: { name: 'Endless Chronicle' },
            episodes,
          }),
        );
      }
      return ok(jsonResponse([]));
    },
  };
}

async function openLongSeasonCatalog(seasonCounts: { readonly s1: number; readonly s2?: number }) {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) throw new Error('migrate failed');
  let now = 1_700_000_000_000;
  let nextId = 1;
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: createLongSeasonHttpClient(seasonCounts),
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
  const series = await catalog.items(`${sourceId}|series|20`, 0, 10);
  const show = series[0];
  if (!show) throw new Error('missing series fixture');
  const target: DetailTarget = {
    itemKey: show.key,
    sourceId,
    kind: 'series',
    title: show.name,
    posterUri: null,
    backdropUri: null,
    year: 2025,
    rating: 9.1,
    catalogId: show.id,
    categoryId: `${sourceId}|series|20`,
  };
  return {
    catalog,
    sourceId,
    target,
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
    onPlay?: (target: PlayTarget) => void;
    onBack?: () => void;
    onOpenDetail?: (target: DetailTarget) => void;
  },
  opts: {
    viewport?: ViewportOverride;
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
      <ThemeProvider preset="obsidianCrimson">
        <I18nProvider i18n={createAppI18n('en')}>
          <DetailScreen
            target={props.target}
            catalog={props.catalog}
            refreshToken={1}
            onBack={props.onBack ?? jest.fn()}
            onPlay={props.onPlay ?? jest.fn()}
            onOpenDetail={props.onOpenDetail ?? jest.fn()}
            isActiveScope={true}
          />
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>
  );

  return render(
    opts.androidSource ? (
      <RemoteKeysProvider android={opts.androidSource}>{content}</RemoteKeysProvider>
    ) : (
      content
    ),
  );
}

describe('DetailScreen 60+ episode chunking (#152)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('mounts only 30 episode rows initially for a 100-episode season, renders 4 chunk sub-tabs, and preserves cross-chunk nextEpisodes', async () => {
    const env = await openLongSeasonCatalog({ s1: 100, s2: 12 });
    const onPlay = jest.fn();
    try {
      const view = await renderDetail({ target: env.target, catalog: env.catalog, onPlay });

      await waitFor(() => {
        expect(screen.getByTestId('detail-episode-chunks-bar')).toBeTruthy();
        expect(screen.getByTestId('detail-episode-0')).toBeTruthy();
      });

      // Desktop/pointer scroll container must not become a spurious tab-stop
      expect(screen.getByTestId('detail-episode-chunks-bar').props.focusable).toBeUndefined();

      // Exactly 4 chunks: 1–30, 31–60, 61–90, 91–100
      expect(screen.getByTestId('detail-episode-chunk-0')).toHaveTextContent('1–30');
      expect(screen.getByTestId('detail-episode-chunk-1')).toHaveTextContent('31–60');
      expect(screen.getByTestId('detail-episode-chunk-2')).toHaveTextContent('61–90');
      expect(screen.getByTestId('detail-episode-chunk-3')).toHaveTextContent('91–100');
      expect(screen.queryByTestId('detail-episode-chunk-4')).toBeNull();

      // O(30) render cap: only indices 0..29 are mounted initially
      const mountedRows = screen.getAllByTestId(/^detail-episode-\d+$/);
      expect(mountedRows).toHaveLength(30);
      expect(screen.getByTestId('detail-episode-29')).toHaveTextContent(/Chapter 30/);
      expect(screen.queryByTestId('detail-episode-30')).toBeNull();

      // Pressing E30 (boundary of chunk 0) queues E31 as nextEpisodes[0] across chunk boundaries!
      await fireEvent.press(screen.getByTestId('detail-episode-29'));
      expect(onPlay).toHaveBeenCalledTimes(1);
      const played30 = onPlay.mock.calls[0]?.[0] as PlayTarget | undefined;
      expect(played30?.episode).toBe(30);
      expect(played30?.nextEpisodes?.[0]?.episode).toBe(31);
      expect(played30?.nextEpisodes).toHaveLength(50);

      // Pressing chunk 31–60 swaps mounted rows to E31–E60
      await fireEvent.press(screen.getByTestId('detail-episode-chunk-1'));
      expect(screen.queryByTestId('detail-episode-0')).toBeNull();
      expect(screen.getByTestId('detail-episode-30')).toHaveTextContent(/Chapter 31/);
      expect(screen.getByTestId('detail-episode-59')).toHaveTextContent(/Chapter 60/);
      expect(screen.getAllByTestId(/^detail-episode-\d+$/)).toHaveLength(30);

      // Pressing E60 queues E61 as nextEpisodes[0]
      await fireEvent.press(screen.getByTestId('detail-episode-59'));
      const played60 = onPlay.mock.calls[1]?.[0] as PlayTarget | undefined;
      expect(played60?.episode).toBe(60);
      expect(played60?.nextEpisodes?.[0]?.episode).toBe(61);
      expect(played60?.nextEpisodes).toHaveLength(40);

      // Switching to Season 2 (12 episodes < 60) hides the chunk bar completely
      await fireEvent.press(screen.getByTestId('detail-season-2'));
      await waitFor(() => {
        expect(screen.getByTestId('detail-episode-0')).toHaveTextContent(/Arc 1/);
      });
      expect(screen.queryByTestId('detail-episode-chunks-bar')).toBeNull();
      expect(screen.getAllByTestId(/^detail-episode-\d+$/)).toHaveLength(12);

      // Switching back to Season 1 resets stale manual chunk choice to default chunk (1–30)
      await fireEvent.press(screen.getByTestId('detail-season-1'));
      await waitFor(() => {
        expect(screen.getByTestId('detail-episode-chunks-bar')).toBeTruthy();
        expect(screen.getByTestId('detail-episode-0')).toHaveTextContent(/Chapter 1/);
      });
      expect(screen.getByTestId('detail-episode-chunk-0').props.accessibilityState?.selected).toBe(
        true,
      );
      expect(screen.queryByTestId('detail-episode-30')).toBeNull();

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('auto-selects chunk 61–90 when E72 has watch progress', async () => {
    const env = await openLongSeasonCatalog({ s1: 100 });
    try {
      // Hydrate seasons once so we know E72's exact key, then seed watch progress for E72
      const catalogId = env.target.catalogId;
      if (catalogId === undefined) throw new Error('missing catalogId');
      const seasonsRes = await env.catalog.seasons(catalogId);
      if (!seasonsRes.ok) throw new Error('seasons failed');
      const allEpisodes = await env.catalog.episodes(catalogId, 1);
      const ep72 = allEpisodes[71];
      if (!ep72) throw new Error('missing E72');

      await env.catalog.saveProgress?.({
        sourceId: env.sourceId,
        itemKey: ep72.key,
        kind: 'episode',
        title: 'Endless Chronicle — E72',
        logo: null,
        seriesKey: env.target.itemKey,
        season: 1,
        episode: 72,
        positionMs: 600_000,
        durationMs: 2_700_000,
        watched: false,
      });

      const view = await renderDetail({ target: env.target, catalog: env.catalog });

      await waitFor(() => {
        expect(screen.getByTestId('detail-episode-chunks-bar')).toBeTruthy();
        expect(screen.getByTestId('detail-episode-71')).toBeTruthy();
      });

      expect(screen.getByTestId('detail-episode-chunk-2').props.accessibilityState?.selected).toBe(
        true,
      );
      expect(screen.getByTestId('detail-episode-60')).toHaveTextContent(/Chapter 61/);
      expect(screen.getByTestId('detail-episode-71')).toHaveTextContent(/Chapter 72/);
      expect(screen.queryByTestId('detail-episode-0')).toBeNull();
      expect(screen.getAllByTestId(/^detail-episode-\d+$/)).toHaveLength(30);

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('renders zero chunk bar for seasons with fewer than 60 episodes', async () => {
    const env = await openLongSeasonCatalog({ s1: 12 });
    try {
      const view = await renderDetail({ target: env.target, catalog: env.catalog });

      await waitFor(() => {
        expect(screen.getByTestId('detail-episode-0')).toHaveTextContent(/Chapter 1/);
      });

      expect(screen.queryByTestId('detail-episode-chunks-bar')).toBeNull();
      expect(screen.getAllByTestId(/^detail-episode-\d+$/)).toHaveLength(12);

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('supports 10-ft TV D-pad navigation across Seasons -> Episode Chunks -> Episodes and chunk switching via Select', async () => {
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

    const env = await openLongSeasonCatalog({ s1: 100 });
    const onPlay = jest.fn();

    try {
      const view = await renderDetail(
        { target: env.target, catalog: env.catalog, onPlay },
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
        expect(screen.getByTestId('detail-episode-chunks-bar')).toBeTruthy();
        expect(screen.getByTestId('detail-episode-0')).toBeTruthy();
      });

      // Zero native TV focus leaks on ScrollViews & chunk tabs
      expect(screen.getByTestId('detail-scroll').props.focusable).toBe(false);
      expect(screen.getByTestId('detail-seasons-bar-rail-scroll').props.focusable).toBe(false);
      expect(screen.getByTestId('detail-episode-chunks-bar-rail-scroll').props.focusable).toBe(
        false,
      );
      expect(screen.getByTestId('detail-episode-chunk-0').props.focusable).toBe(false);

      // Initial focus is hero-play -> Down -> seasons -> Down -> episode-chunks
      expect(screen.getByTestId('detail-play-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_DOWN);
      expect(screen.getByTestId('detail-season-1-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_DOWN);
      expect(screen.getByTestId('detail-episode-chunk-0-focus-ring')).toBeTruthy();

      // Right -> chunk 1 (31–60), Right -> chunk 2 (61–90), Left -> chunk 1 (31–60), Select!
      await pressKey(KEYCODE_DPAD_RIGHT);
      expect(screen.getByTestId('detail-episode-chunk-1-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_RIGHT);
      expect(screen.getByTestId('detail-episode-chunk-2-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_LEFT);
      expect(screen.getByTestId('detail-episode-chunk-1-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_CENTER);

      // Episodes swap to E31..E60
      expect(screen.getByTestId('detail-episode-30')).toHaveTextContent(/Chapter 31/);
      expect(screen.queryByTestId('detail-episode-0')).toBeNull();

      // Down -> first episode of active chunk (E31 = detail-episode-30) -> Select plays E31 with E32 queued!
      await pressKey(KEYCODE_DPAD_DOWN);
      expect(screen.getByTestId('detail-episode-30-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_CENTER);

      expect(onPlay).toHaveBeenCalledTimes(1);
      const tvPlayed = onPlay.mock.calls[0]?.[0] as PlayTarget | undefined;
      expect(tvPlayed?.episode).toBe(31);
      expect(tvPlayed?.nextEpisodes?.[0]?.episode).toBe(32);
      expect(tvPlayed?.nextEpisodes).toHaveLength(50);

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('aligns initial TV chunk focus to the auto-selected resume chunk (61–90) when navigating down from seasons', async () => {
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

    const env = await openLongSeasonCatalog({ s1: 100 });
    try {
      const catalogId = env.target.catalogId;
      if (catalogId === undefined) throw new Error('missing catalogId');
      const seasonsRes = await env.catalog.seasons(catalogId);
      if (!seasonsRes.ok) throw new Error('seasons failed');
      const allEpisodes = await env.catalog.episodes(catalogId, 1);
      const ep72 = allEpisodes[71];
      if (!ep72) throw new Error('missing E72');

      await env.catalog.saveProgress?.({
        sourceId: env.sourceId,
        itemKey: ep72.key,
        kind: 'episode',
        title: 'Endless Chronicle — E72',
        logo: null,
        seriesKey: env.target.itemKey,
        season: 1,
        episode: 72,
        positionMs: 600_000,
        durationMs: 2_700_000,
        watched: false,
      });

      const view = await renderDetail(
        { target: env.target, catalog: env.catalog },
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
        expect(screen.getByTestId('detail-episode-chunks-bar')).toBeTruthy();
        expect(screen.getByTestId('detail-episode-71')).toBeTruthy();
      });

      // Down -> seasons -> Down -> episode-chunks lands directly on active chunk 2 (61–90)
      await pressKey(KEYCODE_DPAD_DOWN);
      expect(screen.getByTestId('detail-season-1-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_DOWN);
      expect(screen.getByTestId('detail-episode-chunk-2-focus-ring')).toBeTruthy();

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });
});
