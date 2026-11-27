import type { AlphabetBucket, ItemRow, ItemSortOrder, NowNextEntry, ProgrammeRow } from '@elv/data';
import type { EpgRowDensity } from '@elv/domain';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import { createPagedListSource, type PagedListSource } from '../shared/paged-list-source';

/** Active sub-mode inside the unified Cinema Quietude Live TV hub (`UI_UX_PHILOSOPHY.md` §2.1). */
export type LiveMode = 'favorites' | 'channels' | 'epg';

/** Minimum channel count required before rendering the Live A–Z `AlphabetJumpRail` (`#407`). */
export const LIVE_ALPHABET_RAIL_MIN_ITEMS = 40;

/** Persisted per-session Live TV hub memory preserved across tab switches and Player visits. */
export interface LiveTabMemory {
  readonly mode: LiveMode;
  readonly categoryId: string | null;
  readonly activeChannelKey: string | null;
  readonly previousChannelKey: string | null;
  readonly zapDrawerOpen: boolean;
  readonly sortBy?: ItemSortOrder;
}

/** Default initial Live TV hub memory (`Channels` grid ready immediately, switchable to `Favorites` / `TV Guide`). */
export const EMPTY_LIVE_MEMORY: LiveTabMemory = {
  mode: 'channels',
  categoryId: null,
  activeChannelKey: null,
  previousChannelKey: null,
  zapDrawerOpen: true,
  sortBy: 'default',
};

/** 30-minute time ruler tick size in milliseconds. */
export const EPG_SLOT_MS = 30 * 60_000;
/** Default visible horizontal EPG window span (3 hours = 6 × 30m ticks). */
export const EPG_VISIBLE_SPAN_MS = 3 * 3_600_000;
/** Extra lookahead buffer fetched beyond the visible EPG window (1 hour). */
export const EPG_FETCH_BUFFER_MS = 60 * 60_000;
/** Horizontal pan increment when stepping Earlier / Later or past the visible edge (2 hours). */
export const EPG_PAN_STEP_MS = 2 * 3_600_000;
/** Maximum channel number digit buffer length (`#54`). */
export const MAX_NUMBER_BUFFER_DIGITS = 5;
/** Auto-tune delay (ms) after the last digit entry on the 0–9 channel number keypad (`#54`). */
export const NUMBER_JUMP_TIMEOUT_MS = 1_800;
/** O(1) LRU channel page size for Live channels & 1,000-channel EPG matrices. */
export const LIVE_PAGE_SIZE = 120;
/** Max cached channel pages (`120 × 8 = 960` items in RAM even for 100k-channel providers). */
export const LIVE_MAX_PAGES = 8;
/** Default TTL (ms) for bounded in-memory Now/Next & EPG window caches (`#250`). */
export const EPG_CACHE_TTL_MS = 90_000;
/** Maximum channel entries kept in the in-memory EPG cache (`#250`). */
export const EPG_CACHE_MAX_ENTRIES = 240;
/** Minimum uncovered EPG span (5 minutes) synthesized into a focusable "No info" gap cell (`#6`, `#25`). */
export const MIN_EPG_GAP_MS = 5 * 60_000;

const EPG_ROW_HEIGHT_TABLE: Readonly<
  Record<EpgRowDensity, { readonly tv: number; readonly standard: number }>
> = {
  compact: { tv: 52, standard: 48 },
  comfortable: { tv: 68, standard: 60 },
  cinematic: { tv: 84, standard: 74 },
};

/** Resolves scaled EPG channel row height in logical pixels for the active {@link EpgRowDensity}. */
export function resolveEpgRowHeight(
  density: EpgRowDensity | undefined,
  isTv: boolean,
  fontScale: number,
): number {
  const safeScale = Number.isFinite(fontScale) ? Math.max(1, fontScale) : 1;
  const preset = EPG_ROW_HEIGHT_TABLE[density ?? 'comfortable'] ?? EPG_ROW_HEIGHT_TABLE.comfortable;
  return Math.round((isTv ? preset.tv : preset.standard) * safeScale);
}

/**
 * Resolves the active `#` or `A..Z` bucket letter owning `currentOffset` in Live Channels (`#407`).
 */
export function resolveLiveAlphabetLetter(
  buckets: readonly AlphabetBucket[],
  currentOffset: number,
): string | null {
  const available = buckets.filter((b) => b.count > 0);
  if (available.length === 0) return null;
  const safeOffset = Number.isFinite(currentOffset) ? Math.max(0, Math.floor(currentOffset)) : 0;
  let active = available[0]?.letter ?? null;
  for (const bucket of available) {
    if (bucket.offset <= safeOffset) {
      active = bucket.letter;
    } else {
      break;
    }
  }
  return active;
}

