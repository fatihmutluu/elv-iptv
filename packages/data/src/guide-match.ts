import { foldGuideMatchText, foldText } from './fold';

/** Live channels of a source indexed for guide matching; values are channel keys. */
export interface ChannelIndex {
  byGuideId: Map<string, string[]>;
  byGuideIdFold: Map<string, string[]>;
  byBaseGuideId: Map<string, string[]>;
  byFold: Map<string, string[]>;
  byNormalizedName: Map<string, string[]>;
  byGuideFold: Map<string, string[]>;
  byNum: Map<number, string[]>;
  nameFoldByKey: Map<string, string>;
}

/** Matching tier used by {@link matchGuideChannel}. */
export type GuideMatchTier = 'id' | 'name' | 'normalized-name' | 'num' | 'none';

const EXACT_CHANNEL_NUM = /^#?(\d{1,6}(?:\.\d{1,3})?)$/;
const HASH_PREFIX_CHANNEL_NUM =
  /^#(\d{1,5}(?:\.\d{1,3})?)(?:(?:\s+(?:[-–—:|]\s*)?|\s*[-–—:|]\s+)\S)/;
const DELIM_CHANNEL_NUM = /^(\d{1,5}(?:\.\d{1,3})?)\s*[-–—:|]\s+\S/;
const BRACKET_TAG_RE = /\[[^\]]*\]/g;
const PAREN_TAG_RE = /\(([^)]*)\)/g;
const CALL_SIGN_RE = /^[A-Z]{3,5}$/;
const TWENTY_FOUR_SEVEN_RE = /(?:^|[^\p{L}\p{N}])24\/7(?=$|[^\p{L}\p{N}])/gu;
const RESOLUTION_NOISE_RE = /(?:^|[^\p{L}\p{N}])(?:1080p|720p|480p)(?=$|[^\p{L}\p{N}])/giu;
const NOISE_TOKENS = new Set(['east', 'west', '1080p', '720p', '480p', 'uhd', 'fhd', 'hd', 'sd']);

/** Strips an `@feedId` suffix from an XMLTV guide id (e.g. `Channel.uk@East` -> `Channel.uk`). */
export function stripFeedId(id: string): string {
  const at = id.indexOf('@');
  return at > 0 ? id.slice(0, at) : id;
}

function stripGuideTags(name: string): string {
  return name
    .replace(BRACKET_TAG_RE, ' ')
    .replace(PAREN_TAG_RE, (_match, inner: string) => {
      const trimmed = inner.trim();
      return CALL_SIGN_RE.test(trimmed) ? ` ${trimmed} ` : ' ';
    })
    .replace(TWENTY_FOUR_SEVEN_RE, ' ');
}

/**
 * Normalizes a channel display name for fallback EPG matching (`#267`): strips `[...]` bracket tags,
 * strips `(...)` parenthetical tags except 3–5 uppercase ASCII broadcast call signs (e.g. `(XELV)`),
 * removes common broadcast noise tokens (`24/7`, `east`, `west`, `1080p`, `720p`, `480p`, `uhd`, `fhd`,
 * `hd`, `sd`), and folds via {@link foldText}.
 */
export function normalizeGuideName(name: string): string {
  const folded = foldText(stripGuideTags(name));
  if (folded === '') return '';
  return folded
    .split(' ')
    .filter((token) => !NOISE_TOKENS.has(token))
    .join(' ');
}

function normalizeGuideMatchName(name: string): string {
  const cleaned = stripGuideTags(name).replace(RESOLUTION_NOISE_RE, ' ');
  const folded = foldGuideMatchText(cleaned);
  if (folded === '') return '';
  return folded
    .split(' ')
    .filter((token) => !NOISE_TOKENS.has(token))
    .join(' ');
}

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
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

