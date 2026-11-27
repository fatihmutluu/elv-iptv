import { type CatalogService, createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { elvError, err, type HttpClient, type HttpResponse, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  createTvRemoteDispatcher,
  I18nProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
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
  return {
    catalog,
    sourceId: added.value.id,
    movies,
    async cleanup() {
      await catalog.close();
      handle.close();
    },
  };
}

async function renderLibrary(
  catalog: CatalogService,
  opts?: {
    readonly isTv?: boolean;
    readonly dispatcher?: ReturnType<typeof createTvRemoteDispatcher>;
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
              onOpenDetail={jest.fn()}
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

describe('Wave P8 Library -> Following Folder-Style Collections (#508)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates an empty collection via top-right CTA (zero Modal), moves starred movie via context menu (excluding it from general Movies), renames, and restores movie to general Movies on delete', async () => {
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

      const view = await renderLibrary(env.catalog);

      await waitFor(() => {
        expect(screen.getByTestId('library-create-collection-btn')).toBeTruthy();
        expect(screen.getByTestId('library-rail-movies')).toBeTruthy();
        expect(screen.getByTestId(`library-card-movies-${m1.key}`)).toBeTruthy();
      });

      // Create empty collection via inline Cinema Quietude modal (zero RN <Modal>)
      await fireEvent.press(screen.getByTestId('library-create-collection-btn'));
      await waitFor(() => {
        expect(screen.getByTestId('library-collection-modal')).toBeTruthy();
      });
      expect(JSON.stringify(view.toJSON())).not.toContain('"type":"Modal"');

      await fireEvent.changeText(screen.getByTestId('library-collection-name-input'), 'Sci-Fi');
      await fireEvent.press(screen.getByTestId('library-collection-modal-confirm'));

      const listed = await env.catalog.listCollections?.();
      const col = listed?.find((c) => c.name === 'Sci-Fi');
      expect(col).toBeDefined();
      if (!col) return;

      // Empty collection renders visibly with empty hint, Rename, and Delete controls
      await waitFor(() => {
        expect(screen.queryByTestId('library-collection-modal')).toBeNull();
        expect(screen.getByTestId(`library-rail-collection-${col.id}`)).toBeTruthy();
        expect(screen.getByTestId(`library-collection-empty-${col.id}`)).toBeTruthy();
        expect(screen.getByTestId(`library-collection-rename-${col.id}`)).toBeTruthy();
        expect(screen.getByTestId(`library-collection-delete-${col.id}`)).toBeTruthy();
      });

      // Move starred movie into Sci-Fi via context menu -> disappears from general Movies rail (which hides when empty)
      await fireEvent(screen.getByTestId(`library-card-movies-${m1.key}`), 'longPress');
      await waitFor(() => {
        expect(screen.getByTestId(`library-context-move-collection-${col.id}`)).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId(`library-context-move-collection-${col.id}`));

      await waitFor(() => {
        expect(screen.queryByTestId('library-rail-movies')).toBeNull();
        expect(screen.getByTestId(`library-card-collection-${col.id}-${m1.key}`)).toBeTruthy();
        expect(screen.queryByTestId(`library-collection-empty-${col.id}`)).toBeNull();
      });

      // Rename collection via inline modal
      await fireEvent.press(screen.getByTestId(`library-collection-rename-${col.id}`));
      await waitFor(() => {
        expect(screen.getByTestId('library-collection-modal')).toBeTruthy();
      });
      await fireEvent.changeText(
        screen.getByTestId('library-collection-name-input'),
        'Space Epics',
      );
      await fireEvent.press(screen.getByTestId('library-collection-modal-confirm'));
      await waitFor(() => {
        expect(screen.getByText('Space Epics')).toBeTruthy();
      });

      // Delete collection -> confirmation modal -> deletes collection, leaves favorites intact, movie returns to general Movies rail!
      await fireEvent.press(screen.getByTestId(`library-collection-delete-${col.id}`));
      await waitFor(() => {
        expect(screen.getByTestId('library-collection-delete-modal')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('library-collection-modal-confirm'));

      await waitFor(() => {
        expect(screen.queryByTestId(`library-rail-collection-${col.id}`)).toBeNull();
        expect(screen.getByTestId('library-rail-movies')).toBeTruthy();
        expect(screen.getByTestId(`library-card-movies-${m1.key}`)).toBeTruthy();
      });
      expect(await env.catalog.listFavoriteKeys?.()).toContain(m1.key);

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('supports web pointer drag-and-drop onto an empty collection section and back to general drop zone', async () => {
    const origOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const listeners = new Map<string, Set<(e: { clientX?: number; clientY?: number }) => void>>();
    const origAdd = (globalThis as Record<string, unknown>).addEventListener;
    const origRemove = (globalThis as Record<string, unknown>).removeEventListener;
    (globalThis as Record<string, unknown>).addEventListener = (
      type: string,
      fn: (e: { clientX?: number; clientY?: number }) => void,
    ) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    };
    (globalThis as Record<string, unknown>).removeEventListener = (
      type: string,
      fn: (e: { clientX?: number; clientY?: number }) => void,
    ) => {
      listeners.get(type)?.delete(fn);
    };

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

      const view = await renderLibrary(env.catalog);
      await waitFor(() => {
        expect(screen.getByTestId(`library-drag-card-movies-${m1.key}`)).toBeTruthy();
        expect(screen.getByTestId(`library-rail-collection-${created.value.id}`)).toBeTruthy();
      });

      // Register drop-zone layout box for the empty collection section
      await fireEvent(screen.getByTestId(`library-rail-collection-${created.value.id}`), 'layout', {
        nativeEvent: { layout: { x: 0, y: 300, width: 1000, height: 150 } },
      });

      // Drag movie card down onto the empty collection section -> drop badge appears -> pointerup moves item
      const dragCard = screen.getByTestId(`library-drag-card-movies-${m1.key}`);
      await act(async () => {
        (dragCard.props.onPointerDown as ((e: unknown) => void) | undefined)?.({
          button: 0,
          clientX: 120,
          clientY: 120,
        });
      });
      await act(async () => {
        for (const fn of listeners.get('pointermove') ?? []) {
          fn({ clientX: 200, clientY: 360 });
        }
      });
      expect(screen.getByTestId(`library-drop-badge-collection-${created.value.id}`)).toBeTruthy();

      await act(async () => {
        for (const fn of listeners.get('pointerup') ?? []) {
          fn({ clientX: 200, clientY: 360 });
        }
      });

      await waitFor(() => {
        expect(screen.queryByTestId('library-rail-movies')).toBeNull();
        expect(
          screen.getByTestId(`library-card-collection-${created.value.id}-${m1.key}`),
        ).toBeTruthy();
      });

      // Drag from collection onto fallback general drop zone -> removes from collection back into Movies
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
      await act(async () => {
        for (const fn of listeners.get('pointermove') ?? []) {
          fn({ clientX: 120, clientY: 340 });
        }
      });
      await waitFor(() => {
        expect(screen.getByTestId('library-dropzone-general')).toBeTruthy();
      });
      await fireEvent(screen.getByTestId('library-dropzone-general'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 120, width: 1000, height: 100 } },
      });
      await act(async () => {
        for (const fn of listeners.get('pointermove') ?? []) {
          fn({ clientX: 200, clientY: 160 });
        }
      });
      expect(screen.getByTestId('library-drop-badge-general')).toBeTruthy();
      await act(async () => {
        for (const fn of listeners.get('pointerup') ?? []) {
          fn({ clientX: 200, clientY: 160 });
        }
      });

      await waitFor(() => {
        expect(screen.getByTestId('library-rail-movies')).toBeTruthy();
        expect(screen.getByTestId(`library-collection-empty-${created.value.id}`)).toBeTruthy();
      });

      await view.unmount();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: origOs, configurable: true });
      (globalThis as Record<string, unknown>).addEventListener = origAdd;
      (globalThis as Record<string, unknown>).removeEventListener = origRemove;
      await env.cleanup();
    }
  });

  it('navigates top-right Create collection CTA and empty collection Rename/Delete controls via 10-ft TV D-pad', async () => {
    const env = await openRealCatalog();
    try {
      const created = await env.catalog.createCollection?.({ name: 'Empty Shelf' });
      expect(created?.ok).toBe(true);
      if (!created?.ok) return;

      const dispatcher = createTvRemoteDispatcher();
      const view = await renderLibrary(env.catalog, { isTv: true, dispatcher });

      await waitFor(() => {
        expect(screen.getByTestId('library-create-collection-btn')).toBeTruthy();
        expect(screen.getByTestId(`library-collection-empty-${created.value.id}`)).toBeTruthy();
      });

      // Up from tabs reaches Create collection CTA -> Select opens inline modal -> Back closes it
      await act(async () => {
        dispatcher.dispatch({ key: 'up', action: 'press', time: 10 }, false);
      });
      await act(async () => {
        dispatcher.dispatch({ key: 'select', action: 'press', time: 20 }, false);
      });
      await waitFor(() => {
        expect(screen.getByTestId('library-collection-modal')).toBeTruthy();
      });
      await act(async () => {
        dispatcher.dispatch({ key: 'back', action: 'press', time: 30 }, false);
      });
      await waitFor(() => {
        expect(screen.queryByTestId('library-collection-modal')).toBeNull();
      });

      // Down from Create CTA returns to tabs -> Down enters empty collection header (Rename col 0) -> Right moves to Delete (col 1) -> Select opens Delete confirmation
      await act(async () => {
        dispatcher.dispatch({ key: 'down', action: 'press', time: 40 }, false);
      });
      await act(async () => {
        dispatcher.dispatch({ key: 'down', action: 'press', time: 50 }, false);
      });
      await act(async () => {
        dispatcher.dispatch({ key: 'right', action: 'press', time: 60 }, false);
      });
      await act(async () => {
        dispatcher.dispatch({ key: 'select', action: 'press', time: 70 }, false);
      });
      await waitFor(() => {
        expect(screen.getByTestId('library-collection-delete-modal')).toBeTruthy();
      });
      await act(async () => {
        dispatcher.dispatch({ key: 'back', action: 'press', time: 80 }, false);
      });
      await waitFor(() => {
        expect(screen.queryByTestId('library-collection-delete-modal')).toBeNull();
      });

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });
});
