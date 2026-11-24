import type {
  ChannelGuideOverrideRecord,
  GuideChannelOption,
  GuideSourceRecord,
  ItemRow,
} from '@elv/data';

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

/** Focusable action slot on an existing guide source row in `GuideSourcesTab` (`#30`). */
export type GuideRowActionSlot =
  | 'row-up'
  | 'row-down'
  | 'row-offset-dec'
  | 'row-offset-inc'
  | 'row-toggle'
  | 'row-remove';

/** Focusable slot inside the inline Add Guide Source form (`#30`). */
type GuideFormSlot =
  | 'form-name'
  | 'form-url'
  | 'form-offset-dec'
  | 'form-offset-inc'
  | 'form-save'
  | 'form-cancel';

/** 2D TV focus row model for {@link GuideSourcesTab}. */
export type GuideSourcesFocusRow =
  | { readonly kind: 'add-cta'; readonly slots: readonly ['add-open'] }
  | { readonly kind: 'form'; readonly slots: readonly GuideFormSlot[] }
  | {
      readonly kind: 'guide';
      readonly guideId: string;
      readonly guideIndex: number;
      readonly slots: readonly GuideRowActionSlot[];
    };

const GUIDE_ROW_ACTION_SLOTS: readonly GuideRowActionSlot[] = [
  'row-up',
  'row-down',
  'row-offset-dec',
  'row-offset-inc',
  'row-toggle',
  'row-remove',
];

/** Builds the ordered 2D TV D-pad focus rows for `GuideSourcesTab`. */
export function buildGuideSourcesFocusRows(
  guides: readonly GuideSourceRecord[],
  adding: boolean,
): readonly GuideSourcesFocusRow[] {
  const rows: GuideSourcesFocusRow[] = adding
    ? [
        { kind: 'form', slots: ['form-name'] },
        { kind: 'form', slots: ['form-url'] },
        { kind: 'form', slots: ['form-offset-dec', 'form-offset-inc'] },
        { kind: 'form', slots: ['form-save', 'form-cancel'] },
      ]
    : [{ kind: 'add-cta', slots: ['add-open'] }];

  for (let i = 0; i < guides.length; i += 1) {
    const guide = guides[i];
    if (guide === undefined) continue;
    rows.push({
      kind: 'guide',
      guideId: guide.id,
      guideIndex: i,
      slots: GUIDE_ROW_ACTION_SLOTS,
    });
  }
  return rows;
}

/** 2D TV focus row model for {@link ChannelMapperTab}. */
export type ChannelMapperFocusRow =
  | { readonly kind: 'filters'; readonly slots: readonly ['filter-all', 'filter-unmatched'] }
  | { readonly kind: 'search'; readonly slots: readonly ['search-input'] }
  | {
      readonly kind: 'channel';
      readonly channelKey: string;
      readonly slots: readonly ('assign' | 'clear')[];
    }
  | {
      readonly kind: 'editor-search';
      readonly channelKey: string;
      readonly slots: readonly ['editor-guide-search'];
    }
  | {
      readonly kind: 'editor-options';
      readonly channelKey: string;
      readonly options: readonly GuideChannelOption[];
    }
  | {
      readonly kind: 'editor-offset';
      readonly channelKey: string;
      readonly slots: readonly ['editor-offset-dec', 'editor-offset-inc'];
    }
  | {
      readonly kind: 'editor-actions';
      readonly channelKey: string;
      readonly slots: readonly ('editor-save' | 'editor-clear' | 'editor-cancel')[];
    }
  | { readonly kind: 'load-more'; readonly slots: readonly ['load-more'] };

const GUIDE_OPTIONS_PER_TV_ROW = 3;
const MAX_VISIBLE_GUIDE_OPTIONS = 12;

/** Builds the ordered 2D TV D-pad focus rows for `ChannelMapperTab`. */
export function buildChannelMapperFocusRows(params: {
  readonly channels: readonly ItemRow[];
  readonly overridesByKey: ReadonlyMap<string, ChannelGuideOverrideRecord>;
  readonly editingChannelKey: string | null;
  readonly guideOptions: readonly GuideChannelOption[];
  readonly hasMore: boolean;
}): readonly ChannelMapperFocusRow[] {
  const { channels, overridesByKey, editingChannelKey, guideOptions, hasMore } = params;
  const rows: ChannelMapperFocusRow[] = [
    { kind: 'filters', slots: ['filter-all', 'filter-unmatched'] },
    { kind: 'search', slots: ['search-input'] },
  ];

  const visibleOpts = guideOptions.slice(0, MAX_VISIBLE_GUIDE_OPTIONS);
  for (const ch of channels) {
    const hasOverride = overridesByKey.has(ch.key);
    if (editingChannelKey === ch.key) {
      rows.push({
        kind: 'editor-search',
        channelKey: ch.key,
        slots: ['editor-guide-search'],
      });
      for (let i = 0; i < visibleOpts.length; i += GUIDE_OPTIONS_PER_TV_ROW) {
        rows.push({
          kind: 'editor-options',
          channelKey: ch.key,
          options: visibleOpts.slice(i, i + GUIDE_OPTIONS_PER_TV_ROW),
        });
      }
      rows.push({
        kind: 'editor-offset',
        channelKey: ch.key,
        slots: ['editor-offset-dec', 'editor-offset-inc'],
      });
      rows.push({
        kind: 'editor-actions',
        channelKey: ch.key,
        slots: hasOverride
          ? ['editor-save', 'editor-clear', 'editor-cancel']
          : ['editor-save', 'editor-cancel'],
      });
    } else {
      rows.push({
        kind: 'channel',
        channelKey: ch.key,
        slots: hasOverride ? ['assign', 'clear'] : ['assign'],
      });
    }
  }

  if (hasMore) {
    rows.push({ kind: 'load-more', slots: ['load-more'] });
  }
  return rows;
}

/** Returns the number of focusable horizontal slots on a {@link ChannelMapperFocusRow}. */
export function mapperRowSlotCount(row: ChannelMapperFocusRow | undefined): number {
  if (row === undefined) return 0;
  return row.kind === 'editor-options' ? row.options.length : row.slots.length;
}
