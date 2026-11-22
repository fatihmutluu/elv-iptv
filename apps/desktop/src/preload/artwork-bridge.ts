import {
  ARTWORK_CHANNELS,
  type ArtworkBridge,
  isDesktopArtworkCacheStats,
} from '../shared/artwork-ipc.ts';

/** Subset of Electron's `ipcRenderer` used by {@link createArtworkBridge}. */
export interface ArtworkIpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

/** Builds the frozen `window.elv.artwork` bridge inside the sandboxed Electron preload (`#405`). */
export function createArtworkBridge(ipc: ArtworkIpcRendererLike): ArtworkBridge {
  const bridge: ArtworkBridge = {
    async clear(): Promise<void> {
      await ipc.invoke(ARTWORK_CHANNELS.clear);
    },
    async setLimitBytes(maxBytes: number): Promise<void> {
      await ipc.invoke(ARTWORK_CHANNELS.setLimit, maxBytes);
    },
    async stats() {
      const reply = await ipc.invoke(ARTWORK_CHANNELS.stats);
      if (!isDesktopArtworkCacheStats(reply)) {
        throw new Error('artwork:stats returned an unexpected reply');
      }
      return { bytes: reply.bytes, entries: reply.entries, maxBytes: reply.maxBytes };
    },
  };
  return Object.freeze(bridge);
}
