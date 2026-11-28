import {
  clampZoomLevel,
  isAspectRatioLockFlag,
  isMinimizeToTrayFlag,
  isPopoutDockPayload,
  isPopoutLaunchPayload,
  isZoomLevel,
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

/** Subset of Electron's `webFrame` used to apply persisted desktop UI zoom inside preload. */
export interface WindowWebFrameLike {
  setZoomLevel(level: number): void;
}

/** Minimal DOM document surface for `DOMContentLoaded` zoom sync inside preload. */
export interface ZoomSyncDocumentLike {
  readonly readyState?: string;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

/**
 * Applies the persisted desktop UI zoom level via `webFrame.setZoomLevel` immediately, again on
 * `DOMContentLoaded`, and on every live `window:zoom-level-changed` event so zoom never resets
 * across routes or resizes. Returns an idempotent teardown function.
 */
export function syncInitialZoomLevel(
  ipc: WindowIpcRendererLike,
  webFrame: WindowWebFrameLike,
  doc: ZoomSyncDocumentLike | undefined = typeof document === 'undefined' ? undefined : document,
): () => void {
  let disposed = false;

  const queryAndApply = (): void => {
    void ipc
      .invoke(WINDOW_CHANNELS.getZoomLevel)
      .then((reply) => {
        if (!disposed && isZoomLevel(reply)) {
          webFrame.setZoomLevel(clampZoomLevel(reply));
        }
      })
      .catch(() => undefined);
  };

  const onZoomChanged = (_event: unknown, level: unknown): void => {
    if (!disposed && isZoomLevel(level)) {
      webFrame.setZoomLevel(clampZoomLevel(level));
    }
  };

  const onDomContentLoaded = (): void => {
    if (!disposed) queryAndApply();
  };

  ipc.on(WINDOW_CHANNELS.zoomLevelChanged, onZoomChanged);
  queryAndApply();

  if (doc !== undefined && typeof doc.addEventListener === 'function') {
    doc.addEventListener('DOMContentLoaded', onDomContentLoaded);
  }

  return () => {
    if (disposed) return;
    disposed = true;
    ipc.removeListener(WINDOW_CHANNELS.zoomLevelChanged, onZoomChanged);
    doc?.removeEventListener?.('DOMContentLoaded', onDomContentLoaded);
  };
}

/** Builds the frozen `window.elv.window` bridge inside the sandboxed Electron preload (`#332`, `#158`). */
export function createWindowBridge(
  ipc: WindowIpcRendererLike,
  webFrame?: WindowWebFrameLike,
): WindowBridge {
  const bridge: WindowBridge = {
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
    async openExternalUrl(url: string): Promise<boolean> {
      const reply = await ipc.invoke(WINDOW_CHANNELS.openExternalUrl, url);
      return reply === true;
    },
    async getZoomLevel(): Promise<number> {
      const reply = await ipc.invoke(WINDOW_CHANNELS.getZoomLevel);
      if (!isZoomLevel(reply)) {
        throw new Error('window:get-zoom-level returned an unexpected reply');
      }
      return clampZoomLevel(reply);
    },
    async setZoomLevel(level: number): Promise<number> {
      const reply = await ipc.invoke(WINDOW_CHANNELS.setZoomLevel, clampZoomLevel(level));
      if (!isZoomLevel(reply)) {
        throw new Error('window:set-zoom-level returned an unexpected reply');
      }
      const clamped = clampZoomLevel(reply);
      webFrame?.setZoomLevel(clamped);
      return clamped;
    },
    onZoomLevelChanged(listener: (level: number) => void): () => void {
      const wrapped = (_event: unknown, level: unknown): void => {
        if (!isZoomLevel(level)) return;
        const clamped = clampZoomLevel(level);
        webFrame?.setZoomLevel(clamped);
        listener(clamped);
      };
      ipc.on(WINDOW_CHANNELS.zoomLevelChanged, wrapped);
      return () => {
        ipc.removeListener(WINDOW_CHANNELS.zoomLevelChanged, wrapped);
      };
    },
  };
  return Object.freeze(bridge);
}
