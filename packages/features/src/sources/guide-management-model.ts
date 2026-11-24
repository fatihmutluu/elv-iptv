import type { ChannelGuideOverrideRecord, GuideSourceRecord, ItemRow } from '@elv/data';

/** Minimum configurable per-guide or per-channel EPG time offset in hours (`#30`). */
export const MIN_EPG_OFFSET_HOURS = -12;

/** Maximum configurable per-guide or per-channel EPG time offset in hours (`#30`). */
export const MAX_EPG_OFFSET_HOURS = 12;

/** Milliseconds in one hour. */
export const HOUR_MS = 3_600_000;

/** Active tab inside `GuideManagementOverlay` (`#30`). */
export type GuideManageTab = 'guides' | 'mapper';

/** Filter mode inside the Manual Channel Mapper tab (`#30`). */
export type ChannelMapperFilter = 'all' | 'unmatched';

const HTTP_URL_RE = /^https?:\/\/[^/\s]+/i;

/** Clamps a numeric hour offset into `[-12, +12]` as an integer. */
export function clampOffsetHours(hours: number): number {
  if (!Number.isFinite(hours)) return 0;
  return Math.max(MIN_EPG_OFFSET_HOURS, Math.min(MAX_EPG_OFFSET_HOURS, Math.round(hours)));
}

/** Converts an EPG shift in milliseconds to integer hours clamped to `[-12, +12]`. */
export function offsetMsToHours(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return 0;
  return clampOffsetHours(ms / HOUR_MS);
}

/** Converts integer hours clamped to `[-12, +12]` into milliseconds. */
export function offsetHoursToMs(hours: number): number {
  return clampOffsetHours(hours) * HOUR_MS;
}

/** Formats an integer hour offset with explicit `+` sign for positive values (e.g. `"+2"`, `"-1"`, `"0"`). */
export function formatSignedOffsetHours(hours: number): string {
  const clamped = clampOffsetHours(hours);
  return clamped > 0 ? `+${clamped}` : String(clamped);
}

/** Computes the next priority-ordered guide source ID list after moving `index` by `delta`, or `null` if out of bounds. */
export function reorderGuideSourceIds(
  guides: readonly Pick<GuideSourceRecord, 'id'>[],
  index: number,
  delta: -1 | 1,
): string[] | null {
  const target = index + delta;
  if (index < 0 || index >= guides.length || target < 0 || target >= guides.length) {
    return null;
  }
  const ids = guides.map((g) => g.id);
  const current = ids[index];
  const swapWith = ids[target];
  if (current === undefined || swapWith === undefined) return null;
  ids[index] = swapWith;
  ids[target] = current;
  return ids;
}

/** Validates inline Add Guide Source fields before invoking `catalog.addGuideSource`. */
export function validateGuideSourceDraft(
  name: string,
  url: string,
): 'missing-name' | 'invalid-url' | null {
  if (name.trim().length === 0) return 'missing-name';
  const trimmedUrl = url.trim();
  if (trimmedUrl.length === 0 || !HTTP_URL_RE.test(trimmedUrl)) return 'invalid-url';
  return null;
}

/** Determines whether a channel has a manual Tier-0 override or is unmatched against guide data. */
export function resolveChannelMappingStatus(
  channelKey: string,
  overridesByKey: ReadonlyMap<string, ChannelGuideOverrideRecord>,
  matchedKeys: ReadonlySet<string>,
): 'manual' | 'matched' | 'unmatched' {
  const override = overridesByKey.get(channelKey);
  if (override?.isManual) {
    return 'manual';
  }
  return matchedKeys.has(channelKey) ? 'matched' : 'unmatched';
}

/** Filters source live channels by `'all'` vs `'unmatched'` and optional case-insensitive search query. */
export function filterMapperChannels(
  channels: readonly ItemRow[],
  overridesByKey: ReadonlyMap<string, ChannelGuideOverrideRecord>,
  matchedKeys: ReadonlySet<string>,
  filter: ChannelMapperFilter,
  query: string,
): readonly ItemRow[] {
  const needle = query.trim().toLowerCase();
  return channels.filter((ch) => {
    const status = resolveChannelMappingStatus(ch.key, overridesByKey, matchedKeys);
    if (filter === 'unmatched' && status !== 'unmatched') return false;
    if (needle.length === 0) return true;
    const overrideGuideId = overridesByKey.get(ch.key)?.guideId?.toLowerCase() ?? '';
    return (
      ch.name.toLowerCase().includes(needle) ||
      ch.key.toLowerCase().includes(needle) ||
      overrideGuideId.includes(needle)
    );
  });
}
