import { createCatalogService, openCatalog, type SourceRow } from '@elv/data';
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
import { createConnectionTracker, type PlaybackService, type PlaybackTimers } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useRef } from 'react';
import { View } from 'react-native';
import { useShellPlaybackModes } from '../../app-shell-desktop';
import { AppProviders, AppShell } from '../../index';
import type { DesktopWindowPort, PopoutDockPayload } from '../../ports/desktop-window-host';
import type { PlayTarget } from '../../ports/play-target';
import type { AdoptedPlaybackSession, OpenVideoEngine, VideoHost } from '../../ports/video-host';
import type { ExternalPlayerPort } from '../../ports/wave-f7b-ports';
import { MultiViewStage } from '../MultiViewStage';
import { PlayerScreen } from '../PlayerScreen';
import { type MultiViewSessionHandle, useMultiViewSession } from '../useMultiViewSession';

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

function createSingleConnectionHttp(activeCons = '1'): HttpClient {
  return {
    async get(rawUrl) {
      const url = new URL(rawUrl);
      if (url.pathname !== '/player_api.php') return err(elvError('network', 'http-404'));
      const action = url.searchParams.get('action');
      if (!action) {
        return ok(
          jsonResponse({
            user_info: {
              auth: 1,
              status: 'Active',
              max_connections: '1',
              active_cons: activeCons,
              allowed_output_formats: ['m3u8'],
            },
            server_info: { timezone: 'UTC' },
          }),
        );
      }
      if (action === 'get_live_categories') {
        return ok(jsonResponse([{ category_id: '1', category_name: 'News' }]));
      }
      if (action === 'get_live_streams') {
        return ok(
          jsonResponse([
            { stream_id: 101, name: 'Alpha News', category_id: '1', num: 1 },
            { stream_id: 102, name: 'Beta Sports', category_id: '1', num: 2 },
          ]),
        );
      }
      return ok(jsonResponse([]));
    },
  };
}

async function createSeededSingleConnEnv(activeCons = '1') {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) throw new Error('migrate failed');
  let now = 1_700_000_000_000;
  let idSeq = 0;
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: createSingleConnectionHttp(activeCons),
    clock: () => {
      now += 10;
      return now;
    },
    newId: () => `src-${++idSeq}`,
  });
  const s1 = await catalog.addSource({
    kind: 'xtream',
    name: 'SingleConn',
    server: 'http://single.example.test:8080',
    username: 'u1',
    password: ['p', '1'].join(''),
  });
  if (!s1.ok) throw new Error('s1 failed');
  await catalog.importSource(s1.value.id);
  return {
    catalog,
    async cleanup() {
      await catalog.close();
      handle.close();
    },
  };
}

