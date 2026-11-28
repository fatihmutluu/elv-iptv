import {
  isClipboardTextReply,
  isPickedPlaylistFile,
  isPickedPlaylistFileArrayReply,
  isPickedPlaylistFileReply,
  isPlaylistDeliveryId,
  type PickedPlaylistFile,
  SOURCES_CHANNELS,
  type SourcesBridge,
} from '../shared/sources-ipc.ts';

/** Subset of Electron's `ipcRenderer` used by {@link createSourcesBridge}. */
export interface SourcesIpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/** Subset of Electron's `webUtils` used strictly inside preload to resolve dropped File paths. */
export interface SourcesWebUtilsLike {
  getPathForFile(file: File): string;
}

/** Builds the frozen `window.elv.sources` bridge inside the sandboxed Electron preload (`#51`, `#259`, Wave Q7). */
export function createSourcesBridge(
  ipc: SourcesIpcRendererLike,
  webUtils?: SourcesWebUtilsLike,
): SourcesBridge {
  const bridge: SourcesBridge = {
    async readClipboardText(): Promise<string | null> {
      const reply = await ipc.invoke(SOURCES_CHANNELS.readClipboardText);
      if (!isClipboardTextReply(reply)) {
        throw new Error('sources:read-clipboard-text returned an unexpected reply');
      }
      return reply;
    },
    async pickPlaylistFile(): Promise<PickedPlaylistFile | null> {
      const reply = await ipc.invoke(SOURCES_CHANNELS.pickPlaylistFile);
      if (!isPickedPlaylistFileReply(reply)) {
        throw new Error('sources:pick-playlist-file returned an unexpected reply');
      }
      return reply;
    },
    async consumePendingPlaylistFiles(): Promise<PickedPlaylistFile[]> {
      const reply = await ipc.invoke(SOURCES_CHANNELS.consumePendingPlaylists);
      if (!isPickedPlaylistFileArrayReply(reply)) {
        throw new Error('sources:consume-pending-playlists returned an unexpected reply');
      }
      return reply;
    },
    onOpenPlaylistFile(listener: (file: PickedPlaylistFile) => void): () => void {
      const wrapped = (_event: unknown, payload: unknown): void => {
        if (!isPickedPlaylistFile(payload)) return;
        listener(payload);
      };
      ipc.on(SOURCES_CHANNELS.openPlaylistFile, wrapped);
      return () => {
        ipc.removeListener(SOURCES_CHANNELS.openPlaylistFile, wrapped);
      };
    },
    async ackPlaylistFile(deliveryId: string): Promise<void> {
      if (!isPlaylistDeliveryId(deliveryId)) {
        throw new Error('sources:ack-playlist-file requires a valid deliveryId');
      }
      await ipc.invoke(SOURCES_CHANNELS.ackPlaylistFile, deliveryId);
    },
    async readDroppedPlaylistFile(file: File): Promise<PickedPlaylistFile | null> {
      if (!webUtils || typeof webUtils.getPathForFile !== 'function') return null;
      let filePath: string;
      try {
        filePath = webUtils.getPathForFile(file);
      } catch {
        return null;
      }
      if (typeof filePath !== 'string' || filePath.trim().length === 0) return null;
      const reply = await ipc.invoke(SOURCES_CHANNELS.readDroppedPlaylistPath, filePath);
      if (!isPickedPlaylistFileReply(reply)) {
        throw new Error('sources:read-dropped-playlist-path returned an unexpected reply');
      }
      return reply;
    },
  };
  return Object.freeze(bridge);
}
