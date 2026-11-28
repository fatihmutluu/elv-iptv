import { describe, expect, it, vi } from 'vitest';
import { CATALOG_CHANNELS } from '../shared/catalog-ipc.ts';
import { DOWNLOADS_CHANNELS } from '../shared/downloads-ipc.ts';
import { LAN_PAIRING_CHANNELS } from '../shared/lan-pairing-ipc.ts';
import { PLAYER_CHANNELS } from '../shared/player-ipc.ts';
import { SOURCES_CHANNELS } from '../shared/sources-ipc.ts';
import { SYNC_CHANNELS } from '../shared/sync-ipc.ts';
import { UPDATER_CHANNELS } from '../shared/updater-ipc.ts';
import { WINDOW_CHANNELS } from '../shared/window-ipc.ts';
import { createArtworkBridge } from './artwork-bridge.ts';
import { createCatalogBridge } from './catalog-bridge.ts';
import { createDownloadsBridge } from './downloads-bridge.ts';
import { createLanPairingBridge } from './lan-pairing-bridge.ts';
import { createPlayerBridge } from './player-bridge.ts';
import { createSourcesBridge } from './sources-bridge.ts';
import { createSyncBridges } from './sync-bridge.ts';
import { createUpdaterBridge } from './updater-bridge.ts';
import { createWindowBridge } from './window-bridge.ts';

type ListenerFn = (event: unknown, ...args: unknown[]) => void;

const SENTINEL_IPC_EVENT = Object.freeze({
  __rawIpcRendererEvent: true,
  sender: Object.freeze({ leaked: true }),
});

function createMockIpc() {
  const listeners = new Map<string, Set<ListenerFn>>();
  const invoke = vi.fn(
    async (_channel: string, ..._args: unknown[]): Promise<unknown> => undefined,
  );
  const send = vi.fn((_channel: string, ..._args: unknown[]): void => undefined);

  const ipc = {
    invoke,
    send,
    on(channel: string, listener: ListenerFn) {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(listener);
      return ipc;
    },
    removeListener(channel: string, listener: ListenerFn) {
      listeners.get(channel)?.delete(listener);
      return ipc;
    },
  };

  return {
    ipc,
    invoke,
    send,
    emit(channel: string, ...args: unknown[]) {
      for (const listener of [...(listeners.get(channel) ?? [])]) {
        listener(SENTINEL_IPC_EVENT, ...args);
      }
    },
    listenerCount(channel: string) {
      return listeners.get(channel)?.size ?? 0;
    },
  };
}

interface ListenerCase {
  readonly name: string;
  readonly channel: string;
  readonly payloadArgs: readonly unknown[];
  readonly expectedArgCount: number;
  readonly ownsSingleSharedIpcListener?: boolean;
  readonly bind: (
    ipc: ReturnType<typeof createMockIpc>['ipc'],
  ) => (cb: (...args: unknown[]) => void) => () => void;
}

const VALID_SYNC_STATE = {
  status: 'signed_in' as const,
  email: 'user@example.test',
  lastSyncedAtIso: '2026-11-28T00:00:00.000Z',
  pendingRecoveryCode: null,
  errorCode: null,
};

