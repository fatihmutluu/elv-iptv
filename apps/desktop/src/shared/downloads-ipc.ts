import {
  ALLOWED_DOWNLOAD_EXTENSIONS,
  type DownloadEnqueueInput,
  type DownloadRecord,
  type ElvError,
  type ErrorCategory,
  isDownloadMediaKind,
  isDownloadStatus,
  isValidManagedDownloadFileName,
  type Result,
} from '@elv/domain';

/** Strictly allowlisted Electron IPC channels for offline VOD downloads (Movies & Series Episodes). */
export const DOWNLOADS_CHANNELS = Object.freeze({
  list: 'downloads:list',
  get: 'downloads:get',
  enqueue: 'downloads:enqueue',
  enqueueBatch: 'downloads:enqueue-batch',
  pause: 'downloads:pause',
  resume: 'downloads:resume',
  cancel: 'downloads:cancel',
  remove: 'downloads:remove',
  notifyOnlinePlayback: 'downloads:notify-online-playback',
  changed: 'downloads:changed',
} as const);

/** Request payload for listing downloads scoped to an optional profile. */
export interface DownloadListRequest {
  readonly profileId?: string;
}

/** Request payload addressing a single managed download by `(itemKey, profileId?)`. */
export interface DownloadKeyRequest {
  readonly itemKey: string;
  readonly profileId?: string;
}

/** Request payload notifying main process when online streaming playback starts or stops. */
export interface DownloadOnlinePlaybackRequest {
  readonly active: boolean;
}

/** Frozen `window.elv.downloads` bridge exposed by the sandboxed Electron preload. */
export interface DownloadsBridge {
  list(profileId?: string): Promise<readonly DownloadRecord[]>;
  get(itemKey: string, profileId?: string): Promise<DownloadRecord | null>;
  enqueue(input: DownloadEnqueueInput): Promise<Result<DownloadRecord>>;
  enqueueBatch(inputs: readonly DownloadEnqueueInput[]): Promise<Result<readonly DownloadRecord[]>>;
  pause(itemKey: string, profileId?: string): Promise<Result<void>>;
  resume(itemKey: string, profileId?: string): Promise<Result<void>>;
  cancel(itemKey: string, profileId?: string): Promise<Result<void>>;
  remove(itemKey: string, profileId?: string): Promise<Result<void>>;
  notifyOnlinePlaybackActive(active: boolean): Promise<void>;
  onChanged(listener: (records: readonly DownloadRecord[]) => void): () => void;
}

const MAX_MANAGED_FILE_URL_CHARS = 4096;
const MAX_STREAM_URL_CHARS = 8 * 1024;
const MAX_ID_CHARS = 128;
const MAX_ITEM_KEY_CHARS = 512;
const MAX_TITLE_CHARS = 512;
const MAX_EXT_CHARS = 16;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_NAME_CHARS = 256;
const MAX_HEADER_VALUE_CHARS = 8 * 1024;
const MAX_HEADERS_TOTAL_CHARS = 32 * 1024;
const MAX_ENQUEUE_BATCH_ITEMS = 500;
/** Hard upper bound on persisted download records shared across IPC and manager enforcement. */
export const MAX_DOWNLOAD_RECORDS = 5_000;
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const VALID_ERROR_CATEGORIES: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'network',
  'auth',
  'source-format',
  'playback',
  'storage',
]);

const hasControlChar = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const isSafeRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' &&
  x !== null &&
  !Array.isArray(x) &&
  !Object.hasOwn(x, '__proto__') &&
  !Object.hasOwn(x, 'constructor') &&
  !Object.hasOwn(x, 'prototype');