function isLiveRailLetter(letter: string): boolean {
  const normalized = letter.trim().toUpperCase();
  return normalized === '#' || (normalized.length === 1 && normalized >= 'A' && normalized <= 'Z');
}

/**
 * Steps TV focus `up` or `down` across available (`count > 0`) Live rail alphabet buckets (`#`, `A..Z`, `#407`).
 */
export function stepLiveAlphabetLetter(
  buckets: readonly AlphabetBucket[],
  currentLetter: string | null,
  direction: 'up' | 'down',
): string | null {
  const available = buckets.filter((b) => b.count > 0 && isLiveRailLetter(b.letter));
  if (available.length === 0) return null;
  const normalized = currentLetter?.trim().toUpperCase() ?? null;
  const currentIdx =
    normalized !== null
      ? available.findIndex((b) => b.letter.trim().toUpperCase() === normalized)
      : -1;
  if (currentIdx === -1) {
    return available[0]?.letter ?? null;
  }
  const nextIdx =
    direction === 'up'
      ? Math.max(0, currentIdx - 1)
      : Math.min(available.length - 1, currentIdx + 1);
  return available[nextIdx]?.letter ?? null;
}

/** Floors an epoch timestamp onto the nearest 30-minute boundary for crisp EPG time rulers. */
export function floorToEpgSlot(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.floor(ms / EPG_SLOT_MS) * EPG_SLOT_MS;
}

/** Generates ordered 30-minute ruler tick timestamps across `[windowStartMs, windowStartMs + spanMs)`. */
export function buildEpgRulerTicks(
  windowStartMs: number,
  spanMs: number = EPG_VISIBLE_SPAN_MS,
): number[] {
  const start = floorToEpgSlot(windowStartMs);
  const count = Math.max(1, Math.ceil(Math.max(EPG_SLOT_MS, spanMs) / EPG_SLOT_MS));
  const ticks: number[] = [];
  for (let i = 0; i < count; i++) {
    ticks.push(start + i * EPG_SLOT_MS);
  }
  return ticks;
}

/** Formats an epoch timestamp as `HH:MM` (24-hour, zero-padded, tabular-nums friendly). */
export function formatClockTime(ms: number): string {
  if (!Number.isFinite(ms)) return '--:--';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Computes live programme progress ratio clamped to `[0, 1]`. */
export function computeProgramProgress(startMs: number, stopMs: number, nowMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(stopMs) || !Number.isFinite(nowMs)) return 0;
  const span = stopMs - startMs;
  if (span <= 0 || nowMs <= startMs) return 0;
  if (nowMs >= stopMs) return 1;
  return (nowMs - startMs) / span;
}

/** Positioned programme or synthesized gap block clipped cleanly to the visible EPG horizontal window. */
export interface EpgPositionedSlot {
  /** Stable slot identifier (`__gap:<startMs>:<stopMs>` for synthesized gaps). */
  readonly id: string;
  /** Underlying programme row, or `null` when {@link isGap} is `true`. */
  readonly programme: ProgrammeRow | null;
  readonly startMs: number;
  readonly stopMs: number;
  readonly leftRatio: number;
  readonly widthRatio: number;
  readonly isLive: boolean;
  /** True when this slot is a synthesized `>= MIN_EPG_GAP_MS` "No info" gap cell. */
  readonly isGap: boolean;
  readonly clippedStart: boolean;
  readonly clippedEnd: boolean;
}

/**
 * Clips and maps a channel's programmes onto normalized `[0, 1]` horizontal coordinates within
 * `[windowStartMs, windowStartMs + spanMs]`, synthesizing focusable gap slots (`>= MIN_EPG_GAP_MS`)
 * before, between, and after programmes (and for empty rows) so D-pad navigation never traps focus.
 */
