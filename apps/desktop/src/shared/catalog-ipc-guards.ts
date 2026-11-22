import type {
  AddSourceInput,
  ImportProgress,
  ItemSortOrder,
  LinkSourceInput,
  ListItemsOptions,
  SaveProgressInput,
  SaveTrackPreferenceInput,
  SearchOptions,
  SearchScope,
  ToggleFavoriteInput,
  TrackPreferenceResizeMode,
  UserItemKind,
} from '@elv/data';
import type { ElvError, ErrorCategory, TransportSettings } from '@elv/domain';

const MAX_STRING_CHARS = 8_192;
export const MAX_ID_CHARS = 256;
export const MAX_ITEM_KEY_CHARS = 1_024;
const MAX_TITLE_CHARS = 512;
const MAX_PROFILE_ID_CHARS = 128;
const MAX_USER_LIST_LIMIT = 100;
const MAX_PROGRESS_KEYS = 200;
const MAX_NOW_NEXT_KEYS = 60;
const MAX_EPG_WINDOW_KEYS = 40;
const MAX_SEARCH_QUERY_CHARS = 256;
const MAX_SEARCH_LIMIT = 60;
const MAX_SOURCE_IDS = 64;

const USER_ITEM_KINDS = new Set<UserItemKind>(['live', 'movie', 'series', 'episode']);
const SEARCH_SCOPES = new Set<SearchScope>(['all', 'live', 'movie', 'series']);
const ITEM_SORT_ORDERS = new Set<ItemSortOrder>(['default', 'alpha']);
const ERROR_CATEGORIES = new Set<ErrorCategory>([
  'network',
  'auth',
  'source-format',
  'playback',
  'storage',
]);
const IMPORT_PHASES = new Set<ImportProgress['phase']>([
  'categories',
  'live',
  'movies',
  'series',
  'episodes',
  'guide-channels',
  'programmes',
  'cleanup',
]);

export const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' &&
  x !== null &&
  !Array.isArray(x) &&
  !Object.hasOwn(x, '__proto__') &&
  !Object.hasOwn(x, 'constructor') &&
  !Object.hasOwn(x, 'prototype');

export const isPositiveId = (x: unknown): x is number =>
  Number.isSafeInteger(x) && (x as number) > 0;
export const isSafeInt = (x: unknown): x is number => Number.isSafeInteger(x);
export const isFiniteNumber = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x);
export const isNonNegativeFinite = (x: unknown): x is number => isFiniteNumber(x) && x >= 0;
export const isBoundedString = (x: unknown, min = 0, max = MAX_STRING_CHARS): x is string =>
  typeof x === 'string' && x.length >= min && x.length <= max;

const hasControlChar = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const isTrimmedCleanString = (x: unknown): x is string =>
  isBoundedString(x) && !hasControlChar(x.trim());
const isOptionalCleanString = (x: unknown): boolean =>
  x === undefined || (isBoundedString(x) && !hasControlChar(x));
const isOptionalTrimmedCleanString = (x: unknown): boolean =>
  x === undefined || isTrimmedCleanString(x);

export const isCleanKey = (x: unknown, max = MAX_ITEM_KEY_CHARS): x is string =>
  isBoundedString(x, 1, max) && !hasControlChar(x);
export const isSafeRecentChannelKey = (x: unknown): x is string =>
  isBoundedString(x, 1, 256) &&
  x.trim().length > 0 &&
  !hasControlChar(x) &&
  !x.includes('://') &&
  !x.includes('{{') &&
  !x.includes('@') &&
  !x.includes('?');
export const isOptionalProfileId = (x: unknown): boolean =>
  x === undefined || isCleanKey(x, MAX_PROFILE_ID_CHARS);
export const isOptionalSourceId = (x: unknown): boolean =>
  x === undefined || isCleanKey(x, MAX_ID_CHARS);
export const isOptionalUserLimit = (x: unknown): boolean =>
  x === undefined || (isSafeInt(x) && x >= 0 && x <= MAX_USER_LIST_LIMIT);
const isOptionalNullableBoundedString = (x: unknown, max: number): boolean =>
  x === undefined || x === null || isBoundedString(x, 0, max);
const isOptionalNullableCleanString = (x: unknown, max: number): boolean =>
  isOptionalNullableBoundedString(x, max) && (typeof x !== 'string' || !hasControlChar(x));
const isOptionalNullableSafeInt = (x: unknown): boolean =>
  x === undefined || x === null || isSafeInt(x);
const isOptionalNullableNonNegInt = (x: unknown): boolean =>
  x === undefined || x === null || (isSafeInt(x) && x >= 0);
