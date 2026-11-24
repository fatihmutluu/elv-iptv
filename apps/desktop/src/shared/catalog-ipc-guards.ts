import {
  type AddSourceInput,
  type AlphabetIndexInput,
  type CategoryQueryOptions,
  type CreateProfileInput,
  type ImportProgress,
  type ItemSortOrder,
  isProfileAvatarToken,
  type LinkSourceInput,
  type ListItemsOptions,
  type LocalM3uSourceInput,
  type ParentalLockFilter,
  type ParentalQueryOptions,
  type SaveProgressInput,
  type SaveTrackPreferenceInput,
  type SearchOptions,
  type SearchScope,
  type SearchSuggestionsOptions,
  type SetParentalLockInput,
  type SourceCategorySelection,
  type SourceSettings,
  type ToggleFavoriteInput,
  type TrackPreferenceResizeMode,
  type UpdateParentalSettingsPatch,
  type UpdateProfilePatch,
  type UserItemKind,
} from '@elv/data';
import {
  type ContentKind,
  type ElvError,
  type ErrorCategory,
  PROFILE_ID_RE,
  type TransportSettings,
} from '@elv/domain';
import { MAX_PICKED_PLAYLIST_BYTES } from './sources-ipc.ts';

const MAX_STRING_CHARS = 8_192;
export const MAX_ID_CHARS = 256;
export const MAX_ITEM_KEY_CHARS = 1_024;
const MAX_TITLE_CHARS = 512;
const MAX_USER_LIST_LIMIT = 100;
const MAX_PROGRESS_KEYS = 200;
const MAX_NOW_NEXT_KEYS = 60;
const MAX_EPG_WINDOW_KEYS = 40;
const MAX_SEARCH_QUERY_CHARS = 256;
const MAX_SEARCH_LIMIT = 60;
const MAX_SEARCH_SUGGESTIONS_LIMIT = 16;
const MAX_SOURCE_IDS = 64;

const CONTENT_KINDS = new Set<ContentKind>(['live', 'movie', 'series']);
const USER_ITEM_KINDS = new Set<UserItemKind>(['live', 'movie', 'series', 'episode']);
const SEARCH_SCOPES = new Set<SearchScope>(['all', 'live', 'epg', 'movie', 'series', 'episode']);
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
export const isOptionalProfileId = (x: unknown): boolean => isOptionalStrictProfileId(x);
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

const SEARCH_OPT_KEYS = new Set([
  'scope',
  'limit',
  'sourceId',
  'nowMs',
  'profileId',
  'parentalUnlocked',
]);
const SEARCH_SUGGESTIONS_OPT_KEYS = new Set(['limit', 'sourceId', 'profileId', 'parentalUnlocked']);
const ALPHABET_INDEX_INPUT_KEYS = new Set([
  'kind',
  'sourceId',
  'categoryId',
  'collapseVariants',
  'groupVersions',
  'excludeWatched',
  'profileId',
  'parentalUnlocked',
]);
const SAVE_PROGRESS_INPUT_KEYS = new Set([
  'profileId',
  'sourceId',
  'itemKey',
  'kind',
  'title',
  'subtitle',
  'logo',
  'seriesKey',
  'season',
  'episode',
  'positionMs',
  'durationMs',
  'watched',
]);
const TOGGLE_FAVORITE_INPUT_KEYS = new Set([
  'profileId',
  'sourceId',
  'itemKey',
  'kind',
  'title',
  'logo',
  'year',
  'rating',
]);
const SAVE_TRACK_PREFERENCE_INPUT_KEYS = new Set([
  'scopeKey',
  'sourceId',
  'profileId',
  'audioLang',
  'audioLabel',
  'subLang',
  'subLabel',
  'subDisabled',
  'audioDelayMs',
  'subDelayMs',
  'resizeMode',
]);
const CATEGORY_QUERY_OPT_KEYS = new Set([
  'collapseVariants',
  'groupVersions',
  'includeHidden',
  'profileId',
  'parentalUnlocked',
]);
const LIST_ITEMS_OPT_KEYS = new Set([
  'sortBy',
  'excludeWatched',
  'collapseVariants',
  'groupVersions',
  'profileId',
  'parentalUnlocked',
]);

export function isSearchOptions(x: unknown): x is SearchOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, SEARCH_OPT_KEYS)) return false;
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
  if (sourceId !== undefined && !isCleanKey(sourceId, MAX_ID_CHARS)) {
    return false;
  }
  const nowMs = x['nowMs'];
  if (nowMs !== undefined && !isNonNegativeFinite(nowMs)) return false;
  if (!isOptionalStrictProfileId(x['profileId'])) return false;
  return x['parentalUnlocked'] === undefined || typeof x['parentalUnlocked'] === 'boolean';
}

