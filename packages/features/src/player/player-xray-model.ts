import type { PlaybackStatus } from '@elv/playback';
import type { PlayTarget } from '../ports/play-target';

/** Returns `true` only for VOD movies, series, and episodes — never Live TV or catch-up streams (`#352`). */
export function isXrayEligibleTarget(target: PlayTarget): boolean {
  if (target.kind !== 'vod' || target.catchup !== undefined) return false;
  if (target.itemKind === undefined) return true;
  return (
    target.itemKind === 'movie' || target.itemKind === 'series' || target.itemKind === 'episode'
  );
}

/** Resolves the catalog match key for X-Ray enrichment (`seriesKey` for episodes, `itemKey` for movies). */
export function resolveXrayBaseItemKey(target: PlayTarget): string {
  const seriesKey = target.seriesKey?.trim();
  if (seriesKey !== undefined && seriesKey.length > 0) return seriesKey;
  return target.itemKey;
}

/** Pure visibility decision for the quiet Cinema Quietude In-Player X-Ray strip (`#352`). */
export function shouldShowXrayStrip(input: {
  readonly eligible: boolean;
  readonly suppressed: boolean;
  readonly statusKind: PlaybackStatus['kind'];
  readonly userPinnedOpen: boolean;
  readonly dismissedOnPause: boolean;
  readonly hasMetadata: boolean;
}): boolean {
  if (!input.eligible || input.suppressed) return false;
  if (input.userPinnedOpen) return true;
  if (input.statusKind === 'paused' && !input.dismissedOnPause && input.hasMetadata) return true;
  return false;
}
