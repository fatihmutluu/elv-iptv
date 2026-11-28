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
import { createConnectionTracker } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import { AppProviders, AppShell } from '../../index';
import type { DesktopWindowPort, PopoutDockPayload } from '../../ports/desktop-window-host';
import type { OpenVideoEngine, VideoHost } from '../../ports/video-host';
import { MultiViewStage } from '../MultiViewStage';
import { PlayerScreen } from '../PlayerScreen';

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

function createTwoProviderHttp(): HttpClient {
  return {
    async get(rawUrl) {
      const url = new URL(rawUrl);
      if (url.pathname !== '/player_api.php') return err(elvError('network', 'http-404'));
      const action = url.searchParams.get('action');
      const isSecond = url.hostname.includes('second');
      if (!action) {
        return ok(
          jsonResponse({
            user_info: {
              auth: 1,
              status: 'Active',
              max_connections: '2',
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
          jsonResponse(
            isSecond
              ? [{ stream_id: 201, name: 'Beta Sports', category_id: '1', num: 2 }]
              : [{ stream_id: 101, name: 'Alpha News', category_id: '1', num: 1 }],
          ),
        );
      }
      return ok(jsonResponse([]));
    },
  };
}

async function createSeededEnv() {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) throw new Error('migrate failed');
  let now = 1_700_000_000_000;
  let idSeq = 0;
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: createTwoProviderHttp(),
    clock: () => {
      now += 10;
      return now;
    },
    newId: () => `src-${++idSeq}`,
  });
  const s1 = await catalog.addSource({
    kind: 'xtream',
    name: 'First',
    server: 'http://first.example.test:8080',
    username: 'u1',
    password: ['p', '1'].join(''),
  });
  if (!s1.ok) throw new Error('s1 failed');
  await catalog.importSource(s1.value.id);
  const s2 = await catalog.addSource({
    kind: 'xtream',
    name: 'Second',
    server: 'http://second.example.test:8080',
    username: 'u2',
    password: ['p', '2'].join(''),
  });
  if (!s2.ok) throw new Error('s2 failed');
  await catalog.importSource(s2.value.id);
  return {
    catalog,
    async cleanup() {
      await catalog.close();
      handle.close();
    },
  };
}