const LISTENER_CASES: readonly ListenerCase[] = [
  {
    name: 'window-bridge.onZoomLevelChanged',
    channel: WINDOW_CHANNELS.zoomLevelChanged,
    payloadArgs: [1.5],
    expectedArgCount: 1,
    bind: (ipc) => {
      const b = createWindowBridge(ipc);
      return (cb) => {
        if (!b.onZoomLevelChanged) throw new Error('expected onZoomLevelChanged');
        return b.onZoomLevelChanged(cb);
      };
    },
  },
  {
    name: 'window-bridge.onPopoutPayload',
    channel: WINDOW_CHANNELS.popoutPayload,
    payloadArgs: [{ itemKey: 'live:s1:ch1', kind: 'live', title: 'News' }],
    expectedArgCount: 1,
    bind: (ipc) => {
      const b = createWindowBridge(ipc);
      return (cb) => b.onPopoutPayload(cb);
    },
  },
  {
    name: 'window-bridge.onPopoutDocked',
    channel: WINDOW_CHANNELS.popoutDocked,
    payloadArgs: [{ itemKey: 'live:s1:ch1', kind: 'live', title: 'News' }],
    expectedArgCount: 1,
    bind: (ipc) => {
      const b = createWindowBridge(ipc);
      return (cb) => b.onPopoutDocked(cb);
    },
  },
  {
    name: 'window-bridge.onWindowRestored',
    channel: WINDOW_CHANNELS.windowRestored,
    payloadArgs: [],
    expectedArgCount: 0,
    bind: (ipc) => {
      const b = createWindowBridge(ipc);
      return (cb) => b.onWindowRestored(cb);
    },
  },
  {
    name: 'window-bridge.onHiddenToTray',
    channel: WINDOW_CHANNELS.hiddenToTray,
    payloadArgs: [],
    expectedArgCount: 0,
    bind: (ipc) => {
      const b = createWindowBridge(ipc);
      return (cb) => b.onHiddenToTray(cb);
    },
  },
  {
    name: 'sources-bridge.onOpenPlaylistFile',
    channel: SOURCES_CHANNELS.openPlaylistFile,
    payloadArgs: [{ name: 'channels.m3u', bytes: new Uint8Array([35, 69, 88, 84]) }],
    expectedArgCount: 1,
    bind: (ipc) => {
      const b = createSourcesBridge(ipc);
      return (cb) => b.onOpenPlaylistFile(cb);
    },
  },
  {
    name: 'catalog-bridge.onChanged',
    channel: CATALOG_CHANNELS.changed,
    payloadArgs: [],
    expectedArgCount: 0,
    ownsSingleSharedIpcListener: true,
    bind: (ipc) => {
      const b = createCatalogBridge(ipc as never);
      return (cb) => b.onChanged(cb);
    },
  },
  {
    name: 'catalog-bridge.onDisconnected',
    channel: CATALOG_CHANNELS.disconnected,
    payloadArgs: [],
    expectedArgCount: 1,
    ownsSingleSharedIpcListener: true,
    bind: (ipc) => {
      const b = createCatalogBridge(ipc as never);
      return (cb) => b.onDisconnected(cb);
    },
  },
  {
    name: 'player-bridge.onEvent',
    channel: PLAYER_CHANNELS.event,
    payloadArgs: [{ engineId: 'engine-1', event: { type: 'playing' } }],
    expectedArgCount: 1,
    bind: (ipc) => {
      const b = createPlayerBridge(ipc);
      return (cb) => b.onEvent(cb);
    },
  },
  {
    name: 'player-bridge.onUi',
    channel: PLAYER_CHANNELS.ui,
    payloadArgs: [{ engineId: 'engine-1', key: 'back' }],
    expectedArgCount: 1,
    bind: (ipc) => {
      const b = createPlayerBridge(ipc);
      return (cb) => b.onUi(cb);
    },
  },
  {
    name: 'player-bridge.onRemoteMediaAction',
    channel: PLAYER_CHANNELS.remoteMediaAction,
    payloadArgs: [{ action: 'play-pause' }],
    expectedArgCount: 1,
    bind: (ipc) => {
      const b = createPlayerBridge(ipc);
      return (cb) => {
        if (!b.onRemoteMediaAction) throw new Error('expected onRemoteMediaAction');
        return b.onRemoteMediaAction(cb);
      };
    },
  },
  {
    name: 'downloads-bridge.onChanged',
    channel: DOWNLOADS_CHANNELS.changed,
    payloadArgs: [[]],
    expectedArgCount: 1,
    bind: (ipc) => {
      const b = createDownloadsBridge(ipc);
      return (cb) => b.onChanged(cb);
    },
  },
  {
    name: 'sync-bridge.sync.onStateChanged',
    channel: SYNC_CHANNELS.stateChanged,
    payloadArgs: [VALID_SYNC_STATE],
    expectedArgCount: 1,
    bind: (ipc) => {
      const b = createSyncBridges(ipc);
      return (cb) => b.sync.onStateChanged(cb);
    },
  },
  {
    name: 'sync-bridge.sync.onInitialPreferencesReceived',
    channel: SYNC_CHANNELS.initialPrefsReceived,
    payloadArgs: [{ theme: 'obsidianCrimson' }],
    expectedArgCount: 1,
    bind: (ipc) => {
      const b = createSyncBridges(ipc);
      return (cb) => {
        if (!b.sync.onInitialPreferencesReceived) {
          throw new Error('expected onInitialPreferencesReceived');
        }
        return b.sync.onInitialPreferencesReceived(cb);
      };
    },
  },
  {
    name: 'sync-bridge.sync.onPairDeepLink',
    channel: SYNC_CHANNELS.pairDeepLink,
    payloadArgs: ['elviptv://pair?code=12345678'],
    expectedArgCount: 1,
    bind: (ipc) => {
      const b = createSyncBridges(ipc);
      return (cb) => {
        if (!b.sync.onPairDeepLink) throw new Error('expected onPairDeepLink');
        return b.sync.onPairDeepLink(cb);
      };
    },
  },
  {
    name: 'lan-pairing-bridge.onPayloadReceived',
    channel: LAN_PAIRING_CHANNELS.payload,
    payloadArgs: [{ kind: 'm3u', name: 'Demo', url: 'https://example.test/list.m3u' }],
    expectedArgCount: 1,
    bind: (ipc) => {
      const b = createLanPairingBridge(ipc);
      return (cb) => b.onPayloadReceived(cb);
    },
  },
  {
    name: 'updater-bridge.onStateChanged',
    channel: UPDATER_CHANNELS.stateChanged,
    payloadArgs: [{ status: 'up-to-date', currentVersion: '0.1.0' }],
    expectedArgCount: 1,
    bind: (ipc) => {
      const b = createUpdaterBridge(ipc);
      return (cb) => b.onStateChanged(cb);
    },
  },
];

