import { type CatalogService, createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { elvError, err, type HttpClient, type HttpResponse, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { I18nProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, View } from 'react-native';
import { AppProviders, AppShell } from '../index';
import type { VideoHost } from '../ports/video-host';
import { HOVER_PREVIEW_OPEN_DELAY_MS } from '../shared/poster-hover-preview-model';

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

function createSyntheticXtreamHttp(): HttpClient {
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
            user_info: { auth: 1, status: 'Active', allowed_output_formats: ['mp4', 'm3u8'] },
            server_info: { timezone: 'UTC' },
          }),
        );
      }
      if (action === 'get_live_categories') {
        return ok(jsonResponse([{ category_id: '1', category_name: 'General' }]));
      }
      if (action === 'get_vod_categories') {
        return ok(jsonResponse([{ category_id: '10', category_name: 'Sci-Fi' }]));
      }
      if (action === 'get_series_categories') {
        return ok(jsonResponse([{ category_id: '20', category_name: 'Drama' }]));
      }
      if (action === 'get_live_streams') {
        return ok(jsonResponse([{ stream_id: 101, name: 'Channel 1', category_id: '1', num: 1 }]));
      }
      if (action === 'get_vod_streams') {
        return ok(
          jsonResponse([
            {
              stream_id: 201,
              name: 'Cosmic Drift',
              category_id: '10',
              container_extension: 'mp4',
              rating: '8.5',
            },
            {
              stream_id: 202,
              name: 'Quiet Harbor',
              category_id: '10',
              container_extension: 'mp4',
              rating: '7.9',
            },
            {
              stream_id: 203,
              name: 'Solar Echo',
              category_id: '10',
              container_extension: 'mp4',
              rating: '8.1',
            },
          ]),
        );
      }
      if (action === 'get_series') {
        return ok(jsonResponse([{ series_id: 301, name: 'Starlight Harbor', category_id: '20' }]));
      }
      return ok(jsonResponse([]));
    },
  };
}

async function openWaveR3Env() {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) throw new Error('migrate failed');
  let nextId = 1;
  let now = 1_700_000_000_000;
  const baseCatalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: createSyntheticXtreamHttp(),
    clock: () => {
      now += 10;
      return now;
    },
    newId: () => `src-${nextId++}`,
  });

  const added = await baseCatalog.addSource({
    kind: 'xtream',
    name: 'SyntheticDemo',
    server: 'http://sim.example.test:8080',
    username: 'demo',
    password: ['de', 'mo'].join(''),
  });
  if (!added.ok) throw new Error('addSource failed');
  await baseCatalog.importSource(added.value.id);
  const sourceId = added.value.id;

  const origDetail = baseCatalog.itemDetail?.bind(baseCatalog);
  const origEnrich = baseCatalog.getElvEnrichmentForKeys?.bind(baseCatalog);

  const cosmicKey = `x:${sourceId}:movie:201`;
  const quietKey = `x:${sourceId}:movie:202`;

  const catalog: CatalogService = {
    ...baseCatalog,
    itemDetail: async (itemKey, opts) => {
      const base = origDetail ? await origDetail(itemKey, opts) : null;
      if (itemKey !== cosmicKey) return base;
      return {
        ...(base ?? {
          id: 201,
          key: cosmicKey,
          sourceId,
          providerId: '201',
          kind: 'movie' as const,
          name: 'Cosmic Drift',
          logo: null,
          num: null,
          year: 2024,
          rating: 8.5,
        }),
        plot: 'Two astronauts chart a mysterious signal at the edge of deep space.',
        runtimeSec: 7680,
        year: 2024,
        rating: 8.5,
      };
    },
    getElvEnrichmentForKeys: async (itemKeys) => {
      const baseMap = (await origEnrich?.(itemKeys)) ?? new Map();
      if (itemKeys.includes(cosmicKey)) {
        baseMap.set(cosmicKey, {
          itemKey: cosmicKey,
          sourceId,
          mediaType: 'movie',
          imdbId: 'tt1234567',
          confidence: 0.99,
          manualLock: false,
          title: {
            imdbId: 'tt1234567',
            mediaType: 'movie',
            originalTitle: 'Cosmic Drift',
            englishTitle: 'Cosmic Drift',
            localizedTitles: {},
            year: 2024,
            rating: 8.7,
            votes: 120_000,
            runtimeMin: 128,
            genres: ['Sci-Fi'],
            posterUrl: null,
            backdropUrl: 'https://art.example.test/cosmic-backdrop.jpg',
            synopses: { en: 'Two astronauts chart a mysterious signal at the edge of deep space.' },
            director: 'Elena Vance',
            cast: [],
            trailerStreamUrl: 'https://cdn.example.test/cosmic-trailer.mp4',
            trailerYoutubeId: null,
            mltImdbIds: [],
            franchiseKey: null,
            franchiseName: null,
            franchiseOrder: null,
            detailFetchedAt: now,
            updatedAt: now,
          },
        });
      }
      return baseMap;
    },
  };

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

  return {
    catalog,
    baseCatalog,
    videoHost,
    sourceId,
    cosmicKey,
    quietKey,
    async cleanup() {
      await baseCatalog.close();
      handle.close();
    },
  };
}

