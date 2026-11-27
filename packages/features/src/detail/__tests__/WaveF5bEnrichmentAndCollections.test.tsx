import {
  type CatalogService,
  createCatalogService,
  openCatalog,
  type VodEnrichmentRecord,
} from '@elv/data';
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
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import type { DetailTarget } from '../../shared';
import { DetailScreen } from '../DetailScreen';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_RIGHT = 22;
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

function createFixtureHttp(): HttpClient {
  return {
    async get(rawUrl) {
      const url = new URL(rawUrl);
      if (url.pathname !== '/player_api.php') return err(elvError('network', 'http-404'));
      const action = url.searchParams.get('action');
      if (!action) {
        return ok(
          jsonResponse({
            user_info: { auth: 1, status: 'Active', allowed_output_formats: ['mp4'] },
            server_info: { timezone: 'UTC' },
          }),
        );
      }
      if (action === 'get_vod_categories') {
        return ok(jsonResponse([{ category_id: '10', category_name: 'Cinema' }]));
      }
      if (action === 'get_vod_streams') {
        return ok(
          jsonResponse([
            {
              stream_id: 501,
              name: '[4K] Inception (2010) HEVC',
              category_id: '10',
              container_extension: 'mp4',
            },
          ]),
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
  const movie = movies[0];
  if (!movie) throw new Error('Missing movie fixture');
  return {
    catalog,
    sourceId: added.value.id,
    movie,
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
    vodEnrichmentEnabled?: boolean;
    onBack?: () => void;
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
            {...(props.vodEnrichmentEnabled !== undefined
              ? { vodEnrichmentEnabled: props.vodEnrichmentEnabled }
              : {})}
            onBack={props.onBack ?? jest.fn()}
            onPlay={jest.fn()}
            onOpenDetail={jest.fn()}
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

describe('Wave F5B / Wave P8 DetailScreen: Key-Free VOD Enrichment (#215) & Minimalist Action Row (#508)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('makes ZERO enrichment calls when vodEnrichmentEnabled is false and enriches missing fields when true', async () => {
    const env = await openFixtureCatalog();
    const getSpy = jest.fn(env.catalog.getVodEnrichment?.bind(env.catalog));
    const enrichRecord: VodEnrichmentRecord = {
      itemKey: env.movie.key,
      sourceId: env.sourceId,
      cleanTitle: 'Inception',
      releaseYear: 2010,
      rating: 8.8,
      ratingSource: 'local-index',
      genres: ['Sci-Fi', 'Thriller'],
      synopsis: 'A skilled thief enters shared dreams to plant an idea.',
      certification: 'PG-13',
      fetchedAt: 1000,
      expiresAt: 9999999999,
    };
    const enrichSpy = jest.fn(async () => enrichRecord);
    const wrappedCatalog: CatalogService = {
      ...env.catalog,
      getVodEnrichment: getSpy,
      enrichVodItem: enrichSpy,
    };

    const target: DetailTarget = {
      itemKey: env.movie.key,
      sourceId: env.sourceId,
      kind: 'movie',
      title: env.movie.name,
      posterUri: null,
      backdropUri: null,
      year: null,
      rating: null,
      catalogId: env.movie.id,
      categoryId: `${env.sourceId}|movie|10`,
    };

    try {
      // Disabled by default -> ZERO calls to getVodEnrichment or enrichVodItem
      const disabledView = await renderDetail({
        target,
        catalog: wrappedCatalog,
        vodEnrichmentEnabled: false,
      });
      await waitFor(() => {
        expect(screen.getByTestId('detail-title')).toBeTruthy();
      });
      expect(getSpy).not.toHaveBeenCalled();
      expect(enrichSpy).not.toHaveBeenCalled();
      expect(screen.queryByTestId('detail-enrichment-badge')).toBeNull();
      await disabledView.unmount();

      // Enabled -> calls enrichVodItem({ enabled: true }), fills missing fields, without showing clutter badge
      const enabledView = await renderDetail({
        target,
        catalog: wrappedCatalog,
        vodEnrichmentEnabled: true,
      });
      await waitFor(() => {
        expect(enrichSpy).toHaveBeenCalledWith(env.movie.key, { enabled: true });
        expect(screen.queryByTestId('detail-enrichment-badge')).toBeNull();
        expect(screen.getByTestId('detail-rating')).toHaveTextContent(/8\.8/);
        expect(screen.getByTestId('detail-year')).toHaveTextContent('2010');
        expect(screen.getByTestId('detail-genres')).toHaveTextContent('Sci-Fi · Thriller');
        expect(screen.getByTestId('detail-synopsis')).toHaveTextContent(/shared dreams/);
      });
      await enabledView.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('omits collection button & picker on DetailScreen and keeps circular icon row cleanly above Play CTA on TV D-pad (#508)', async () => {
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

    const env = await openFixtureCatalog();
    const onBack = jest.fn();
    try {
      const created = await env.catalog.createCollection?.({ name: 'Favorites Mix' });
      expect(created?.ok).toBe(true);

      const view = await renderDetail(
        {
          target: {
            itemKey: env.movie.key,
            sourceId: env.sourceId,
            kind: 'movie',
            title: env.movie.name,
            posterUri: null,
            backdropUri: null,
            year: 2010,
            rating: 8.8,
            catalogId: env.movie.id,
          },
          catalog: env.catalog,
          onBack,
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
        expect(screen.getByTestId('detail-hero-icon-row')).toBeTruthy();
        expect(screen.getByTestId('detail-play')).toBeTruthy();
      });

      // Collection button and picker overlay are completely absent from DetailScreen (Wave P8)
      expect(screen.queryByTestId('detail-collections')).toBeNull();
      expect(screen.queryByTestId('collection-picker-overlay')).toBeNull();
      expect(JSON.stringify(view.toJSON())).not.toContain('"type":"Modal"');

      // TV D-pad: hero-play -> Up (mylist) -> Right (like) -> Right (dislike) -> Right (watched) -> extra Right stays clamped on watched
      await pressKey(KEYCODE_DPAD_UP);
      expect(screen.getByTestId('detail-mylist-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_RIGHT);
      expect(screen.getByTestId('detail-like-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_RIGHT);
      expect(screen.getByTestId('detail-dislike-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_RIGHT);
      expect(screen.getByTestId('detail-watched-focus-ring')).toBeTruthy();
      await pressKey(KEYCODE_DPAD_RIGHT);
      expect(screen.getByTestId('detail-watched-focus-ring')).toBeTruthy();

      // Down returns cleanly to detail-play and Back pops DetailScreen
      await pressKey(KEYCODE_DPAD_DOWN);
      await pressKey(KEYCODE_BACK);
      expect(onBack).toHaveBeenCalledTimes(1);

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });
});
