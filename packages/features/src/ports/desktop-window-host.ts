/** Sanitized play target payload transferred from main window to standalone Desktop Popout window (`#158`). */
export interface PopoutLaunchPayload {
  readonly itemKey: string;
  readonly kind: 'live' | 'movie' | 'episode';
  readonly title: string;
  readonly subtitle?: string;
  readonly logo?: string;
  readonly sourceId?: string;
  readonly resumePositionMs?: number;
  readonly pinned?: boolean;
  readonly transferEngineId?: string;
  readonly isLocalOffline?: boolean;
  readonly localFileUri?: string;
}

/** Payload sent back to the main window when a standalone Desktop Popout player docks (`#158`). */
export interface PopoutDockPayload {
  readonly itemKey: string;
  readonly kind: 'live' | 'movie' | 'episode';
  readonly title: string;
  readonly subtitle?: string;
  readonly logo?: string;
  readonly sourceId?: string;
  readonly positionMs?: number;
  readonly transferEngineId?: string;
  readonly isLocalOffline?: boolean;
  readonly localFileUri?: string;
}

/** Localized context menu labels for the desktop system tray (`#158`). */
export interface DesktopTrayLabels {
  readonly restore: string;
  readonly quit: string;
}

/** Desktop shell window port for persistent minimize-to-tray and standalone popout playback (`#158`). */
export interface DesktopWindowPort {
  readonly setMinimizeToTray?: (
    enabled: boolean,
    labels?: DesktopTrayLabels,
  ) => Promise<void> | void;
  readonly openPopout?: (payload: PopoutLaunchPayload) => Promise<boolean>;
  readonly closePopout?: () => Promise<void> | void;
  readonly onPopoutDocked?: (listener: (payload: PopoutDockPayload) => void) => () => void;
  readonly onWindowRestored?: (listener: () => void) => () => void;
  readonly onHiddenToTray?: (listener: () => void) => () => void;
}