describe('Preload listener ownership & IPC error propagation contracts (F-14 #1)', () => {
  it.each(LISTENER_CASES)(
    '$name never leaks raw IpcRendererEvent and unsubscribes sibling listeners independently',
    (entry) => {
      const mock = createMockIpc();
      const subscribe = entry.bind(mock.ipc);
      const sub1Calls: unknown[][] = [];
      const sub2Calls: unknown[][] = [];

      const off1 = subscribe((...args) => sub1Calls.push(args));
      const off2 = subscribe((...args) => sub2Calls.push(args));

      mock.emit(entry.channel, ...entry.payloadArgs);
      expect(sub1Calls).toHaveLength(1);
      expect(sub2Calls).toHaveLength(1);
      expect(sub1Calls[0]).toHaveLength(entry.expectedArgCount);
      expect(sub2Calls[0]).toHaveLength(entry.expectedArgCount);

      // Raw Electron IpcRendererEvent must NEVER be forwarded in any argument slot!
      for (const arg of [...(sub1Calls[0] ?? []), ...(sub2Calls[0] ?? [])]) {
        expect(arg).not.toBe(SENTINEL_IPC_EVENT);
        expect(arg).not.toMatchObject({ __rawIpcRendererEvent: true });
      }

      // Unsubscribing sub1 must remove strictly sub1 while sub2 keeps receiving events!
      off1();
      mock.emit(entry.channel, ...entry.payloadArgs);
      expect(sub1Calls).toHaveLength(1);
      expect(sub2Calls).toHaveLength(2);

      // Unsubscribing sub2 stops deliveries cleanly
      off2();
      mock.emit(entry.channel, ...entry.payloadArgs);
      expect(sub1Calls).toHaveLength(1);
      expect(sub2Calls).toHaveLength(2);
      if (entry.ownsSingleSharedIpcListener !== true) {
        expect(mock.listenerCount(entry.channel)).toBe(0);
      }
    },
  );

  it('propagates IPC invoke rejections intact across all 8 preload bridges (never swallowed)', async () => {
    const boom = new Error('ipc-main-rejected-sentinel');
    const mock = createMockIpc();
    mock.invoke.mockRejectedValue(boom);

    const windowBridge = createWindowBridge(mock.ipc);
    const sourcesBridge = createSourcesBridge(mock.ipc);
    const artworkBridge = createArtworkBridge(mock.ipc);
    const playerBridge = createPlayerBridge(mock.ipc);
    const downloadsBridge = createDownloadsBridge(mock.ipc);
    const syncBridges = createSyncBridges(mock.ipc);
    const lanBridge = createLanPairingBridge(mock.ipc);
    const updaterBridge = createUpdaterBridge(mock.ipc);

    await expect(windowBridge.setAspectRatioLock(true)).rejects.toBe(boom);
    await expect(windowBridge.setZoomLevel?.(1)).rejects.toBe(boom);
    await expect(sourcesBridge.readClipboardText()).rejects.toBe(boom);
    await expect(sourcesBridge.pickPlaylistFile()).rejects.toBe(boom);
    await expect(sourcesBridge.consumePendingPlaylistFiles()).rejects.toBe(boom);
    await expect(artworkBridge.resolve('https://example.test/poster.jpg')).rejects.toBe(boom);
    await expect(artworkBridge.stats()).rejects.toBe(boom);
    await expect(playerBridge.open()).rejects.toBe(boom);
    await expect(playerBridge.close('engine-1')).rejects.toBe(boom);
    await expect(downloadsBridge.list()).rejects.toBe(boom);
    await expect(downloadsBridge.notifyOnlinePlaybackActive(true)).rejects.toBe(boom);
    await expect(syncBridges.sync.getState()).rejects.toBe(boom);
    await expect(syncBridges.telemetry.getStatus()).rejects.toBe(boom);
    await expect(
      syncBridges.feedback.submit({
        category: 'other',
        message: 'Testing rejection propagation',
        includeDiagnostics: false,
      }),
    ).rejects.toBe(boom);
    await expect(lanBridge.startSession()).rejects.toBe(boom);
    await expect(lanBridge.stopSession()).rejects.toBe(boom);
    await expect(updaterBridge.getState()).rejects.toBe(boom);
    await expect(updaterBridge.checkForUpdates()).rejects.toBe(boom);
    await expect(updaterBridge.downloadUpdate()).rejects.toBe(boom);
    await expect(updaterBridge.installUpdate()).rejects.toBe(boom);
    await expect(updaterBridge.openReleasePage()).rejects.toBe(boom);

    // Catalog bridge rejects in-flight callValue RPCs cleanly on worker disconnect
    const catalogMock = createMockIpc();
    const catalogBridge = createCatalogBridge(catalogMock.ipc as never);
    const inflight = catalogBridge.listSources();
    catalogMock.emit(CATALOG_CHANNELS.disconnected);
    await expect(inflight).rejects.toThrow(/worker-exited/i);
  });
});
