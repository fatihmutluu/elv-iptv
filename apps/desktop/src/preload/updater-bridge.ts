import {
  type DesktopUpdateState,
  isDesktopUpdateState,
  UPDATER_CHANNELS,
  type UpdaterBridge,
} from '../shared/updater-ipc.ts';

/** Subset of Electron's `ipcRenderer` used by {@link createUpdaterBridge}. */
export interface UpdaterIpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/**
 * Builds the frozen `window.elv.updater` bridge inside the sandboxed Electron preload (`F-13`).
 * Validates all replies strictly, propagates IPC rejections intact, strips Electron's raw
 * `IpcRendererEvent`, and unsubscribes strictly its own listener callback.
 */
export function createUpdaterBridge(ipc: UpdaterIpcRendererLike): UpdaterBridge {
  const invokeState = async (channel: string): Promise<DesktopUpdateState> => {
    const reply = await ipc.invoke(channel);
    if (!isDesktopUpdateState(reply)) {
      throw new Error(`${channel} returned an unexpected reply`);
    }
    return reply;
  };

  const bridge: UpdaterBridge = {
    getState: () => invokeState(UPDATER_CHANNELS.getState),
    checkForUpdates: () => invokeState(UPDATER_CHANNELS.check),
    downloadUpdate: () => invokeState(UPDATER_CHANNELS.download),

    async installUpdate(): Promise<void> {
      await ipc.invoke(UPDATER_CHANNELS.install);
    },

    async openReleasePage(): Promise<boolean> {
      const reply = await ipc.invoke(UPDATER_CHANNELS.openReleasePage);
      if (typeof reply !== 'boolean') {
        throw new Error(`${UPDATER_CHANNELS.openReleasePage} returned an unexpected reply`);
      }
      return reply;
    },

    onStateChanged(listener: (state: DesktopUpdateState) => void): () => void {
      const wrapped = (_event: unknown, payload: unknown): void => {
        if (!isDesktopUpdateState(payload)) return;
        try {
          listener(payload);
        } catch {
          // Isolate renderer listener failures.
        }
      };
      ipc.on(UPDATER_CHANNELS.stateChanged, wrapped);
      return () => {
        ipc.removeListener(UPDATER_CHANNELS.stateChanged, wrapped);
      };
    },
  };

  return Object.freeze(bridge);
}
