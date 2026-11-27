import type {
  ApplyElvFixMatchInput,
  ElvFranchiseLibraryItem,
  ElvGenreBucket,
  ElvItemEnrichment,
  ElvMediaType,
  ElvPersonLibraryItem,
  ElvPersonQuery,
  ElvRecommendationsQuery,
  ElvRecommendedItem,
  ElvSearchCandidate,
  ItemRow,
  ListElvFranchiseItemsOptions,
  ListElvImdbGenresOptions,
  ListElvItemsByImdbGenreOptions,
  ListElvPersonLibraryItemsOptions,
} from '@elv/data';
import {
  hasControlChar,
  hasOnlyKeys,
  isBoundedString,
  isCleanKey,
  isOptionalStrictProfileId,
  isRecord,
  isSafeInt,
  isSearchQuery,
  isSourceIdList,
  MAX_ID_CHARS,
} from './catalog-ipc-guards.ts';

const MAX_ELV_ITEM_KEY_CHARS = 256;
const MAX_ELV_GENRE_CHARS = 80;
const MAX_ELV_GENRE_OFFSET = 100_000;
const MAX_ELV_GENRE_LIMIT = 200;
const MAX_ELV_RECS_LIMIT = 100;
const MAX_ELV_PERSON_LIMIT = 200;
const MAX_ELV_PERSON_NAME_CHARS = 160;
const MAX_ELV_PERSON_ID_CHARS = 64;
const MAX_RATING_AGE = 21;
const IMDB_ID_RE = /^tt\d{5,10}$/i;
const SAFE_LANG_RE = /^[a-z]{2}(?:-[a-z]{2})?$/i;
const WHITESPACE_RE = /\s/;

/** Serializable IPC options for `refreshElvFeeds` (`#512`; excludes non-serializable `signal`). */
interface RefreshElvFeedsIpcOptions {
  readonly force?: boolean;
}

/** Discriminated union of Wave E2 ELV Mode discovery & recommendations RPC calls (`#512`). */
export type CatalogWaveE2OpsRpcCall =
  | { method: 'listElvImdbGenres'; kind: ElvMediaType; opts?: ListElvImdbGenresOptions }
  | {
      method: 'listElvItemsByImdbGenre';
      kind: ElvMediaType;
      genre: string;
      opts?: ListElvItemsByImdbGenreOptions;
    }
  | { method: 'getElvRecommendations'; opts: ElvRecommendationsQuery }
  | { method: 'refreshElvFeeds'; opts?: RefreshElvFeedsIpcOptions }
  | {
      method: 'listElvFranchiseItems';
      imdbId: string;
      opts?: ListElvFranchiseItemsOptions;
    }
  | {
      method: 'listElvPersonLibraryItems';
      person: ElvPersonQuery;
      opts?: ListElvPersonLibraryItemsOptions;
    }
  | { method: 'searchElvMatchCandidates'; query: string; mediaType: ElvMediaType }
  | { method: 'applyElvFixMatch'; input: ApplyElvFixMatchInput };

/** Preload bridge methods for Wave E2 ELV Mode discovery, recommendations, franchise, cast & Fix Match (`#512`). */
export interface CatalogBridgeWaveE2Ops {
  listElvImdbGenres?(
    kind: ElvMediaType,
    opts?: ListElvImdbGenresOptions,
  ): Promise<readonly ElvGenreBucket[]>;
  listElvItemsByImdbGenre?(
    kind: ElvMediaType,
    genre: string,
    opts?: ListElvItemsByImdbGenreOptions,
  ): Promise<readonly ItemRow[]>;
  getElvRecommendations?(opts: ElvRecommendationsQuery): Promise<readonly ElvRecommendedItem[]>;
  refreshElvFeeds?(opts?: RefreshElvFeedsIpcOptions): Promise<boolean>;
  listElvFranchiseItems?(
    imdbId: string,
    opts?: ListElvFranchiseItemsOptions,
  ): Promise<readonly ElvFranchiseLibraryItem[]>;
  listElvPersonLibraryItems?(
    person: ElvPersonQuery,
    opts?: ListElvPersonLibraryItemsOptions,
  ): Promise<readonly ElvPersonLibraryItem[]>;
  searchElvMatchCandidates?(
    query: string,
    mediaType: ElvMediaType,
  ): Promise<readonly ElvSearchCandidate[]>;
  applyElvFixMatch?(input: ApplyElvFixMatchInput): Promise<ElvItemEnrichment | null>;
}

/** Set of Wave E2 ELV Mode RPC method names for worker runtime dispatch narrowing. */
export const WAVE_E2_RPC_METHODS: ReadonlySet<string> = new Set<CatalogWaveE2OpsRpcCall['method']>([
  'listElvImdbGenres',
  'listElvItemsByImdbGenre',
  'getElvRecommendations',
  'refreshElvFeeds',
  'listElvFranchiseItems',
  'listElvPersonLibraryItems',
  'searchElvMatchCandidates',
  'applyElvFixMatch',
]);

