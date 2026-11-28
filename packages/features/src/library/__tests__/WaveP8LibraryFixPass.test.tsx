import {
  type CatalogService,
  createCatalogService,
  type FavoriteRow,
  type ItemRow,
  openCatalog,
  type VodCollectionRecord,
} from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { elvError, err, type HttpClient, type HttpResponse, ok, type Result } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  createTvRemoteDispatcher,
  I18nProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';
import { DownloadsProvider } from '../../shared';
import { LibraryScreen } from '../LibraryScreen';

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
            { stream_id: 101, name: 'Dune', category_id: '10', container_extension: 'mp4' },
            { stream_id: 102, name: 'Arrival', category_id: '10', container_extension: 'mp4' },
          ]),
        );
      }
      if (action === 'get_series_categories') {
        return ok(jsonResponse([{ category_id: '20', category_name: 'Drama' }]));
      }
      if (action === 'get_series') {
        return ok(jsonResponse([{ series_id: 201, name: 'Arcane', category_id: '20' }]));
      }
      return ok(jsonResponse([]));
    },
  };
}

async function openRealCatalog() {
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

function installWebGlobals() {
  const origOs = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
  const listeners = new Map<string, Set<(e: Record<string, unknown>) => void>>();
  const origAdd = (globalThis as Record<string, unknown>).addEventListener;
  const origRemove = (globalThis as Record<string, unknown>).removeEventListener;
  (globalThis as Record<string, unknown>).addEventListener = (
    type: string,
    fn: (e: Record<string, unknown>) => void,
  ) => {
    const set = listeners.get(type) ?? new Set();
    set.add(fn);
    listeners.set(type, set);
  };
  (globalThis as Record<string, unknown>).removeEventListener = (
    type: string,
    fn: (e: Record<string, unknown>) => void,
  ) => {
    listeners.get(type)?.delete(fn);
  };
  return {
    listeners,
    dispatch(type: string, event: Record<string, unknown>) {
      for (const fn of [...(listeners.get(type) ?? [])]) {
        fn(event);
      }
    },
    restore() {
      Object.defineProperty(Platform, 'OS', { value: origOs, configurable: true });
      (globalThis as Record<string, unknown>).addEventListener = origAdd;
      (globalThis as Record<string, unknown>).removeEventListener = origRemove;
    },
  };
}

async function renderLibrary(
  catalog: CatalogService,
  opts?: {
    readonly isTv?: boolean;
    readonly dispatcher?: ReturnType<typeof createTvRemoteDispatcher>;
    readonly onOpenDetail?: jest.Mock;
  },
) {
  const isTv = opts?.isTv ?? false;
  const content = (
    <ViewportProvider
      value={{
        width: 1280,
        height: 720,
        formFactor: isTv ? 'tv' : 'desktop',
        inputModality: isTv ? 'tv' : 'pointer',
      }}
    >
      <ThemeProvider reduceMotion>
        <I18nProvider i18n={createAppI18n('en')}>
          <DownloadsProvider>
            <LibraryScreen
              catalog={catalog}
              sources={[]}
              refreshToken={0}
              onPlay={jest.fn()}
              onOpenDetail={opts?.onOpenDetail ?? jest.fn()}
            />
          </DownloadsProvider>
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>
  );
  return render(
    opts?.dispatcher ? (
      <TvRemoteProvider dispatcher={opts.dispatcher}>{content}</TvRemoteProvider>
    ) : (
      content
    ),
  );
}

describe('Wave P8 Library Fix Pass regressions', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('P0 #1: supports 10-ft TV D-pad create & rename (input focus ring, typing, down->confirm), delete failure stays open, and web Escape dismisses cleanly', async () => {
    const env = await openRealCatalog();
    try {
      const dispatcher = createTvRemoteDispatcher();
      const view = await renderLibrary(env.catalog, { isTv: true, dispatcher });

      await waitFor(() => {
        expect(screen.getByTestId('library-empty-following')).toBeTruthy();
        expect(screen.getByTestId('library-create-collection-btn')).toBeTruthy();
      });
      const serializedEmpty = JSON.stringify(view.toJSON());
      expect(serializedEmpty.indexOf('"library-empty-following"')).toBeLessThan(
        serializedEmpty.indexOf('"library-create-collection-btn"'),
      );

      // Down from empty Following tabs -> bottom Create collection trigger -> Select opens Create modal with input slot focused
      await act(async () => {
        dispatcher.dispatch({ key: 'down', action: 'press', time: 10 }, false);
      });
      await act(async () => {
        dispatcher.dispatch({ key: 'select', action: 'press', time: 20 }, false);
      });
      await waitFor(() => {
        expect(screen.getByTestId('library-collection-modal')).toBeTruthy();
      });

      const wrapperStyle = StyleSheet.flatten(
        screen.getByTestId('library-collection-name-input-wrapper').props.style,
      );
      expect(wrapperStyle.borderWidth).toBeGreaterThan(1);

      // Select on focused input slot invokes input focus, typing + Down + Select creates collection
      await act(async () => {
        dispatcher.dispatch({ key: 'select', action: 'press', time: 30 }, false);
      });
      await fireEvent.changeText(screen.getByTestId('library-collection-name-input'), 'TV Shelf');
      await act(async () => {
        dispatcher.dispatch({ key: 'down', action: 'press', time: 40 }, false);
      });
      await act(async () => {
        dispatcher.dispatch({ key: 'select', action: 'press', time: 50 }, false);
      });

      await waitFor(() => {
        expect(screen.queryByTestId('library-collection-modal')).toBeNull();
        expect(screen.getByText('TV Shelf')).toBeTruthy();
      });
      const created = (await env.catalog.listCollections?.())?.find((c) => c.name === 'TV Shelf');
      expect(created).toBeDefined();
      if (!created) return;

      // Up from bottom Create collection trigger returns directly to TV Shelf collection actions (Rename col 0) -> Select opens Rename modal
      await act(async () => {
        dispatcher.dispatch({ key: 'up', action: 'press', time: 60 }, false);
      });
      await act(async () => {
        dispatcher.dispatch({ key: 'select', action: 'press', time: 80 }, false);
      });
      await waitFor(() => {
        expect(screen.getByTestId('library-collection-modal')).toBeTruthy();
      });

      // Down to actions -> Up back to input -> edit -> Down -> Select saves renamed collection
      await act(async () => {
        dispatcher.dispatch({ key: 'down', action: 'press', time: 90 }, false);
      });
      await act(async () => {
        dispatcher.dispatch({ key: 'up', action: 'press', time: 100 }, false);
      });
      await act(async () => {
        dispatcher.dispatch({ key: 'select', action: 'press', time: 110 }, false);
      });
      await fireEvent.changeText(screen.getByTestId('library-collection-name-input'), 'TV Cinema');
      await act(async () => {
        dispatcher.dispatch({ key: 'down', action: 'press', time: 120 }, false);
      });
      await act(async () => {
        dispatcher.dispatch({ key: 'select', action: 'press', time: 130 }, false);
      });

      await waitFor(() => {
        expect(screen.queryByTestId('library-collection-modal')).toBeNull();
        expect(screen.getByText('TV Cinema')).toBeTruthy();
      });

      // Delete failure keeps delete modal open cleanly
      const deleteSpy = jest
        .spyOn(env.catalog, 'deleteCollection')
        .mockResolvedValueOnce(err(elvError('storage', 'db-busy')));
      await act(async () => {
        dispatcher.dispatch({ key: 'right', action: 'press', time: 140 }, false);
      });
      await act(async () => {
        dispatcher.dispatch({ key: 'select', action: 'press', time: 150 }, false);
      });
      await waitFor(() => {
        expect(screen.getByTestId('library-collection-delete-modal')).toBeTruthy();
      });
      await act(async () => {
        dispatcher.dispatch({ key: 'select', action: 'press', time: 160 }, false);
      });
      await waitFor(() => {
        expect(deleteSpy).toHaveBeenCalledTimes(1);
      });
      expect(screen.getByTestId('library-collection-delete-modal')).toBeTruthy();

      await view.unmount();

      // Desktop web Escape key dismisses modal and removes keydown listener
      const web = installWebGlobals();
      try {
        const webView = await renderLibrary(env.catalog);
        await fireEvent.press(await screen.findByTestId('library-create-collection-btn'));
        await waitFor(() => {
          expect(screen.getByTestId('library-collection-modal')).toBeTruthy();
        });
        expect(web.listeners.get('keydown')?.size ?? 0).toBe(1);

        await act(async () => {
          web.dispatch('keydown', { key: 'Escape', preventDefault: jest.fn() });
        });
        await waitFor(() => {
          expect(screen.queryByTestId('library-collection-modal')).toBeNull();
        });
        expect(web.listeners.get('keydown')?.size ?? 0).toBe(0);

        await webView.unmount();
      } finally {
        web.restore();
      }
    } finally {
      await env.cleanup();
    }
  });

  it('P1 #9: registers distinct general drop targets for both Series and Movies when both are non-empty', async () => {
    const web = installWebGlobals();
    const env = await openRealCatalog();
    try {
      const m1 = env.movies[0];
      const m2 = env.movies[1];
      const s1 = env.series[0];
      expect(m1 && m2 && s1).toBeTruthy();
      if (!m1 || !m2 || !s1) return;

      for (const row of [m1, m2, s1]) {
        await env.catalog.setFavorite?.(
          {
            sourceId: env.sourceId,
            itemKey: row.key,
            kind: row.kind === 'series' ? 'series' : 'movie',
            title: row.name,
            logo: row.logo,
            year: row.year,
            rating: row.rating,
          },
          true,
        );
      }
      const created = await env.catalog.createCollection?.({ name: 'Sci-Fi' });
      expect(created?.ok).toBe(true);
      if (!created?.ok) return;
      await env.catalog.addItemToCollection?.(created.value.id, m1.key, 'movie');

      const view = await renderLibrary(env.catalog);
      await waitFor(() => {
        expect(screen.getByTestId('library-rail-series')).toBeTruthy();
        expect(screen.getByTestId('library-rail-movies')).toBeTruthy();
        expect(
          screen.getByTestId(`library-drag-card-collection-${created.value.id}-${m1.key}`),
        ).toBeTruthy();
      });

      await fireEvent(screen.getByTestId('library-rail-series'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 100, width: 1000, height: 120 } },
      });
      await fireEvent(screen.getByTestId('library-rail-movies'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 260, width: 1000, height: 120 } },
      });

      // Drag collected movie upward onto the general Movies rail (while Series is also non-empty!)
      const dragCard = screen.getByTestId(
        `library-drag-card-collection-${created.value.id}-${m1.key}`,
      );
      await act(async () => {
        (dragCard.props.onPointerDown as ((e: unknown) => void) | undefined)?.({
          button: 0,
          clientX: 120,
          clientY: 460,
        });
      });
      await act(async () => {
        web.dispatch('pointermove', { clientX: 130, clientY: 310 });
      });

      expect(screen.getByTestId('library-drop-badge-movies')).toBeTruthy();
      expect(screen.queryByTestId('library-drop-badge-series')).toBeNull();

      await act(async () => {
        web.dispatch('pointerup', { clientX: 130, clientY: 310 });
      });

      await waitFor(() => {
        expect(screen.getByTestId(`library-card-movies-${m1.key}`)).toBeTruthy();
        expect(screen.getByTestId(`library-collection-empty-${created.value.id}`)).toBeTruthy();
      });

      await view.unmount();
    } finally {
      web.restore();
      await env.cleanup();
    }
  });

  it('P1 #10: Likes and Watched context menus show Remove from collection and exclude current collection from Move to', async () => {
    const env = await openRealCatalog();
    try {
      const m1 = env.movies[0];
      expect(m1).toBeDefined();
      if (!m1) return;

      const c1 = await env.catalog.createCollection?.({ name: 'Sci-Fi' });
      const c2 = await env.catalog.createCollection?.({ name: 'Weekend' });
      expect(c1?.ok && c2?.ok).toBe(true);
      if (!c1?.ok || !c2?.ok) return;

      await env.catalog.addItemToCollection?.(c1.value.id, m1.key, 'movie');
      await env.catalog.setRating?.(
        {
          sourceId: env.sourceId,
          itemKey: m1.key,
          kind: 'movie',
          title: m1.name,
          logo: m1.logo,
          year: m1.year,
          rating: m1.rating,
        },
        'like',
      );
      await env.catalog.setWatched?.(m1.key, true);

      const view = await renderLibrary(env.catalog);

      // Likes tab -> long-press collected movie
      await fireEvent.press(await screen.findByTestId('library-tab-likes'));
      await waitFor(() => {
        expect(screen.getByTestId(`library-card-liked-movies-${m1.key}`)).toBeTruthy();
      });
      await fireEvent(screen.getByTestId(`library-card-liked-movies-${m1.key}`), 'longPress');
      await waitFor(() => {
        expect(screen.getByTestId('library-context-remove-collection')).toBeTruthy();
        expect(screen.getByTestId(`library-context-move-collection-${c2.value.id}`)).toBeTruthy();
      });
      expect(screen.queryByTestId(`library-context-move-collection-${c1.value.id}`)).toBeNull();
      await fireEvent.press(screen.getByTestId('context-menu-backdrop'));
      await fireEvent.press(screen.getByTestId('library-tab-watched'));

      // Watched tab -> long-press collected movie
      await waitFor(() => {
        expect(screen.getByTestId(`library-card-watched-movies-${m1.key}`)).toBeTruthy();
      });
      await fireEvent(screen.getByTestId(`library-card-watched-movies-${m1.key}`), 'longPress');
      await waitFor(() => {
        expect(screen.getByTestId('library-context-remove-collection')).toBeTruthy();
        expect(screen.getByTestId(`library-context-move-collection-${c2.value.id}`)).toBeTruthy();
      });
      expect(screen.queryByTestId(`library-context-move-collection-${c1.value.id}`)).toBeNull();

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('P1 #11: horizontal drag does not start folder drag, vertical drag suppresses synthetic onPress, and unmount cleans up listeners', async () => {
    const web = installWebGlobals();
    const env = await openRealCatalog();
    try {
      const m1 = env.movies[0];
      expect(m1).toBeDefined();
      if (!m1) return;

      await env.catalog.setFavorite?.(
        {
          sourceId: env.sourceId,
          itemKey: m1.key,
          kind: 'movie',
          title: m1.name,
          logo: m1.logo,
          year: m1.year,
          rating: m1.rating,
        },
        true,
      );
      const created = await env.catalog.createCollection?.({ name: 'Watchlist' });
      expect(created?.ok).toBe(true);
      if (!created?.ok) return;

      const onOpenDetail = jest.fn();
      const view = await renderLibrary(env.catalog, { onOpenDetail });

      await waitFor(() => {
        expect(screen.getByTestId(`library-drag-card-movies-${m1.key}`)).toBeTruthy();
        expect(screen.getByTestId(`library-rail-collection-${created.value.id}`)).toBeTruthy();
      });

      await fireEvent(screen.getByTestId(`library-rail-collection-${created.value.id}`), 'layout', {
        nativeEvent: { layout: { x: 0, y: 300, width: 1000, height: 150 } },
      });

      // Horizontal-dominant movement cancels pending folder drag so rail scrolling wins
      const dragCard = screen.getByTestId(`library-drag-card-movies-${m1.key}`);
      await act(async () => {
        (dragCard.props.onPointerDown as ((e: unknown) => void) | undefined)?.({
          button: 0,
          clientX: 120,
          clientY: 120,
        });
      });
      await act(async () => {
        web.dispatch('pointermove', { clientX: 180, clientY: 122 });
      });
      expect(web.listeners.get('pointermove')?.size ?? 0).toBe(0);
      expect(screen.queryByTestId(`library-drop-badge-collection-${created.value.id}`)).toBeNull();

      // Vertical-dominant drag activates, moves item, and suppresses immediate synthetic onPress
      await act(async () => {
        (dragCard.props.onPointerDown as ((e: unknown) => void) | undefined)?.({
          button: 0,
          clientX: 120,
          clientY: 120,
        });
      });
      await act(async () => {
        web.dispatch('pointermove', { clientX: 125, clientY: 360 });
      });
      expect(screen.getByTestId(`library-drop-badge-collection-${created.value.id}`)).toBeTruthy();
      await act(async () => {
        web.dispatch('pointerup', { clientX: 125, clientY: 360 });
      });

      await waitFor(() => {
        expect(
          screen.getByTestId(`library-card-collection-${created.value.id}-${m1.key}`),
        ).toBeTruthy();
      });

      // Synthetic click right after folder drag must be suppressed
      await fireEvent.press(
        screen.getByTestId(`library-card-collection-${created.value.id}-${m1.key}`),
      );
      expect(onOpenDetail).not.toHaveBeenCalled();

      // Unmounting mid-drag removes all global window listeners cleanly
      const colDragCard = screen.getByTestId(
        `library-drag-card-collection-${created.value.id}-${m1.key}`,
      );
      await act(async () => {
        (colDragCard.props.onPointerDown as ((e: unknown) => void) | undefined)?.({
          button: 0,
          clientX: 120,
          clientY: 360,
        });
      });
      expect(web.listeners.get('pointermove')?.size ?? 0).toBe(1);
      await view.unmount();
      expect(web.listeners.get('pointermove')?.size ?? 0).toBe(0);
      expect(web.listeners.get('pointerup')?.size ?? 0).toBe(0);
      expect(web.listeners.get('pointercancel')?.size ?? 0).toBe(0);
      expect(web.listeners.get('blur')?.size ?? 0).toBe(0);
    } finally {
      web.restore();
      await env.cleanup();
    }
  });

  it('P1 #12: concurrent collection mutations do not clobber each other and DB failure re-syncs without rolling back a later succeeded mutation', async () => {
    const col1: VodCollectionRecord = {
      id: 'col-1',
      profileId: 'default',
      name: 'Sci-Fi',
      sortOrder: 0,
      itemCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const col2: VodCollectionRecord = {
      id: 'col-2',
      profileId: 'default',
      name: 'Weekend',
      sortOrder: 1,
      itemCount: 0,
      createdAt: 2,
      updatedAt: 2,
    };
    const movieRow: ItemRow = {
      id: 1,
      key: 'movie:s1:1',
      sourceId: 's1',
      providerId: '1',
      kind: 'movie',
      name: 'Dune',
      logo: null,
      num: null,
      year: 2021,
      rating: 8.1,
    };
    const favorites: FavoriteRow[] = [
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: movieRow.key,
        kind: 'movie',
        title: movieRow.name,
        logo: null,
        year: 2021,
        rating: 8.1,
        addedAt: 100,
      },
    ];

    let dbCol2Items: ItemRow[] = [];
    let resolveRename!: (res: Result<VodCollectionRecord>) => void;
    let resolveMove!: (res: Result<void>) => void;

    const catalog = {
      listFavorites: jest.fn(async () => favorites),
      listRatings: jest.fn(async () => []),
      listWatched: jest.fn(async () => []),
      listMyListNewEpisodes: jest.fn(async () => []),
      listCollections: jest.fn(async () => [col1, { ...col2, itemCount: dbCol2Items.length }]),
      listCollectionItems: jest.fn(async (id: string) => (id === 'col-2' ? dbCol2Items : [])),
      createCollection: jest.fn(),
      renameCollection: jest.fn(
        () =>
          new Promise<Result<VodCollectionRecord>>((resolve) => {
            resolveRename = resolve;
          }),
      ),
      addItemToCollection: jest.fn(
        () =>
          new Promise<Result<void>>((resolve) => {
            resolveMove = resolve;
          }),
      ),
      deleteCollection: jest.fn(async () => ok(undefined)),
      removeItemFromCollection: jest.fn(async () => ok(undefined)),
    } as unknown as CatalogService;

    const view = await renderLibrary(catalog);

    await waitFor(() => {
      expect(screen.getByText('Sci-Fi')).toBeTruthy();
      expect(screen.getByText('Weekend')).toBeTruthy();
      expect(screen.getByTestId(`library-card-movies-${movieRow.key}`)).toBeTruthy();
    });

    // Mutation 1 (in-flight): rename col-1 to "Broken Rename"
    await fireEvent.press(screen.getByTestId('library-collection-rename-col-1'));
    await fireEvent.changeText(
      screen.getByTestId('library-collection-name-input'),
      'Broken Rename',
    );
    await fireEvent.press(screen.getByTestId('library-collection-modal-confirm'));
    expect(screen.getByText('Broken Rename')).toBeTruthy();

    // Dismiss modal backdrop so we can trigger Mutation 2 concurrently while Mutation 1 is still pending
    await fireEvent.press(screen.getByTestId('library-collection-modal-backdrop'));

    // Mutation 2 (concurrent): move Dune into col-2
    await fireEvent(screen.getByTestId(`library-card-movies-${movieRow.key}`), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('library-context-move-collection-col-2')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('library-context-move-collection-col-2'));

    // Both optimistic updates coexist without clobbering each other
    await waitFor(() => {
      expect(screen.getByText('Broken Rename')).toBeTruthy();
      expect(screen.getByTestId(`library-card-collection-col-2-${movieRow.key}`)).toBeTruthy();
    });

    // Mutation 2 succeeds in DB first
    dbCol2Items = [movieRow];
    await act(async () => {
      resolveMove(ok(undefined));
    });

    // Mutation 1 fails in DB -> re-syncs from catalog: col-1 restores "Sci-Fi", col-2 KEEPS Dune!
    await act(async () => {
      resolveRename(err(elvError('storage', 'rename-failed')));
    });

    await waitFor(() => {
      expect(screen.getByText('Sci-Fi')).toBeTruthy();
      expect(screen.queryByText('Broken Rename')).toBeNull();
      expect(screen.getByTestId(`library-card-collection-col-2-${movieRow.key}`)).toBeTruthy();
    });

    await view.unmount();
  });

  it('P2: resetFocus resets tvZone back to tabs when switching sub-tabs', async () => {
    const env = await openRealCatalog();
    try {
      const m1 = env.movies[0];
      expect(m1).toBeDefined();
      if (!m1) return;

      await env.catalog.setFavorite?.(
        {
          sourceId: env.sourceId,
          itemKey: m1.key,
          kind: 'movie',
          title: m1.name,
          logo: m1.logo,
          year: m1.year,
          rating: m1.rating,
        },
        true,
      );

      const dispatcher = createTvRemoteDispatcher();
      const view = await renderLibrary(env.catalog, { isTv: true, dispatcher });

      await waitFor(() => {
        expect(screen.getByTestId('library-rail-movies')).toBeTruthy();
      });

      // Move TV focus down into content zone
      await act(async () => {
        dispatcher.dispatch({ key: 'down', action: 'press', time: 10 }, false);
      });

      // Switch tab via EditorialCategoryBar (triggers tv.resetFocus())
      await fireEvent.press(screen.getByTestId('library-tab-likes'));
      await waitFor(() => {
        expect(screen.getByTestId('library-empty-likes')).toBeTruthy();
      });

      // Right arrow should advance from Likes -> Watched tab because tvZone was reset to 'tabs'
      await act(async () => {
        dispatcher.dispatch({ key: 'right', action: 'press', time: 20 }, false);
      });
      await waitFor(() => {
        expect(screen.getByTestId('library-empty-watched')).toBeTruthy();
      });

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });
});