function createTrackedOpenedEngine(hostEngineId?: string) {
  const fake = createFakePlayerEngine({
    now: () => performance.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const loadSpy = jest.spyOn(fake, 'load');
  const stopSpy = jest.spyOn(fake, 'stop');
  const releaseSpy = jest.spyOn(fake, 'release');
  const setMuted = jest.fn();
  const toggleMute = jest.fn();
  const setVolume = jest.fn();
  const setPrimary = jest.fn();
  const setAudioDevice = jest.fn();
  const setAudioNormalization = jest.fn();
  const setPitchLock = jest.fn();
  const setDeinterlaceMode = jest.fn();
  const parkForTransfer =
    hostEngineId !== undefined ? jest.fn(async () => hostEngineId) : undefined;
  const opened: OpenVideoEngine = {
    engine: fake,
    overlayMode: 'floating',
    ...(hostEngineId !== undefined ? { hostEngineId } : {}),
    ...(parkForTransfer !== undefined ? { parkForTransfer } : {}),
    setMuted,
    toggleMute,
    setVolume,
    setPrimary,
    setAudioDevice,
    setAudioNormalization,
    setPitchLock,
    setDeinterlaceMode,
    renderSurface: ({ testID }) => <View testID={testID ?? 'p3-surface'} />,
  };
  return {
    opened,
    loadSpy,
    stopSpy,
    releaseSpy,
    setMuted,
    toggleMute,
    setVolume,
    setPrimary,
    setAudioDevice,
    setAudioNormalization,
    setPitchLock,
    setDeinterlaceMode,
    parkForTransfer,
  };
}

describe('Wave P3 — Zero-Reload Detached Popout & Seamless Multi-View Handoff', () => {
  it('supports cross-window adoptEngineId and Dock-back button with parkForTransfer on PlayerScreen (with fallback on null)', async () => {
    const adopted = createTrackedOpenedEngine('eng-42');
    const openSpy = jest.fn(() => createTrackedOpenedEngine('eng-fresh').opened);
    const adoptEngine = jest.fn(async (id: string) => (id === 'eng-42' ? adopted.opened : null));
    const videoHost: VideoHost = { open: openSpy, adoptEngine };
    const onDockPopout = jest.fn();
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
                adoptEngineId="eng-42"
                onDockPopout={onDockPopout}
                onPopoutPlayer={jest.fn()}
                onExit={jest.fn()}
              />
            </ThemeProvider>
          </I18nProvider>
        </ViewportProvider>
      </FormFactorProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('player-dock-popout-button')).toBeTruthy());
    expect(adoptEngine).toHaveBeenCalledWith('eng-42');
    expect(openSpy).not.toHaveBeenCalled();
    expect(adopted.loadSpy).not.toHaveBeenCalled();
    expect(catalog.resolveStream).not.toHaveBeenCalled();
    // Dock replaces Detach button; no top-right pin button exists
    expect(screen.queryByTestId('player-window-mode-button')).toBeNull();
    expect(screen.getByTestId('player-dock-popout-button').props.accessibilityLabel).toBe(
      'Return to main window',
    );

    // Click Dock -> calls parkForTransfer() and forwards transferEngineId; unmount skips release/stop!
    await fireEvent.press(screen.getByTestId('player-dock-popout-button'));
    await waitFor(() => expect(onDockPopout).toHaveBeenCalledTimes(1));
    expect(adopted.parkForTransfer).toHaveBeenCalledTimes(1);
    expect(onDockPopout.mock.calls[0]?.[2]).toBe('eng-42');

    await view.unmount();
    expect(adopted.releaseSpy).not.toHaveBeenCalled();
    expect(adopted.stopSpy).not.toHaveBeenCalled();

    // Fallback when adoptEngine returns null -> cleanly opens fresh engine and tunes
    const fallbackView = await render(
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
                adoptEngineId="stale-id"
                onExit={jest.fn()}
              />
            </ThemeProvider>
          </I18nProvider>
        </ViewportProvider>
      </FormFactorProvider>,
    );

    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(catalog.resolveStream).toHaveBeenCalledTimes(1));
    await fallbackView.unmount();
  });

  it('hands off live playback between AppShell PlayerScreen and Multi-View with zero reload, preserves volume/prefs, renders top-right tile controls, hides redundant Add button, and auto-solos on closing 1 of 2 tiles', async () => {
    const env = await createSeededEnv();
    const prefsStore = createMemoryPreferencesStore({
      playerVolume: 72,
      preferredAudioDevice: 'hdmi-1',
      audioNormalization: true,
      pitchLock: false,
      deinterlaceMode: 'bwdif',
    });
    const tracker = createConnectionTracker();
    const openedEngines: Array<ReturnType<typeof createTrackedOpenedEngine>> = [];
    const openSpy = jest.fn(() => {
      const tracked = createTrackedOpenedEngine(`eng-${openedEngines.length + 1}`);
      openedEngines.push(tracked);
      return tracked.opened;
    });
    const videoHost: VideoHost = { open: openSpy, supportsMultiView: true };

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
                <AppShell catalog={env.catalog} videoHost={videoHost} connectionTracker={tracker} />
              </I18nProvider>
            </ViewportProvider>
          </FormFactorProvider>
        </AppProviders>,
      );

      await waitFor(() => expect(screen.getByTestId('home-live-item-0')).toBeTruthy());

      // Start Channel 1 in fullscreen PlayerScreen
      await fireEvent.press(screen.getByTestId('home-live-item-0'));
      await waitFor(() => expect(screen.getByTestId('player-settings-button')).toBeTruthy());
      expect(openSpy).toHaveBeenCalledTimes(1);
      const tile1Engine = openedEngines[0];
      if (tile1Engine === undefined) throw new Error('expected tile1Engine');

      // Enter Multi-View via Settings -> adopts live Tile 1 with ZERO new videoHost.open(), ZERO stop(), ZERO release()!
      await fireEvent.press(screen.getByTestId('player-settings-button'));
      await waitFor(() => expect(screen.getByTestId('player-settings-multiview')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('player-settings-multiview'));
      await waitFor(() => expect(screen.getByTestId('multiview-stage')).toBeTruthy());
      await waitFor(() => expect(screen.getByTestId('multiview-tile-0')).toBeTruthy());

      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(tile1Engine.stopSpy).not.toHaveBeenCalled();
      expect(tile1Engine.releaseSpy).not.toHaveBeenCalled();
      expect(tile1Engine.setVolume).toHaveBeenLastCalledWith(72);
      expect(tile1Engine.setAudioDevice).toHaveBeenCalledWith('hdmi-1');
      expect(tile1Engine.setAudioNormalization).toHaveBeenCalledWith(true);
      expect(tile1Engine.setPitchLock).toHaveBeenCalledWith(false);
      expect(tile1Engine.setDeinterlaceMode).toHaveBeenCalledWith('auto');

      // Redundant top-right Add button is hidden when empty '+' slot card is visible!
      expect(screen.getByTestId('multiview-empty-slot')).toBeTruthy();
      expect(screen.queryByTestId('multiview-add-button')).toBeNull();

      // Interactive volume + mute control in Multi-View header
      expect(screen.getByTestId('multiview-volume-control')).toBeTruthy();
      await act(async () => {
        fireEvent(screen.getByTestId('multiview-mute-button'), 'hoverIn');
      });
      await waitFor(() => expect(screen.getByTestId('multiview-volume-popover')).toBeTruthy());
      const slider = screen.getByTestId('multiview-volume-slider');
      expect(slider.props.accessibilityValue?.now).toBe(72);

      // Increment volume via accessibility action -> updates active tile & persists playerVolume
      await act(async () => {
        fireEvent(slider, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
      });
      expect(tile1Engine.setVolume).toHaveBeenLastCalledWith(77);
      expect((await prefsStore.load()).playerVolume).toBe(77);

      // Add Channel 2 via empty '+' slot -> opens Tile 2 with preserved preferences
      await fireEvent.press(screen.getByTestId('multiview-empty-slot'));
      await waitFor(() => expect(screen.getByTestId('multiview-picker-item-0')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('multiview-picker-item-0'));
      await waitFor(() => expect(screen.getByTestId('multiview-tile-1')).toBeTruthy());
      expect(openSpy).toHaveBeenCalledTimes(2);
      const tile2Engine = openedEngines[1];
      if (tile2Engine === undefined) throw new Error('expected tile2Engine');
      expect(tile2Engine.setVolume).toHaveBeenCalledWith(77);
      expect(tile2Engine.setAudioDevice).toHaveBeenCalledWith('hdmi-1');
      expect(tile2Engine.setAudioNormalization).toHaveBeenCalledWith(true);
      expect(tile2Engine.setPitchLock).toHaveBeenCalledWith(false);
      expect(tile2Engine.setDeinterlaceMode).toHaveBeenCalledWith('auto');

      // Hover Tile 0 (active audio): top-right Replace + Close icon buttons visible, NO bottom actions bar!
      await act(async () => {
        fireEvent(screen.getByTestId('multiview-tile-0'), 'hoverIn');
      });
      expect(screen.getByTestId('multiview-tile-corner-actions-0')).toBeTruthy();
      expect(screen.getByTestId('multiview-tile-replace-btn-0')).toBeTruthy();
      expect(screen.getByTestId('multiview-tile-remove-btn-0')).toBeTruthy();
      expect(screen.queryByTestId('multiview-tile-actions-bar-0')).toBeNull();

      // Hover Tile 1 (muted): top-right Replace + Close buttons AND bottom Swap Audio bar only!
      await act(async () => {
        fireEvent(screen.getByTestId('multiview-tile-1'), 'hoverIn');
      });
      expect(screen.getByTestId('multiview-tile-corner-actions-1')).toBeTruthy();
      expect(screen.getByTestId('multiview-tile-actions-bar-1')).toBeTruthy();
      expect(screen.getByTestId('multiview-tile-audio-btn-1')).toBeTruthy();

      // Close Tile 1 -> 1 tile remains -> Auto-Solo straight back to fullscreen PlayerScreen with ZERO reload!
      await fireEvent.press(screen.getByTestId('multiview-tile-remove-btn-1'));
      await waitFor(() => expect(screen.getByTestId('player-screen')).toBeTruthy());
      expect(screen.queryByTestId('multiview-stage')).toBeNull();
      expect(tile2Engine.releaseSpy).toHaveBeenCalledTimes(1);
      expect(tile1Engine.releaseSpy).not.toHaveBeenCalled();
      expect(tile1Engine.stopSpy).not.toHaveBeenCalled();
      expect(openSpy).toHaveBeenCalledTimes(2);

      // Re-enter Multi-View via Settings and press Back/Exit -> also hands off Tile 1 back to PlayerScreen without reload!
      await waitFor(() => expect(screen.getByTestId('player-settings-button')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('player-settings-button'));
      await waitFor(() => expect(screen.getByTestId('player-settings-multiview')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('player-settings-multiview'));
      await waitFor(() => expect(screen.getByTestId('multiview-exit-button')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('multiview-exit-button'));
      await waitFor(() => expect(screen.getByTestId('player-screen')).toBeTruthy());
      expect(tile1Engine.releaseSpy).not.toHaveBeenCalled();
      expect(tile1Engine.stopSpy).not.toHaveBeenCalled();
      expect(openSpy).toHaveBeenCalledTimes(2);
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('transfers parked engine ID across AppShell Popout detach and dock without reloading', async () => {
    const env = await createSeededEnv();
    const tracker = createConnectionTracker();
    const parked = createTrackedOpenedEngine('eng-pop-9');
    const openSpy = jest.fn(() => parked.opened);
    const adoptEngine = jest.fn(async (id: string) => (id === 'eng-pop-9' ? parked.opened : null));
    const videoHost: VideoHost = { open: openSpy, adoptEngine, supportsMultiView: true };

    let dockedCb: ((payload: PopoutDockPayload) => void) | undefined;
    const openPopout = jest.fn(async () => true);
    const desktopWindow: DesktopWindowPort = {
      openPopout,
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

      await waitFor(() => expect(screen.getByTestId('home-live-item-0')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('home-live-item-0'));
      await waitFor(() => expect(screen.getByTestId('player-window-mode-button')).toBeTruthy());
      expect(openSpy).toHaveBeenCalledTimes(1);

      // Detach via merged Window Mode popover -> parks engine & forwards transferEngineId without stopping/releasing!
      await fireEvent.press(screen.getByTestId('player-window-mode-button'));
      await waitFor(() => expect(screen.getByTestId('player-window-mode-popout')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('player-window-mode-popout'));
      await waitFor(() => expect(openPopout).toHaveBeenCalledTimes(1));
      expect(parked.parkForTransfer).toHaveBeenCalledTimes(1);
      expect(openPopout).toHaveBeenCalledWith(
        expect.objectContaining({ transferEngineId: 'eng-pop-9' }),
      );
      expect(parked.stopSpy).not.toHaveBeenCalled();
      expect(parked.releaseSpy).not.toHaveBeenCalled();

      // Dock back with transferEngineId -> adopts parked engine directly instead of calling videoHost.open()!
      await act(async () => {
        dockedCb?.({
          itemKey: 'live:src-1:101',
          kind: 'live',
          title: 'Alpha News',
          sourceId: 'src-1',
          positionMs: 0,
          transferEngineId: 'eng-pop-9',
        });
      });
      await waitFor(() => expect(adoptEngine).toHaveBeenCalledWith('eng-pop-9'));
      await waitFor(() => expect(screen.getByTestId('player-osd')).toBeTruthy());
      expect(openSpy).toHaveBeenCalledTimes(1);
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('toggles mute on active audio tile from MultiViewStage header control', async () => {
    const tracker = createConnectionTracker();
    const tracked = createTrackedOpenedEngine();
    const videoHost: VideoHost = { open: () => tracked.opened, supportsMultiView: true };
    const sources: readonly SourceRow[] = [
      {
        id: 'src-1',
        kind: 'xtream',
        name: 'Provider A',
        needsImport: false,
        accountMeta: { maxConnections: 2 },
      } as unknown as SourceRow,
    ];
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
                  allSourcesItems: async () => [],
                }}
                videoHost={videoHost}
                tracker={tracker}
                sources={sources}
                initialSeed={{
                  itemKey: 'live:src-1:1',
                  sourceId: 'src-1',
                  title: 'Alpha News',
                  kind: 'live',
                }}
                playerVolume={60}
                onExit={jest.fn()}
              />
            </ThemeProvider>
          </I18nProvider>
        </ViewportProvider>
      </FormFactorProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('multiview-mute-button')).toBeTruthy());
    expect(tracked.setMuted).toHaveBeenLastCalledWith(false);
    await fireEvent.press(screen.getByTestId('multiview-mute-button'));
    expect(tracked.setMuted).toHaveBeenLastCalledWith(true);
    await fireEvent.press(screen.getByTestId('multiview-mute-button'));
    expect(tracked.setMuted).toHaveBeenLastCalledWith(false);

    await view.unmount();
  });
});