const hasOnlyKeys = (obj: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
  Object.keys(obj).every((k) => allowed.has(k));

const isBoundedNonEmptyString = (x: unknown, maxLen: number): x is string =>
  typeof x === 'string' && x.trim().length > 0 && x.length <= maxLen && !hasControlChar(x);

const isOptionalNullableBoundedString = (x: unknown, maxLen: number): boolean =>
  x === undefined ||
  x === null ||
  (typeof x === 'string' && x.length <= maxLen && !hasControlChar(x));

const isOptionalNullableFiniteInt = (x: unknown): boolean =>
  x === undefined || x === null || (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0);

/**
 * Pure shape validator for a managed offline download `file://` URL:
 * requires `file://` scheme, `<= 4 KiB`, zero ASCII control characters, zero query/hash,
 * local authority only (`""` or `"localhost"`), zero `..` traversal segments (raw or decoded),
 * and an allowlisted video container extension (`.mp4`, `.mkv`, `.ts`, `.m4v`, `.webm`, `.mov`).
 *
 * This shape check is NEVER sufficient on its own for playback: the main process MUST also run
 * `validateManagedDownloadPath` to enforce realpath containment inside `<userData>/downloads/`.
 */
export function isManagedDownloadFileUrlShape(raw: unknown): raw is string {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > MAX_MANAGED_FILE_URL_CHARS ||
    hasControlChar(raw)
  ) {
    return false;
  }
  if (!/^file:[/][/]/i.test(raw) || raw.includes('?') || raw.includes('#')) {
    return false;
  }
  const rawAfterScheme = raw.slice(7);
  if (rawAfterScheme.split(/[/\\]/).some((seg) => seg === '..')) {
    return false;
  }
  let decodedRaw: string;
  try {
    decodedRaw = decodeURIComponent(rawAfterScheme);
  } catch {
    return false;
  }
  if (decodedRaw.split(/[/\\]/).some((seg) => seg === '..')) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'file:' || parsed.search !== '' || parsed.hash !== '') {
    return false;
  }
  if (parsed.hostname !== '' && parsed.hostname.toLowerCase() !== 'localhost') {
    return false;
  }
  if (parsed.pathname.split(/[/\\]/).some((seg) => seg === '..')) {
    return false;
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    return false;
  }
  if (decodedPath.length === 0 || hasControlChar(decodedPath)) {
    return false;
  }
  const segments = decodedPath.split(/[/\\]/);
  if (segments.some((seg) => seg === '..')) {
    return false;
  }
  const baseName = segments[segments.length - 1] ?? '';
  if (baseName.length === 0 || baseName.startsWith('.')) {
    return false;
  }
  const lowerBase = baseName.toLowerCase();
  const matchedExt = ALLOWED_DOWNLOAD_EXTENSIONS.find((ext) => lowerBase.endsWith(ext));
  if (matchedExt === undefined) return false;
  const stem = baseName.slice(0, baseName.length - matchedExt.length);
  return stem.length > 0 && !stem.endsWith('.');
}