const LIST_GENRES_KEYS = new Set(['method', 'kind', 'opts']);
const LIST_GENRES_OPT_KEYS = new Set(['excludedSourceIds', 'profileId', 'parentalUnlocked']);
const LIST_GENRE_ITEMS_KEYS = new Set(['method', 'kind', 'genre', 'opts']);
const LIST_GENRE_ITEMS_OPT_KEYS = new Set([
  'offset',
  'limit',
  'excludedSourceIds',
  'profileId',
  'parentalUnlocked',
  'sortBy',
]);
const GET_RECS_KEYS = new Set(['method', 'opts']);
const GET_RECS_OPT_KEYS = new Set([
  'profileId',
  'profile',
  'kind',
  'limit',
  'excludedSourceIds',
  'maxRatingAge',
  'parentalUnlocked',
]);
const REFRESH_FEEDS_KEYS = new Set(['method', 'opts']);
const REFRESH_FEEDS_OPT_KEYS = new Set(['force']);
const LIST_FRANCHISE_KEYS = new Set(['method', 'imdbId', 'opts']);
const LIST_FRANCHISE_OPT_KEYS = new Set(['excludedSourceIds', 'profileId', 'parentalUnlocked']);
const LIST_PERSON_KEYS = new Set(['method', 'person', 'opts']);
const PERSON_QUERY_KEYS = new Set(['personId', 'name']);
const LIST_PERSON_OPT_KEYS = new Set([
  'excludedSourceIds',
  'limit',
  'profileId',
  'parentalUnlocked',
]);
const SEARCH_CANDIDATES_KEYS = new Set(['method', 'query', 'mediaType']);
const APPLY_FIX_MATCH_KEYS = new Set(['method', 'input']);
const APPLY_FIX_MATCH_INPUT_KEYS = new Set(['itemKey', 'sourceId', 'mediaType', 'imdbId', 'lang']);

const isElvMediaType = (x: unknown): x is ElvMediaType => x === 'movie' || x === 'series';

const isSafeElvItemKey = (x: unknown): x is string =>
  isBoundedString(x, 1, MAX_ELV_ITEM_KEY_CHARS) &&
  !WHITESPACE_RE.test(x) &&
  !hasControlChar(x) &&
  !x.includes('://') &&
  !x.includes('{{');

const isValidImdbId = (x: unknown): x is string =>
  typeof x === 'string' && IMDB_ID_RE.test(x.trim());

const isOptionalSafeLang = (x: unknown): boolean =>
  x === undefined || (typeof x === 'string' && SAFE_LANG_RE.test(x.trim()));

function isListGenresOptions(x: unknown): x is ListElvImdbGenresOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, LIST_GENRES_OPT_KEYS)) return false;
  if (x['excludedSourceIds'] !== undefined && !isSourceIdList(x['excludedSourceIds'])) return false;
  if (!isOptionalStrictProfileId(x['profileId'])) return false;
  return x['parentalUnlocked'] === undefined || typeof x['parentalUnlocked'] === 'boolean';
}

function isListGenreItemsOptions(x: unknown): x is ListElvItemsByImdbGenreOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, LIST_GENRE_ITEMS_OPT_KEYS)) return false;
  const offset = x['offset'];
  if (offset !== undefined && (!isSafeInt(offset) || offset < 0 || offset > MAX_ELV_GENRE_OFFSET)) {
    return false;
  }
  const limit = x['limit'];
  if (limit !== undefined && (!isSafeInt(limit) || limit < 0 || limit > MAX_ELV_GENRE_LIMIT)) {
    return false;
  }
  if (x['excludedSourceIds'] !== undefined && !isSourceIdList(x['excludedSourceIds'])) return false;
  if (!isOptionalStrictProfileId(x['profileId'])) return false;
  if (x['parentalUnlocked'] !== undefined && typeof x['parentalUnlocked'] !== 'boolean') {
    return false;
  }
  const sortBy = x['sortBy'];
  return sortBy === undefined || sortBy === 'default' || sortBy === 'alpha';
}

function isRecommendationsQuery(x: unknown): x is ElvRecommendationsQuery {
  if (!isRecord(x) || !hasOnlyKeys(x, GET_RECS_OPT_KEYS)) return false;
  if (!isOptionalStrictProfileId(x['profileId'])) return false;
  const profile = x['profile'];
  if (profile !== 'home' && profile !== 'elv_picks') return false;
  if (x['kind'] !== undefined && !isElvMediaType(x['kind'])) return false;
  const limit = x['limit'];
  if (limit !== undefined && (!isSafeInt(limit) || limit < 0 || limit > MAX_ELV_RECS_LIMIT)) {
    return false;
  }
  if (x['excludedSourceIds'] !== undefined && !isSourceIdList(x['excludedSourceIds'])) return false;
  const maxAge = x['maxRatingAge'];
  if (
    maxAge !== undefined &&
    maxAge !== null &&
    (!isSafeInt(maxAge) || maxAge < 0 || maxAge > MAX_RATING_AGE)
  ) {
    return false;
  }
  return x['parentalUnlocked'] === undefined || typeof x['parentalUnlocked'] === 'boolean';
}