const isOptionalNullableFinite = (x: unknown): boolean =>
  x === undefined || x === null || isFiniteNumber(x);
const isUserItemKind = (x: unknown): x is UserItemKind =>
  typeof x === 'string' && USER_ITEM_KINDS.has(x as UserItemKind);

export function isSearchQuery(x: unknown): x is string {
  return isBoundedString(x, 0, MAX_SEARCH_QUERY_CHARS) && !hasControlChar(x);
}

export function isSearchOptions(x: unknown): x is SearchOptions {
  if (!isRecord(x)) return false;
  const scope = x['scope'];
  if (
    scope !== undefined &&
    (typeof scope !== 'string' || !SEARCH_SCOPES.has(scope as SearchScope))
  ) {
    return false;
  }
  const limit = x['limit'];
  if (limit !== undefined && (!isSafeInt(limit) || limit < 0 || limit > MAX_SEARCH_LIMIT)) {
    return false;
  }
  const sourceId = x['sourceId'];
  return sourceId === undefined || isCleanKey(sourceId, MAX_ID_CHARS);
}

export function isSaveProgressInput(x: unknown): x is SaveProgressInput {
  return (
    isRecord(x) &&
    isOptionalProfileId(x['profileId']) &&
    isCleanKey(x['sourceId'], MAX_ID_CHARS) &&
    isCleanKey(x['itemKey']) &&
    isUserItemKind(x['kind']) &&
    isBoundedString(x['title'], 1, MAX_TITLE_CHARS) &&
    isOptionalNullableBoundedString(x['subtitle'], MAX_TITLE_CHARS) &&
    isOptionalNullableCleanString(x['logo'], MAX_STRING_CHARS) &&
    isOptionalNullableCleanString(x['seriesKey'], MAX_ITEM_KEY_CHARS) &&
    isOptionalNullableNonNegInt(x['season']) &&
    isOptionalNullableNonNegInt(x['episode']) &&
    isNonNegativeFinite(x['positionMs']) &&
    isNonNegativeFinite(x['durationMs']) &&
    (x['watched'] === undefined || typeof x['watched'] === 'boolean')
  );
}

export function isToggleFavoriteInput(x: unknown): x is ToggleFavoriteInput {
  return (
    isRecord(x) &&
    isOptionalProfileId(x['profileId']) &&
    isCleanKey(x['sourceId'], MAX_ID_CHARS) &&
    isCleanKey(x['itemKey']) &&
    isUserItemKind(x['kind']) &&
    isBoundedString(x['title'], 1, MAX_TITLE_CHARS) &&
    isOptionalNullableCleanString(x['logo'], MAX_STRING_CHARS) &&
    isOptionalNullableSafeInt(x['year']) &&
    isOptionalNullableFinite(x['rating'])
  );
}

const MAX_TRACK_LANG_CHARS = 16;
const MAX_TRACK_LABEL_CHARS = 128;
const MAX_TRACK_DELAY_MS = 60_000;
const TRACK_RESIZE_MODES = new Set<TrackPreferenceResizeMode>(['fit', 'fill', 'stretch']);

const isOptionalTrackDelayMs = (x: unknown): boolean =>
  x === undefined || (isFiniteNumber(x) && Math.abs(x) <= MAX_TRACK_DELAY_MS);
const isOptionalNullableResizeMode = (x: unknown): boolean =>
  x === undefined ||
  x === null ||
  (typeof x === 'string' && TRACK_RESIZE_MODES.has(x as TrackPreferenceResizeMode));

export function isSaveTrackPreferenceInput(x: unknown): x is SaveTrackPreferenceInput {
  return (
    isRecord(x) &&
    isCleanKey(x['scopeKey']) &&
    isCleanKey(x['sourceId'], MAX_ID_CHARS) &&
    isOptionalProfileId(x['profileId']) &&
    isOptionalNullableCleanString(x['audioLang'], MAX_TRACK_LANG_CHARS) &&
    isOptionalNullableCleanString(x['audioLabel'], MAX_TRACK_LABEL_CHARS) &&
    isOptionalNullableCleanString(x['subLang'], MAX_TRACK_LANG_CHARS) &&
    isOptionalNullableCleanString(x['subLabel'], MAX_TRACK_LABEL_CHARS) &&
    (x['subDisabled'] === undefined || typeof x['subDisabled'] === 'boolean') &&
    isOptionalTrackDelayMs(x['audioDelayMs']) &&
    isOptionalTrackDelayMs(x['subDelayMs']) &&
    isOptionalNullableResizeMode(x['resizeMode'])
  );
}