/** Validates an `http://` or `https://` source stream URL for offline VOD download enqueueing. */
export function isHttpDownloadSourceUrl(raw: unknown): raw is string {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > MAX_STREAM_URL_CHARS ||
    !/^https?:[/][/]/i.test(raw) ||
    hasControlChar(raw)
  ) {
    return false;
  }
  try {
    const parsed = new URL(raw);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function isDownloadHeaders(x: unknown): x is Readonly<Record<string, string>> {
  if (!isSafeRecord(x)) return false;
  const entries = Object.entries(x);
  if (entries.length > MAX_HEADER_COUNT) return false;
  let totalChars = 0;
  for (const [name, value] of entries) {
    if (
      name.length === 0 ||
      name.length > MAX_HEADER_NAME_CHARS ||
      !HEADER_TOKEN.test(name) ||
      typeof value !== 'string' ||
      value.length > MAX_HEADER_VALUE_CHARS ||
      hasControlChar(value)
    ) {
      return false;
    }
    totalChars += name.length + value.length;
    if (totalChars > MAX_HEADERS_TOTAL_CHARS) return false;
  }
  return true;
}

const LIST_REQUEST_KEYS = new Set(['profileId']);
const KEY_REQUEST_KEYS = new Set(['itemKey', 'profileId']);
const ONLINE_PLAYBACK_KEYS = new Set(['active']);
const ENQUEUE_REQUEST_KEYS = new Set([
  'profileId',
  'sourceId',
  'itemKey',
  'kind',
  'title',
  'seriesKey',
  'seriesTitle',
  'season',
  'episodeNum',
  'poster',
  'streamUrl',
  'headers',
  'containerExtension',
]);
const RECORD_KEYS = new Set([
  'id',
  'profileId',
  'sourceId',
  'itemKey',
  'kind',
  'title',
  'seriesKey',
  'seriesTitle',
  'season',
  'episodeNum',
  'poster',
  'localFileName',
  'localUri',
  'bytesDownloaded',
  'totalBytes',
  'status',
  'pausedForPlayback',
  'errorCode',
  'createdAt',
  'updatedAt',
  'completedAt',
]);
const ELV_ERROR_KEYS = new Set(['category', 'code', 'detail']);

/** Runtime guard for `downloads:list` request payload. */
export function isDownloadListRequest(x: unknown): x is DownloadListRequest {
  if (x === undefined) return true;
  if (!isSafeRecord(x) || !hasOnlyKeys(x, LIST_REQUEST_KEYS)) return false;
  return x['profileId'] === undefined || isBoundedNonEmptyString(x['profileId'], MAX_ID_CHARS);
}

/** Runtime guard for `downloads:get` / `pause` / `resume` / `cancel` / `remove` request payloads. */
export function isDownloadKeyRequest(x: unknown): x is DownloadKeyRequest {
  if (!isSafeRecord(x) || !hasOnlyKeys(x, KEY_REQUEST_KEYS)) return false;
  return (
    isBoundedNonEmptyString(x['itemKey'], MAX_ITEM_KEY_CHARS) &&
    (x['profileId'] === undefined || isBoundedNonEmptyString(x['profileId'], MAX_ID_CHARS))
  );
}

/** Runtime guard for `downloads:notify-online-playback` request payload. */
export function isDownloadOnlinePlaybackRequest(x: unknown): x is DownloadOnlinePlaybackRequest {
  return (
    isSafeRecord(x) && hasOnlyKeys(x, ONLINE_PLAYBACK_KEYS) && typeof x['active'] === 'boolean'
  );
}

/** Runtime guard for `downloads:enqueue` payload: strictly VOD (`'movie' | 'episode'`) and optional `http(s)` URL. */
export function isDownloadEnqueueRequest(x: unknown): x is DownloadEnqueueInput {
  if (!isSafeRecord(x) || !hasOnlyKeys(x, ENQUEUE_REQUEST_KEYS)) return false;
  if (x['profileId'] !== undefined && !isBoundedNonEmptyString(x['profileId'], MAX_ID_CHARS)) {
    return false;
  }
  if (!isBoundedNonEmptyString(x['sourceId'], MAX_ID_CHARS)) return false;
  if (!isBoundedNonEmptyString(x['itemKey'], MAX_ITEM_KEY_CHARS)) return false;
  if (!isDownloadMediaKind(x['kind'])) return false;
  if (!isBoundedNonEmptyString(x['title'], MAX_TITLE_CHARS)) return false;
  if (!isOptionalNullableBoundedString(x['seriesKey'], MAX_ITEM_KEY_CHARS)) return false;
  if (!isOptionalNullableBoundedString(x['seriesTitle'], MAX_TITLE_CHARS)) return false;
  if (!isOptionalNullableFiniteInt(x['season'])) return false;
  if (!isOptionalNullableFiniteInt(x['episodeNum'])) return false;
  if (!isOptionalNullableBoundedString(x['poster'], MAX_STREAM_URL_CHARS)) return false;
  if (x['streamUrl'] !== undefined && !isHttpDownloadSourceUrl(x['streamUrl'])) return false;
  if (x['headers'] !== undefined && !isDownloadHeaders(x['headers'])) return false;
  if (!isOptionalNullableBoundedString(x['containerExtension'], MAX_EXT_CHARS)) return false;
  return true;
}

/** Runtime guard for `downloads:enqueue-batch` payload (1..500 valid VOD download enqueue entries). */
export function isDownloadEnqueueBatchRequest(x: unknown): x is readonly DownloadEnqueueInput[] {
  return (
    Array.isArray(x) &&
    x.length >= 1 &&
    x.length <= MAX_ENQUEUE_BATCH_ITEMS &&
    x.every(isDownloadEnqueueRequest)
  );
}

/** Runtime guard for one {@link DownloadRecord} crossing IPC. */
export function isDownloadRecord(x: unknown): x is DownloadRecord {
  if (!isSafeRecord(x) || !hasOnlyKeys(x, RECORD_KEYS)) return false;
  if (
    !isBoundedNonEmptyString(x['id'], MAX_ITEM_KEY_CHARS + MAX_ID_CHARS) ||
    !isBoundedNonEmptyString(x['profileId'], MAX_ID_CHARS) ||
    !isBoundedNonEmptyString(x['sourceId'], MAX_ID_CHARS) ||
    !isBoundedNonEmptyString(x['itemKey'], MAX_ITEM_KEY_CHARS) ||
    !isDownloadMediaKind(x['kind']) ||
    !isBoundedNonEmptyString(x['title'], MAX_TITLE_CHARS) ||
    !isOptionalNullableBoundedString(x['seriesKey'], MAX_ITEM_KEY_CHARS) ||
    !isOptionalNullableBoundedString(x['seriesTitle'], MAX_TITLE_CHARS) ||
    !isOptionalNullableFiniteInt(x['season']) ||
    !isOptionalNullableFiniteInt(x['episodeNum']) ||
    !isOptionalNullableBoundedString(x['poster'], MAX_STREAM_URL_CHARS)
  ) {
    return false;
  }
  if (
    typeof x['localFileName'] !== 'string' ||
    !isValidManagedDownloadFileName(x['localFileName'])
  ) {
    return false;
  }
  const localUri = x['localUri'];
  if (localUri !== null && !isManagedDownloadFileUrlShape(localUri)) return false;
  const bytes = x['bytesDownloaded'];
  const total = x['totalBytes'];
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return false;
  if (total !== null && (typeof total !== 'number' || !Number.isFinite(total) || total < 0)) {
    return false;
  }
  if (!isDownloadStatus(x['status'])) return false;
  if (x['pausedForPlayback'] !== undefined && typeof x['pausedForPlayback'] !== 'boolean') {
    return false;
  }
  if (!isOptionalNullableBoundedString(x['errorCode'], MAX_ID_CHARS)) return false;
  if (
    typeof x['createdAt'] !== 'number' ||
    !Number.isFinite(x['createdAt']) ||
    typeof x['updatedAt'] !== 'number' ||
    !Number.isFinite(x['updatedAt'])
  ) {
    return false;
  }
  const completedAt = x['completedAt'];
  if (
    completedAt !== undefined &&
    completedAt !== null &&
    (typeof completedAt !== 'number' || !Number.isFinite(completedAt))
  ) {
    return false;
  }
  return true;
}

/** Runtime guard for a list of {@link DownloadRecord} entries. */
export function isDownloadRecordList(x: unknown): x is readonly DownloadRecord[] {
  return Array.isArray(x) && x.length <= MAX_DOWNLOAD_RECORDS && x.every(isDownloadRecord);
}

function isElvError(x: unknown): x is ElvError {
  if (!isSafeRecord(x) || !hasOnlyKeys(x, ELV_ERROR_KEYS)) return false;
  return (
    typeof x['category'] === 'string' &&
    VALID_ERROR_CATEGORIES.has(x['category'] as ErrorCategory) &&
    isBoundedNonEmptyString(x['code'], MAX_ID_CHARS) &&
    (x['detail'] === undefined || isBoundedNonEmptyString(x['detail'], MAX_TITLE_CHARS))
  );
}

/** Runtime guard for `Result<DownloadRecord>` IPC replies. */
export function isDownloadRecordResult(x: unknown): x is Result<DownloadRecord> {
  if (!isSafeRecord(x) || typeof x['ok'] !== 'boolean') return false;
  return x['ok'] ? isDownloadRecord(x['value']) : isElvError(x['error']);
}

/** Runtime guard for `Result<readonly DownloadRecord[]>` IPC replies. */
export function isDownloadRecordListResult(x: unknown): x is Result<readonly DownloadRecord[]> {
  if (!isSafeRecord(x) || typeof x['ok'] !== 'boolean') return false;
  return x['ok'] ? isDownloadRecordList(x['value']) : isElvError(x['error']);
}

/** Runtime guard for `Result<void>` IPC replies. */
export function isDownloadVoidResult(x: unknown): x is Result<void> {
  if (!isSafeRecord(x) || typeof x['ok'] !== 'boolean') return false;
  return x['ok'] ? x['value'] === undefined : isElvError(x['error']);
}
