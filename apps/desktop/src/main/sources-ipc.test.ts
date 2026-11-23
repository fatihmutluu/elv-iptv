import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOURCES_CHANNELS } from '../shared/sources-ipc.ts';
import { registerSourcesIpc } from './sources-ipc.ts';

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
    expect(await readHandler?.({ sender: {} })).toBe('https://example.test/list.m3u');

    readClipboardText.mockReturnValueOnce('   ');
    expect(await readHandler?.({ sender: {} })).toBeNull();

    dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(SOURCES_CHANNELS.readClipboardText);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(SOURCES_CHANNELS.pickPlaylistFile);
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
    const picked = (await pickHandler?.({ sender: {} })) as {
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
    await expect(pickHandler?.({ sender: {} })).rejects.toThrow(/size|limit/i);

    // Cancelled dialog returns null
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await pickHandler?.({ sender: {} })).toBeNull();
  });
});
