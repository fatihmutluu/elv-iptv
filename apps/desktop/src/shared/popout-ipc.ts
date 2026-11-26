import { isManagedDownloadFileUrlShape } from './downloads-ipc.ts';
import { isEngineId, sanitizeDesktopArtworkUrl } from './player-ipc.ts';
import { hasOnlyKeys } from './player-ipc-subtitles.ts';

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

const MAX_ITEM_KEY_CHARS = 512;
const MAX_TITLE_CHARS = 512;
const MAX_SUBTITLE_CHARS = 512;
const MAX_SOURCE_ID_CHARS = 128;
const MAX_LOGO_URL_CHARS = 4096;
const MAX_POSITION_MS = 86_400_000_000;

const RAW_URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:[/][/]/i;
const DANGEROUS_SCHEME_RE = /^(?:javascript|data|vbscript|file):/i;

const POPOUT_LAUNCH_KEYS: ReadonlySet<string> = new Set([
  'itemKey',
  'kind',
  'title',
  'subtitle',
  'logo',
  'sourceId',
  'resumePositionMs',
  'pinned',
  'transferEngineId',
  'isLocalOffline',
  'localFileUri',
]);

const POPOUT_DOCK_KEYS: ReadonlySet<string> = new Set([
  'itemKey',
  'kind',
  'title',
  'subtitle',
  'logo',
  'sourceId',
  'positionMs',
  'transferEngineId',
  'isLocalOffline',
  'localFileUri',
]);

const isSafeRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' &&
  x !== null &&
  !Array.isArray(x) &&
  !Object.hasOwn(x, '__proto__') &&
  !Object.hasOwn(x, 'constructor') &&
  !Object.hasOwn(x, 'prototype');

const hasControlChar = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const isPopoutKind = (x: unknown): x is 'live' | 'movie' | 'episode' =>
  x === 'live' || x === 'movie' || x === 'episode';

const isSafeItemKey = (x: unknown): x is string => {
  if (typeof x !== 'string' || x.length > MAX_ITEM_KEY_CHARS || hasControlChar(x)) return false;
  const trimmed = x.trim();
  if (trimmed.length === 0) return false;
  if (RAW_URI_SCHEME_RE.test(trimmed) || DANGEROUS_SCHEME_RE.test(trimmed)) return false;
  return true;
};

const isBoundedText = (x: unknown, max: number, required: boolean): boolean => {
  if (x === undefined) return !required;
  if (typeof x !== 'string' || x.length > max || hasControlChar(x)) return false;
  return !required || x.trim().length > 0;
};

const isOptionalLogo = (x: unknown): boolean => {
  if (x === undefined) return true;
  if (typeof x !== 'string' || x.length > MAX_LOGO_URL_CHARS || hasControlChar(x)) return false;
  if (x.trim().length === 0) return true;
  return sanitizeDesktopArtworkUrl(x) !== undefined;
};

const isOptionalPositionMs = (x: unknown): boolean =>
  x === undefined ||
  (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX_POSITION_MS);

const isOptionalTransferEngineId = (x: unknown): boolean =>
  x === undefined || (isEngineId(x) && !hasControlChar(x) && x.trim().length > 0);

const isOptionalLocalFileUri = (x: unknown, kind: unknown): boolean => {
  if (x === undefined) return true;
  if (kind === 'live') return false;
  return isManagedDownloadFileUrlShape(x);
};

/** Strict runtime guard for `window:open-popout` / `window:popout-payload` (`#158`). */
export function isPopoutLaunchPayload(x: unknown): x is PopoutLaunchPayload {
  if (!isSafeRecord(x) || !hasOnlyKeys(x, POPOUT_LAUNCH_KEYS)) return false;
  return (
    isSafeItemKey(x['itemKey']) &&
    isPopoutKind(x['kind']) &&
    isBoundedText(x['title'], MAX_TITLE_CHARS, true) &&
    isBoundedText(x['subtitle'], MAX_SUBTITLE_CHARS, false) &&
    isOptionalLogo(x['logo']) &&
    isBoundedText(x['sourceId'], MAX_SOURCE_ID_CHARS, false) &&
    isOptionalPositionMs(x['resumePositionMs']) &&
    (x['pinned'] === undefined || typeof x['pinned'] === 'boolean') &&
    isOptionalTransferEngineId(x['transferEngineId']) &&
    (x['isLocalOffline'] === undefined || typeof x['isLocalOffline'] === 'boolean') &&
    isOptionalLocalFileUri(x['localFileUri'], x['kind'])
  );
}