export function isSearchSuggestionsOptions(x: unknown): x is SearchSuggestionsOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, SEARCH_SUGGESTIONS_OPT_KEYS)) return false;
  const limit = x['limit'];
  if (
    limit !== undefined &&
    (!isSafeInt(limit) || limit < 0 || limit > MAX_SEARCH_SUGGESTIONS_LIMIT)
  ) {
    return false;
  }
  return (
    isOptionalSourceId(x['sourceId']) &&
    isOptionalStrictProfileId(x['profileId']) &&
    (x['parentalUnlocked'] === undefined || typeof x['parentalUnlocked'] === 'boolean')
  );
}

export function isAlphabetIndexInput(x: unknown): x is AlphabetIndexInput {
  if (!isRecord(x) || !hasOnlyKeys(x, ALPHABET_INDEX_INPUT_KEYS)) return false;
  const kind = x['kind'];
  if (typeof kind !== 'string' || !CONTENT_KINDS.has(kind as ContentKind)) {
    return false;
  }
  if (!isOptionalSourceId(x['sourceId'])) return false;
  if (x['categoryId'] !== undefined && !isCleanKey(x['categoryId'], 512)) return false;
  if (x['collapseVariants'] !== undefined && typeof x['collapseVariants'] !== 'boolean') {
    return false;
  }
  if (x['groupVersions'] !== undefined && typeof x['groupVersions'] !== 'boolean') {
    return false;
  }
  if (x['excludeWatched'] !== undefined && typeof x['excludeWatched'] !== 'boolean') {
    return false;
  }
  if (x['parentalUnlocked'] !== undefined && typeof x['parentalUnlocked'] !== 'boolean') {
    return false;
  }
  return isOptionalStrictProfileId(x['profileId']);
}

export function isSaveProgressInput(x: unknown): x is SaveProgressInput {
  return (
    isRecord(x) &&
    hasOnlyKeys(x, SAVE_PROGRESS_INPUT_KEYS) &&
    isOptionalStrictProfileId(x['profileId']) &&
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
    hasOnlyKeys(x, TOGGLE_FAVORITE_INPUT_KEYS) &&
    isOptionalStrictProfileId(x['profileId']) &&
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
    hasOnlyKeys(x, SAVE_TRACK_PREFERENCE_INPUT_KEYS) &&
    isCleanKey(x['scopeKey']) &&
    isCleanKey(x['sourceId'], MAX_ID_CHARS) &&
    isOptionalStrictProfileId(x['profileId']) &&
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
  if (x['allowLegacyTls'] !== undefined && typeof x['allowLegacyTls'] !== 'boolean') return false;
  const fmt = x['xtreamFormat'];
  return fmt === undefined || fmt === 'ts' || fmt === 'm3u8';
}

const MAX_TIMEZONE_CHARS = 128;
const MAX_CATEGORY_SELECTION_IDS = 4_096;
const CATEGORY_SELECTION_KEYS = new Set<keyof SourceCategorySelection>([
  'live',
  'movie',
  'series',
  'knownLive',
  'knownMovie',
  'knownSeries',
  'pendingLive',
  'pendingMovie',
  'pendingSeries',
]);
const SOURCE_SETTINGS_PATCH_KEYS = new Set<keyof SourceSettings>([
  'xmltvTimezone',
  'categorySelection',
  'transport',
  'epgShiftMs',
  'includePlaceholderChannels',
  'vodPlaylist',
]);

const isOptionalTimezoneString = (x: unknown): boolean =>
  x === undefined || (isBoundedString(x, 0, MAX_TIMEZONE_CHARS) && !hasControlChar(x.trim()));

function isSourceCategorySelection(x: unknown): x is SourceCategorySelection {
  if (!isRecord(x)) return false;
  for (const [key, value] of Object.entries(x)) {
    if (!CATEGORY_SELECTION_KEYS.has(key as keyof SourceCategorySelection)) return false;
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      value.length > MAX_CATEGORY_SELECTION_IDS ||
      !value.every((entry) => isCleanKey(entry, MAX_ID_CHARS))
    ) {
      return false;
    }
  }
  return true;
}

