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
  });

  it('drains buffered OS-opened playlists via sources:consume-pending-playlists and subscribes sender safely (#259)', async () => {
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
    const webContents = makeSender();

    // First consume drains buffered cold-start files and attaches a live subscription
    expect(await consumeHandler?.(trustedEvent(webContents.sender))).toEqual([payload]);
    // Calling consume a second time does not create duplicate subscriptions
    expect(await consumeHandler?.(trustedEvent(webContents.sender))).toEqual([]);
    expect(webContents.listenerCount('did-start-navigation')).toBe(1);

    // Live file arrives and is forwarded exactly once
    pendingPlaylists.enqueue(livePayload);
    expect(webContents.sent).toEqual([
      { channel: SOURCES_CHANNELS.openPlaylistFile, payload: livePayload },
    ]);

    // Subframe and same-document navigations keep the subscription active
    webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(webContents.listenerCount('did-start-navigation')).toBe(1);

    // Main-frame non-same-document navigation detaches so subsequent files buffer until reloaded page consumes
    webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(webContents.listenerCount('did-start-navigation')).toBe(0);
    pendingPlaylists.enqueue(afterNavPayload);
    expect(webContents.sent).toHaveLength(1);
    expect(pendingPlaylists.pendingCount).toBe(1);

    // Re-attaching drains buffered file and detaches on render-process-gone / destroyed
    expect(await consumeHandler?.(trustedEvent(webContents.sender))).toEqual([afterNavPayload]);
    webContents.emit('render-process-gone');
    expect(webContents.listenerCount('render-process-gone')).toBe(0);

    expect(await consumeHandler?.(trustedEvent(webContents.sender))).toEqual([]);
    webContents.destroy();
    expect(webContents.listenerCount('destroyed')).toBe(0);

    // Disposed registerSourcesIpc cleans up active subscriptions
    const webContents2 = makeSender();
    expect(await consumeHandler?.(trustedEvent(webContents2.sender))).toEqual([]);
    dispose();
    expect(webContents2.listenerCount('did-start-navigation')).toBe(0);
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