export function layoutEpgSlots(
  programmes: readonly ProgrammeRow[],
  windowStartMs: number,
  spanMs: number,
  nowMs: number,
): EpgPositionedSlot[] {
  if (spanMs <= 0) return [];
  const windowEndMs = windowStartMs + spanMs;
  const out: EpgPositionedSlot[] = [];

  const pushGap = (gapStart: number, gapStop: number): void => {
    if (gapStop - gapStart < MIN_EPG_GAP_MS) return;
    out.push({
      id: `__gap:${gapStart}:${gapStop}`,
      programme: null,
      startMs: gapStart,
      stopMs: gapStop,
      leftRatio: (gapStart - windowStartMs) / spanMs,
      widthRatio: (gapStop - gapStart) / spanMs,
      isLive: gapStart <= nowMs && gapStop > nowMs,
      isGap: true,
      clippedStart: false,
      clippedEnd: false,
    });
  };

  const visible: Array<{
    readonly programme: ProgrammeRow;
    readonly visStart: number;
    readonly visEnd: number;
  }> = [];
  for (const programme of programmes) {
    if (programme.stop <= windowStartMs || programme.start >= windowEndMs) continue;
    const visStart = Math.max(windowStartMs, programme.start);
    const visEnd = Math.min(windowEndMs, programme.stop);
    if (visEnd <= visStart) continue;
    visible.push({ programme, visStart, visEnd });
  }
  visible.sort((a, b) => a.visStart - b.visStart || a.visEnd - b.visEnd);

  if (visible.length === 0) {
    pushGap(windowStartMs, windowEndMs);
    return out;
  }

  let cursorMs = windowStartMs;
  for (const { programme, visStart, visEnd } of visible) {
    if (visStart > cursorMs) {
      pushGap(cursorMs, visStart);
    }
    out.push({
      id: `${programme.guideId}-${programme.start}-${programme.stop}`,
      programme,
      startMs: programme.start,
      stopMs: programme.stop,
      leftRatio: (visStart - windowStartMs) / spanMs,
      widthRatio: (visEnd - visStart) / spanMs,
      isLive: programme.start <= nowMs && programme.stop > nowMs,
      isGap: false,
      clippedStart: programme.start < windowStartMs,
      clippedEnd: programme.stop > windowEndMs,
    });
    cursorMs = Math.max(cursorMs, visEnd);
  }
  if (windowEndMs > cursorMs) {
    pushGap(cursorMs, windowEndMs);
  }
  return out;
}

/**
 * Computes normalized `[0, 1]` horizontal position of the vertical `Now` line, or `null` when
 * `nowMs` lies outside `[windowStartMs, windowStartMs + spanMs]`.
 */
export function computeNowLineRatio(
  windowStartMs: number,
  spanMs: number,
  nowMs: number,
): number | null {
  if (spanMs <= 0 || nowMs < windowStartMs || nowMs > windowStartMs + spanMs) return null;
  return (nowMs - windowStartMs) / spanMs;
}

/** Input parameters for {@link computeEpgClockPillLayout}. */
export interface EpgClockPillLayoutInput {
  readonly trackWidth: number;
  readonly nowLineRatio: number | null;
  readonly tickCount: number;
  readonly pillWidth: number;
  readonly tickLabelWidth: number;
  readonly tickLabelOffset?: number;
  readonly gap?: number;
}

/** Computed horizontal anchor and colliding tick indices for the EPG ruler live clock pill (`#507`). */
export interface EpgClockPillLayout {
  readonly visible: boolean;
  readonly pillLeftPx: number;
  readonly hiddenTickIndices: ReadonlySet<number>;
}

/**
 * Computes the edge-clamped pixel offset of the live clock pill centered on `nowLineRatio` over
 * `epg-ruler-track` and returns the set of half-hour tick indices whose label boxes overlap it (`#507`).
 */
export function computeEpgClockPillLayout(input: EpgClockPillLayoutInput): EpgClockPillLayout {
  const { trackWidth, nowLineRatio, tickCount, pillWidth, tickLabelWidth } = input;
  const visible =
    nowLineRatio !== null &&
    Number.isFinite(nowLineRatio) &&
    nowLineRatio >= 0 &&
    nowLineRatio <= 1 &&
    Number.isFinite(trackWidth) &&
    trackWidth > 0;
  if (!visible) {
    return { visible: false, pillLeftPx: 0, hiddenTickIndices: new Set<number>() };
  }

  const safePillWidth = Number.isFinite(pillWidth) && pillWidth > 0 ? pillWidth : 0;
  const safeTickWidth = Number.isFinite(tickLabelWidth) && tickLabelWidth > 0 ? tickLabelWidth : 0;
  const safeTickOffset =
    input.tickLabelOffset !== undefined &&
    Number.isFinite(input.tickLabelOffset) &&
    input.tickLabelOffset > 0
      ? input.tickLabelOffset
      : 0;
  const safeGap =
    input.gap !== undefined && Number.isFinite(input.gap) && input.gap > 0 ? input.gap : 0;

  const centerX = nowLineRatio * trackWidth;
  const maxLeft = Math.max(0, trackWidth - safePillWidth);
  const pillLeftPx = Math.max(0, Math.min(maxLeft, centerX - safePillWidth / 2));
  const pillStart = pillLeftPx - safeGap;
  const pillEnd = pillLeftPx + safePillWidth + safeGap;

  const hidden = new Set<number>();
  if (Number.isInteger(tickCount) && tickCount > 0) {
    for (let i = 0; i < tickCount; i += 1) {
      const tickLeft = (i / tickCount) * trackWidth + safeTickOffset;
      const tickRight = tickLeft + safeTickWidth;
      if (tickLeft < pillEnd && tickRight > pillStart) {
        hidden.add(i);
      }
    }
  }
  return { visible: true, pillLeftPx, hiddenTickIndices: hidden };
}