/** Strict runtime guard for `window:dock-popout` / `window:popout-docked` (`#158`). */
export function isPopoutDockPayload(x: unknown): x is PopoutDockPayload {
  if (!isSafeRecord(x) || !hasOnlyKeys(x, POPOUT_DOCK_KEYS)) return false;
  return (
    isSafeItemKey(x['itemKey']) &&
    isPopoutKind(x['kind']) &&
    isBoundedText(x['title'], MAX_TITLE_CHARS, true) &&
    isBoundedText(x['subtitle'], MAX_SUBTITLE_CHARS, false) &&
    isOptionalLogo(x['logo']) &&
    isBoundedText(x['sourceId'], MAX_SOURCE_ID_CHARS, false) &&
    isOptionalPositionMs(x['positionMs']) &&
    isOptionalTransferEngineId(x['transferEngineId']) &&
    (x['isLocalOffline'] === undefined || typeof x['isLocalOffline'] === 'boolean') &&
    isOptionalLocalFileUri(x['localFileUri'], x['kind'])
  );
}

/** Returns a credential-stripped, allow-listed copy of a validated {@link PopoutLaunchPayload}. */
export function sanitizePopoutLaunchPayload(payload: PopoutLaunchPayload): PopoutLaunchPayload {
  const safeLogo = sanitizeDesktopArtworkUrl(payload.logo);
  const subtitle = payload.subtitle?.trim();
  const sourceId = payload.sourceId?.trim();
  const transferEngineId = payload.transferEngineId?.trim();
  const safeLocalUri =
    payload.kind !== 'live' && isManagedDownloadFileUrlShape(payload.localFileUri)
      ? payload.localFileUri.trim()
      : undefined;
  return {
    itemKey: payload.itemKey.trim(),
    kind: payload.kind,
    title: payload.title.trim(),
    ...(subtitle ? { subtitle } : {}),
    ...(safeLogo ? { logo: safeLogo } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(payload.resumePositionMs !== undefined
      ? { resumePositionMs: Math.round(payload.resumePositionMs) }
      : {}),
    ...(payload.pinned !== undefined ? { pinned: payload.pinned } : {}),
    ...(transferEngineId && isEngineId(transferEngineId) ? { transferEngineId } : {}),
    ...(payload.isLocalOffline === true && payload.kind !== 'live' ? { isLocalOffline: true } : {}),
    ...(safeLocalUri ? { localFileUri: safeLocalUri } : {}),
  };
}

/** Returns a credential-stripped, allow-listed copy of a validated {@link PopoutDockPayload}. */
export function sanitizePopoutDockPayload(payload: PopoutDockPayload): PopoutDockPayload {
  const safeLogo = sanitizeDesktopArtworkUrl(payload.logo);
  const subtitle = payload.subtitle?.trim();
  const sourceId = payload.sourceId?.trim();
  const transferEngineId = payload.transferEngineId?.trim();
  const safeLocalUri =
    payload.kind !== 'live' && isManagedDownloadFileUrlShape(payload.localFileUri)
      ? payload.localFileUri.trim()
      : undefined;
  return {
    itemKey: payload.itemKey.trim(),
    kind: payload.kind,
    title: payload.title.trim(),
    ...(subtitle ? { subtitle } : {}),
    ...(safeLogo ? { logo: safeLogo } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(payload.positionMs !== undefined ? { positionMs: Math.round(payload.positionMs) } : {}),
    ...(transferEngineId && isEngineId(transferEngineId) ? { transferEngineId } : {}),
    ...(payload.isLocalOffline === true && payload.kind !== 'live' ? { isLocalOffline: true } : {}),
    ...(safeLocalUri ? { localFileUri: safeLocalUri } : {}),
  };
}