function createTrackedOpenedEngine(hostEngineId?: string, parkImpl?: () => Promise<string | null>) {
  const fake = createFakePlayerEngine({
    now: () => performance.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const loadSpy = jest.spyOn(fake, 'load');
  const stopSpy = jest.spyOn(fake, 'stop');
  const releaseSpy = jest.spyOn(fake, 'release');
  const parkForTransfer =
    parkImpl !== undefined
      ? jest.fn(parkImpl)
      : hostEngineId !== undefined
        ? jest.fn(async () => hostEngineId)
        : undefined;
  const opened: OpenVideoEngine = {
    engine: fake,
    overlayMode: 'floating',
    ...(hostEngineId !== undefined ? { hostEngineId } : {}),
    ...(parkForTransfer !== undefined ? { parkForTransfer } : {}),
    setMuted: jest.fn(),
    toggleMute: jest.fn(),
    setVolume: jest.fn(),
    setPrimary: jest.fn(),
    renderSurface: ({ testID }) => <View testID={testID ?? 'p3-fix-surface'} />,
  };
  return { opened, fake, loadSpy, stopSpy, releaseSpy, parkForTransfer };
}

function ModesCleanupHarness({
  onReady,
}: {
  readonly onReady: (modes: ReturnType<typeof useShellPlaybackModes>) => void;
}) {
  const stopActivePlayerRef = useRef<(() => Promise<void>) | null>(null);
  const playTargetRef = useRef<PlayTarget | null>(null);
  onReady(
    useShellPlaybackModes({
      videoHost: { open: () => null, supportsMultiView: true },
      stopActivePlayerRef,
      minimizeToTray: false,
      backgroundAudioPlayback: false,
      playTargetRef,
      onStopActivePlayback: () => undefined,
      onRequestPlay: () => undefined,
      onAdoptPlay: () => undefined,
    }),
  );
  return <View />;
}

function MultiViewSessionHarness({
  videoHost,
  tracker,
  sources,
  initialSeed,
  onReady,
}: {
  readonly videoHost: VideoHost;
  readonly tracker: ReturnType<typeof createConnectionTracker>;
  readonly sources: readonly SourceRow[];
  readonly initialSeed: {
    readonly itemKey: string;
    readonly sourceId: string;
    readonly title: string;
    readonly kind: 'live';
  };
  readonly onReady: (session: MultiViewSessionHandle) => void;
}) {
  onReady(
    useMultiViewSession({
      catalog: {
        resolveStream: async () =>
          ok({
            url: 'http://sim.example.test/a.m3u8',
            kind: 'live' as const,
            headers: {},
          }),
      },
      videoHost,
      tracker,
      sources,
      initialSeed,
    }),
  );
  return <View />;
}

describe('Wave P3 review regression fixes', () => {
  it('bypasses ConnectionLimitDialog & external player on zero-reload Multi-View, Dock, and Popout-failure handoffs when providerActiveCons >= maxConnections (#2)', async () => {
    const env = await createSeededSingleConnEnv('1');
    const tracker = createConnectionTracker();
    const prefsStore = createMemoryPreferencesStore({
      externalPlayerMode: 'always',
    });
    const openedEngines: Array<ReturnType<typeof createTrackedOpenedEngine>> = [];
    const openSpy = jest.fn(() => {
      const tracked = createTrackedOpenedEngine(`eng-${openedEngines.length + 1}`);
      openedEngines.push(tracked);
      return tracked.opened;
    });
    const adoptEngine = jest.fn(async (id: string) => {
      const found = openedEngines.find((e) => e.opened.hostEngineId === id);
      return found?.opened ?? null;
    });
    const videoHost: VideoHost = { open: openSpy, adoptEngine, supportsMultiView: true };

    let dockedCb: ((payload: PopoutDockPayload) => void) | undefined;
    let popoutShouldSucceed = false;
    const openPopout = jest.fn(async () => popoutShouldSucceed);
    const desktopWindow: DesktopWindowPort = {
      openPopout,
      onPopoutDocked: (cb) => {
        dockedCb = cb;
        return () => {
          dockedCb = undefined;
        };
      },
    };
    const launchExternal = jest.fn(async () => ({ launched: true }));
    const externalPlayer: ExternalPlayerPort = {
      isSupported: true,
      launch: launchExternal,
    };

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <AppProviders preferencesStore={prefsStore}>
          <FormFactorProvider value="desktop">
            <ViewportProvider
              value={{
                formFactor: 'desktop',
                orientation: 'landscape',
                inputModality: 'pointer',
                width: 1280,
                height: 800,
              }}
            >
              <I18nProvider i18n={createAppI18n('en')}>
                <AppShell
                  catalog={env.catalog}
                  videoHost={videoHost}
                  connectionTracker={tracker}
                  desktopWindow={desktopWindow}
                  externalPlayer={externalPlayer}
                />
              </I18nProvider>
            </ViewportProvider>
          </FormFactorProvider>
        </AppProviders>,
      );

      await waitFor(() => expect(screen.getByTestId('home-live-item-0')).toBeTruthy());

      // Seed an active integrated player by docking with transferEngineId — must bypass BOTH
      // ConnectionLimitDialog (providerActiveCons=1, maxConnections=1) AND externalPlayer!
      const eng1 = createTrackedOpenedEngine('eng-dock-1');
      openedEngines.push(eng1);
      await act(async () => {
        dockedCb?.({
          itemKey: 'live:src-1:101',
          kind: 'live',
          title: 'Alpha News',
          sourceId: 'src-1',
          positionMs: 0,
          transferEngineId: 'eng-dock-1',
        });
      });

      await waitFor(() => expect(screen.getByTestId('player-multiview-button')).toBeTruthy());
      expect(screen.queryByTestId('connection-limit-dialog')).toBeNull();
      expect(launchExternal).not.toHaveBeenCalled();
      expect(adoptEngine).toHaveBeenCalledWith('eng-dock-1');
      expect(openSpy).not.toHaveBeenCalled();

      // Player -> Multi-View with providerActiveCons = 1, maxConnections = 1: must adopt Tile 1 cleanly!
      await fireEvent.press(screen.getByTestId('player-multiview-button'));
      await waitFor(() => expect(screen.getByTestId('multiview-stage')).toBeTruthy());
      await waitFor(() => expect(screen.getByTestId('multiview-tile-0')).toBeTruthy());
      expect(screen.queryByTestId('multiview-banner-connection-limit')).toBeNull();
      expect(eng1.releaseSpy).not.toHaveBeenCalled();

      // Multi-View -> Player exit: must bypass ConnectionLimitDialog & externalPlayer!
      await fireEvent.press(screen.getByTestId('multiview-exit-button'));
      await waitFor(() => expect(screen.getByTestId('player-popout-button')).toBeTruthy());
      expect(screen.queryByTestId('connection-limit-dialog')).toBeNull();
      expect(launchExternal).not.toHaveBeenCalled();
      expect(eng1.releaseSpy).not.toHaveBeenCalled();

      // Popout detach when openPopout returns false: fallback re-adopts transferEngineId with NO dialog!
      popoutShouldSucceed = false;
      await fireEvent.press(screen.getByTestId('player-popout-button'));
      await waitFor(() => expect(openPopout).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(adoptEngine).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByTestId('player-osd')).toBeTruthy());
      expect(screen.queryByTestId('connection-limit-dialog')).toBeNull();
      expect(launchExternal).not.toHaveBeenCalled();
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('defensively disposes an unconsumed pendingAdoptedSession if replaced or unmounted (#2)', async () => {
    const tracked = createTrackedOpenedEngine('eng-unconsumed');
    const stop = jest.fn();
    const dispose = jest.fn();
    const fakeService = { stop, dispose } as unknown as PlaybackService;
    const adopted: AdoptedPlaybackSession = {
      opened: tracked.opened,
      service: fakeService,
      target: {
        itemKey: 'live:src-1:101',
        sourceId: 'src-1',
        title: 'Alpha News',
        kind: 'live',
      },
      muted: false,
      volume: 80,
    };

    let modesRef: ReturnType<typeof useShellPlaybackModes> | undefined;
    const view = await render(
      <ModesCleanupHarness
        onReady={(m) => {
          modesRef = m;
        }}
      />,
    );
    await act(async () => {
      modesRef?.exitMultiView(adopted.target, adopted);
    });
    expect(stop).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(tracked.releaseSpy).not.toHaveBeenCalled();

    // Unmount without any PlayerScreen ever consuming the pendingAdoptedSession -> must clean up!
    await view.unmount();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(tracked.releaseSpy).toHaveBeenCalledTimes(1);
  });

  it('cleanly releases an already-active Main PlayerScreen and adopts the docked Popout engine (#4)', async () => {
    const env = await createSeededSingleConnEnv('0');
    const tracker = createConnectionTracker();
    const mainEngine = createTrackedOpenedEngine('eng-main-1');
    const popoutEngine = createTrackedOpenedEngine('eng-popout-2');
    const openSpy = jest.fn(() => mainEngine.opened);
    const adoptEngine = jest.fn(async (id: string) =>
      id === 'eng-popout-2' ? popoutEngine.opened : null,
    );
    const videoHost: VideoHost = { open: openSpy, adoptEngine, supportsMultiView: true };

    let dockedCb: ((payload: PopoutDockPayload) => void) | undefined;
    const desktopWindow: DesktopWindowPort = {
      openPopout: async () => true,
      onPopoutDocked: (cb) => {
        dockedCb = cb;
        return () => {
          dockedCb = undefined;
        };
      },
    };

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <AppProviders>
          <FormFactorProvider value="desktop">
            <ViewportProvider
              value={{
                formFactor: 'desktop',
                orientation: 'landscape',
                inputModality: 'pointer',
                width: 1280,
                height: 800,
              }}
            >
              <I18nProvider i18n={createAppI18n('en')}>
                <AppShell
                  catalog={env.catalog}
                  videoHost={videoHost}
                  connectionTracker={tracker}
                  desktopWindow={desktopWindow}
                />
              </I18nProvider>
            </ViewportProvider>
          </FormFactorProvider>
        </AppProviders>,
      );

      // Start Channel 1 in Main window PlayerScreen
      await waitFor(() => expect(screen.getByTestId('home-live-item-0')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('home-live-item-0'));
      await waitFor(() => expect(screen.getByTestId('player-osd')).toBeTruthy());
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(mainEngine.releaseSpy).not.toHaveBeenCalled();

      // Now Popout docks Channel 2 with transferEngineId while Main's PlayerScreen is STILL active!
      await act(async () => {
        dockedCb?.({
          itemKey: 'live:src-1:102',
          kind: 'live',
          title: 'Beta Sports',
          sourceId: 'src-1',
          positionMs: 0,
          transferEngineId: 'eng-popout-2',
        });
      });

      await waitFor(() => expect(adoptEngine).toHaveBeenCalledWith('eng-popout-2'));
      await waitFor(() => expect(screen.getByText('Beta Sports')).toBeTruthy());
      // Prior Main engine MUST have been released, and no fresh open() should happen!
      expect(mainEngine.releaseSpy).toHaveBeenCalledTimes(1);
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(popoutEngine.loadSpy).not.toHaveBeenCalled();
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('disposes donor PlaybackService timers on parked Popout transfer without calling engine.stop or engine.release (#6)', async () => {
    const activeTimers = new Map<number, () => void>();
    let timerSeq = 0;
    const clearTimeoutSpy = jest.fn((handle: unknown) => {
      activeTimers.delete(handle as number);
    });
    const timers: PlaybackTimers = {
      setTimeout: (fn) => {
        const id = ++timerSeq;
        activeTimers.set(id, fn);
        return id;
      },
      clearTimeout: clearTimeoutSpy,
    };
    const tracked = createTrackedOpenedEngine('eng-park-6');
    const videoHost: VideoHost = { open: () => tracked.opened };
    const onPopoutPlayer = jest.fn();
    // Keep resolveStream pending so PlaybackService arms its resolveTimeout timer!
    const catalog = {
      resolveStream: jest.fn(() => new Promise<never>(() => undefined)),
      getProgress: async () => null,
      saveProgress: async () => ok({} as never),
    };

    const view = await render(
      <FormFactorProvider value="desktop">
        <ViewportProvider
          value={{
            formFactor: 'desktop',
            orientation: 'landscape',
            inputModality: 'pointer',
            width: 1280,
            height: 720,
          }}
        >
          <I18nProvider i18n={createAppI18n('en')}>
            <ThemeProvider preset="obsidianCrimson">
              <PlayerScreen
                catalog={catalog}
                videoHost={videoHost}
                timers={timers}
                target={{
                  itemKey: 'live:src-1:101',
                  sourceId: 'src-1',
                  title: 'Alpha News',
                  kind: 'live',
                }}
                onPopoutPlayer={onPopoutPlayer}
                onExit={jest.fn()}
              />
            </ThemeProvider>
          </I18nProvider>
        </ViewportProvider>
      </FormFactorProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('player-popout-button')).toBeTruthy());
    expect(activeTimers.size).toBeGreaterThan(0);

    await fireEvent.press(screen.getByTestId('player-popout-button'));
    await waitFor(() => expect(onPopoutPlayer).toHaveBeenCalledTimes(1));
    expect(onPopoutPlayer.mock.calls[0]?.[2]).toBe('eng-park-6');

    const clearedBeforeUnmount = clearTimeoutSpy.mock.calls.length;
    await view.unmount();

    // PlaybackService.dispose() cleared its resolve timer, while engine.stop() & engine.release() were skipped!
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(clearedBeforeUnmount);
    expect(activeTimers.size).toBe(0);
    expect(tracked.stopSpy).not.toHaveBeenCalled();
    expect(tracked.releaseSpy).not.toHaveBeenCalled();
  });

  it('guards triggerTransfer against rapid double-clicks while parkForTransfer is in flight (#7)', async () => {
    let resolvePark!: (id: string | null) => void;
    const parkPromise = new Promise<string | null>((resolve) => {
      resolvePark = resolve;
    });
    const tracked = createTrackedOpenedEngine('eng-guard-7', () => parkPromise);
    const videoHost: VideoHost = { open: () => tracked.opened };
    const onPopoutPlayer = jest.fn();
    const catalog = {
      resolveStream: jest.fn(async () =>
        ok({ url: 'http://sim.example.test/live.m3u8', kind: 'live' as const, headers: {} }),
      ),
      getProgress: async () => null,
      saveProgress: async () => ok({} as never),
    };

    const view = await render(
      <FormFactorProvider value="desktop">
        <ViewportProvider
          value={{
            formFactor: 'desktop',
            orientation: 'landscape',
            inputModality: 'pointer',
            width: 1280,
            height: 720,
          }}
        >
          <I18nProvider i18n={createAppI18n('en')}>
            <ThemeProvider preset="obsidianCrimson">
              <PlayerScreen
                catalog={catalog}
                videoHost={videoHost}
                target={{
                  itemKey: 'live:src-1:101',
                  sourceId: 'src-1',
                  title: 'Alpha News',
                  kind: 'live',
                }}
                onPopoutPlayer={onPopoutPlayer}
                onExit={jest.fn()}
              />
            </ThemeProvider>
          </I18nProvider>
        </ViewportProvider>
      </FormFactorProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('player-popout-button')).toBeTruthy());

    // Rapid double-click while parkForTransfer() is still pending
    await fireEvent.press(screen.getByTestId('player-popout-button'));
    await fireEvent.press(screen.getByTestId('player-popout-button'));
    expect(tracked.parkForTransfer).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePark('eng-guard-7');
      await parkPromise;
    });

    // Clicking a 3rd time right after resolve before unmount is also ignored
    await fireEvent.press(screen.getByTestId('player-popout-button'));
    expect(tracked.parkForTransfer).toHaveBeenCalledTimes(1);
    expect(onPopoutPlayer).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('auto-solos reliably on concurrent tile removals using authoritative controller tile count (#8)', async () => {
    const tracker = createConnectionTracker();
    const engines: Array<ReturnType<typeof createTrackedOpenedEngine>> = [];
    const videoHost: VideoHost = {
      open: () => {
        const tracked = createTrackedOpenedEngine(`eng-mv-${engines.length + 1}`);
        engines.push(tracked);
        return tracked.opened;
      },
      supportsMultiView: true,
    };
    const sources: readonly SourceRow[] = [
      {
        id: 'src-1',
        kind: 'xtream',
        name: 'Provider A',
        needsImport: false,
        accountMeta: { maxConnections: 4 },
      } as unknown as SourceRow,
    ];
    const items = [
      { itemKey: 'live:src-1:1', sourceId: 'src-1', title: 'Ch 1', kind: 'live' as const },
      { itemKey: 'live:src-1:2', sourceId: 'src-1', title: 'Ch 2', kind: 'live' as const },
      { itemKey: 'live:src-1:3', sourceId: 'src-1', title: 'Ch 3', kind: 'live' as const },
    ];
    const onExit = jest.fn();

    const view = await render(
      <FormFactorProvider value="desktop">
        <ViewportProvider
          value={{
            formFactor: 'desktop',
            orientation: 'landscape',
            inputModality: 'pointer',
            width: 1280,
            height: 800,
          }}
        >
          <I18nProvider i18n={createAppI18n('en')}>
            <ThemeProvider preset="obsidianCrimson">
              <MultiViewStage
                catalog={{
                  resolveStream: async () =>
                    ok({
                      url: 'http://sim.example.test/a.m3u8',
                      kind: 'live' as const,
                      headers: {},
                    }),
                  categories: async () => [],
                  items: async () => [],
                  allSourcesItems: async () =>
                    items.map((it) => ({
                      key: it.itemKey,
                      sourceId: it.sourceId,
                      kind: 'live' as const,
                      title: it.title,
                    })) as never,
                }}
                videoHost={videoHost}
                tracker={tracker}
                sources={sources}
                initialSeed={items[0]}
                onExit={onExit}
              />
            </ThemeProvider>
          </I18nProvider>
        </ViewportProvider>
      </FormFactorProvider>,
    );

    // Add Tile 2 and Tile 3
    await waitFor(() => expect(screen.getByTestId('multiview-empty-slot')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('multiview-empty-slot'));
    await waitFor(() => expect(screen.getByTestId('multiview-picker-item-0')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('multiview-picker-item-0'));
    await waitFor(() => expect(screen.getByTestId('multiview-tile-1')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('multiview-empty-slot'));
    await waitFor(() => expect(screen.getByTestId('multiview-picker-item-0')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('multiview-picker-item-0'));
    await waitFor(() => expect(screen.getByTestId('multiview-tile-2')).toBeTruthy());

    // Hover Tile 1 and Tile 2, then remove both tiles — MultiViewStage reads authoritative remainingCount
    await fireEvent(screen.getByTestId('multiview-tile-1'), 'hoverIn');
    await fireEvent.press(screen.getByTestId('multiview-tile-remove-btn-1'));
    await waitFor(() => expect(screen.queryByTestId('multiview-tile-2')).toBeNull());
    expect(onExit).not.toHaveBeenCalled();

    await fireEvent(screen.getByTestId('multiview-tile-1'), 'hoverIn');
    await fireEvent.press(screen.getByTestId('multiview-tile-remove-btn-1'));

    // Authoritative controller tile count reaches 1 -> MUST auto-solo with Tile 0's adoptedSession!
    await waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(onExit.mock.calls[0]?.[0]?.itemKey).toBe('live:src-1:1');
    expect(onExit.mock.calls[0]?.[1]).not.toBeNull();
    await view.unmount();

    // Direct concurrency test on useMultiViewSession.removeTile: removing 2 of 3 tiles concurrently
    // reports authoritative remainingCount = 1 (never stale countBefore - 1).
    const harnessTracker = createConnectionTracker();
    const seed0 = items[0];
    if (!seed0) throw new Error('expected seed0');
    let sessionRef: MultiViewSessionHandle | undefined;
    const harness = await render(
      <MultiViewSessionHarness
        videoHost={videoHost}
        tracker={harnessTracker}
        sources={sources}
        initialSeed={seed0}
        onReady={(s) => {
          sessionRef = s;
        }}
      />,
    );
    const item1 = items[1];
    const item2 = items[2];
    if (!item1 || !item2) throw new Error('expected seed items');
    await act(async () => {
      sessionRef?.addChannel(item1);
      sessionRef?.addChannel(item2);
    });
    const [t0, t1, t2] = sessionRef?.state.tiles ?? [];
    if (!t0 || !t1 || !t2 || !sessionRef) throw new Error('expected 3 tiles');
    const activeSession = sessionRef;
    let results: Array<{ removed: boolean; remainingCount: number }> = [];
    await act(async () => {
      results = await Promise.all([
        activeSession.removeTile(t1.tileId),
        activeSession.removeTile(t2.tileId),
      ]);
    });
    expect(results.map((r) => r.removed)).toEqual([true, true]);
    expect(Math.min(...results.map((r) => r.remainingCount))).toBe(1);
    expect(sessionRef.state.tiles).toHaveLength(1);
    await harness.unmount();
  });
});
