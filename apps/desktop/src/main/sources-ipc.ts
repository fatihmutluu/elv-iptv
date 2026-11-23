import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  MAX_PICKED_PLAYLIST_BYTES,
  type PickedPlaylistFile,
  SOURCES_CHANNELS,
} from '../shared/sources-ipc.ts';

type IpcHandler = (event: { sender: unknown }, ...args: unknown[]) => unknown;

interface SourcesIpcMainLike {
  handle(channel: string, listener: IpcHandler): void;
  removeHandler(channel: string): void;
}

interface PlaylistOpenDialogOptions {
  readonly properties: readonly 'openFile'[];
  readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[];
}

interface PlaylistOpenDialogResult {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}

/** Collaborators injected into {@link registerSourcesIpc}. */
export interface SourcesIpcDeps<TWindow = unknown> {
  ipcMain: SourcesIpcMainLike;
  getWindowFromSender(sender: unknown): TWindow | null | undefined;
  readClipboardText(): string | Promise<string>;
  showOpenDialog(
    window: TWindow | null | undefined,
    options: PlaylistOpenDialogOptions,
  ): Promise<PlaylistOpenDialogResult>;
  maxPlaylistBytes?: number;
  maxClipboardChars?: number;
}

const DEFAULT_MAX_CLIPBOARD_CHARS = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

async function readBoundedPlaylistFile(filePath: string, maxBytes: number): Promise<Uint8Array> {
  const info = await stat(filePath);
  if (!info.isFile()) {
    throw new Error('Selected playlist path is not a regular file');
  }
  if (info.size > maxBytes) {
    throw new Error(`Selected playlist exceeds ${maxBytes} byte size limit`);
  }
  const handle = await open(filePath, 'r');
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buf, 0, READ_CHUNK_BYTES, null);
      if (bytesRead <= 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new Error(`Selected playlist exceeds ${maxBytes} byte size limit`);
      }
      chunks.push(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  } finally {
    await handle.close();
  }
}

/**
 * Registers `sources:read-clipboard-text` and `sources:pick-playlist-file` handlers on `ipcMain`
 * while keeping `lockDownSession` 100% strict (`#51`). Never leaks full host paths to the renderer.
 */
export function registerSourcesIpc<TWindow = unknown>(deps: SourcesIpcDeps<TWindow>): () => void {
  const { ipcMain, getWindowFromSender, readClipboardText, showOpenDialog } = deps;
  const maxPlaylistBytes = deps.maxPlaylistBytes ?? MAX_PICKED_PLAYLIST_BYTES;
  const maxClipboardChars = deps.maxClipboardChars ?? DEFAULT_MAX_CLIPBOARD_CHARS;

  ipcMain.handle(SOURCES_CHANNELS.readClipboardText, async () => {
    try {
      const raw = await readClipboardText();
      if (typeof raw !== 'string') return null;
      const trimmed = raw.trim();
      if (trimmed.length === 0) return null;
      return raw.slice(0, maxClipboardChars);
    } catch {
      return null;
    }
  });

  ipcMain.handle(SOURCES_CHANNELS.pickPlaylistFile, async ({ sender }) => {
    const win = getWindowFromSender(sender);
    const result = await showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'M3U Playlists', extensions: ['m3u', 'm3u8', 'gz'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const selectedPath = result.filePaths[0];
    if (!selectedPath) return null;
    const bytes = await readBoundedPlaylistFile(selectedPath, maxPlaylistBytes);
    const name = basename(selectedPath).trim() || 'playlist.m3u';
    const picked: PickedPlaylistFile = { name, bytes };
    return picked;
  });

  return () => {
    ipcMain.removeHandler(SOURCES_CHANNELS.readClipboardText);
    ipcMain.removeHandler(SOURCES_CHANNELS.pickPlaylistFile);
  };
}