function isBoundedKeyList(x: unknown, max: number): x is readonly string[] {
  return Array.isArray(x) && x.length <= max && x.every((k) => isCleanKey(k, MAX_ITEM_KEY_CHARS));
}

export const isItemKeyList = (x: unknown): x is readonly string[] =>
  isBoundedKeyList(x, MAX_PROGRESS_KEYS);
export const isSeriesKeyList = (x: unknown): x is readonly string[] =>
  isBoundedKeyList(x, MAX_PROGRESS_KEYS);
export const isNowNextKeyList = (x: unknown): x is readonly string[] =>
  isBoundedKeyList(x, MAX_NOW_NEXT_KEYS);
export const isEpgWindowKeyList = (x: unknown): x is readonly string[] =>
  isBoundedKeyList(x, MAX_EPG_WINDOW_KEYS);

function isTransportSettings(x: unknown): x is TransportSettings {
  if (!isRecord(x)) return false;
  if (!isOptionalCleanString(x['userAgent']) || !isOptionalCleanString(x['referer'])) return false;
  const fmt = x['xtreamFormat'];
  return fmt === undefined || fmt === 'ts' || fmt === 'm3u8';
}

export function isAddSourceInput(x: unknown): x is AddSourceInput {
  if (!isRecord(x) || !isBoundedString(x['name'])) return false;
  if (x['transport'] !== undefined && !isTransportSettings(x['transport'])) return false;
  if (!isOptionalTrimmedCleanString(x['guideUrl'])) return false;
  if (x['kind'] === 'xtream') {
    return (
      isTrimmedCleanString(x['server']) &&
      isBoundedString(x['username']) &&
      isBoundedString(x['password'])
    );
  }
  if (x['kind'] === 'm3u') {
    return (
      isTrimmedCleanString(x['playlistUrl']) &&
      (x['vodPlaylist'] === undefined || typeof x['vodPlaylist'] === 'boolean')
    );
  }
  return false;
}

export function isLinkSourceInput(x: unknown): x is LinkSourceInput {
  if (!isRecord(x)) return false;
  if (!isBoundedString(x['name']) || !isTrimmedCleanString(x['url'])) {
    return false;
  }
  if (x['keepAsM3u'] !== undefined && typeof x['keepAsM3u'] !== 'boolean') return false;
  if (!isOptionalTrimmedCleanString(x['guideUrl'])) return false;
  if (x['vodPlaylist'] !== undefined && typeof x['vodPlaylist'] === 'boolean') {
    // valid boolean
  } else if (x['vodPlaylist'] !== undefined) {
    return false;
  }
  return x['transport'] === undefined || isTransportSettings(x['transport']);
}

export function isElvError(x: unknown): x is ElvError {
  return (
    isRecord(x) &&
    typeof x['category'] === 'string' &&
    ERROR_CATEGORIES.has(x['category'] as ErrorCategory) &&
    isBoundedString(x['code'], 1, 128) &&
    (x['detail'] === undefined || isBoundedString(x['detail'], 0, 1024))
  );
}

export function isListItemsOptions(x: unknown): x is ListItemsOptions {
  if (!isRecord(x)) return false;
  const sortBy = x['sortBy'];
  if (
    sortBy !== undefined &&
    (typeof sortBy !== 'string' || !ITEM_SORT_ORDERS.has(sortBy as ItemSortOrder))
  ) {
    return false;
  }
  const excludeWatched = x['excludeWatched'];
  if (excludeWatched !== undefined && typeof excludeWatched !== 'boolean') return false;
  return isOptionalProfileId(x['profileId']);
}

export function isSourceIdList(x: unknown): x is readonly string[] {
  return (
    Array.isArray(x) && x.length <= MAX_SOURCE_IDS && x.every((id) => isCleanKey(id, MAX_ID_CHARS))
  );
}

export function isImportProgress(x: unknown): x is ImportProgress {
  return (
    isRecord(x) &&
    typeof x['phase'] === 'string' &&
    IMPORT_PHASES.has(x['phase'] as ImportProgress['phase']) &&
    isFiniteNumber(x['done']) &&
    x['done'] >= 0 &&
    (x['total'] === undefined || (isFiniteNumber(x['total']) && x['total'] >= 0)) &&
    (x['fraction'] === undefined ||
      (isFiniteNumber(x['fraction']) && x['fraction'] >= 0 && x['fraction'] <= 1)) &&
    (x['percent'] === undefined ||
      (isSafeInt(x['percent']) && x['percent'] >= 0 && x['percent'] <= 100))
  );
}