export function isSourceSettingsPatch(x: unknown): x is Partial<SourceSettings> {
  if (!isRecord(x)) return false;
  for (const key of Object.keys(x)) {
    if (!SOURCE_SETTINGS_PATCH_KEYS.has(key as keyof SourceSettings)) return false;
  }
  if (!isOptionalTimezoneString(x['xmltvTimezone'])) return false;
  if (x['categorySelection'] !== undefined && !isSourceCategorySelection(x['categorySelection'])) {
    return false;
  }
  if (x['transport'] !== undefined && !isTransportSettings(x['transport'])) return false;
  if (x['epgShiftMs'] !== undefined && !isFiniteNumber(x['epgShiftMs'])) return false;
  if (
    x['includePlaceholderChannels'] !== undefined &&
    typeof x['includePlaceholderChannels'] !== 'boolean'
  ) {
    return false;
  }
  if (x['vodPlaylist'] !== undefined && typeof x['vodPlaylist'] !== 'boolean') return false;
  return true;
}

export function isLocalM3uSourceInput(x: unknown): x is LocalM3uSourceInput {
  if (!isRecord(x) || !isBoundedString(x['name'])) return false;
  const bytes = x['bytes'];
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_PICKED_PLAYLIST_BYTES) return false;
  if (!isOptionalTrimmedCleanString(x['guideUrl'])) return false;
  if (!isOptionalTimezoneString(x['xmltvTimezone'])) return false;
  if (x['vodPlaylist'] !== undefined && typeof x['vodPlaylist'] !== 'boolean') return false;
  return x['transport'] === undefined || isTransportSettings(x['transport']);
}

export function isAddSourceInput(x: unknown): x is AddSourceInput {
  if (!isRecord(x) || !isBoundedString(x['name'])) return false;
  if (x['transport'] !== undefined && !isTransportSettings(x['transport'])) return false;
  if (!isOptionalTrimmedCleanString(x['guideUrl'])) return false;
  if (!isOptionalTimezoneString(x['xmltvTimezone'])) return false;
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

export function isCategoryQueryOptions(x: unknown): x is CategoryQueryOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, CATEGORY_QUERY_OPT_KEYS)) return false;
  if (x['collapseVariants'] !== undefined && typeof x['collapseVariants'] !== 'boolean') {
    return false;
  }
  if (x['groupVersions'] !== undefined && typeof x['groupVersions'] !== 'boolean') {
    return false;
  }
  if (x['includeHidden'] !== undefined && typeof x['includeHidden'] !== 'boolean') {
    return false;
  }
  if (!isOptionalStrictProfileId(x['profileId'])) return false;
  return x['parentalUnlocked'] === undefined || typeof x['parentalUnlocked'] === 'boolean';
}

export function isListItemsOptions(x: unknown): x is ListItemsOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, LIST_ITEMS_OPT_KEYS)) return false;
  const sortBy = x['sortBy'];
  if (
    sortBy !== undefined &&
    (typeof sortBy !== 'string' || !ITEM_SORT_ORDERS.has(sortBy as ItemSortOrder))
  ) {
    return false;
  }
  const excludeWatched = x['excludeWatched'];
  if (excludeWatched !== undefined && typeof excludeWatched !== 'boolean') return false;
  if (x['collapseVariants'] !== undefined && typeof x['collapseVariants'] !== 'boolean') {
    return false;
  }
  if (x['groupVersions'] !== undefined && typeof x['groupVersions'] !== 'boolean') {
    return false;
  }
  if (x['parentalUnlocked'] !== undefined && typeof x['parentalUnlocked'] !== 'boolean') {
    return false;
  }
  return isOptionalStrictProfileId(x['profileId']);
}

const MAX_PROFILE_NAME_INPUT_CHARS = 128;
const MAX_PIN_INPUT_CHARS = 32;
const MAX_RATING_AGE = 21;
const MAX_UNLOCK_TIMEOUT_MIN = 1_440;
const CREATE_PROFILE_KEYS = new Set(['name', 'avatarToken', 'isKids']);
const UPDATE_PARENTAL_SETTINGS_KEYS = new Set([
  'enabled',
  'blockAdultKeywords',
  'maxRatingAge',
  'unlockTimeoutMin',
]);
const PARENTAL_LOCK_FILTER_KEYS = new Set(['sourceId', 'targetKind', 'itemKind']);
const SET_PARENTAL_LOCK_KEYS = new Set([
  'profileId',
  'sourceId',
  'targetKind',
  'itemKind',
  'targetKey',
]);
const PARENTAL_QUERY_OPT_KEYS = new Set(['profileId', 'parentalUnlocked']);
const PARENTAL_UNLOCKED_OPT_KEYS = new Set(['parentalUnlocked']);

function hasOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

export const isStrictProfileId = (x: unknown): x is string =>
  typeof x === 'string' && PROFILE_ID_RE.test(x);

export const isOptionalStrictProfileId = (x: unknown): boolean =>
  x === undefined || isStrictProfileId(x);

export const isPinString = (x: unknown, min = 0): x is string =>
  isBoundedString(x, min, MAX_PIN_INPUT_CHARS) && !hasControlChar(x);

export function isParentalQueryOptions(x: unknown): x is ParentalQueryOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, PARENTAL_QUERY_OPT_KEYS)) return false;
  if (!isOptionalStrictProfileId(x['profileId'])) return false;
  return x['parentalUnlocked'] === undefined || typeof x['parentalUnlocked'] === 'boolean';
}

export function isParentalUnlockedOption(x: unknown): x is { readonly parentalUnlocked?: boolean } {
  if (!isRecord(x) || !hasOnlyKeys(x, PARENTAL_UNLOCKED_OPT_KEYS)) return false;
  return x['parentalUnlocked'] === undefined || typeof x['parentalUnlocked'] === 'boolean';
}

export function isCreateProfileInput(x: unknown): x is CreateProfileInput {
  if (!isRecord(x) || !hasOnlyKeys(x, CREATE_PROFILE_KEYS)) return false;
  if (!isCleanKey(x['name'], MAX_PROFILE_NAME_INPUT_CHARS)) return false;
  if (x['avatarToken'] !== undefined && !isProfileAvatarToken(x['avatarToken'])) return false;
  return x['isKids'] === undefined || typeof x['isKids'] === 'boolean';
}

export function isUpdateProfilePatch(x: unknown): x is UpdateProfilePatch {
  if (!isRecord(x) || !hasOnlyKeys(x, CREATE_PROFILE_KEYS)) return false;
  if (x['name'] !== undefined && !isCleanKey(x['name'], MAX_PROFILE_NAME_INPUT_CHARS)) return false;
  if (x['avatarToken'] !== undefined && !isProfileAvatarToken(x['avatarToken'])) return false;
  return x['isKids'] === undefined || typeof x['isKids'] === 'boolean';
}

export function isUpdateParentalSettingsPatch(x: unknown): x is UpdateParentalSettingsPatch {
  if (!isRecord(x) || !hasOnlyKeys(x, UPDATE_PARENTAL_SETTINGS_KEYS)) return false;
  if (x['enabled'] !== undefined && typeof x['enabled'] !== 'boolean') return false;
  if (x['blockAdultKeywords'] !== undefined && typeof x['blockAdultKeywords'] !== 'boolean') {
    return false;
  }
  const maxAge = x['maxRatingAge'];
  if (
    maxAge !== undefined &&
    maxAge !== null &&
    (!isSafeInt(maxAge) || maxAge < 0 || maxAge > MAX_RATING_AGE)
  ) {
    return false;
  }
  const timeout = x['unlockTimeoutMin'];
  return (
    timeout === undefined ||
    (isSafeInt(timeout) && timeout >= 0 && timeout <= MAX_UNLOCK_TIMEOUT_MIN)
  );
}

export function isParentalLockFilter(x: unknown): x is ParentalLockFilter {
  if (!isRecord(x) || !hasOnlyKeys(x, PARENTAL_LOCK_FILTER_KEYS)) return false;
  if (!isOptionalSourceId(x['sourceId'])) return false;
  const targetKind = x['targetKind'];
  if (targetKind !== undefined && targetKind !== 'category' && targetKind !== 'item') return false;
  const itemKind = x['itemKind'];
  return (
    itemKind === undefined ||
    (typeof itemKind === 'string' && CONTENT_KINDS.has(itemKind as ContentKind))
  );
}

export function isSetParentalLockInput(x: unknown): x is SetParentalLockInput {
  if (!isRecord(x) || !hasOnlyKeys(x, SET_PARENTAL_LOCK_KEYS)) return false;
  if (!isOptionalStrictProfileId(x['profileId'])) return false;
  if (!isCleanKey(x['sourceId'], MAX_ID_CHARS)) return false;
  if (x['targetKind'] !== 'category' && x['targetKind'] !== 'item') return false;
  const itemKind = x['itemKind'];
  if (typeof itemKind !== 'string' || !CONTENT_KINDS.has(itemKind as ContentKind)) return false;
  return isCleanKey(x['targetKey'], MAX_ITEM_KEY_CHARS);
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
