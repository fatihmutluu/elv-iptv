import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  isPlaylistDeliveryId,
  MAX_PICKED_PLAYLIST_BYTES,
  type PickedPlaylistFile,
  SOURCES_CHANNELS,
} from '../shared/sources-ipc.ts';
import { type PendingPlaylistQueue, readValidatedPlaylistFile } from './playlist-open.ts';
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
  if (filePath.startsWith('\\\\') || filePath.startsWith('//')) {
    throw new Error('Selected playlist path cannot be a network or device path');
  }
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

interface PendingSenderSubscription {
  readonly unackedIds: Set<string>;
  readonly cleanup: () => void;
}

/**
 * Registers desktop sources IPC handlers (`readClipboardText`, `pickPlaylistFile`,
 * `consumePendingPlaylists`, `ackPlaylistFile`, and `readDroppedPlaylistPath`) on `ipcMain`
 * while keeping `lockDownSession` 100% strict (`#51`, `#259`, Wave Q7). Never leaks host paths.
 */
export function registerSourcesIpc<TWindow = unknown>(deps: SourcesIpcDeps<TWindow>): () => void {
  const { ipcMain, getWindowFromSender, readClipboardText, showOpenDialog } = deps;
  const maxPlaylistBytes = deps.maxPlaylistBytes ?? MAX_PICKED_PLAYLIST_BYTES;
  const maxClipboardChars = deps.maxClipboardChars ?? DEFAULT_MAX_CLIPBOARD_CHARS;
  const pendingSubscriptions = new Map<SubscribableWebContents, PendingSenderSubscription>();

  const detachPendingSubscriber = (sender: SubscribableWebContents): void => {
    const entry = pendingSubscriptions.get(sender);
    if (!entry) return;
    pendingSubscriptions.delete(sender);
    if (entry.unackedIds.size > 0) {
      deps.pendingPlaylists?.requeueUnacked([...entry.unackedIds]);
      entry.unackedIds.clear();
    }
    entry.cleanup();
  };

  const subscribePendingSender = (sender: unknown): PendingSenderSubscription | null => {
    const queue = deps.pendingPlaylists;
    if (!queue || !isSubscribableWebContents(sender)) return null;
    if (sender.isDestroyed()) return null;
    const existing = pendingSubscriptions.get(sender);
    if (existing) return existing;

    const unackedIds = new Set<string>();
    const unsubscribeQueue = queue.subscribeDeliveries((delivery) => {
      if (sender.isDestroyed()) {
        queue.requeueUnacked([delivery.deliveryId]);
        detachPendingSubscriber(sender);
        return;
      }
      unackedIds.add(delivery.deliveryId);
      const wirePayload: PickedPlaylistFile = {
        ...delivery.file,
        deliveryId: delivery.deliveryId,
      };
      try {
        sender.send(SOURCES_CHANNELS.openPlaylistFile, wirePayload);
      } catch {
        unackedIds.delete(delivery.deliveryId);
        queue.requeueUnacked([delivery.deliveryId]);
        detachPendingSubscriber(sender);
      }
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

    const record: PendingSenderSubscription = {
      unackedIds,
      cleanup: () => {
        unsubscribeQueue();
        sender.removeListener?.(
          'did-start-navigation',
          onNavigation as (...args: unknown[]) => void,
        );
        sender.removeListener?.('render-process-gone', onGone);
        sender.removeListener?.('destroyed', onDestroyed);
      },
    };
    pendingSubscriptions.set(sender, record);
    return record;
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
    const sub = subscribePendingSender(event.sender);
    const entries = deps.pendingPlaylists?.consumePendingEntries() ?? [];
    return entries.map((entry): PickedPlaylistFile => {
      sub?.unackedIds.add(entry.deliveryId);
      return { ...entry.file, deliveryId: entry.deliveryId };
    });
  });

  ipcMain.handle(SOURCES_CHANNELS.ackPlaylistFile, async (event, deliveryId) => {
    assertTrustedSenderFrame(event, SOURCES_CHANNELS.ackPlaylistFile, deps.devOrigin, deps.log);
    if (!isPlaylistDeliveryId(deliveryId)) {
      deps.log?.(`sources ipc: dropped an invalid ${SOURCES_CHANNELS.ackPlaylistFile} payload`);
      return;
    }
    for (const sub of pendingSubscriptions.values()) {
      sub.unackedIds.delete(deliveryId);
    }
    deps.pendingPlaylists?.ackDelivery(deliveryId);
  });

  ipcMain.handle(SOURCES_CHANNELS.readDroppedPlaylistPath, async (event, rawPath) => {
    assertTrustedSenderFrame(
      event,
      SOURCES_CHANNELS.readDroppedPlaylistPath,
      deps.devOrigin,
      deps.log,
    );
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      deps.log?.(
        `sources ipc: dropped an invalid ${SOURCES_CHANNELS.readDroppedPlaylistPath} payload`,
      );
      return null;
    }
    return readValidatedPlaylistFile(rawPath, { maxBytes: maxPlaylistBytes });
  });

  return () => {
    for (const sender of [...pendingSubscriptions.keys()]) {
      detachPendingSubscriber(sender);
    }
    ipcMain.removeHandler(SOURCES_CHANNELS.readClipboardText);
    ipcMain.removeHandler(SOURCES_CHANNELS.pickPlaylistFile);
    ipcMain.removeHandler(SOURCES_CHANNELS.consumePendingPlaylists);
    ipcMain.removeHandler(SOURCES_CHANNELS.ackPlaylistFile);
    ipcMain.removeHandler(SOURCES_CHANNELS.readDroppedPlaylistPath);
  };
}