/** Indexes live channel rows by exact/case-insensitive/base guide id, folded/normalized name, and positive finite channel number. */
export function buildChannelIndex(
  rows: readonly {
    key: string;
    guide_id: string | null;
    name?: string;
    name_fold: string;
    num?: number | null;
  }[],
): ChannelIndex {
  const index: ChannelIndex = {
    byGuideId: new Map(),
    byGuideIdFold: new Map(),
    byBaseGuideId: new Map(),
    byFold: new Map(),
    byNormalizedName: new Map(),
    byGuideFold: new Map(),
    byNum: new Map(),
    nameFoldByKey: new Map(),
  };
  for (const row of rows) {
    if (row.guide_id !== null && row.guide_id !== '') {
      push(index.byGuideId, row.guide_id, row.key);
      push(index.byGuideIdFold, row.guide_id.toLowerCase(), row.key);
      const baseId = stripFeedId(row.guide_id).toLowerCase();
      if (baseId !== '') push(index.byBaseGuideId, baseId, row.key);
    }
    const foldedName = row.name_fold !== '' ? row.name_fold : foldText(row.name ?? '');
    if (foldedName !== '') index.nameFoldByKey.set(row.key, foldedName);
    if (row.name_fold !== '') push(index.byFold, row.name_fold, row.key);
    const rawName = row.name ?? row.name_fold;
    const norm = normalizeGuideName(rawName);
    if (norm !== '') push(index.byNormalizedName, norm, row.key);
    const guideFold = normalizeGuideMatchName(rawName);
    if (guideFold !== '') push(index.byGuideFold, guideFold, row.key);
    if (typeof row.num === 'number' && Number.isFinite(row.num) && row.num > 0) {
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

function matchUniqueName(
  names: readonly string[],
  map: Map<string, string[]>,
  toKey: (name: string) => string,
): Set<string> {
  const found = new Set<string>();
  for (const name of names) {
    const key = toKey(name);
    const keys = key === '' ? undefined : map.get(key);
    if (keys?.length === 1) found.add(keys[0] as string);
  }
  return found;
}

/**
 * Finds the live channels a guide channel belongs to in strict precedence:
 * 1. Exact guide id, case-insensitive guide id, then `@feedId`-stripped base guide id (`tier: 'id'`).
 * 2. Unique folded display name (`tier: 'name'`), then unique call-sign preserving normalized name
 *    (`tier: 'normalized-name'`).
 * 3. Unique positive finite channel number fallback (`tier: 'num'`, supporting decimal sub-channels
 *    such as `4.1` and `10.2`), only when no name matched and all numeric display-name candidates
 *    resolve to a single live channel.
 */
export function matchGuideChannel(
  index: ChannelIndex,
  guide: { id: string; names: readonly string[] },
): GuideMatch {
  const byId = index.byGuideId.get(guide.id);
  if (byId !== undefined) return { keys: [...byId], byId: true, tier: 'id' };
  const byCi = index.byGuideIdFold.get(guide.id.toLowerCase());
  if (byCi !== undefined) return { keys: [...byCi], byId: true, tier: 'id' };
  const baseId = stripFeedId(guide.id).toLowerCase();
  const byBase = baseId === '' ? undefined : index.byBaseGuideId.get(baseId);
  if (byBase !== undefined) return { keys: [...byBase], byId: true, tier: 'id' };

  const foundName = matchUniqueName(guide.names, index.byFold, foldText);
  if (foundName.size === 1) return { keys: [...foundName], byId: false, tier: 'name' };
  if (foundName.size > 1) return { keys: [], byId: false, tier: 'none' };

  const foundNorm = matchUniqueName(guide.names, index.byNormalizedName, normalizeGuideName);
  if (foundNorm.size === 1) return { keys: [...foundNorm], byId: false, tier: 'normalized-name' };
  if (foundNorm.size > 1) return { keys: [], byId: false, tier: 'none' };

  const foundGuideFold = matchUniqueName(guide.names, index.byGuideFold, normalizeGuideMatchName);
  if (foundGuideFold.size === 1) {
    return { keys: [...foundGuideFold], byId: false, tier: 'normalized-name' };
  }
  if (foundGuideFold.size > 1) return { keys: [], byId: false, tier: 'none' };

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

/** Optional extra ID tiers and channel name folds for deterministic `@feedId` disambiguation (`#431`, `#121`). */
export interface ResolveMappingsExtra {
  byCiId?: readonly (readonly [string, string])[];
  byBaseId?: readonly (readonly [string, string])[];
  channelNameFolds?: ReadonlyMap<string, string>;
}

const lexCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function feedTokens(guideId: string): string[] {
  const at = guideId.indexOf('@');
  if (at <= 0) return [];
  const folded = foldText(guideId.slice(at + 1));
  return folded === '' ? [] : folded.split(' ').filter(Boolean);
}

function pickBaseFeed(candidates: Iterable<string>, liveNameFold: string | undefined): string {
  const sorted = [...new Set(candidates)].sort(lexCompare);
  if (sorted.length <= 1 || liveNameFold === undefined || liveNameFold === '') {
    return sorted[0] as string;
  }
  const liveWords = new Set(liveNameFold.split(' ').filter(Boolean));
  let best = sorted[0] as string;
  let bestScore = 0;
  for (const guideId of sorted) {
    const tokens = feedTokens(guideId);
    if (tokens.length === 0) continue;
    let hits = 0;
    for (const t of tokens) {
      if (liveWords.has(t)) hits += 1;
    }
    if (hits > bestScore) {
      bestScore = hits;
      best = guideId;
    }
  }
  return best;
}

function applyDeterministicIdTier(
  out: Map<string, string>,
  pairs: readonly (readonly [string, string])[] | undefined,
  channelNameFolds?: ReadonlyMap<string, string>,
): void {
  if (pairs === undefined || pairs.length === 0) return;
  const candidates = new Map<string, Set<string>>();
  for (const [key, guideId] of pairs) {
    if (out.has(key)) continue;
    let ids = candidates.get(key);
    if (ids === undefined) {
      ids = new Set();
      candidates.set(key, ids);
    }
    ids.add(guideId);
  }
  for (const [key, ids] of candidates) {
    out.set(key, pickBaseFeed(ids, channelNameFolds?.get(key)));
  }
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
 * The final `[channelKey, guideId]` pairs of a guide in strict precedence:
 * 1. Exact `guide_id` (`byId`)
 * 2. Case-insensitive `guide_id` (`extra.byCiId`)
 * 3. `@feedId`-stripped base `guide_id` (`extra.byBaseId`) with regional feed-token + lexicographical disambiguation
 * 4. Unambiguous exact folded display name (`byName`)
 * 5. Unambiguous normalized display name (`byNormalizedName`)
 * 6. Unambiguous channel number (`byNum`)
 */
export function resolveMappings(
  byId: readonly (readonly [string, string])[],
  byName: readonly (readonly [string, string])[],
  byNum: readonly (readonly [string, string])[] = [],
  byNormalizedName: readonly (readonly [string, string])[] = [],
  extra?: ResolveMappingsExtra,
): [string, string][] {
  const out = new Map<string, string>();
  for (const [key, guideId] of byId) if (!out.has(key)) out.set(key, guideId);
  applyDeterministicIdTier(out, extra?.byCiId);
  applyDeterministicIdTier(out, extra?.byBaseId, extra?.channelNameFolds);
  applyUniqueTier(out, byName);
  applyUniqueTier(out, byNormalizedName);
  applyUniqueTier(out, byNum);
  return [...out];
}
