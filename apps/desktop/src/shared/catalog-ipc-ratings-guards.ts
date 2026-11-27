import type {
  ListRatingsOptions,
  RatingRow,
  RatingValue,
  RefreshMyListNewEpisodesOptions,
  SetRatingInput,
} from '@elv/data';
import type { Result } from '@elv/domain';
import {
  hasControlChar,
  hasOnlyKeys,
  isBoundedString,
  isCleanKey,
  isFiniteNumber,
  isItemKeyList,
  isOptionalProfileId,
  isOptionalStrictProfileId,
  isOptionalUserLimit,
  isRecord,
  isSafeInt,
  MAX_ID_CHARS,
} from './catalog-ipc-guards.ts';

const MAX_RATING_TITLE_CHARS = 512;
const MAX_RATING_LOGO_CHARS = 4096;
const MAX_NEW_EPISODES_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_NEW_EPISODES_OPT_KEYS = new Set([
  'cooldownMs',
  'maxSeries',
  'force',
  'extraSeriesKeys',
]);

/** Validates options passed to `refreshMyListNewEpisodes` (including optional `extraSeriesKeys`). */
export function isRefreshMyListNewEpisodesOptions(
  x: unknown,
): x is RefreshMyListNewEpisodesOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, REFRESH_NEW_EPISODES_OPT_KEYS)) return false;
  const cd = x['cooldownMs'];
  const max = x['maxSeries'];
  return (
    (cd === undefined || (isSafeInt(cd) && cd >= 0 && cd <= MAX_NEW_EPISODES_COOLDOWN_MS)) &&
    (max === undefined || (isSafeInt(max) && max >= 0 && max <= 50)) &&
    (x['force'] === undefined || typeof x['force'] === 'boolean') &&
    (x['extraSeriesKeys'] === undefined || isItemKeyList(x['extraSeriesKeys']))
  );
}

/** Discriminated union of personal movie/series rating RPC calls. */
export type CatalogRatingsOpsRpcCall =
  | { method: 'setRating'; input: SetRatingInput; value: RatingValue | null }
  | { method: 'getRating'; itemKey: string; profileId?: string }
  | { method: 'listRatings'; opts?: ListRatingsOptions }
  | { method: 'listRatingMap'; profileId?: string };

/** Preload bridge methods for personal movie/series ratings. */
export interface CatalogBridgeRatingsOps {
  setRating?(input: SetRatingInput, value: RatingValue | null): Promise<Result<RatingValue | null>>;
  getRating?(itemKey: string, profileId?: string): Promise<RatingValue | null>;
  listRatings?(opts?: ListRatingsOptions): Promise<RatingRow[]>;
  listRatingMap?(profileId?: string): Promise<Readonly<Record<string, RatingValue>>>;
}

const SET_RATING_INPUT_KEYS = new Set([
  'profileId',
  'sourceId',
  'itemKey',
  'kind',
  'title',
  'logo',
  'year',
  'rating',
]);
const LIST_RATINGS_OPT_KEYS = new Set(['value', 'kind', 'limit', 'profileId', 'parentalUnlocked']);

const SET_RATING_CALL_KEYS = new Set(['method', 'input', 'value']);
const GET_RATING_CALL_KEYS = new Set(['method', 'itemKey', 'profileId']);
const LIST_RATINGS_CALL_KEYS = new Set(['method', 'opts']);
const LIST_RATING_MAP_CALL_KEYS = new Set(['method', 'profileId']);

const isRatingValue = (x: unknown): x is RatingValue => x === 'like' || x === 'dislike';
const isRatingKind = (x: unknown): boolean => x === 'movie' || x === 'series';

const isOptionalNullableLogo = (x: unknown): boolean =>
  x === undefined ||
  x === null ||
  (isBoundedString(x, 0, MAX_RATING_LOGO_CHARS) && !hasControlChar(x));

const isOptionalNullableSafeInt = (x: unknown): boolean =>
  x === undefined || x === null || isSafeInt(x);

const isOptionalNullableFinite = (x: unknown): boolean =>
  x === undefined || x === null || isFiniteNumber(x);

function isSetRatingInput(x: unknown): x is SetRatingInput {
  return (
    isRecord(x) &&
    hasOnlyKeys(x, SET_RATING_INPUT_KEYS) &&
    isOptionalStrictProfileId(x['profileId']) &&
    isCleanKey(x['sourceId'], MAX_ID_CHARS) &&
    isCleanKey(x['itemKey']) &&
    isRatingKind(x['kind']) &&
    isBoundedString(x['title'], 1, MAX_RATING_TITLE_CHARS) &&
    isOptionalNullableLogo(x['logo']) &&
    isOptionalNullableSafeInt(x['year']) &&
    isOptionalNullableFinite(x['rating'])
  );
}

function isListRatingsOptions(x: unknown): x is ListRatingsOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, LIST_RATINGS_OPT_KEYS)) return false;
  if (x['value'] !== undefined && !isRatingValue(x['value'])) return false;
  if (x['kind'] !== undefined && !isRatingKind(x['kind'])) return false;
  if (!isOptionalUserLimit(x['limit'])) return false;
  if (!isOptionalProfileId(x['profileId'])) return false;
  return x['parentalUnlocked'] === undefined || typeof x['parentalUnlocked'] === 'boolean';
}

/** Validates personal movie/series rating RPC calls (`setRating`, `getRating`, `listRatings`, `listRatingMap`). */
export function isRatingsOpsRpcCall(x: Record<string, unknown>): boolean {
  switch (x['method']) {
    case 'setRating':
      return (
        hasOnlyKeys(x, SET_RATING_CALL_KEYS) &&
        isSetRatingInput(x['input']) &&
        (x['value'] === null || isRatingValue(x['value']))
      );
    case 'getRating':
      return (
        hasOnlyKeys(x, GET_RATING_CALL_KEYS) &&
        isCleanKey(x['itemKey']) &&
        isOptionalProfileId(x['profileId'])
      );
    case 'listRatings':
      return (
        hasOnlyKeys(x, LIST_RATINGS_CALL_KEYS) &&
        (x['opts'] === undefined || isListRatingsOptions(x['opts']))
      );
    case 'listRatingMap':
      return hasOnlyKeys(x, LIST_RATING_MAP_CALL_KEYS) && isOptionalProfileId(x['profileId']);
    default:
      return false;
  }
}