/**
 * Finds the programme index spanning `anchorTimeMs` so D-pad Up/Down navigation across virtualized
 * channels keeps focus cleanly aligned under the user's time cursor (`#6`). Falls back to the
 * nearest programme when a schedule gap exists, or `-1` if the channel has no programmes.
 */
export function findProgramIndexAtTime(
  programmes: ReadonlyArray<{ readonly start: number; readonly stop: number }>,
  anchorTimeMs: number,
): number {
  if (programmes.length === 0) return -1;
  for (let i = 0; i < programmes.length; i++) {
    const p = programmes[i];
    if (p !== undefined && p.start <= anchorTimeMs && p.stop > anchorTimeMs) return i;
  }
  let bestIdx = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < programmes.length; i++) {
    const p = programmes[i];
    if (p === undefined) continue;
    const dist =
      anchorTimeMs < p.start ? p.start - anchorTimeMs : Math.max(0, anchorTimeMs - p.stop);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Selects the programme in `programmes` with strictly greatest positive time overlap against
 * `[windowStartMs, windowStopMs]`, breaking ties by smallest `|p.start - windowStartMs|` (then
 * earlier index). Falls back to {@link findProgramIndexAtTime} with `fallbackAnchorMs` when no
 * programme overlaps the window (`#112`).
 */
export function findOverlappingProgramIndex(
  programmes: ReadonlyArray<{ readonly start: number; readonly stop: number }>,
  windowStartMs: number,
  windowStopMs: number,
  fallbackAnchorMs: number,
): number {
  if (programmes.length === 0) return -1;
  if (
    !Number.isFinite(windowStartMs) ||
    !Number.isFinite(windowStopMs) ||
    windowStopMs <= windowStartMs
  ) {
    return findProgramIndexAtTime(programmes, fallbackAnchorMs);
  }
  let bestIdx = -1;
  let bestOverlap = 0;
  let bestStartDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < programmes.length; i++) {
    const p = programmes[i];
    if (p === undefined) continue;
    const overlap = Math.min(p.stop, windowStopMs) - Math.max(p.start, windowStartMs);
    if (overlap <= 0) continue;
    const startDist = Math.abs(p.start - windowStartMs);
    if (overlap > bestOverlap || (overlap === bestOverlap && startDist < bestStartDist)) {
      bestOverlap = overlap;
      bestStartDist = startDist;
      bestIdx = i;
    }
  }
  return bestOverlap > 0 ? bestIdx : findProgramIndexAtTime(programmes, fallbackAnchorMs);
}

/** Appends a single digit (`'0'..'9'`) to a channel number jump buffer, capping length cleanly. */
export function appendNumberDigit(buffer: string, digit: string): string {
  if (!/^[0-9]$/.test(digit)) return buffer;
  const next = `${buffer}${digit}`.replace(/^0+(?=\d)/, '');
  return next.slice(0, MAX_NUMBER_BUFFER_DIGITS);
}

