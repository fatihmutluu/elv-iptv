import {
  type DesktopUpdateState,
  isDesktopUpdateState,
  isUpdaterBridge,
  type UpdaterBridge,
} from '../../src/shared/updater-ipc.ts';

/**
 * Structurally matches `@elv/features`'s `DesktopUpdaterPort` so `App.tsx` can pass it directly
 * into `AppShell` without requiring Electron imports in shared feature packages.
 */
export interface DesktopUpdaterPort {
  getState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  downloadUpdate(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<void>;
  openReleasePage(): Promise<boolean>;
  subscribe(listener: (state: DesktopUpdateState) => void): () => void;
}

/** Optional configuration for {@link createDesktopUpdaterPort}. */
export interface DesktopUpdaterPortOptions {
  readonly currentVersion?: string;
}

/**
 * Adapts the preload's frozen `window.elv.updater` bridge into `@elv/features`'s
 * {@link DesktopUpdaterPort} (`F-13`). Degrades cleanly to `'unsupported'` when running in a
 * plain browser workbench or when the preload bridge is absent.
 */
export function createDesktopUpdaterPort(
  bridge?: UpdaterBridge,
  options?: DesktopUpdaterPortOptions,
): DesktopUpdaterPort {
  const fallbackVersion = options?.currentVersion ?? '0.0.0';
  const unsupportedState: DesktopUpdateState = Object.freeze({
    status: 'unsupported',
    currentVersion: fallbackVersion,
  });

  if (!isUpdaterBridge(bridge)) {
    return {
      async getState(): Promise<DesktopUpdateState> {
        return unsupportedState;
      },
      async checkForUpdates(): Promise<DesktopUpdateState> {
        return unsupportedState;
      },
      async downloadUpdate(): Promise<DesktopUpdateState> {
        return unsupportedState;
      },
      async installUpdate(): Promise<void> {
        return undefined;
      },
      async openReleasePage(): Promise<boolean> {
        return false;
      },
      subscribe(): () => void {
        return () => undefined;
      },
    };
  }

  let lastState: DesktopUpdateState = unsupportedState;

  const remember = (next: DesktopUpdateState): DesktopUpdateState => {
    lastState = next;
    return next;
  };

  return {
    async getState(): Promise<DesktopUpdateState> {
      try {
        const next = await bridge.getState();
        return isDesktopUpdateState(next) ? remember(next) : unsupportedState;
      } catch {
        return unsupportedState;
      }
    },

    async checkForUpdates(): Promise<DesktopUpdateState> {
      try {
        const next = await bridge.checkForUpdates();
        return isDesktopUpdateState(next) ? remember(next) : lastState;
      } catch {
        return remember({
          status: 'error',
          currentVersion: lastState.currentVersion,
          errorCode: 'ipc_error',
        });
      }
    },

    async downloadUpdate(): Promise<DesktopUpdateState> {
      try {
        const next = await bridge.downloadUpdate();
        return isDesktopUpdateState(next) ? remember(next) : lastState;
      } catch {
        return remember({
          ...lastState,
          status: 'error',
          errorCode: 'ipc_error',
        });
      }
    },

    async installUpdate(): Promise<void> {
      await bridge.installUpdate();
    },

    async openReleasePage(): Promise<boolean> {
      try {
        return (await bridge.openReleasePage()) === true;
      } catch {
        return false;
      }
    },

    subscribe(listener: (state: DesktopUpdateState) => void): () => void {
      return bridge.onStateChanged((next) => {
        if (!isDesktopUpdateState(next)) return;
        remember(next);
        listener(next);
      });
    },
  };
}