function isRefreshFeedsOptions(x: unknown): x is RefreshElvFeedsIpcOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, REFRESH_FEEDS_OPT_KEYS)) return false;
  return x['force'] === undefined || typeof x['force'] === 'boolean';
}

function isListFranchiseOptions(x: unknown): x is ListElvFranchiseItemsOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, LIST_FRANCHISE_OPT_KEYS)) return false;
  if (x['excludedSourceIds'] !== undefined && !isSourceIdList(x['excludedSourceIds'])) return false;
  if (!isOptionalStrictProfileId(x['profileId'])) return false;
  return x['parentalUnlocked'] === undefined || typeof x['parentalUnlocked'] === 'boolean';
}

function isPersonQuery(x: unknown): x is ElvPersonQuery {
  if (!isRecord(x) || !hasOnlyKeys(x, PERSON_QUERY_KEYS)) return false;
  const name = x['name'];
  if (!isBoundedString(name, 0, MAX_ELV_PERSON_NAME_CHARS) || hasControlChar(name)) return false;
  const personId = x['personId'];
  if (personId !== undefined) {
    if (
      !isBoundedString(personId, 1, MAX_ELV_PERSON_ID_CHARS) ||
      WHITESPACE_RE.test(personId) ||
      hasControlChar(personId)
    ) {
      return false;
    }
  }
  return name.trim().length > 0 || (typeof personId === 'string' && personId.trim().length > 0);
}

function isListPersonOptions(x: unknown): x is ListElvPersonLibraryItemsOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, LIST_PERSON_OPT_KEYS)) return false;
  if (x['excludedSourceIds'] !== undefined && !isSourceIdList(x['excludedSourceIds'])) return false;
  const limit = x['limit'];
  if (limit !== undefined && (!isSafeInt(limit) || limit < 0 || limit > MAX_ELV_PERSON_LIMIT)) {
    return false;
  }
  if (!isOptionalStrictProfileId(x['profileId'])) return false;
  return x['parentalUnlocked'] === undefined || typeof x['parentalUnlocked'] === 'boolean';
}

function isApplyFixMatchInput(x: unknown): x is ApplyElvFixMatchInput {
  if (!isRecord(x) || !hasOnlyKeys(x, APPLY_FIX_MATCH_INPUT_KEYS)) return false;
  if (!isSafeElvItemKey(x['itemKey'])) return false;
  if (!isCleanKey(x['sourceId'], MAX_ID_CHARS)) return false;
  if (!isElvMediaType(x['mediaType'])) return false;
  if (!isValidImdbId(x['imdbId'])) return false;
  return isOptionalSafeLang(x['lang']);
}

/** Validates all Wave E2 ELV Mode discovery & recommendations RPC payloads (`#512`). */
export function isWaveE2OpsRpcCall(x: Record<string, unknown>): boolean {
  switch (x['method']) {
    case 'listElvImdbGenres':
      return (
        hasOnlyKeys(x, LIST_GENRES_KEYS) &&
        isElvMediaType(x['kind']) &&
        (x['opts'] === undefined || isListGenresOptions(x['opts']))
      );
    case 'listElvItemsByImdbGenre':
      return (
        hasOnlyKeys(x, LIST_GENRE_ITEMS_KEYS) &&
        isElvMediaType(x['kind']) &&
        isBoundedString(x['genre'], 1, MAX_ELV_GENRE_CHARS) &&
        x['genre'].trim().length > 0 &&
        !hasControlChar(x['genre']) &&
        (x['opts'] === undefined || isListGenreItemsOptions(x['opts']))
      );
    case 'getElvRecommendations':
      return hasOnlyKeys(x, GET_RECS_KEYS) && isRecommendationsQuery(x['opts']);
    case 'refreshElvFeeds':
      return (
        hasOnlyKeys(x, REFRESH_FEEDS_KEYS) &&
        (x['opts'] === undefined || isRefreshFeedsOptions(x['opts']))
      );
    case 'listElvFranchiseItems':
      return (
        hasOnlyKeys(x, LIST_FRANCHISE_KEYS) &&
        isValidImdbId(x['imdbId']) &&
        (x['opts'] === undefined || isListFranchiseOptions(x['opts']))
      );
    case 'listElvPersonLibraryItems':
      return (
        hasOnlyKeys(x, LIST_PERSON_KEYS) &&
        isPersonQuery(x['person']) &&
        (x['opts'] === undefined || isListPersonOptions(x['opts']))
      );
    case 'searchElvMatchCandidates':
      return (
        hasOnlyKeys(x, SEARCH_CANDIDATES_KEYS) &&
        isSearchQuery(x['query']) &&
        isElvMediaType(x['mediaType'])
      );
    case 'applyElvFixMatch':
      return hasOnlyKeys(x, APPLY_FIX_MATCH_KEYS) && isApplyFixMatchInput(x['input']);
    default:
      return false;
  }
}
