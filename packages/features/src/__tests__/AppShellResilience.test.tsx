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
import { createConnectionTracker } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import { AppProviders, AppShell } from '../index';
import type { VideoHost } from '../ports/video-host';

function jsonBody(payload: unknown): HttpResponse {
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

function makeFakeVideoHost(): VideoHost {
  const engine = createFakePlayerEngine({
    now: () => 10_000,
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  return {
    open: () => ({
      engine,
      renderSurface: () => <View testID="resilience-video-surface" />,
    }),
  };
}

function makeXtreamHttp(opts: {
  shouldFail: () => boolean;
  userInfo: () => Record<string, unknown>;
}): HttpClient {
  return {
    async get(rawUrl) {
      if (opts.shouldFail()) return err(elvError('network', 'http-503'));
      const url = new URL(rawUrl);
      const action = url.searchParams.get('action');
      if (!action) {
        return ok(
          jsonBody({
            user_info: opts.userInfo(),
            server_info: { timezone: 'UTC' },
          }),
        );
      }
      if (action === 'get_live_categories') {
        return ok(jsonBody([{ category_id: '1', category_name: 'News' }]));
      }
      if (action === 'get_live_streams') {
        return ok(
          jsonBody([
            { stream_id: 101, name: 'News One', category_id: '1', num: 1 },
            { stream_id: 102, name: 'News Two', category_id: '1', num: 2 },
          ]),
        );
      }
      return ok(jsonBody([]));
    },
  };
}

describe('AppShell end-to-end resilience wiring (#141 CachedCatalogStrip & #87 ConnectionLimitDialog)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows CachedCatalogStrip when refresh failed over cached rows and hides it after Check again recovers (#141)', async () => {
    const t = testDb();
    await openCatalog(t.db);
    let fail = false;
    const catalog = createCatalogService({
      db: t.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: makeXtreamHttp({
        shouldFail: () => fail,
        userInfo: () => ({
          auth: 1,
          status: 'Active',
          max_connections: '1',
          active_cons: '0',
          allowed_output_formats: ['ts'],
        }),
      }),
      clock: () => 1_000,
      newId: () => 'src-res',
    });

    const added = await catalog.addSource({
      kind: 'xtream',
      name: 'Main',
      server: 'http://panel.example.test',
      username: 'u1',
      password: 'p1',
    });
    if (!added.ok) throw new Error('add failed');
    expect((await catalog.importSource(added.value.id)).ok).toBe(true);

    // Subsequent refresh fails while cached items remain browsable
    fail = true;
    expect((await catalog.importSource(added.value.id)).ok).toBe(false);

    const view = await render(
      <AppProviders preferencesStore={createMemoryPreferencesStore()}>
        <AppShell catalog={catalog} videoHost={makeFakeVideoHost()} />
      </AppProviders>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('cached-catalog-strip')).toBeTruthy();
    });
    expect(screen.getByText('Showing cached catalog — provider refresh failed')).toBeTruthy();

    // Provider recovers -> clicking "Check again" refreshes and hides the strip
    fail = false;
    await fireEvent.press(screen.getByTestId('cached-catalog-retry'));

    await waitFor(() => {
      expect(screen.queryByTestId('cached-catalog-strip')).toBeNull();
    });

    await view.unmount();
    await catalog.close();
  });

  it('triggers ConnectionLimitDialog on pre-flight limit conflict and handles Cancel, Continue anyway, and Stop other stream (#87)', async () => {
    const t = testDb();
    await openCatalog(t.db);
    const catalog = createCatalogService({
      db: t.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: makeXtreamHttp({
        shouldFail: () => false,
        userInfo: () => ({
          auth: 1,
          status: 'Active',
          max_connections: '1',
          active_cons: '1',
          allowed_output_formats: ['ts'],
        }),
      }),
      clock: () => 2_000,
      newId: () => 'src-limit',
    });

    const added = await catalog.addSource({
      kind: 'xtream',
      name: 'Limited',
      server: 'http://panel.example.test',
      username: 'u2',
      password: 'p2',
    });
    if (!added.ok) throw new Error('add failed');
    expect((await catalog.importSource(added.value.id)).ok).toBe(true);
    const sources = await catalog.listSources();
    const accountKey = sources[0]?.credentialFingerprint ?? added.value.id;

    const tracker = createConnectionTracker();
    const view = await render(
      <AppProviders preferencesStore={createMemoryPreferencesStore()}>
        <AppShell catalog={catalog} videoHost={makeFakeVideoHost()} connectionTracker={tracker} />
      </AppProviders>,
    );

    // Wait for Home screen to hydrate with the live channel, then press it to play
    await waitFor(() => {
      expect(screen.getByTestId('home-live-item-0')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('home-live-item-0'));

    // Provider reported 1 active stream (limit 1) -> dialog shows with Cancel & Continue anyway
    await waitFor(() => {
      expect(screen.getByTestId('connection-limit-dialog')).toBeTruthy();
    });
    expect(screen.getByText('The provider reports 1 active streams (limit 1).')).toBeTruthy();
    expect(screen.queryByTestId('connection-limit-stop-other')).toBeNull();

    // Cancel keeps user out of player
    await fireEvent.press(screen.getByTestId('connection-limit-cancel'));
    expect(screen.queryByTestId('connection-limit-dialog')).toBeNull();
    expect(screen.queryByTestId('player-screen')).toBeNull();

    // Now simulate an existing in-app active stream on the same accountKey
    tracker.acquire(accountKey, 'other-in-app-stream');
    await fireEvent.press(screen.getByTestId('home-live-item-0'));

    await waitFor(() => {
      expect(screen.getByTestId('connection-limit-stop-other')).toBeTruthy();
    });

    // Pressing "Stop other stream" releases the old stream, acquires the new one, and opens PlayerScreen
    await fireEvent.press(screen.getByTestId('connection-limit-stop-other'));
    await waitFor(() => {
      expect(screen.getByTestId('player-screen')).toBeTruthy();
    });
    expect(tracker.activeStreamIds(accountKey)).not.toContain('other-in-app-stream');
    expect(tracker.activeCount(accountKey)).toBe(1);

    await view.unmount();
    await catalog.close();
  });
});
