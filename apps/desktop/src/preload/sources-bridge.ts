import {
  isClipboardTextReply,
  isPickedPlaylistFile,
  isPickedPlaylistFileArrayReply,
  isPickedPlaylistFileReply,
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

/** Builds the frozen `window.elv.sources` bridge inside the sandboxed Electron preload (`#51`, `#259`). */
export function createSourcesBridge(ipc: SourcesIpcRendererLike): SourcesBridge {
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
        if (isPickedPlaylistFile(payload)) listener(payload);
      };
      ipc.on(SOURCES_CHANNELS.openPlaylistFile, wrapped);
      return () => {
        ipc.removeListener(SOURCES_CHANNELS.openPlaylistFile, wrapped);
      };
    },
  };
  return Object.freeze(bridge);
}
