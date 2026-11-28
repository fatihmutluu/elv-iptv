/** Lifecycle status of the store-gated desktop auto-updater (`F-13`). */
export type DesktopUpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'downloaded'
  | 'error';

/** Sanitized update status snapshot displayed inside Settings -> About & Licenses. */
export interface DesktopUpdateState {
  readonly status: DesktopUpdateStatus;
  readonly currentVersion: string;
  readonly availableVersion?: string;
  readonly releaseNotes?: string;
  readonly manualDownloadUrl?: string;
  readonly downloadPercent?: number;
  readonly errorCode?: string;
  readonly checkedAt?: string;
}

/** Platform port for user-initiated desktop update checks, downloads, and restarts (`F-13`). */
export interface DesktopUpdaterPort {
  getState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  downloadUpdate(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<void>;
  openReleasePage(): Promise<boolean>;
  subscribe(listener: (state: DesktopUpdateState) => void): () => void;
}
