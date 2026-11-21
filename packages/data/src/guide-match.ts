import { foldText } from './fold';

/** Live channels of a source indexed for guide matching; values are channel keys. */
export interface ChannelIndex {
  byGuideId: Map<string, string[]>;
  byFold: Map<string, string[]>;
  byNum: Map<number, string[]>;
}

/** Matching tier used by {@link matchGuideChannel}. */
export type GuideMatchTier = 'id' | 'name' | 'num' | 'none';

const EXACT_CHANNEL_NUM = /^#?(\d{1,6})$/;
const HASH_PREFIX_CHANNEL_NUM = /^#(\d{1,5})(?:(?:\s+(?:[-–—:|]\s*)?|\s*[-–—:|]\s+)\S)/;
const DELIM_CHANNEL_NUM = /^(\d{1,5})\s*[-–—:|]\s+\S/;

function push<K>(map: Map<K, string[]>, id: K, key: string): void {
  const list = map.get(id);
  if (list === undefined) map.set(id, [key]);
  else list.push(key);
}

function extractChannelNumber(name: string): number | undefined {
  const trimmed = name.trim();
  const match =
    EXACT_CHANNEL_NUM.exec(trimmed) ??
    HASH_PREFIX_CHANNEL_NUM.exec(trimmed) ??
    DELIM_CHANNEL_NUM.exec(trimmed);
  if (match === null) return undefined;
  const num = Number(match[1]);
  return Number.isInteger(num) && num > 0 ? num : undefined;
}

/** Indexes live channel rows by their guide id, folded name, and positive integer channel number. */
export function buildChannelIndex(
  rows: readonly {
    key: string;
    guide_id: string | null;
    name_fold: string;
    num?: number | null;
  }[],
): ChannelIndex {
  const index: ChannelIndex = { byGuideId: new Map(), byFold: new Map(), byNum: new Map() };
  for (const row of rows) {
    if (row.guide_id !== null && row.guide_id !== '') push(index.byGuideId, row.guide_id, row.key);
    if (row.name_fold !== '') push(index.byFold, row.name_fold, row.key);
    if (typeof row.num === 'number' && Number.isInteger(row.num) && row.num > 0) {
      push(index.byNum, row.num, row.key);
    }
  }
  return index;
}

/** Live channel keys a guide channel matched, whether it matched by guide id, and the winning tier. */
export interface GuideMatch {
  keys: string[];
  byId: boolean;
  tier: GuideMatchTier;
}

/**
 * Finds the live channels a guide channel belongs to in strict 3-tier precedence:
 * 1. Exact guide id (`tier: 'id'`), mapping every live channel sharing that id.
 * 2. Unique folded display name (`tier: 'name'`), only when all matching names agree on one live channel.
 * 3. Unique channel number fallback (`tier: 'num'`), only when no folded name matched and all numeric
 *    display-name candidates resolve to a single live channel with a unique `num`.
 * Ambiguous candidates map nothing (`tier: 'none'`). Name and number matches are candidates:
 * {@link resolveMappings} enforces `byId > byName > byNum`.
 */
export function matchGuideChannel(
  index: ChannelIndex,
  guide: { id: string; names: readonly string[] },
): GuideMatch {
  const byId = index.byGuideId.get(guide.id);
  if (byId !== undefined) return { keys: [...byId], byId: true, tier: 'id' };
  const foundName = new Set<string>();
  for (const name of guide.names) {
    const fold = foldText(name);
    const keys = fold === '' ? undefined : index.byFold.get(fold);
    if (keys?.length === 1) foundName.add(keys[0] as string);
  }
  if (foundName.size === 1) return { keys: [...foundName], byId: false, tier: 'name' };
  if (foundName.size > 1) return { keys: [], byId: false, tier: 'none' };

  const extractedNums = new Set<number>();
  for (const name of guide.names) {
    const num = extractChannelNumber(name);
    if (num !== undefined) extractedNums.add(num);
  }
  if (extractedNums.size === 1) {
    const onlyNum = [...extractedNums][0] as number;
    const keys = index.byNum.get(onlyNum);
    if (keys?.length === 1) return { keys: [keys[0] as string], byId: false, tier: 'num' };
  }
  return { keys: [], byId: false, tier: 'none' };
}

function applyUniqueTier(
  out: Map<string, string>,
  pairs: readonly (readonly [string, string])[],
): void {
  const candidates = new Map<string, Set<string>>();
  for (const [key, guideId] of pairs) {
    if (out.has(key)) continue;
    const ids = candidates.get(key) ?? new Set<string>();
    ids.add(guideId);
    candidates.set(key, ids);
  }
  for (const [key, ids] of candidates) {
    if (ids.size === 1) out.set(key, [...ids][0] as string);
  }
}

/**
 * The final `[channelKey, guideId]` pairs of a guide in strict precedence: every id match, then unambiguous
 * name matches of channels without an id match, then unambiguous channel-number matches of channels left
 * unmatched by id and name.
 */
export function resolveMappings(
  byId: readonly (readonly [string, string])[],
  byName: readonly (readonly [string, string])[],
  byNum: readonly (readonly [string, string])[] = [],
): [string, string][] {
  const out = new Map<string, string>();
  for (const [key, guideId] of byId) if (!out.has(key)) out.set(key, guideId);
  applyUniqueTier(out, byName);
  applyUniqueTier(out, byNum);
  return [...out];
}
