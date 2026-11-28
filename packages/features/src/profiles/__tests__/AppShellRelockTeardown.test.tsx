import type { CatalogService } from '@elv/data';
import { elvError, err, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import { AppProviders, AppShell } from '../../index';
import type { AppLifecyclePort, AppLifecycleState } from '../../ports/app-lifecycle';
import type { DesktopWindowPort } from '../../ports/desktop-window-host';
import type { PlaybackGuard } from '../../ports/playback-guard';
import type { VideoHost } from '../../ports/video-host';

class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly listeners = new Set<(event: { data: unknown }) => void>();
  constructor(readonly name: string) {
    let set = FakeBroadcastChannel.channels.get(name);
    if (!set) {
      set = new Set();
      FakeBroadcastChannel.channels.set(name, set);
    }
    set.add(this);
  }
  postMessage(data: unknown): void {
    const peers = FakeBroadcastChannel.channels.get(this.name);
    if (!peers) return;
    for (const peer of peers) {
      if (peer === this) continue;
      peer.onmessage?.({ data });
      for (const fn of peer.listeners) fn({ data });
    }
  }
  addEventListener(_type: string, fn: (event: { data: unknown }) => void): void {
    this.listeners.add(fn);
  }
  removeEventListener(_type: string, fn: (event: { data: unknown }) => void): void {
    this.listeners.delete(fn);
  }
  close(): void {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

function createDesktopVideoHost(): VideoHost {
  return {
    supportsMultiView: true,
    open: jest.fn(() => {
      const engine = createFakePlayerEngine({
        now: () => performance.now(),
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      });
      return {
        engine,
        renderSurface: ({ testID }) => <View testID={testID ?? 'mv-surface'} />,
      };
    }),
  };
}

function createStubCatalog() {
  return {
    listSources: jest.fn(async () => [
      { id: 's1', kind: 'm3u' as const, name: 'Demo', createdAt: 1, needsImport: false },
    ]),
    categories: jest.fn(async () => [{ id: 's1|live|1', name: 'News', count: 1 }]),
    items: jest.fn(async () => [
      {
        id: 1,
        key: 'm:s1:live:1',
        kind: 'live' as const,
        sourceId: 's1',
        providerId: '1',
        name: 'News 1',
        logo: null,
        rating: null,
        year: null,
        num: 1,
      },
    ]),
    allSourcesItems: jest.fn(async () => [
      {
        id: 1,
        key: 'm:s1:live:1',
        kind: 'live' as const,
        sourceId: 's1',
        providerId: '1',
        name: 'News 1',
        logo: null,
        rating: null,
        year: null,
        num: 1,
      },
    ]),
    itemDetail: jest.fn(async () => ({
      id: 1,
      key: 'm:s1:live:1',
      kind: 'live' as const,
      sourceId: 's1',
      providerId: '1',
      name: 'News 1',
      logo: null,
      rating: null,
      year: null,
      num: 1,
      plot: null,
    })),
    listProfiles: jest.fn(async () => [
      {
        id: 'default',
        name: 'Default',
        avatarToken: 'crimson',
        isKids: false,
        isDefault: true,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'kids-1',
        name: 'Kids',
        avatarToken: 'emerald',
        isKids: true,
        isDefault: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
    getParentalSettings: jest.fn(async (pid?: string) => ({
      profileId: pid ?? 'default',
      enabled: true,
      blockAdultKeywords: true,
      maxRatingAge: 12,
      unlockTimeoutMin: 30,
      updatedAt: 0,
    })),
    listParentalLocks: jest.fn(async () => []),
    hasParentalPin: jest.fn(async () => true),
    verifyParentalPin: jest.fn(async () => ({ ok: true as const })),
    resolveStream: jest.fn(async (_key: string, opts?: { parentalUnlocked?: boolean }) =>
      opts?.parentalUnlocked
        ? ok({ url: 'http://127.0.0.1/live.ts', headers: {} })
        : err(elvError('auth', 'parental-locked')),
    ),
    addSource: jest.fn(),
    addSourceFromLink: jest.fn(),
    removeSource: jest.fn(),
    importSource: jest.fn(),
    seasons: jest.fn(async () => ok([])),
    episodes: jest.fn(async () => []),
    close: jest.fn(async () => undefined),
  } as unknown as CatalogService;
}

describe('AppShell Multi-View & Popout teardown on relock, profile switch, and source deletion (Wave Q5-A)', () => {
  let origBc: unknown;

  beforeEach(() => {
    FakeBroadcastChannel.channels.clear();
    origBc = (globalThis as Record<string, unknown>).BroadcastChannel;
    (globalThis as Record<string, unknown>).BroadcastChannel = FakeBroadcastChannel;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).BroadcastChannel = origBc;
    jest.restoreAllMocks();
  });

  it('closes Multi-View and broadcasts parental-relock when app backgrounds while unlocked under Kids Mode', async () => {
    const received: unknown[] = [];
    const observer = new FakeBroadcastChannel('elv-session-guard');
    observer.onmessage = (e) => received.push(e.data);

    const lifecycleListeners = new Set<(state: AppLifecycleState) => void>();
    const appLifecycle: AppLifecyclePort = {
      subscribe: (listener) => {
        lifecycleListeners.add(listener);
        return () => lifecycleListeners.delete(listener);
      },
    };
    const closePopout = jest.fn(async () => undefined);
    const desktopWindow: DesktopWindowPort = { closePopout };
    const catalog = createStubCatalog();

    const view = await render(
      <AppProviders
        i18n={createAppI18n('en')}
        viewport={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      >
        <AppShell
          catalog={catalog}
          videoHost={createDesktopVideoHost()}
          appLifecycle={appLifecycle}
          desktopWindow={desktopWindow}
          pendingDeepLink={{ itemKey: 'm:s1:live:1', kind: 'live' }}
        />
      </AppProviders>,
    );

    // Unlock via PIN dialog from deep link
    await waitFor(() => expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy());
    for (const d of ['1', '2', '3', '4']) {
      await fireEvent.press(screen.getByTestId(`pin-key-${d}`));
    }
    await fireEvent.press(screen.getByTestId('pin-entry-submit'));

    await waitFor(() => expect(screen.getByTestId('player-screen')).toBeTruthy());

    // Enter Multi-View from Player OSD
    await waitFor(() => expect(screen.getByTestId('player-multiview-button')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('player-multiview-button'));
    await waitFor(() => expect(screen.getByTestId('multiview-stage')).toBeTruthy());

    // Backgrounding triggers lockParentalNow -> Multi-View closes & parental-relock broadcasts
    await act(async () => {
      for (const l of lifecycleListeners) l('background');
    });

    await waitFor(() => {
      expect(screen.queryByTestId('multiview-stage')).toBeNull();
    });
    expect(received).toContainEqual(
      expect.objectContaining({ type: 'parental-relock', profileId: 'default' }),
    );

    observer.close();
    await view.unmount();
  });

  it('closes Popout and broadcasts profile-switch when switching profiles, and closes Multi-View + broadcasts source-deleted on source deletion', async () => {
    const received: unknown[] = [];
    const observer = new FakeBroadcastChannel('elv-session-guard');
    observer.onmessage = (e) => received.push(e.data);

    const closePopout = jest.fn(async () => undefined);
    const desktopWindow: DesktopWindowPort = { closePopout };
    const catalog = createStubCatalog();
    // Allow stream resolution without PIN for this test
    (catalog.getParentalSettings as jest.Mock).mockResolvedValue({
      profileId: 'default',
      enabled: false,
      blockAdultKeywords: true,
      maxRatingAge: null,
      unlockTimeoutMin: 30,
      updatedAt: 0,
    });
    (catalog.hasParentalPin as jest.Mock).mockResolvedValue(false);
    (catalog.resolveStream as jest.Mock).mockResolvedValue(
      ok({ url: 'http://127.0.0.1/live.ts', headers: {} }),
    );

    let guard: PlaybackGuard | undefined;
    const view = await render(
      <AppProviders
        i18n={createAppI18n('en')}
        viewport={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      >
        <AppShell
          catalog={catalog}
          videoHost={createDesktopVideoHost()}
          desktopWindow={desktopWindow}
          onPlaybackGuardReady={(g) => {
            guard = g;
          }}
        />
      </AppProviders>,
    );

    // Dismiss auto profile picker if opened, then switch to kids-1 via picker
    await waitFor(() => expect(screen.getByTestId('profile-picker-card-kids-1')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('profile-picker-card-kids-1'));

    await waitFor(() => {
      expect(closePopout).toHaveBeenCalled();
    });
    expect(received).toContainEqual(
      expect.objectContaining({ type: 'profile-switch', profileId: 'kids-1' }),
    );

    // Play a live channel and enter Multi-View, then delete its source via playbackGuard
    await waitFor(() => expect(screen.getByTestId('home-live-item-0')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('home-live-item-0'));
    await waitFor(() => expect(screen.getByTestId('player-multiview-button')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('player-multiview-button'));
    await waitFor(() => expect(screen.getByTestId('multiview-stage')).toBeTruthy());

    await act(async () => {
      await guard?.stopIfUsingSource('s1');
    });

    await waitFor(() => {
      expect(screen.queryByTestId('multiview-stage')).toBeNull();
    });
    expect(received).toContainEqual({ type: 'source-deleted', sourceId: 's1' });

    observer.close();
    await view.unmount();
  });

  it('blocks dock-back transfer adoption when locked and restricted, and tears down Multi-View when an offline secondary tile source is deleted', async () => {
    let onDockListener:
      | ((payload: {
          readonly itemKey: string;
          readonly kind: 'live' | 'movie' | 'episode';
          readonly title: string;
          readonly sourceId?: string;
          readonly transferEngineId?: string;
        }) => void)
      | undefined;
    const desktopWindow: DesktopWindowPort = {
      closePopout: jest.fn(async () => undefined),
      onPopoutDocked: (fn) => {
        onDockListener = fn;
        return () => {
          onDockListener = undefined;
        };
      },
    };
    const catalog = createStubCatalog();
    const resolveStream = catalog.resolveStream as jest.Mock;
    let guard: PlaybackGuard | undefined;

    const view = await render(
      <AppProviders
        i18n={createAppI18n('en')}
        viewport={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      >
        <AppShell
          catalog={catalog}
          videoHost={createDesktopVideoHost()}
          desktopWindow={desktopWindow}
          onPlaybackGuardReady={(g) => {
            guard = g;
          }}
        />
      </AppProviders>,
    );

    await waitFor(() => expect(onDockListener).toBeDefined());

    // 1. While parentalUnlocked === false and resolveStream returns parental-locked, docking with
    // transferEngineId MUST NOT blindly adopt playback into PlayerScreen!
    await act(async () => {
      onDockListener?.({
        itemKey: 'm:s1:live:1',
        kind: 'live',
        title: 'Restricted Ch',
        sourceId: 's1',
        transferEngineId: 'eng-transfer-1',
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(resolveStream).toHaveBeenCalled();
    expect(screen.queryByTestId('player-screen')).toBeNull();

    // 2. Verify secondary Multi-View tile (tile 2 from sync-deleted fingerprinted source s2 while
    // tile 1 seed is s1 and tracker has 0 count under raw 's2') still tears down Multi-View cleanly
    const twoSources = [
      { id: 's1', kind: 'm3u' as const, name: 'Demo 1', createdAt: 1, needsImport: false },
      {
        id: 's2',
        kind: 'xtream' as const,
        name: 'Sync Deleted',
        createdAt: 2,
        needsImport: false,
        accountMeta: { credentialFingerprint: 'fp-sync-2', maxConnections: 2 },
      },
    ];
    (catalog.listSources as jest.Mock).mockResolvedValue(twoSources);
    (catalog.allSourcesItems as jest.Mock).mockResolvedValue([
      {
        id: 1,
        key: 'm:s1:live:1',
        kind: 'live' as const,
        sourceId: 's1',
        providerId: '1',
        name: 'News 1',
        logo: null,
        rating: null,
        year: null,
        num: 1,
      },
      {
        id: 2,
        key: 'm:s2:live:2',
        kind: 'live' as const,
        sourceId: 's2',
        providerId: '2',
        name: 'Sports 2',
        logo: null,
        rating: null,
        year: null,
        num: 2,
      },
    ]);
    resolveStream.mockResolvedValue(ok({ url: 'http://127.0.0.1/live.ts', headers: {} }));

    // Dock permitted item from s1 into main player, enter Multi-View (tile 1 = s1), then add tile 2 = s2
    await act(async () => {
      onDockListener?.({
        itemKey: 'm:s1:live:1',
        kind: 'live',
        title: 'News 1',
        sourceId: 's1',
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('player-multiview-button')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('player-multiview-button'));
    await waitFor(() => expect(screen.getByTestId('multiview-stage')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('multiview-empty-slot')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('multiview-empty-slot'));
    await waitFor(() => expect(screen.getByTestId('multiview-picker-item-0')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('multiview-picker-item-0'));
    await waitFor(() => expect(screen.getByTestId('multiview-tile-1')).toBeTruthy());

    // Simulate sync deleting s2 from sources before guard.stopIfUsingSource('s2') runs
    (catalog.listSources as jest.Mock).mockResolvedValue([twoSources[0]]);
    await act(async () => {
      await guard?.stopIfUsingSource('s2');
    });
    await waitFor(() => expect(screen.queryByTestId('multiview-stage')).toBeNull());

    await view.unmount();
  });
});
