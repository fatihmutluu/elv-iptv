import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  MAX_PICKED_PLAYLIST_BYTES,
  type PickedPlaylistFile,
  SOURCES_CHANNELS,
} from '../shared/sources-ipc.ts';
import type { PendingPlaylistQueue } from './playlist-open.ts';
import { assertTrustedSenderFrame, type TrustedSenderEventLike } from './trusted-sender.ts';

type IpcHandler = (
  event: TrustedSenderEventLike & { sender: unknown },
  ...args: unknown[]
) => unknown;

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
  pendingPlaylists?: PendingPlaylistQueue;
  maxPlaylistBytes?: number;
  maxClipboardChars?: number;
  devOrigin?: string | null;
  log?(line: string): void;
}

const DEFAULT_MAX_CLIPBOARD_CHARS = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

async function readBoundedPlaylistFile(filePath: string, maxBytes: number): Promise<Uint8Array> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) {
    throw new Error('Selected playlist path cannot be a symbolic link');
  }
  if (!info.isFile()) {
    throw new Error('Selected playlist path is not a regular file');
  }
  if (info.size > maxBytes) {
    throw new Error(`Selected playlist exceeds ${maxBytes} byte size limit`);
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const fdStat = await handle.stat({ bigint: true });
    const linkStat = await lstat(filePath, { bigint: true });
    if (
      linkStat.isSymbolicLink() ||
      !linkStat.isFile() ||
      !fdStat.isFile() ||
      fdStat.dev !== linkStat.dev ||
      fdStat.ino !== linkStat.ino
    ) {
      throw new Error('Selected playlist path changed or is not a regular file');
    }
    if (fdStat.size > BigInt(maxBytes)) {
      throw new Error(`Selected playlist exceeds ${maxBytes} byte size limit`);
    }
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

interface SubscribableWebContents {
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  once?(event: 'destroyed', listener: () => void): unknown;
  on?(
    event: 'did-start-navigation',
    listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void,
  ): unknown;
  on?(event: 'render-process-gone', listener: () => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

function isSubscribableWebContents(value: unknown): value is SubscribableWebContents {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<SubscribableWebContents>;
  return typeof candidate.send === 'function' && typeof candidate.isDestroyed === 'function';
}

/**
 * Registers `sources:read-clipboard-text`, `sources:pick-playlist-file`, and
 * `sources:consume-pending-playlists` handlers on `ipcMain` while keeping `lockDownSession` 100%
 * strict (`#51`, `#259`). Never leaks full host paths to the renderer.
 */
export function registerSourcesIpc<TWindow = unknown>(deps: SourcesIpcDeps<TWindow>): () => void {
  const { ipcMain, getWindowFromSender, readClipboardText, showOpenDialog } = deps;
  const maxPlaylistBytes = deps.maxPlaylistBytes ?? MAX_PICKED_PLAYLIST_BYTES;
  const maxClipboardChars = deps.maxClipboardChars ?? DEFAULT_MAX_CLIPBOARD_CHARS;
  const pendingSubscriptions = new Map<SubscribableWebContents, () => void>();

  const detachPendingSubscriber = (sender: SubscribableWebContents): void => {
    const cleanup = pendingSubscriptions.get(sender);
    if (!cleanup) return;
    pendingSubscriptions.delete(sender);
    cleanup();
  };

  const subscribePendingSender = (sender: unknown): void => {
    const queue = deps.pendingPlaylists;
    if (!queue || !isSubscribableWebContents(sender)) return;
    if (sender.isDestroyed() || pendingSubscriptions.has(sender)) return;

    const unsubscribeQueue = queue.subscribe((file) => {
      if (sender.isDestroyed()) {
        detachPendingSubscriber(sender);
        return;
      }
      sender.send(SOURCES_CHANNELS.openPlaylistFile, file);
    });

    const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
      if (details.isMainFrame && !details.isSameDocument) {
        detachPendingSubscriber(sender);
      }
    };
    const onGone = (): void => {
      detachPendingSubscriber(sender);
    };
    const onDestroyed = (): void => {
      detachPendingSubscriber(sender);
    };

    sender.on?.('did-start-navigation', onNavigation);
    sender.on?.('render-process-gone', onGone);
    sender.once?.('destroyed', onDestroyed);

    pendingSubscriptions.set(sender, () => {
      unsubscribeQueue();
      sender.removeListener?.('did-start-navigation', onNavigation as (...args: unknown[]) => void);
      sender.removeListener?.('render-process-gone', onGone);
      sender.removeListener?.('destroyed', onDestroyed);
    });
  };

  ipcMain.handle(SOURCES_CHANNELS.readClipboardText, async (event) => {
    assertTrustedSenderFrame(event, SOURCES_CHANNELS.readClipboardText, deps.devOrigin, deps.log);
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

  ipcMain.handle(SOURCES_CHANNELS.pickPlaylistFile, async (event) => {
    assertTrustedSenderFrame(event, SOURCES_CHANNELS.pickPlaylistFile, deps.devOrigin, deps.log);
    const win = getWindowFromSender(event.sender);
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

  ipcMain.handle(SOURCES_CHANNELS.consumePendingPlaylists, async (event) => {
    assertTrustedSenderFrame(
      event,
      SOURCES_CHANNELS.consumePendingPlaylists,
      deps.devOrigin,
      deps.log,
    );
    subscribePendingSender(event.sender);
    return deps.pendingPlaylists?.consumePending() ?? [];
  });

  return () => {
    for (const sender of [...pendingSubscriptions.keys()]) {
      detachPendingSubscriber(sender);
    }
    ipcMain.removeHandler(SOURCES_CHANNELS.readClipboardText);
    ipcMain.removeHandler(SOURCES_CHANNELS.pickPlaylistFile);
    ipcMain.removeHandler(SOURCES_CHANNELS.consumePendingPlaylists);
  };
}
