import type { RecommendationDismissalKind } from '@elv/data';
import {
  hasControlChar,
  hasOnlyKeys,
  isBoundedString,
  isOptionalStrictProfileId,
  MAX_ITEM_KEY_CHARS,
} from './catalog-ipc-guards.ts';

/** Discriminated union of Wave R3 recommendation dismissal RPC calls. */
export type CatalogWaveR3OpsRpcCall =
  | {
      method: 'dismissRecommendation';
      itemKey: string;
      kind: RecommendationDismissalKind;
      profileId?: string;
    }
  | { method: 'restoreRecommendation'; itemKey: string; profileId?: string }
  | { method: 'listDismissedRecommendationKeys'; profileId?: string };

/** Preload bridge methods for Wave R3 per-profile recommendation dismissals. */
export interface CatalogBridgeWaveR3Ops {
  dismissRecommendation?(
    itemKey: string,
    kind: RecommendationDismissalKind,
    profileId?: string,
  ): Promise<void>;
  restoreRecommendation?(itemKey: string, profileId?: string): Promise<void>;
  listDismissedRecommendationKeys?(profileId?: string): Promise<readonly string[]>;
}

/** Set of Wave R3 RPC method names for worker runtime dispatch narrowing. */
export const WAVE_R3_RPC_METHODS: ReadonlySet<string> = new Set<CatalogWaveR3OpsRpcCall['method']>([
  'dismissRecommendation',
  'restoreRecommendation',
  'listDismissedRecommendationKeys',
]);

const DISMISS_RECOMMENDATION_KEYS = new Set(['method', 'itemKey', 'kind', 'profileId']);
const RESTORE_RECOMMENDATION_KEYS = new Set(['method', 'itemKey', 'profileId']);
const LIST_DISMISSED_KEYS = new Set(['method', 'profileId']);

/** Validates a non-blank recommendation dismissal item key without control characters. */
export const isNonBlankDismissalKey = (x: unknown): x is string =>
  isBoundedString(x, 1, MAX_ITEM_KEY_CHARS) && x.trim().length > 0 && !hasControlChar(x);

/** Validates a recommendation dismissal content kind (`movie` or `series`). */
export const isDismissalKind = (x: unknown): x is RecommendationDismissalKind =>
  x === 'movie' || x === 'series';

/** Validates Wave R3 recommendation dismissal RPC calls (`dismissRecommendation`, `restoreRecommendation`, `listDismissedRecommendationKeys`). */
export function isWaveR3OpsRpcCall(x: Record<string, unknown>): boolean {
  switch (x['method']) {
    case 'dismissRecommendation':
      return (
        hasOnlyKeys(x, DISMISS_RECOMMENDATION_KEYS) &&
        isNonBlankDismissalKey(x['itemKey']) &&
        isDismissalKind(x['kind']) &&
        isOptionalStrictProfileId(x['profileId'])
      );
    case 'restoreRecommendation':
      return (
        hasOnlyKeys(x, RESTORE_RECOMMENDATION_KEYS) &&
        isNonBlankDismissalKey(x['itemKey']) &&
        isOptionalStrictProfileId(x['profileId'])
      );
    case 'listDismissedRecommendationKeys':
      return hasOnlyKeys(x, LIST_DISMISSED_KEYS) && isOptionalStrictProfileId(x['profileId']);
    default:
      return false;
  }
}