describe('Wave R3 Desktop Expanded Hover Preview & Dismissal Integration', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('opens root-portal Hover Preview on Desktop after 350ms, triggers Trailer/MyList/Watched/Like/Dismiss, preserves Continue Watching & My List, and auto-dismisses on tab switch', async () => {
    const osReplacer = jest.replaceProperty(Platform, 'OS', 'web');
    const env = await openWaveR3Env();
    let view: Awaited<ReturnType<typeof render>> | undefined;

    try {
      // Save Quiet Harbor to both Continue Watching and My List before launching AppShell
      await env.catalog.saveProgress?.({
        sourceId: env.sourceId,
        itemKey: env.quietKey,
        kind: 'movie',
        title: 'Quiet Harbor',
        positionMs: 120_000,
        durationMs: 600_000,
      });
      await env.catalog.setFavorite?.(
        {
          sourceId: env.sourceId,
          itemKey: env.quietKey,
          kind: 'movie',
          title: 'Quiet Harbor',
          logo: null,
        },
        true,
      );

      view = await render(
        <AppProviders>
          <ViewportProvider
            value={{ formFactor: 'desktop', orientation: 'landscape', inputModality: 'pointer' }}
          >
            <I18nProvider i18n={createAppI18n('en')}>
              <AppShell catalog={env.catalog} videoHost={env.videoHost} />
            </I18nProvider>
          </ViewportProvider>
        </AppProviders>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('home-movies-item-0')).toBeTruthy();
        expect(screen.getByTestId('home-continue-item-0')).toBeTruthy();
        expect(screen.getByTestId('home-mylist-item-0')).toBeTruthy();
      });

      // Switch to fake timers deterministically for hover dwell control
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });

      // < 350ms dwell must NOT open preview, and zero legacy bottom-right quick buttons render
      await fireEvent(screen.getByTestId('home-movies-item-0'), 'pointerEnter');
      expect(screen.queryByTestId('home-movies-item-0-quick-play')).toBeNull();
      expect(screen.queryByTestId('home-movies-item-0-quick-favorite')).toBeNull();
      expect(screen.queryByTestId('home-movies-item-0-quick-watched')).toBeNull();

      await act(async () => {
        jest.advanceTimersByTime(200);
        await Promise.resolve();
      });
      expect(screen.queryByTestId('poster-hover-preview-card')).toBeNull();

      // Reaching 350ms opens expanded card + hydrates trailer, runtime, rating & synopsis
      await act(async () => {
        jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS - 200);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByTestId('poster-hover-preview-card')).toBeTruthy();
      expect(screen.getByTestId('hover-preview-title')).toHaveTextContent('Cosmic Drift');
      expect(screen.getByTestId('hover-preview-play')).toBeTruthy();
      expect(screen.getByTestId('hover-preview-actions-grid')).toBeTruthy();
      expect(screen.getByTestId('hover-preview-meta')).toHaveTextContent(/2024/);
      expect(screen.getByTestId('hover-preview-meta')).toHaveTextContent(/8\.7/);
      expect(screen.getByTestId('hover-preview-synopsis')).toHaveTextContent(/deep space/);

      // My List + Like + Watched inside hover preview persist to SQLite
      await act(async () => {
        await fireEvent.press(screen.getByTestId('hover-preview-mylist'));
        await fireEvent.press(screen.getByTestId('hover-preview-like'));
        await Promise.resolve();
      });

      // Trailer launches DetailTrailerModal directly from hover preview and closes hover card
      await fireEvent.press(screen.getByTestId('hover-preview-trailer'));
      expect(screen.queryByTestId('poster-hover-preview-card')).toBeNull();
      expect(screen.getByTestId('detail-trailer-modal')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('detail-trailer-close'));
      expect(screen.queryByTestId('detail-trailer-modal')).toBeNull();

      // Re-hover Cosmic Drift -> press "Don't recommend again" (ban) -> closes & filters live
      await fireEvent(screen.getByTestId('home-movies-item-0'), 'pointerLeave');
      await fireEvent(screen.getByTestId('home-movies-item-0'), 'pointerEnter');
      await act(async () => {
        jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId('poster-hover-preview-card')).toBeTruthy();

      await act(async () => {
        await fireEvent.press(screen.getByTestId('hover-preview-dismiss'));
        await Promise.resolve();
        await Promise.resolve();
      });

      jest.useRealTimers();

      await waitFor(async () => {
        expect(screen.queryByTestId('poster-hover-preview-card')).toBeNull();
        expect(await env.catalog.listDismissedRecommendationKeys?.()).toEqual([env.cosmicKey]);
        expect(await env.catalog.listFavoriteKeys?.()).toContain(env.cosmicKey);
        expect(await env.catalog.getRating?.(env.cosmicKey)).toBe('like');
      });

      // Home Featured Movies no longer lists Cosmic Drift
      expect(screen.getByTestId('home-movies-item-0').props.accessibilityLabel).not.toContain(
        'Cosmic Drift',
      );

      // Navigate to Movies tab -> Cosmic Drift is also hidden in Movies discovery rail
      await fireEvent.press(screen.getByTestId('nav-tab-movie'));
      await waitFor(() => {
        expect(screen.getByTestId('catalog-screen-movie')).toBeTruthy();
        expect(screen.getByTestId('catalog-rail-0-item-0')).toBeTruthy();
      });
      expect(screen.getByTestId('catalog-rail-0-item-0').props.accessibilityLabel).not.toContain(
        'Cosmic Drift',
      );

      // Hover next card (Quiet Harbor) in Movies -> auto-dismisses when switching tabs to Series
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      await fireEvent(screen.getByTestId('catalog-rail-0-item-0'), 'pointerEnter');
      await act(async () => {
        jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS);
        await Promise.resolve();
      });
      expect(screen.getByTestId('poster-hover-preview-card')).toBeTruthy();
      jest.useRealTimers();

      await fireEvent.press(screen.getByTestId('nav-tab-series'));
      await waitFor(() => {
        expect(screen.getByTestId('catalog-screen-series')).toBeTruthy();
        expect(screen.queryByTestId('poster-hover-preview-card')).toBeNull();
      });

      // Dismiss Quiet Harbor manually and confirm Home Continue Watching & My List preserve it
      await act(async () => {
        await env.catalog.dismissRecommendation?.(env.quietKey, 'movie');
      });
      await fireEvent.press(screen.getByTestId('nav-tab-home'));
      await waitFor(() => {
        expect(screen.getByTestId('home-continue-item-0').props.accessibilityLabel).toContain(
          'Quiet Harbor',
        );
        expect(screen.getByTestId('home-mylist-item-0').props.accessibilityLabel).toContain(
          'Quiet Harbor',
        );
      });
    } finally {
      jest.useRealTimers();
      osReplacer.restore();
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('never opens hover preview on touch mobile and supports "Don\'t recommend again" via long-press context menu while omitting it from Continue Watching & My List', async () => {
    const osReplacer = jest.replaceProperty(Platform, 'OS', 'android');
    const env = await openWaveR3Env();
    let view: Awaited<ReturnType<typeof render>> | undefined;

    try {
      await env.catalog.saveProgress?.({
        sourceId: env.sourceId,
        itemKey: env.quietKey,
        kind: 'movie',
        title: 'Quiet Harbor',
        positionMs: 120_000,
        durationMs: 600_000,
      });
      await env.catalog.setFavorite?.(
        {
          sourceId: env.sourceId,
          itemKey: env.quietKey,
          kind: 'movie',
          title: 'Quiet Harbor',
          logo: null,
        },
        true,
      );

      view = await render(
        <AppProviders>
          <ViewportProvider
            value={{
              formFactor: 'phone',
              orientation: 'portrait',
              inputModality: 'touch',
              width: 390,
              height: 844,
            }}
          >
            <I18nProvider i18n={createAppI18n('en')}>
              <AppShell catalog={env.catalog} videoHost={env.videoHost} />
            </I18nProvider>
          </ViewportProvider>
        </AppProviders>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('home-movies-item-0')).toBeTruthy();
        expect(screen.getByTestId('home-continue-item-0')).toBeTruthy();
        expect(screen.getByTestId('home-mylist-item-0')).toBeTruthy();
      });

      // Pointer hover never activates preview on mobile touch
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      await fireEvent(screen.getByTestId('home-movies-item-0'), 'pointerEnter');
      await act(async () => {
        jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS + 100);
        await Promise.resolve();
      });
      expect(screen.queryByTestId('poster-hover-preview-card')).toBeNull();
      jest.useRealTimers();

      // Long-pressing Continue Watching & My List does NOT expose Don't recommend again
      await fireEvent(screen.getByTestId('home-continue-item-0'), 'longPress');
      await waitFor(() => expect(screen.getByTestId('home-context-resume')).toBeTruthy());
      expect(screen.queryByTestId('home-context-dont-recommend')).toBeNull();
      await fireEvent.press(screen.getByTestId('context-menu-backdrop'));

      await fireEvent(screen.getByTestId('home-mylist-item-0'), 'longPress');
      await waitFor(() => expect(screen.getByTestId('home-context-mylist')).toBeTruthy());
      expect(screen.queryByTestId('home-context-dont-recommend')).toBeNull();
      await fireEvent.press(screen.getByTestId('context-menu-backdrop'));

      // Long-pressing Home Movies exposes home-context-dont-recommend and dismisses live
      const firstTitleBefore = screen.getByTestId('home-movies-item-0').props.accessibilityLabel;
      await fireEvent(screen.getByTestId('home-movies-item-0'), 'longPress');
      await waitFor(() => expect(screen.getByTestId('home-context-dont-recommend')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('home-context-dont-recommend'));

      await waitFor(async () => {
        const dismissed = await env.catalog.listDismissedRecommendationKeys?.();
        expect(dismissed?.length).toBe(1);
        expect(screen.getByTestId('home-movies-item-0').props.accessibilityLabel).not.toBe(
          firstTitleBefore,
        );
      });

      // Switching to Movies tab also exposes context-menu-dont-recommend on discovery rail cards
      await fireEvent.press(screen.getByTestId('nav-tab-movie'));
      await waitFor(() => expect(screen.getByTestId('catalog-rail-0-item-0')).toBeTruthy());
      const secondTitleBefore =
        screen.getByTestId('catalog-rail-0-item-0').props.accessibilityLabel;
      await fireEvent(screen.getByTestId('catalog-rail-0-item-0'), 'longPress');
      await waitFor(() => expect(screen.getByTestId('context-menu-dont-recommend')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('context-menu-dont-recommend'));

      await waitFor(async () => {
        const dismissed = await env.catalog.listDismissedRecommendationKeys?.();
        expect(dismissed?.length).toBe(2);
        expect(screen.getByTestId('catalog-rail-0-item-0').props.accessibilityLabel).not.toBe(
          secondTitleBefore,
        );
      });
    } finally {
      jest.useRealTimers();
      osReplacer.restore();
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('rolls back failed Home Favorite/Watched writes on PosterHoverPreviewCard and omits dismiss on My List & Collections while showing entry overview immediately', async () => {
    const osReplacer = jest.replaceProperty(Platform, 'OS', 'web');
    const env = await openWaveR3Env();
    let view: Awaited<ReturnType<typeof render>> | undefined;

    try {
      await env.catalog.setFavorite?.(
        {
          sourceId: env.sourceId,
          itemKey: env.quietKey,
          kind: 'movie',
          title: 'Quiet Harbor',
          logo: null,
        },
        true,
      );

      const flakyCatalog: CatalogService = {
        ...env.catalog,
        setFavorite: jest.fn(async () => err(elvError('storage', 'disk-full'))),
        toggleFavorite: jest.fn(async () => err(elvError('storage', 'disk-full'))),
        saveProgress: undefined,
        setWatched: jest.fn(async () => err(elvError('storage', 'disk-full'))),
      };

      view = await render(
        <AppProviders>
          <ViewportProvider
            value={{ formFactor: 'desktop', orientation: 'landscape', inputModality: 'pointer' }}
          >
            <I18nProvider i18n={createAppI18n('en')}>
              <AppShell catalog={flakyCatalog} videoHost={env.videoHost} />
            </I18nProvider>
          </ViewportProvider>
        </AppProviders>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('home-movies-item-0')).toBeTruthy();
        expect(screen.getByTestId('home-mylist-item-0')).toBeTruthy();
      });

      // Failed Home Favorite & Watched writes roll back hover preview buttons cleanly
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      await fireEvent(screen.getByTestId('home-movies-item-0'), 'pointerEnter');
      await act(async () => {
        jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId('hover-preview-dismiss')).toBeTruthy();
      expect(screen.getByTestId('hover-preview-mylist').props.accessibilityState?.selected).toBe(
        false,
      );
      expect(screen.getByTestId('hover-preview-watched').props.accessibilityState?.selected).toBe(
        false,
      );

      await act(async () => {
        await fireEvent.press(screen.getByTestId('hover-preview-mylist'));
        await fireEvent.press(screen.getByTestId('hover-preview-watched'));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByTestId('hover-preview-mylist').props.accessibilityState?.selected).toBe(
        false,
      );
      expect(screen.getByTestId('hover-preview-watched').props.accessibilityState?.selected).toBe(
        false,
      );

      // My List hover preview omits Don't recommend again button
      await fireEvent(screen.getByTestId('home-movies-item-0'), 'pointerLeave');
      await fireEvent(screen.getByTestId('home-mylist-item-0'), 'pointerEnter');
      await act(async () => {
        jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS);
        await Promise.resolve();
      });
      expect(screen.getByTestId('poster-hover-preview-card')).toBeTruthy();
      expect(screen.queryByTestId('hover-preview-dismiss')).toBeNull();

      jest.useRealTimers();

      // Movies -> My List quick filter tab ALSO omits Don't recommend again button on hover preview
      await fireEvent.press(screen.getByTestId('nav-tab-movie'));
      await waitFor(() => expect(screen.getByTestId('catalog-filter-mylist')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('catalog-filter-mylist'));
      await waitFor(() => expect(screen.getByTestId('catalog-quick-filter-item-0')).toBeTruthy());

      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      await fireEvent(screen.getByTestId('catalog-quick-filter-item-0'), 'pointerEnter');
      await act(async () => {
        jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS);
        await Promise.resolve();
      });
      expect(screen.getByTestId('poster-hover-preview-card')).toBeTruthy();
      expect(screen.queryByTestId('hover-preview-dismiss')).toBeNull();
    } finally {
      jest.useRealTimers();
      osReplacer.restore();
      await view?.unmount();
      await env.cleanup();
    }
  });
});
