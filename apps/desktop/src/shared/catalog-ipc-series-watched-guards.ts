import type { Result } from '@elv/domain';
import { hasOnlyKeys, isCleanKey, isOptionalProfileId, isSafeInt } from './catalog-ipc-guards.ts';

/** Discriminated union of transactional series/season watched RPC calls. */
export type CatalogSeriesWatchedOpsRpcCall =
  | {
      method: 'setSeasonWatched';
      seriesKey: string;
      season: number;
      watched: boolean;
      profileId?: string;
    }
  | {
      method: 'setSeriesWatched';
      seriesKey: string;
      watched: boolean;
      profileId?: string;
    };

/** Preload bridge methods for transactional series and season watched mutations. */
export interface CatalogBridgeSeriesWatchedOps {
  setSeasonWatched?(
    seriesKey: string,
    season: number,
    watched: boolean,
    profileId?: string,
  ): Promise<Result<number>>;
  setSeriesWatched?(
    seriesKey: string,
    watched: boolean,
    profileId?: string,
  ): Promise<Result<number>>;
}

const SET_SEASON_WATCHED_KEYS = new Set(['method', 'seriesKey', 'season', 'watched', 'profileId']);
const SET_SERIES_WATCHED_KEYS = new Set(['method', 'seriesKey', 'watched', 'profileId']);
const isNonBlankSeriesKey = (x: unknown): x is string => isCleanKey(x) && x.trim().length > 0;

/** Validates transactional series and season watched RPC calls (`setSeasonWatched`, `setSeriesWatched`). */
export function isSeriesWatchedOpsRpcCall(x: Record<string, unknown>): boolean {
  switch (x['method']) {
    case 'setSeasonWatched':
      return (
        hasOnlyKeys(x, SET_SEASON_WATCHED_KEYS) &&
        isNonBlankSeriesKey(x['seriesKey']) &&
        isSafeInt(x['season']) &&
        x['season'] >= 0 &&
        typeof x['watched'] === 'boolean' &&
        isOptionalProfileId(x['profileId'])
      );
    case 'setSeriesWatched':
      return (
        hasOnlyKeys(x, SET_SERIES_WATCHED_KEYS) &&
        isNonBlankSeriesKey(x['seriesKey']) &&
        typeof x['watched'] === 'boolean' &&
        isOptionalProfileId(x['profileId'])
      );
    default:
      return false;
  }
}
