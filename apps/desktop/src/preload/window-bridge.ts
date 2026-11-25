import {
  isAlwaysOnTopFlag,
  isAspectRatioLockFlag,
  isMinimizeToTrayFlag,
  isPopoutDockPayload,
  isPopoutLaunchPayload,
  type PopoutDockPayload,
  type PopoutLaunchPayload,
  type TrayLabels,
  WINDOW_CHANNELS,
  type WindowBridge,
} from '../shared/window-ipc.ts';

/** Subset of Electron's `ipcRenderer` used by {@link createWindowBridge}. */
export interface WindowIpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/** Builds the frozen `window.elv.window` bridge inside the sandboxed Electron preload (`#408`, `#332`, `#158`). */
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
    async setMinimizeToTray(enabled: boolean, labels?: TrayLabels): Promise<boolean> {
      const reply =
        labels === undefined
          ? await ipc.invoke(WINDOW_CHANNELS.setMinimizeToTray, enabled)
          : await ipc.invoke(WINDOW_CHANNELS.setMinimizeToTray, enabled, labels);
      if (!isMinimizeToTrayFlag(reply)) {
        throw new Error('window:set-minimize-to-tray returned an unexpected reply');
      }
      return reply;
    },
    async openPopout(payload: PopoutLaunchPayload): Promise<boolean> {
      const reply = await ipc.invoke(WINDOW_CHANNELS.openPopout, payload);
      if (typeof reply !== 'boolean') {
        throw new Error('window:open-popout returned an unexpected reply');
      }
      return reply;
    },
    async closePopout(): Promise<void> {
      await ipc.invoke(WINDOW_CHANNELS.closePopout);
    },
    async getPopoutPayload(): Promise<PopoutLaunchPayload | null> {
      const reply = await ipc.invoke(WINDOW_CHANNELS.getPopoutPayload);
      if (reply === null || reply === undefined) return null;
      if (!isPopoutLaunchPayload(reply)) {
        throw new Error('window:get-popout-payload returned an unexpected reply');
      }
      return reply;
    },
    onPopoutPayload(listener: (payload: PopoutLaunchPayload) => void): () => void {
      const wrapped = (_event: unknown, payload: unknown): void => {
        if (isPopoutLaunchPayload(payload)) listener(payload);
      };
      ipc.on(WINDOW_CHANNELS.popoutPayload, wrapped);
      return () => {
        ipc.removeListener(WINDOW_CHANNELS.popoutPayload, wrapped);
      };
    },
    async dockPopout(payload: PopoutDockPayload): Promise<void> {
      await ipc.invoke(WINDOW_CHANNELS.dockPopout, payload);
    },
    onPopoutDocked(listener: (payload: PopoutDockPayload) => void): () => void {
      const wrapped = (_event: unknown, payload: unknown): void => {
        if (isPopoutDockPayload(payload)) listener(payload);
      };
      ipc.on(WINDOW_CHANNELS.popoutDocked, wrapped);
      return () => {
        ipc.removeListener(WINDOW_CHANNELS.popoutDocked, wrapped);
      };
    },
    onWindowRestored(listener: () => void): () => void {
      const wrapped = (): void => {
        listener();
      };
      ipc.on(WINDOW_CHANNELS.windowRestored, wrapped);
      return () => {
        ipc.removeListener(WINDOW_CHANNELS.windowRestored, wrapped);
      };
    },
    onHiddenToTray(listener: () => void): () => void {
      const wrapped = (): void => {
        listener();
      };
      ipc.on(WINDOW_CHANNELS.hiddenToTray, wrapped);
      return () => {
        ipc.removeListener(WINDOW_CHANNELS.hiddenToTray, wrapped);
      };
    },
  };
  return Object.freeze(bridge);
}