/** Parses a non-empty digit buffer into a channel number, or `null` when invalid. */
export function parseNumberBuffer(buffer: string): number | null {
  const trimmed = buffer.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Formats a live channel title with its optional channel number prefix. */
export function formatLiveTitle(item: Pick<ItemRow, 'num' | 'name'>): string {
  return item.num !== null && item.num !== undefined ? `${item.num}. ${item.name}` : item.name;
}

/**
 * Updates `(activeChannelKey, previousChannelKey)` history when tuning to a new channel so
 * `Previous channel` (`P`) always toggles back cleanly without losing state.
 */
export function recordChannelTune(
  state: { readonly activeChannelKey: string | null; readonly previousChannelKey: string | null },
  nextChannelKey: string,
): { readonly activeChannelKey: string; readonly previousChannelKey: string | null } {
  if (state.activeChannelKey === nextChannelKey) {
    return {
      activeChannelKey: nextChannelKey,
      previousChannelKey: state.previousChannelKey,
    };
  }
  return {
    activeChannelKey: nextChannelKey,
    previousChannelKey: state.activeChannelKey,
  };
}

/** Converts a live channel {@link ItemRow} into a {@link PlayableEntry}. */
export function toLiveEntry(row: ItemRow): PlayableEntry {
  return {
    itemKey: row.key,
    sourceId: row.sourceId,
    title: formatLiveTitle(row),
    kind: 'live',
    logo: row.logo,
    itemKind: 'live',
  };
}

/** Builds a Live TV `PlayTarget` backed by an O(1) LRU-paged `LiveChannelPlaylist`. */
export function buildLiveHubPlayTarget(opts: {
  readonly item: ItemRow;
  readonly categoryId: string;
  readonly categoryCount: number;
  readonly currentIndex: number;
  readonly loadPage: (offset: number, limit: number) => Promise<readonly ItemRow[]>;
  readonly onChangeIndex?: (nextIndex: number) => void;
}): PlayTarget {
  const count = Math.max(opts.categoryCount, opts.currentIndex + 1);
  const loader = createPagedListSource<ItemRow>({
    count,
    pageSize: LIVE_PAGE_SIZE,
    maxPages: 4,
    loadPage: opts.loadPage,
  });
  const categoryScope = opts.categoryId !== 'favorites' ? opts.categoryId : undefined;
  return {
    ...toLiveEntry(opts.item),
    ...(categoryScope !== undefined ? { categoryId: categoryScope } : {}),
    playlist: {
      count,
      currentIndex: opts.currentIndex,
      onChangeIndex: opts.onChangeIndex ?? (() => undefined),
      async getAt(index: number): Promise<PlayableEntry | undefined> {
        const row = await loader.loadItem(index);
        if (row === undefined) return undefined;
        return {
          ...toLiveEntry(row),
          ...(categoryScope !== undefined ? { categoryId: categoryScope } : {}),
        };
      },
    },
  };
}

/** Bounded insertion-ordered LRU cache with TTL for Now/Next and EPG window slices (`#250`). */
export interface BoundedTtlCache<T> {
  get(key: string, nowMs: number): T | undefined;
  set(key: string, value: T, nowMs: number): void;
  clear(): void;
  size(): number;
}

/** Creates an O(1) bounded LRU TTL cache keeping EPG/Now-Next memory strictly capped (`#250`). */
export function createBoundedTtlCache<T>(
  maxEntries: number = EPG_CACHE_MAX_ENTRIES,
  ttlMs: number = EPG_CACHE_TTL_MS,
): BoundedTtlCache<T> {
  const cap = Math.max(1, Math.floor(maxEntries));
  const ttl = Math.max(1, Math.floor(ttlMs));
  const map = new Map<string, { value: T; storedAt: number }>();

  return {
    get(key, nowMs) {
      const hit = map.get(key);
      if (hit === undefined) return undefined;
      if (nowMs - hit.storedAt > ttl) {
        map.delete(key);
        return undefined;
      }
      map.delete(key);
      map.set(key, hit);
      return hit.value;
    },
    set(key, value, nowMs) {
      if (map.has(key)) map.delete(key);
      map.set(key, { value, storedAt: nowMs });
      while (map.size > cap) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    clear() {
      map.clear();
    },
    size: () => map.size,
  };
}

/** Maps an array of {@link NowNextEntry} rows into a `Map` keyed by `channelKey`. */
export function indexNowNext(entries: readonly NowNextEntry[]): Map<string, NowNextEntry> {
  const out = new Map<string, NowNextEntry>();
  for (const entry of entries) out.set(entry.channelKey, entry);
  return out;
}

/** Creates a synchronous in-memory {@link PagedListSource} over a bounded item list (e.g. Favorites). */
export function createStaticPagedListSource<T>(items: readonly T[]): PagedListSource<T> {
  let disposed = false;
  return {
    count: () => (disposed ? 0 : items.length),
    get: (index: number) =>
      disposed || !Number.isInteger(index) || index < 0 || index >= items.length
        ? undefined
        : items[index],
    prefetch: () => undefined,
    onChange: () => () => undefined,
    loadItem: async (index: number) =>
      disposed || !Number.isInteger(index) || index < 0 || index >= items.length
        ? undefined
        : items[index],
    dispose: () => {
      disposed = true;
    },
  };
}
