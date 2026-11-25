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
import { Platform, ScrollView } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { DetailTarget } from '../../shared';
import { DetailScreen } from '../DetailScreen';

const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_BACK = 4;

const LONG_SYNOPSIS =
  'In a quiet orbital listening station suspended above the twilight meridian, a veteran engineer uncovers a recurring signal hidden beneath decades of archived telemetry. As rival relays begin shutting down one by one, the crew must decide whether to broadcast the message back home or seal the beacon forever.';

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

function createFixtureHttp(): HttpClient {
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
              container_extension: 'mkv',
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
              plot: LONG_SYNOPSIS,
            },
          ]),
        );
      }
      if (action === 'get_series_info') {
        return ok(
          jsonResponse({
            episodes: {
              '1': [
                {
                  id: '9001',
                  episode_num: 1,
                  title: 'Arrival',
                  container_extension: 'mp4',
                  info: { duration_secs: 2880 },
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

async function openFixtureCatalog() {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) throw new Error('migrate failed');
  let now = 1_700_000_000_000;
  let seq = 1;
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: createFixtureHttp(),
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
  const movies = await catalog.items(`${added.value.id}|movie|10`, 0, 10);
  const series = await catalog.items(`${added.value.id}|series|20`, 0, 10);
  return {
    catalog,
    sourceId: added.value.id,
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
    preferredAudioLang?: string;
    preferredSubtitleLang?: string;
    onPlay?: (target: PlayTarget) => void;
    onBack?: () => void;
    onOpenDetail?: (target: DetailTarget) => void;
    onSearchPerson?: (name: string) => void;
    isActiveScope?: boolean;
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
      <ThemeProvider>
        <I18nProvider i18n={createAppI18n('en')}>
          <DetailScreen
            target={props.target}
            catalog={props.catalog}
            refreshToken={1}
            onBack={props.onBack ?? jest.fn()}
            onPlay={props.onPlay ?? jest.fn()}
            onOpenDetail={props.onOpenDetail ?? jest.fn()}
            {...(props.preferredAudioLang !== undefined
              ? { preferredAudioLang: props.preferredAudioLang }
              : {})}
            {...(props.preferredSubtitleLang !== undefined
              ? { preferredSubtitleLang: props.preferredSubtitleLang }
              : {})}
            {...(props.onSearchPerson !== undefined
              ? { onSearchPerson: props.onSearchPerson }
              : {})}
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

function requireFirst<T>(items: readonly T[], label: string): T {
  const item = items[0];
  if (item === undefined) throw new Error(`Missing fixture: ${label}`);
  return item;
}

describe('DetailScreen technical badges, pre-play selectors, expandable synopsis & clickable cast (#398)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders technical MicroPill badges, cycles pre-play Audio/Subtitles onto PlayTarget, expands long synopsis, and clicks director & cast', async () => {
    const env = await openFixtureCatalog();
    const onPlay = jest.fn();
    const onSearchPerson = jest.fn();
    try {
      const movie = requireFirst(env.movies, 'movie');
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
          categoryId: `${env.sourceId}|movie|10`,
          overview: LONG_SYNOPSIS,
          director: 'Nuri Bilge Ceylan',
          cast: [
            { name: 'Leyla Demir', role: 'Commander' },
            { name: 'Kerem Kaya', role: 'Navigator' },
          ],
          technicalMeta: {
            resolution: '4K',
            hdr: 'HDR10',
            codec: 'HEVC',
            audioChannels: '5.1',
            container: 'mkv',
            durationMin: 124,
          },
        },
        catalog: env.catalog,
        preferredAudioLang: 'en',
        preferredSubtitleLang: 'tr',
        onPlay,
        onSearchPerson,
      });

      await waitFor(() => {
        expect(screen.getByTestId('detail-tech-badge-resolution')).toHaveTextContent('4K');
      });

      // Technical badges rendered cleanly
      expect(screen.getByTestId('detail-tech-badge-hdr')).toHaveTextContent('HDR10');
      expect(screen.getByTestId('detail-tech-badge-codec')).toHaveTextContent('HEVC');
      expect(screen.getByTestId('detail-tech-badge-audioChannels')).toHaveTextContent('5.1');
      expect(screen.getByTestId('detail-tech-badge-container')).toHaveTextContent('MKV');
      expect(screen.getByTestId('detail-tech-badge-durationMin')).toHaveTextContent('124m');

      // Pre-play audio/subtitle buttons are removed (managed globally via sticky player track memory)
      expect(screen.queryByTestId('detail-preplay-audio')).toBeNull();
      expect(screen.queryByTestId('detail-preplay-subtitles')).toBeNull();

      await fireEvent.press(screen.getByTestId('detail-play'));
      expect(onPlay).toHaveBeenCalledTimes(1);
      expect(onPlay.mock.calls[0]?.[0]).toMatchObject({
        itemKey: movie.key,
      });

      // Expandable synopsis opens modal reader sheet and toggles Read more / Show less
      const toggle = screen.getByTestId('detail-synopsis-toggle');
      expect(toggle).toHaveTextContent('Read more');
      await fireEvent.press(toggle);
      expect(screen.getByTestId('detail-synopsis-sheet')).toBeTruthy();
      expect(screen.getByTestId('detail-synopsis-full')).toHaveTextContent(LONG_SYNOPSIS);
      expect(screen.getByTestId('detail-synopsis-close')).toHaveTextContent('Show less');
      expect(
        screen.getByTestId('detail-synopsis-toggle', { includeHiddenElements: true }),
      ).toHaveTextContent('Show less');

      await fireEvent.press(screen.getByTestId('detail-synopsis-close'));
      expect(screen.queryByTestId('detail-synopsis-sheet')).toBeNull();

      // Clickable director & cast invoke onSearchPerson with accessible labels
      const directorBtn = screen.getByTestId('detail-director-link');
      expect(directorBtn.props.accessibilityLabel).toBe('Search Nuri Bilge Ceylan');
      await fireEvent.press(directorBtn);
      expect(onSearchPerson).toHaveBeenLastCalledWith('Nuri Bilge Ceylan');

      const castBtn = screen.getByTestId('detail-cast-item-0');
      expect(castBtn.props.accessibilityLabel).toBe('Search Leyla Demir');
      await fireEvent.press(castBtn);
      expect(onSearchPerson).toHaveBeenLastCalledWith('Leyla Demir');

      // Preserves exact §3 order: Hero -> Cast -> Related
      const json = JSON.stringify(view.toJSON());
      expect(json.indexOf('"detail-cast"')).toBeGreaterThan(json.indexOf('"detail-hero"'));
      expect(json.indexOf('"detail-related-rail"')).toBeGreaterThan(json.indexOf('"detail-cast"'));

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('omits technical badges and synopsis toggle cleanly when metadata absent or synopsis short', async () => {
    const env = await openFixtureCatalog();
    try {
      const movie = requireFirst(env.movies, 'movie');
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
          overview: 'Short synopsis.',
        },
        catalog: env.catalog,
      });

      await waitFor(() => {
        expect(screen.getByTestId('detail-synopsis')).toHaveTextContent('Short synopsis.');
      });
      expect(screen.queryByTestId('detail-tech-badge-resolution')).toBeNull();
      expect(screen.queryByTestId('detail-synopsis-toggle')).toBeNull();
      expect(screen.queryByTestId('detail-cast')).toBeNull();
      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('keeps TV D-pad traversal working across play -> preplay -> synopsis -> cast -> seasons and closes synopsis sheet on Back', async () => {
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

    const env = await openFixtureCatalog();
    const onPlay = jest.fn();
    const onBack = jest.fn();
    const onSearchPerson = jest.fn();
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
            overview: LONG_SYNOPSIS,
            director: 'Nuri Bilge Ceylan',
            cast: [{ name: 'Leyla Demir', role: 'Commander' }],
          },
          catalog: env.catalog,
          onPlay,
          onBack,
          onSearchPerson,
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
        expect(screen.getByTestId('detail-synopsis-toggle')).toBeTruthy();
      });

      // Lands directly on primary Play CTA
      expect(screen.getByTestId('detail-play-focus-ring')).toBeTruthy();

      // Right -> Synopsis Read more -> Select opens sheet (audio/subtitle pre-play buttons removed)
      await pressKey(KEYCODE_DPAD_RIGHT);
      expect(screen.getByTestId('detail-synopsis-toggle-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_CENTER);
      expect(screen.getByTestId('detail-synopsis-sheet')).toBeTruthy();

      // Back closes synopsis sheet WITHOUT popping DetailScreen
      await pressKey(KEYCODE_BACK);
      expect(screen.queryByTestId('detail-synopsis-sheet')).toBeNull();
      expect(onBack).not.toHaveBeenCalled();

      // Record Cast strip layout Y and verify Down scrolls Cast smoothly into view (#398)
      const scrollToSpy = jest
        .spyOn(ScrollView.prototype, 'scrollTo')
        .mockImplementation(() => undefined);
      await fireEvent(screen.getByTestId('detail-cast'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 520, width: 1920, height: 180 } },
      });
      scrollToSpy.mockClear();

      // Down moves into Cast row (director at index 0, cast at index 1) -> scrolls into view -> Right -> Select searches cast
      await pressKey(KEYCODE_DPAD_DOWN);
      expect(scrollToSpy).toHaveBeenCalledWith(
        expect.objectContaining({ y: expect.any(Number), animated: true }),
      );
      const scrolledY = (scrollToSpy.mock.calls[0]?.[0] as { y?: number } | undefined)?.y ?? 0;
      expect(scrolledY).toBeGreaterThan(0);
      await pressKey(KEYCODE_DPAD_RIGHT);
      await pressKey(KEYCODE_DPAD_CENTER);
      expect(onSearchPerson).toHaveBeenCalledWith('Leyla Demir');

      // Down moves to Seasons row -> Down moves to Episode 0 -> Select plays episode cleanly
      await pressKey(KEYCODE_DPAD_DOWN);
      expect(screen.getByTestId('detail-season-1-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_DOWN);
      await pressKey(KEYCODE_DPAD_CENTER);
      expect(onPlay).toHaveBeenCalledWith(
        expect.objectContaining({
          itemKind: 'episode',
        }),
      );

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });
});
