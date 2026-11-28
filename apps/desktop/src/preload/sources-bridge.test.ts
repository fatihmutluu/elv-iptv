import { describe, expect, it, vi } from 'vitest';
import { type PickedPlaylistFile, SOURCES_CHANNELS } from '../shared/sources-ipc.ts';
import { createSourcesBridge } from './sources-bridge.ts';

describe('createSourcesBridge (#51, #259)', () => {
  it('invokes clipboard, playlist picker, and pending playlist channels and validates replies', async () => {
    const bytes = new Uint8Array([35, 69, 88, 84]);
    const invoke = vi.fn(async (channel: string) => {
      if (channel === SOURCES_CHANNELS.readClipboardText) return 'https://example.test/a.m3u';
      if (channel === SOURCES_CHANNELS.pickPlaylistFile) return { name: 'a.m3u', bytes };
      if (channel === SOURCES_CHANNELS.consumePendingPlaylists) return [{ name: 'b.m3u8', bytes }];
      return null;
    });
    const listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();
    const on = vi.fn((ch: string, fn: (event: unknown, ...args: unknown[]) => void) => {
      const set = listeners.get(ch) ?? new Set();
      set.add(fn);
      listeners.set(ch, set);
    });
    const removeListener = vi.fn((ch: string, fn: (event: unknown, ...args: unknown[]) => void) => {
      listeners.get(ch)?.delete(fn);
    });
    const bridge = createSourcesBridge({ invoke, on, removeListener });
    expect(Object.isFrozen(bridge)).toBe(true);

    expect(await bridge.readClipboardText()).toBe('https://example.test/a.m3u');
    expect(await bridge.pickPlaylistFile()).toEqual({ name: 'a.m3u', bytes });
    expect(await bridge.consumePendingPlaylistFiles()).toEqual([{ name: 'b.m3u8', bytes }]);

    invoke.mockResolvedValueOnce(null);
    expect(await bridge.readClipboardText()).toBeNull();

    invoke.mockResolvedValueOnce(null);
    expect(await bridge.pickPlaylistFile()).toBeNull();

    invoke.mockResolvedValueOnce({ name: 'bad', bytes: 'not-bytes' } as never);
    await expect(bridge.pickPlaylistFile()).rejects.toThrow();

    invoke.mockResolvedValueOnce([{ name: '', bytes }] as never);
    await expect(bridge.consumePendingPlaylistFiles()).rejects.toThrow();

    const received: PickedPlaylistFile[] = [];
    const unsubscribe = bridge.onOpenPlaylistFile((file) => received.push(file));
    for (const fn of listeners.get(SOURCES_CHANNELS.openPlaylistFile) ?? []) {
      fn({}, { name: 'live.m3u', bytes });
      fn({}, { name: '', bytes: 'invalid' });
    }
    expect(received).toEqual([{ name: 'live.m3u', bytes }]);

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(
      SOURCES_CHANNELS.openPlaylistFile,
      expect.any(Function),
    );
    expect(listeners.get(SOURCES_CHANNELS.openPlaylistFile)?.size).toBe(0);
  });

  it('defers delivery ACK to caller (never eagerly ACKs) and resolves dropped files strictly inside preload via webUtils (Wave Q7, MINOR-11)', async () => {
    const bytes = new Uint8Array([35, 69, 88, 84]);
    const invoke = vi.fn(async (channel: string, arg?: unknown) => {
      if (channel === SOURCES_CHANNELS.consumePendingPlaylists) {
        return [{ name: 'cold.m3u', bytes, deliveryId: 'pl-1' }];
      }
      if (
        channel === SOURCES_CHANNELS.readDroppedPlaylistPath &&
        arg === 'C:\\Users\\demo\\drop.m3u'
      ) {
        return { name: 'drop.m3u', bytes };
      }
      return undefined;
    });
    const listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();
    const on = vi.fn((ch: string, fn: (event: unknown, ...args: unknown[]) => void) => {
      const set = listeners.get(ch) ?? new Set();
      set.add(fn);
      listeners.set(ch, set);
    });
    const removeListener = vi.fn((ch: string, fn: (event: unknown, ...args: unknown[]) => void) => {
      listeners.get(ch)?.delete(fn);
    });
    const getPathForFile = vi.fn(() => 'C:\\Users\\demo\\drop.m3u');

    const bridge = createSourcesBridge({ invoke, on, removeListener }, { getPathForFile });

    // Consuming pending files preserves deliveryId WITHOUT eagerly invoking ackPlaylistFile
    const pending = await bridge.consumePendingPlaylistFiles();
    expect(pending).toEqual([{ name: 'cold.m3u', bytes, deliveryId: 'pl-1' }]);
    expect(invoke).not.toHaveBeenCalledWith(SOURCES_CHANNELS.ackPlaylistFile, expect.anything());

    // Live file preserves deliveryId WITHOUT eagerly invoking ackPlaylistFile
    const liveReceived: PickedPlaylistFile[] = [];
    const off = bridge.onOpenPlaylistFile((f) => liveReceived.push(f));
    for (const fn of listeners.get(SOURCES_CHANNELS.openPlaylistFile) ?? []) {
      fn({}, { name: 'live.m3u8', bytes, deliveryId: 'pl-3' });
    }
    expect(liveReceived).toEqual([{ name: 'live.m3u8', bytes, deliveryId: 'pl-3' }]);
    expect(invoke).not.toHaveBeenCalledWith(SOURCES_CHANNELS.ackPlaylistFile, expect.anything());
    off();

    // Explicit ack validates deliveryId and sends IPC once React stages the playlist
    await bridge.ackPlaylistFile?.('pl-1');
    expect(invoke).toHaveBeenCalledWith(SOURCES_CHANNELS.ackPlaylistFile, 'pl-1');
    await expect(bridge.ackPlaylistFile?.('')).rejects.toThrow();

    // Dropped file resolves path strictly inside preload and returns basename + bytes only
    const fakeFile = { name: 'drop.m3u' } as unknown as File;
    const dropped = await bridge.readDroppedPlaylistFile?.(fakeFile);
    expect(getPathForFile).toHaveBeenCalledWith(fakeFile);
    expect(invoke).toHaveBeenCalledWith(
      SOURCES_CHANNELS.readDroppedPlaylistPath,
      'C:\\Users\\demo\\drop.m3u',
    );
    expect(dropped).toEqual({ name: 'drop.m3u', bytes });

    // Without webUtils, readDroppedPlaylistFile returns null cleanly
    const noWebUtilsBridge = createSourcesBridge({ invoke, on, removeListener });
    expect(await noWebUtilsBridge.readDroppedPlaylistFile?.(fakeFile)).toBeNull();
  });
});
