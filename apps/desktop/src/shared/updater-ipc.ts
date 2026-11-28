/** IPC channels exposed by main for the store-gated desktop auto-updater (`F-13`). */
export const UPDATER_CHANNELS = Object.freeze({
  getState: 'updater:get-state',
  check: 'updater:check',
  download: 'updater:download',
  install: 'updater:install',
  openReleasePage: 'updater:open-release-page',
  stateChanged: 'updater:state-changed',
} as const);

/** Lifecycle status of the desktop auto-updater. */
export type DesktopUpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'downloaded'
  | 'error';

/** Sanitized updater snapshot crossing Electron IPC and consumed by Settings -> About & Licenses. */
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

/** Frozen `window.elv.updater` bridge exposed by the sandboxed Electron preload (`F-13`). */
export interface UpdaterBridge {
  getState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  downloadUpdate(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<void>;
  openReleasePage(): Promise<boolean>;
  onStateChanged(listener: (state: DesktopUpdateState) => void): () => void;
}

const VALID_STATUSES: ReadonlySet<string> = new Set<DesktopUpdateStatus>([
  'unsupported',
  'idle',
  'checking',
  'available',
  'up-to-date',
  'downloading',
  'downloaded',
  'error',
]);

const ALLOWED_STATE_KEYS: ReadonlySet<string> = new Set([
  'status',
  'currentVersion',
  'availableVersion',
  'releaseNotes',
  'manualDownloadUrl',
  'downloadPercent',
  'errorCode',
  'checkedAt',
]);

const MAX_SHORT_FIELD_CHARS = 64;
const MAX_RELEASE_NOTES_CHARS = 8_192;
const MAX_RELEASE_URL_CHARS = 512;

function hasAnyControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function hasDisallowedMultilineControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x09 || code === 0x0a) continue;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isSafeRecord(x: unknown): x is Record<string, unknown> {
  return (
    typeof x === 'object' &&
    x !== null &&
    !Array.isArray(x) &&
    !Object.hasOwn(x, '__proto__') &&
    !Object.hasOwn(x, 'constructor') &&
    !Object.hasOwn(x, 'prototype')
  );
}

function isBoundedSingleLineString(x: unknown, maxChars = MAX_SHORT_FIELD_CHARS): x is string {
  return (
    typeof x === 'string' &&
    x.length > 0 &&
    x.length <= maxChars &&
    x.trim().length > 0 &&
    !hasAnyControlChar(x)
  );
}

/** Validates whether a value is one of the canonical {@link DesktopUpdateStatus} literals. */
export function isDesktopUpdateStatus(x: unknown): x is DesktopUpdateStatus {
  return typeof x === 'string' && VALID_STATUSES.has(x);
}

/**
 * Validates that a manual release URL strictly targets ELV IPTV's official HTTPS GitHub Releases
 * path (`https://github.com/fatihmutluu/elv-iptv/releases/...`) with no credentials, port,
 * traversal segments, or control characters.
 */
export function isAllowedReleasePageUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  if (raw.length === 0 || raw.length > MAX_RELEASE_URL_CHARS) return false;
  if (raw !== raw.trim() || hasAnyControlChar(raw)) return false;
  if (raw.includes('\\') || /%(?:2e|2f|5c)/i.test(raw)) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.hostname.toLowerCase() !== 'github.com') return false;
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return false;

  const rawPath = raw.slice('https://github.com'.length).split(/[?#]/)[0] ?? '';
  if (/(?:^|\/)\.\.?(?:\/|$)/.test(rawPath)) return false;

  const path = parsed.pathname;
  return (
    path === '/fatihmutluu/elv-iptv/releases' || path.startsWith('/fatihmutluu/elv-iptv/releases/')
  );
}

/** Runtime guard validating {@link DesktopUpdateState} payloads across IPC boundaries. */
export function isDesktopUpdateState(x: unknown): x is DesktopUpdateState {
  if (!isSafeRecord(x)) return false;
  for (const key of Object.keys(x)) {
    if (!ALLOWED_STATE_KEYS.has(key)) return false;
  }
  if (!isDesktopUpdateStatus(x['status'])) return false;
  if (!isBoundedSingleLineString(x['currentVersion'])) return false;

  if (x['availableVersion'] !== undefined && !isBoundedSingleLineString(x['availableVersion'])) {
    return false;
  }
  if (x['releaseNotes'] !== undefined) {
    const notes = x['releaseNotes'];
    if (
      typeof notes !== 'string' ||
      notes.length > MAX_RELEASE_NOTES_CHARS ||
      hasDisallowedMultilineControlChar(notes)
    ) {
      return false;
    }
  }
  if (x['manualDownloadUrl'] !== undefined && !isAllowedReleasePageUrl(x['manualDownloadUrl'])) {
    return false;
  }
  if (x['downloadPercent'] !== undefined) {
    const pct = x['downloadPercent'];
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      return false;
    }
  }
  if (x['errorCode'] !== undefined && !isBoundedSingleLineString(x['errorCode'])) {
    return false;
  }
  if (x['checkedAt'] !== undefined && !isBoundedSingleLineString(x['checkedAt'])) {
    return false;
  }
  return true;
}

/** Runtime guard validating a preload-exposed {@link UpdaterBridge} object. */
export function isUpdaterBridge(x: unknown): x is UpdaterBridge {
  if (typeof x !== 'object' || x === null) return false;
  const candidate = x as Record<string, unknown>;
  return (
    typeof candidate['getState'] === 'function' &&
    typeof candidate['checkForUpdates'] === 'function' &&
    typeof candidate['downloadUpdate'] === 'function' &&
    typeof candidate['installUpdate'] === 'function' &&
    typeof candidate['openReleasePage'] === 'function' &&
    typeof candidate['onStateChanged'] === 'function'
  );
}
