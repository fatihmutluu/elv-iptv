import { foldText } from './fold';

/** Live channels of a source indexed for guide matching; values are channel keys. */
export interface ChannelIndex {
  byGuideId: Map<string, string[]>;
  byBaseGuideId: Map<string, string[]>;
  byFold: Map<string, string[]>;
  byNormalizedName: Map<string, string[]>;
  byNum: Map<number, string[]>;
}

/** Matching tier used by {@link matchGuideChannel}. */
export type GuideMatchTier = 'id' | 'name' | 'normalized-name' | 'num' | 'none';

const EXACT_CHANNEL_NUM = /^#?(\d{1,6})$/;
const HASH_PREFIX_CHANNEL_NUM = /^#(\d{1,5})(?:(?:\s+(?:[-–—:|]\s*)?|\s*[-–—:|]\s+)\S)/;
const DELIM_CHANNEL_NUM = /^(\d{1,5})\s*[-–—:|]\s+\S/;
const BRACKET_TAG_RE = /\[[^\]]*\]/g;
const PAREN_TAG_RE = /\(([^)]*)\)/g;
const CALL_SIGN_RE = /^[A-Z]{3,5}$/;
const TWENTY_FOUR_SEVEN_RE = /(?:^|[^\p{L}\p{N}])24\/7(?=$|[^\p{L}\p{N}])/gu;
const NOISE_TOKENS = new Set(['east', 'west', '1080p', '720p', '480p', 'uhd', 'fhd', 'hd', 'sd']);

/** Strips an `@feedId` suffix from an XMLTV guide id (e.g. `Channel.uk@East` -> `Channel.uk`). */
export function stripFeedId(id: string): string {
  const at = id.indexOf('@');
  return at > 0 ? id.slice(0, at) : id;
}

/**
 * Normalizes a channel display name for fallback EPG matching (`#267`): strips `[...]` bracket tags,
 * strips `(...)` parenthetical tags except 3–5 uppercase ASCII broadcast call signs (e.g. `(XELV)`),
 * removes common broadcast noise tokens (`24/7`, `east`, `west`, `1080p`, `720p`, `480p`, `uhd`, `fhd`,
 * `hd`, `sd`), and folds via {@link foldText}.
 */
export function normalizeGuideName(name: string): string {
  const cleaned = name
    .replace(BRACKET_TAG_RE, ' ')
    .replace(PAREN_TAG_RE, (_match, inner: string) => {
      const trimmed = inner.trim();
      return CALL_SIGN_RE.test(trimmed) ? ` ${trimmed} ` : ' ';
    })
    .replace(TWENTY_FOUR_SEVEN_RE, ' ');
  const folded = foldText(cleaned);
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
  return Number.isInteger(num) && num > 0 ? num : undefined;
}

/** Indexes live channel rows by exact/base guide id, folded/normalized name, and positive channel number. */
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
    byBaseGuideId: new Map(),
    byFold: new Map(),
    byNormalizedName: new Map(),
    byNum: new Map(),
  };
  for (const row of rows) {
    if (row.guide_id !== null && row.guide_id !== '') {
      push(index.byGuideId, row.guide_id, row.key);
      const baseId = stripFeedId(row.guide_id);
      if (baseId !== '') push(index.byBaseGuideId, baseId, row.key);
    }
    if (row.name_fold !== '') push(index.byFold, row.name_fold, row.key);
    const norm = normalizeGuideName(row.name ?? row.name_fold);
    if (norm !== '') push(index.byNormalizedName, norm, row.key);
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
 * 1. Exact guide id (`tier: 'id'`), then `@feedId`-stripped base guide id (`tier: 'id'`).
 * 2. Unique folded display name (`tier: 'name'`), then unique call-sign preserving normalized name
 *    (`tier: 'normalized-name'`).
 * 3. Unique channel number fallback (`tier: 'num'`), only when no name matched and all numeric
 *    display-name candidates resolve to a single live channel with a unique `num`.
 * Ambiguous candidates map nothing (`tier: 'none'`). Name and number matches are candidates:
 * {@link resolveMappings} enforces `byId > byName > byNormalizedName > byNum`.
 */
export function matchGuideChannel(
  index: ChannelIndex,
  guide: { id: string; names: readonly string[] },
): GuideMatch {
  const byId = index.byGuideId.get(guide.id);
  if (byId !== undefined) return { keys: [...byId], byId: true, tier: 'id' };
  const baseId = stripFeedId(guide.id);
  const byBase = baseId === '' ? undefined : index.byBaseGuideId.get(baseId);
  if (byBase !== undefined) return { keys: [...byBase], byId: true, tier: 'id' };

  const foundName = matchUniqueName(guide.names, index.byFold, foldText);
  if (foundName.size === 1) return { keys: [...foundName], byId: false, tier: 'name' };
  if (foundName.size > 1) return { keys: [], byId: false, tier: 'none' };

  const foundNorm = matchUniqueName(guide.names, index.byNormalizedName, normalizeGuideName);
  if (foundNorm.size === 1) return { keys: [...foundNorm], byId: false, tier: 'normalized-name' };
  if (foundNorm.size > 1) return { keys: [], byId: false, tier: 'none' };

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
 * exact folded name matches, then unambiguous normalized name matches, then unambiguous channel-number
 * matches of channels left unmatched by id and name.
 */
export function resolveMappings(
  byId: readonly (readonly [string, string])[],
  byName: readonly (readonly [string, string])[],
  byNum: readonly (readonly [string, string])[] = [],
  byNormalizedName: readonly (readonly [string, string])[] = [],
): [string, string][] {
  const out = new Map<string, string>();
  for (const [key, guideId] of byId) if (!out.has(key)) out.set(key, guideId);
  applyUniqueTier(out, byName);
  applyUniqueTier(out, byNormalizedName);
  applyUniqueTier(out, byNum);
  return [...out];
}
