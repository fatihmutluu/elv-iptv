import type { CatalogService, CategoryRow, EpgGenre, ItemRow, ProgrammeRow } from '@elv/data';
import type { DisplayCategory, PagedListSource } from '@elv/features';

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

/** Deterministic base timestamp for the synthetic EPG proof gate (18:15 UTC). */
export const EPG_GATE_BASE_NOW_MS = Date.UTC(2026, 10, 24, 18, 15, 0);

const DURATION_PATTERN_MIN = [30, 45, 60, 90, 30, 60] as const;
const GENRES: readonly EpgGenre[] = ['news', 'sports', 'movie', 'kids'];
const MAX_CHANNEL_CACHE = 64;

function makeSyntheticEpgChannel(index: number): ItemRow {
  return {
    id: index + 1,
    key: `gate:epg:live:${index + 1}`,
    sourceId: 'gate-epg',
    kind: 'live',
    providerId: String(index + 1),
    name: `Channel ${index + 1}`,
    logo: null,
    rating: null,
    year: null,
    num: index + 1,
  };
}

/** Parses the 0-based channel index from a synthetic EPG gate channel key, or `-1`. */
export function parseSyntheticChannelIndex(channelKey: string): number {
  const prefix = 'gate:epg:live:';
  if (!channelKey.startsWith(prefix)) return -1;
  const num = Number.parseInt(channelKey.slice(prefix.length), 10);
  return Number.isInteger(num) && num >= 1 ? num - 1 : -1;
}

/**
 * Generates deterministic programmes on-the-fly for a single channel strictly overlapping `[fromMs, toMs]`
 * within a `days`-day horizon centered around `baseMs` (1 day back, `days - 1` days forward).
 * Includes staggered starts across channels, varied durations for overlap jumps, and intentional
 * 15-minute `>= 5 min` gaps on every 5th channel (`index % 5 === 2`) so gap-cell focus is exercised.
 */
export function generateSyntheticProgrammes(
  channelIndex: number,
  fromMs: number,
  toMs: number,
  baseMs: number = EPG_GATE_BASE_NOW_MS,
  days = 7,
): ProgrammeRow[] {
  if (channelIndex < 0 || toMs <= fromMs || days <= 0) return [];
  const horizonStart = Math.floor(baseMs / DAY_MS) * DAY_MS - DAY_MS;
  const horizonEnd = horizonStart + days * DAY_MS;
  const queryStart = Math.max(fromMs, horizonStart);
  const queryEnd = Math.min(toMs, horizonEnd);
  if (queryEnd <= queryStart) return [];

  const staggerMs = (channelIndex % 4) * 15 * MIN_MS;
  const hasGaps = channelIndex % 5 === 2;
  const channelKey = `gate:epg:live:${channelIndex + 1}`;
  const guideId = `guide-${channelIndex + 1}`;
  const genre = GENRES[channelIndex % GENRES.length] ?? 'news';

  // Period of one repeating 6-programme cycle: sum(DURATION_PATTERN_MIN) = 315 min (+ 15m gap if hasGaps = 330 min)
  const cycleMin = hasGaps ? 330 : 315;
  const cycleMs = cycleMin * MIN_MS;
  const alignedOrigin = horizonStart + staggerMs;
  const startCycle = Math.max(0, Math.floor((queryStart - alignedOrigin) / cycleMs) - 1);

  const out: ProgrammeRow[] = [];
  let cursor = alignedOrigin + startCycle * cycleMs;
  let seq = startCycle * DURATION_PATTERN_MIN.length;

  while (cursor < queryEnd && cursor < horizonEnd) {
    for (let p = 0; p < DURATION_PATTERN_MIN.length; p++) {
      const durMin = DURATION_PATTERN_MIN[(p + channelIndex) % DURATION_PATTERN_MIN.length] ?? 60;
      const start = cursor;
      const stop = Math.min(horizonEnd, start + durMin * MIN_MS);
      cursor = stop;
      if (stop > queryStart && start < queryEnd) {
        out.push({
          channelKey,
          sourceId: 'gate-epg',
          guideId,
          start,
          stop,
          title: `Ch ${channelIndex + 1} · Show ${seq + 1}`,
          subTitle: null,
          description: null,
          episodeNum: null,
          icon: null,
          genre,
          flags: 0,
        });
      }
      seq++;
      if (hasGaps && p === 2) {
        // Intentional 15-minute gap (>= 5 min) between programmes
        cursor += 15 * MIN_MS;
      }
      if (cursor >= queryEnd || cursor >= horizonEnd) break;
    }
  }
  return out;
}

/** O(1)-windowed synthetic `CatalogService`, category, and paged channel source for `EpgGateScreen`. */
export interface SyntheticEpgDataset {
  readonly catalog: CatalogService;
  readonly category: DisplayCategory;
  readonly channelSource: PagedListSource<ItemRow>;
  readonly totalEstimatedProgrammes: number;
}

/**
 * Builds an O(1)-memory synthetic EPG dataset for `channels` × `days` (default `1,000 × 7 ≈ 336,000`
 * programmes). Programmes are generated strictly on demand per queried window so RAM stays bounded.
 */
export function createSyntheticEpgCatalog(opts: {
  readonly channels: number;
  readonly days: number;
  readonly baseMs?: number;
}): SyntheticEpgDataset {
  const { channels, days, baseMs = EPG_GATE_BASE_NOW_MS } = opts;
  const row: CategoryRow = {
    id: 'gate-epg|live|all',
    sourceId: 'gate-epg',
    kind: 'live',
    name: 'All Channels',
    itemCount: channels,
    position: 0,
  };
  const category: DisplayCategory = { row, label: 'All Channels' };

  let disposed = false;
  const cache = new Map<number, ItemRow>();
  const getCached = (index: number): ItemRow | undefined => {
    if (disposed || !Number.isInteger(index) || index < 0 || index >= channels) return undefined;
    const hit = cache.get(index);
    if (hit !== undefined) {
      cache.delete(index);
      cache.set(index, hit);
      return hit;
    }
    const item = makeSyntheticEpgChannel(index);
    if (cache.size >= MAX_CHANNEL_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(index, item);
    return item;
  };
  const channelSource: PagedListSource<ItemRow> = {
    count: () => (disposed ? 0 : channels),
    get: (index: number) => getCached(index),
    prefetch: () => undefined,
    onChange: () => () => undefined,
    loadItem: async (index: number) => getCached(index),
    dispose: () => {
      disposed = true;
      cache.clear();
    },
  };

  const catalog = {
    epgWindow: async (
      channelKeys: readonly string[],
      fromMs: number,
      toMs: number,
    ): Promise<Record<string, ProgrammeRow[]>> => {
      const result: Record<string, ProgrammeRow[]> = {};
      for (const key of channelKeys) {
        const idx = parseSyntheticChannelIndex(key);
        result[key] = idx >= 0 ? generateSyntheticProgrammes(idx, fromMs, toMs, baseMs, days) : [];
      }
      return result;
    },
  } as unknown as CatalogService;

  // ~48 programmes/channel/day across 1,000 channels × 7 days ≈ 336,000
  const totalEstimatedProgrammes = channels * days * 48;
  return { catalog, category, channelSource, totalEstimatedProgrammes };
}
