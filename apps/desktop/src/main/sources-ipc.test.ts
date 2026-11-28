import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOURCES_CHANNELS } from '../shared/sources-ipc.ts';
import { createPendingPlaylistQueue } from './playlist-open.ts';
import { registerSourcesIpc } from './sources-ipc.ts';

function trustedFrame(url = 'app://elv/index.html') {
  const frame: { url: string; top: unknown } = { url, top: undefined };
  frame.top = frame;
  return frame;
}

function trustedEvent(sender: unknown = {}) {
  return { sender, senderFrame: trustedFrame() };
}

const dirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elv-sources-ipc-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('registerSourcesIpc (#51)', () => {
  it('reads clipboard text cleanly and returns null when empty', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(ch, fn);
      }),
      removeHandler: vi.fn((ch: string) => {
        handlers.delete(ch);
      }),
    };
    const readClipboardText = vi.fn(() => 'https://example.test/list.m3u');
    const dispose = registerSourcesIpc({
      ipcMain,
      getWindowFromSender: () => null,
      readClipboardText,
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    });

    const readHandler = handlers.get(SOURCES_CHANNELS.readClipboardText);
    expect(readHandler).toBeDefined();
    expect(await readHandler?.(trustedEvent())).toBe('https://example.test/list.m3u');

    readClipboardText.mockReturnValueOnce('   ');
    expect(await readHandler?.(trustedEvent())).toBeNull();

    dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(SOURCES_CHANNELS.readClipboardText);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(SOURCES_CHANNELS.pickPlaylistFile);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(SOURCES_CHANNELS.consumePendingPlaylists);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(SOURCES_CHANNELS.ackPlaylistFile);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(SOURCES_CHANNELS.readDroppedPlaylistPath);
  });

  it('drains buffered OS-opened playlists with deliveryId, handles ACK, and requeues unacked files on crash/navigation (#259, Wave Q7)', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(ch, fn);
      }),
      removeHandler: vi.fn(),
    };
    const pendingPlaylists = createPendingPlaylistQueue();
    const payload = { name: 'launched.m3u8', bytes: new Uint8Array([35, 69, 88, 84]) };
    const livePayload = { name: 'second.m3u', bytes: new Uint8Array([1, 2, 3]) };
    const unackedLivePayload = { name: 'lost-unless-requeued.m3u', bytes: new Uint8Array([7, 8]) };
    const afterNavPayload = { name: 'after-nav.m3u', bytes: new Uint8Array([4, 5, 6]) };
    pendingPlaylists.enqueue(payload);

    const makeSender = () => {
      let destroyed = false;
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const sent: Array<{ channel: string; payload: unknown }> = [];
      return {
        sent,
        sender: {
          isDestroyed: () => destroyed,
          send: (channel: string, data: unknown) => {
            sent.push({ channel, payload: data });
          },
          on: (event: string, listener: (...args: unknown[]) => void) => {
            const set = listeners.get(event) ?? new Set();
            set.add(listener);
            listeners.set(event, set);
          },
          once: (event: string, listener: (...args: unknown[]) => void) => {
            const set = listeners.get(event) ?? new Set();
            set.add(listener);
            listeners.set(event, set);
          },
          removeListener: (event: string, listener: (...args: unknown[]) => void) => {
            listeners.get(event)?.delete(listener);
          },
        },
        emit: (event: string, ...args: unknown[]) => {
          for (const l of [...(listeners.get(event) ?? [])]) l(...args);
        },
        destroy: () => {
          destroyed = true;
          for (const l of [...(listeners.get('destroyed') ?? [])]) l();
        },
        listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
      };
    };

    const dispose = registerSourcesIpc({
      ipcMain,
      getWindowFromSender: () => null,
      readClipboardText: () => '',
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      pendingPlaylists,
    });

    const consumeHandler = handlers.get(SOURCES_CHANNELS.consumePendingPlaylists);
    const ackHandler = handlers.get(SOURCES_CHANNELS.ackPlaylistFile);
    const webContents = makeSender();

    // First consume drains buffered cold-start files with deliveryId and attaches live subscription
    const initial = (await consumeHandler?.(trustedEvent(webContents.sender))) as Array<{
      name: string;
      bytes: Uint8Array;
      deliveryId?: string;
    }>;
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject(payload);
    expect(typeof initial[0]?.deliveryId).toBe('string');
    await ackHandler?.(trustedEvent(webContents.sender), initial[0]?.deliveryId);
    expect(pendingPlaylists.awaitingAckCount).toBe(0);

    // Calling consume a second time does not create duplicate subscriptions
    expect(await consumeHandler?.(trustedEvent(webContents.sender))).toEqual([]);
    expect(webContents.listenerCount('did-start-navigation')).toBe(1);

    // Live file arrives with deliveryId and is acknowledged
    pendingPlaylists.enqueue(livePayload);
    expect(webContents.sent).toHaveLength(1);
    const firstLive = webContents.sent[0]?.payload as { name: string; deliveryId?: string };
    expect(webContents.sent[0]?.channel).toBe(SOURCES_CHANNELS.openPlaylistFile);
    expect(firstLive).toMatchObject(livePayload);
    expect(typeof firstLive.deliveryId).toBe('string');
    await ackHandler?.(trustedEvent(webContents.sender), firstLive.deliveryId);
    expect(pendingPlaylists.awaitingAckCount).toBe(0);

    // Subframe and same-document navigations keep the subscription active
    webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(webContents.listenerCount('did-start-navigation')).toBe(1);

    // Unacked live delivery is automatically requeued if cross-document navigation fires before ACK!
    pendingPlaylists.enqueue(unackedLivePayload);
    expect(webContents.sent).toHaveLength(2);
    expect(pendingPlaylists.awaitingAckCount).toBe(1);
    webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(webContents.listenerCount('did-start-navigation')).toBe(0);
    expect(pendingPlaylists.pendingCount).toBe(1);
    expect(pendingPlaylists.awaitingAckCount).toBe(0);

    // Subsequent enqueue buffers behind the requeued item
    pendingPlaylists.enqueue(afterNavPayload);
    expect(webContents.sent).toHaveLength(2);
    expect(pendingPlaylists.pendingCount).toBe(2);

    // Re-attaching drains both files; crashing via render-process-gone before ACK requeues them!
    const redrained = (await consumeHandler?.(trustedEvent(webContents.sender))) as Array<{
      name: string;
      deliveryId?: string;
    }>;
    expect(redrained.map((f) => f.name)).toEqual([unackedLivePayload.name, afterNavPayload.name]);
    webContents.emit('render-process-gone');
    expect(webContents.listenerCount('render-process-gone')).toBe(0);
    expect(pendingPlaylists.pendingCount).toBe(2);

    // Re-attaching and acking clears queue cleanly
    const recovered = (await consumeHandler?.(trustedEvent(webContents.sender))) as Array<{
      name: string;
      deliveryId?: string;
    }>;
    expect(recovered).toHaveLength(2);
    for (const f of recovered) {
      await ackHandler?.(trustedEvent(webContents.sender), f.deliveryId);
    }
    webContents.destroy();
    expect(webContents.listenerCount('destroyed')).toBe(0);
    expect(pendingPlaylists.pendingCount).toBe(0);

    // Disposed registerSourcesIpc cleans up active subscriptions
    const webContents2 = makeSender();
    expect(await consumeHandler?.(trustedEvent(webContents2.sender))).toEqual([]);
    dispose();
    expect(webContents2.listenerCount('did-start-navigation')).toBe(0);
  });

  it('validates dropped local playlist paths in main via sources:read-dropped-playlist-path without returning host paths (Wave Q7)', async () => {
    const dir = makeTempDir();
    const okPath = join(dir, 'dropped.m3u8');
    const badExt = join(dir, 'secret.txt');
    const content = new TextEncoder().encode('#EXTM3U\n#EXTINF:-1,Drop\nhttp://a/1.ts\n');
    writeFileSync(okPath, content);
    writeFileSync(badExt, 'nope');

    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(ch, fn);
      }),
      removeHandler: vi.fn(),
    };
    const dispose = registerSourcesIpc({
      ipcMain,
      getWindowFromSender: () => null,
      readClipboardText: () => '',
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      maxPlaylistBytes: 1024,
    });

    const dropHandler = handlers.get(SOURCES_CHANNELS.readDroppedPlaylistPath);
    const result = (await dropHandler?.(trustedEvent(), okPath)) as {
      name: string;
      bytes: Uint8Array;
    } | null;
    expect(result).not.toBeNull();
    expect(result?.name).toBe('dropped.m3u8');
    expect(Array.from(result?.bytes ?? [])).toEqual(Array.from(content));
    expect(Object.keys(result ?? {})).toEqual(['name', 'bytes']);

    expect(await dropHandler?.(trustedEvent(), badExt)).toBeNull();
    expect(await dropHandler?.(trustedEvent(), 'https://evil.example/a.m3u')).toBeNull();
    expect(await dropHandler?.(trustedEvent(), '\\\\evil\\share\\a.m3u')).toBeNull();
    expect(await dropHandler?.(trustedEvent(), '\\\\?\\UNC\\evil\\share\\a.m3u')).toBeNull();
    expect(await dropHandler?.(trustedEvent(), '\\\\.\\pipe\\a.m3u')).toBeNull();
    expect(await dropHandler?.(trustedEvent(), 'file:///%5C%5Cevil%5Cshare%5Ca.m3u')).toBeNull();
    expect(await dropHandler?.(trustedEvent(), 123)).toBeNull();

    await expect(
      dropHandler?.({ sender: {}, senderFrame: trustedFrame('https://evil.example/') }, okPath),
    ).rejects.toThrow(/untrusted sender/i);
    dispose();
  });

  it('requeues delivery when sender.send throws synchronously and prunes ACK across all tracked windows (MINOR-11)', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(ch, fn);
      }),
      removeHandler: vi.fn(),
    };
    const pendingPlaylists = createPendingPlaylistQueue();
    const dispose = registerSourcesIpc({
      ipcMain,
      getWindowFromSender: () => null,
      readClipboardText: () => '',
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      pendingPlaylists,
    });

    const consumeHandler = handlers.get(SOURCES_CHANNELS.consumePendingPlaylists);
    const ackHandler = handlers.get(SOURCES_CHANNELS.ackPlaylistFile);

    // Throwing sender.send must immediately requeue delivery without losing it
    const throwingSender = {
      isDestroyed: () => false,
      send: () => {
        throw new Error('Object has been destroyed');
      },
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    };
    expect(await consumeHandler?.(trustedEvent(throwingSender))).toEqual([]);
    const fileA = { name: 'survives-send-throw.m3u', bytes: new Uint8Array([1, 2, 3]) };
    pendingPlaylists.enqueue(fileA);
    expect(pendingPlaylists.pendingCount).toBe(1);
    expect(pendingPlaylists.awaitingAckCount).toBe(0);

    // Multi-window ACK: if Window 1 receives delivery and Window 2 ACKs it, Window 1 detaching must NOT requeue it
    const makeTrackableSender = () => {
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const sent: unknown[] = [];
      return {
        sent,
        sender: {
          isDestroyed: () => false,
          send: (_ch: string, data: unknown) => sent.push(data),
          on: (ev: string, fn: (...args: unknown[]) => void) => {
            const set = listeners.get(ev) ?? new Set();
            set.add(fn);
            listeners.set(ev, set);
          },
          once: (ev: string, fn: (...args: unknown[]) => void) => {
            const set = listeners.get(ev) ?? new Set();
            set.add(fn);
            listeners.set(ev, set);
          },
          removeListener: (ev: string, fn: (...args: unknown[]) => void) => {
            listeners.get(ev)?.delete(fn);
          },
        },
        emit: (ev: string, ...args: unknown[]) => {
          for (const fn of [...(listeners.get(ev) ?? [])]) fn(...args);
        },
      };
    };

    const win1 = makeTrackableSender();
    const win2 = makeTrackableSender();
    const drained = (await consumeHandler?.(trustedEvent(win1.sender))) as Array<{
      name: string;
      deliveryId?: string;
    }>;
    expect(drained.map((d) => d.name)).toEqual(['survives-send-throw.m3u']);
    expect(await consumeHandler?.(trustedEvent(win2.sender))).toEqual([]);

    // Window 2 ACKs the delivery that Window 1 received
    await ackHandler?.(trustedEvent(win2.sender), drained[0]?.deliveryId);
    expect(pendingPlaylists.awaitingAckCount).toBe(0);

    // Window 1 navigates away — must NOT requeue the already-ACKed delivery
    win1.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(pendingPlaylists.pendingCount).toBe(0);

    dispose();
  });

  it('picks a local playlist file with bounded <= 64 MiB read and strips host directory paths', async () => {
    const dir = makeTempDir();
    const playlistPath = join(dir, 'my-channels.m3u8');
    const content = new TextEncoder().encode('#EXTM3U\n#EXTINF:-1,One\nhttp://a/1.ts\n');
    writeFileSync(playlistPath, content);

    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(ch, fn);
      }),
      removeHandler: vi.fn(),
    };
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: [playlistPath] }));
    registerSourcesIpc({
      ipcMain,
      getWindowFromSender: () => null,
      readClipboardText: () => '',
      showOpenDialog,
      maxPlaylistBytes: 1024,
    });

    const pickHandler = handlers.get(SOURCES_CHANNELS.pickPlaylistFile);
    const picked = (await pickHandler?.(trustedEvent())) as {
      name: string;
      bytes: Uint8Array;
    } | null;
    expect(picked).not.toBeNull();
    expect(picked?.name).toBe('my-channels.m3u8');
    expect(Array.from(picked?.bytes ?? [])).toEqual(Array.from(content));
    expect(showOpenDialog).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        properties: ['openFile'],
        filters: [expect.objectContaining({ extensions: ['m3u', 'm3u8', 'gz'] })],
      }),
    );

    // Oversized file is rejected cleanly
    const bigPath = join(dir, 'huge.m3u');
    writeFileSync(bigPath, new Uint8Array(1025));
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [bigPath] });
    await expect(pickHandler?.(trustedEvent())).rejects.toThrow(/size|limit/i);

    // Cancelled dialog returns null
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await pickHandler?.(trustedEvent())).toBeNull();

    // Non-regular directory and symlinks are rejected cleanly without following links
    const folderPath = join(dir, 'not-a-file.m3u');
    mkdirSync(folderPath);
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [folderPath] });
    await expect(pickHandler?.(trustedEvent())).rejects.toThrow(/regular file|symlink/i);

    const symPath = join(dir, 'linked.m3u');
    let linkCreated = false;
    try {
      symlinkSync(playlistPath, symPath);
      linkCreated = true;
    } catch {
      if (process.platform === 'win32') {
        try {
          symlinkSync(folderPath, symPath, 'junction');
          linkCreated = true;
        } catch {
          linkCreated = false;
        }
      }
    }
    if (linkCreated) {
      showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [symPath] });
      await expect(pickHandler?.(trustedEvent())).rejects.toThrow(/symbolic link/i);
    }
  });

  it('rejects untrusted senderFrame, missing senderFrame, and subframes on all sources IPC channels', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(ch, fn);
      }),
      removeHandler: vi.fn(),
    };
    const readClipboardText = vi.fn(() => 'secret');
    const showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));
    const log = vi.fn();

    const dispose = registerSourcesIpc({
      ipcMain,
      getWindowFromSender: () => null,
      readClipboardText,
      showOpenDialog,
      log,
    });

    const top = trustedFrame();
    const badEvents = [
      { sender: {} },
      { sender: {}, senderFrame: null },
      { sender: {}, senderFrame: { url: 'app://elv/index.html', top } },
      { sender: {}, senderFrame: trustedFrame('https://evil.example/') },
    ];
    for (const ch of [
      SOURCES_CHANNELS.readClipboardText,
      SOURCES_CHANNELS.pickPlaylistFile,
      SOURCES_CHANNELS.consumePendingPlaylists,
    ]) {
      const fn = handlers.get(ch);
      for (const ev of badEvents) {
        await expect(fn?.(ev)).rejects.toThrow(/untrusted sender/i);
      }
    }
    expect(readClipboardText).not.toHaveBeenCalled();
    expect(showOpenDialog).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(badEvents.length * 3);
    dispose();
  });
});
