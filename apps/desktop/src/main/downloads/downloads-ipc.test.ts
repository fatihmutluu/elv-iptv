import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DownloadRecord } from '@elv/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesktopDownloadsPort } from '../../../renderer/src/downloads/desktop-downloads-port.ts';
import {
  createDownloadsBridge,
  type DownloadsIpcRendererLike,
} from '../../preload/downloads-bridge.ts';
import {
  DOWNLOADS_CHANNELS,
  isDownloadEnqueueRequest,
  isDownloadRecord,
} from '../../shared/downloads-ipc.ts';
import { createDesktopDownloadManager, type DesktopDownloadManager } from './download-manager.ts';
import { type DownloadsIpcMainLike, registerDownloadsIpc } from './ipc.ts';

const tempDirs: string[] = [];
const servers: Server[] = [];
const managers: DesktopDownloadManager[] = [];

afterEach(async () => {
  for (const mgr of managers.splice(0)) await mgr.dispose();
  for (const srv of servers.splice(0)) {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('downloads IPC, preload bridge, and desktop port', () => {
  it('strictly validates enqueue requests (VOD only, http/https only) and rejects untrusted senders', async () => {
    expect(
      isDownloadEnqueueRequest({
        sourceId: 'src-1',
        itemKey: 'live:1',
        kind: 'live',
        title: 'Live Channel',
        streamUrl: 'http://example.test/live.ts',
      }),
    ).toBe(false);

    expect(
      isDownloadEnqueueRequest({
        sourceId: 'src-1',
        itemKey: 'movie:1',
        kind: 'movie',
        title: 'Local Attempt',
        streamUrl: 'file:///etc/passwd',
      }),
    ).toBe(false);

    expect(
      isDownloadEnqueueRequest({
        sourceId: 'src-1',
        itemKey: 'movie:1',
        kind: 'movie',
        title: 'Valid Movie',
        streamUrl: 'https://cdn.example.test/movie.mp4',
      }),
    ).toBe(true);

    const downloadsDir = await mkdtemp(path.join(tmpdir(), 'elv-dl-ipc-'));
    tempDirs.push(downloadsDir);
    const manager = createDesktopDownloadManager({ downloadsDir });
    managers.push(manager);

    type TestHandler = Parameters<DownloadsIpcMainLike['handle']>[1];
    const handlers = new Map<string, TestHandler>();
    const ipcMain: DownloadsIpcMainLike = {
      handle: (ch, fn) => void handlers.set(ch, fn),
      removeHandler: (ch) => void handlers.delete(ch),
    };
    const dispose = registerDownloadsIpc({ ipcMain, manager });

    const listHandler = handlers.get(DOWNLOADS_CHANNELS.list);
    expect(listHandler).toBeDefined();
    await expect(
      Promise.resolve(listHandler?.({ senderFrame: { url: 'https://evil.example/' } }, {})),
    ).rejects.toThrow('untrusted sender');
    await expect(Promise.resolve(listHandler?.({ senderFrame: null }, {}))).rejects.toThrow(
      'untrusted sender',
    );

    dispose();
    expect(handlers.size).toBe(0);
  });

  it('round-trips enqueue, list, get, notifyOnlinePlaybackActive, broadcast, and remove across bridge & port', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': '12' });
      res.end(Buffer.from('hello-movie!'));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

    const downloadsDir = await mkdtemp(path.join(tmpdir(), 'elv-dl-bridge-'));
    tempDirs.push(downloadsDir);
    const manager = createDesktopDownloadManager({ downloadsDir, progressThrottleMs: 0 });
    managers.push(manager);

    type TestHandler = Parameters<DownloadsIpcMainLike['handle']>[1];
    const handlers = new Map<string, TestHandler>();
    const rendererListeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();

    const ipcMain: DownloadsIpcMainLike = {
      handle: (ch, fn) => void handlers.set(ch, fn),
      removeHandler: (ch) => void handlers.delete(ch),
    };

    const trustedWindow = {
      isDestroyed: () => false,
      getURL: () => 'app://elv/',
      send: (channel: string, ...args: unknown[]) => {
        for (const fn of rendererListeners.get(channel) ?? []) fn({}, ...args);
      },
    };
    const untrustedWindow = {
      isDestroyed: () => false,
      getURL: () => 'https://untrusted.example/',
      send: () => {
        throw new Error('must never broadcast to untrusted window');
      },
    };

    const dispose = registerDownloadsIpc({
      ipcMain,
      manager,
      getBroadcastTargets: () => [trustedWindow, untrustedWindow],
    });

    const trustedFrame = { url: 'app://elv/' };
    const ipcRenderer: DownloadsIpcRendererLike = {
      invoke: (channel, ...args) => {
        const handler = handlers.get(channel);
        if (!handler) return Promise.reject(new Error(`missing handler ${channel}`));
        return Promise.resolve(handler({ senderFrame: trustedFrame }, ...args));
      },
      on: (channel, listener) => {
        let set = rendererListeners.get(channel);
        if (!set) {
          set = new Set();
          rendererListeners.set(channel, set);
        }
        set.add(listener);
      },
      removeListener: (channel, listener) => {
        rendererListeners.get(channel)?.delete(listener);
      },
    };

    const bridge = createDownloadsBridge(ipcRenderer);
    const port = createDesktopDownloadsPort(bridge);
    expect(port.supported).toBe(true);

    const snapshots: Array<readonly DownloadRecord[]> = [];
    const unsub = port.subscribe((records) => snapshots.push(records));

    const res = await port.enqueue({
      sourceId: 'src-1',
      itemKey: 'movie:bridge-1',
      kind: 'movie',
      title: 'Bridge Movie',
      streamUrl: `${baseUrl}/movie.mp4`,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(isDownloadRecord(res.value)).toBe(true);

    // Wait for download to finish.
    for (let i = 0; i < 40; i += 1) {
      const rec = await port.get('movie:bridge-1');
      if (rec?.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const listed = await port.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe('completed');
    expect(snapshots.length).toBeGreaterThan(0);

    await port.notifyOnlinePlaybackActive?.(true);
    await port.notifyOnlinePlaybackActive?.(false);

    const removed = await port.remove('movie:bridge-1');
    expect(removed.ok).toBe(true);
    expect(await port.list()).toHaveLength(0);

    unsub();
    dispose();

    // Unsupported fallback outside Electron preload.
    const fallback = createDesktopDownloadsPort(undefined);
    expect(fallback.supported).toBe(false);
    expect(await fallback.list()).toEqual([]);
    const enqueueRes = await fallback.enqueue({
      sourceId: 'src-1',
      itemKey: 'movie:1',
      kind: 'movie',
      title: 'Fallback',
      streamUrl: 'https://example.test/m.mp4',
    });
    expect(enqueueRes.ok).toBe(false);
  });
});
