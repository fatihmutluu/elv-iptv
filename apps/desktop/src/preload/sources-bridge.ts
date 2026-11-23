import {
  isClipboardTextReply,
  isPickedPlaylistFileReply,
  type PickedPlaylistFile,
  SOURCES_CHANNELS,
  type SourcesBridge,
} from '../shared/sources-ipc.ts';

/** Subset of Electron's `ipcRenderer` used by {@link createSourcesBridge}. */
export interface SourcesIpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

/** Builds the frozen `window.elv.sources` bridge inside the sandboxed Electron preload (`#51`). */
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
  };
  return Object.freeze(bridge);
}
