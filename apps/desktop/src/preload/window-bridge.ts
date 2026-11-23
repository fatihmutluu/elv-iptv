import {
  isAlwaysOnTopFlag,
  isAspectRatioLockFlag,
  WINDOW_CHANNELS,
  type WindowBridge,
} from '../shared/window-ipc.ts';

/** Subset of Electron's `ipcRenderer` used by {@link createWindowBridge}. */
export interface WindowIpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/** Builds the frozen `window.elv.window` bridge inside the sandboxed Electron preload (`#408`, `#332`). */
export function createWindowBridge(ipc: WindowIpcRendererLike): WindowBridge {
  const bridge: WindowBridge = {
    async setAlwaysOnTop(enabled: boolean): Promise<boolean> {
      const reply = await ipc.invoke(WINDOW_CHANNELS.setAlwaysOnTop, enabled);
      if (!isAlwaysOnTopFlag(reply)) {
        throw new Error('window:set-always-on-top returned an unexpected reply');
      }
      return reply;
    },
    async getAlwaysOnTop(): Promise<boolean> {
      const reply = await ipc.invoke(WINDOW_CHANNELS.getAlwaysOnTop);
      if (!isAlwaysOnTopFlag(reply)) {
        throw new Error('window:get-always-on-top returned an unexpected reply');
      }
      return reply;
    },
    onAlwaysOnTopChanged(listener: (enabled: boolean) => void): () => void {
      const wrapped = (_event: unknown, enabled: unknown): void => {
        if (isAlwaysOnTopFlag(enabled)) listener(enabled);
      };
      ipc.on(WINDOW_CHANNELS.alwaysOnTopChanged, wrapped);
      return () => {
        ipc.removeListener(WINDOW_CHANNELS.alwaysOnTopChanged, wrapped);
      };
    },
    async setAspectRatioLock(enabled: boolean): Promise<boolean> {
      const reply = await ipc.invoke(WINDOW_CHANNELS.setAspectRatioLock, enabled);
      if (!isAspectRatioLockFlag(reply)) {
        throw new Error('window:set-aspect-ratio-lock returned an unexpected reply');
      }
      return reply;
    },
  };
  return Object.freeze(bridge);
}
