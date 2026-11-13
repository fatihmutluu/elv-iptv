import { foldText } from './fold';

/** Live channels of a source indexed for guide matching; values are channel keys. */
export interface ChannelIndex {
  byGuideId: Map<string, string[]>;
  byFold: Map<string, string[]>;
}

function push(map: Map<string, string[]>, id: string, key: string): void {
  const list = map.get(id);
  if (list === undefined) map.set(id, [key]);
  else list.push(key);
}

/** Indexes live channel rows by their guide id and by their folded name. */
export function buildChannelIndex(
  rows: readonly { key: string; guide_id: string | null; name_fold: string }[],
): ChannelIndex {
  const index: ChannelIndex = { byGuideId: new Map(), byFold: new Map() };
  for (const row of rows) {
    if (row.guide_id !== null && row.guide_id !== '') push(index.byGuideId, row.guide_id, row.key);
    if (row.name_fold !== '') push(index.byFold, row.name_fold, row.key);
  }
  return index;
}

/** Live channel keys a guide channel matched, and whether the match was by guide id. */
export interface GuideMatch {
  keys: string[];
  byId: boolean;
}

/**
 * Finds the live channels a guide channel belongs to. An exact guide id wins and maps every channel that shares
 * it; otherwise a folded display name must point at exactly one channel. Ambiguous names map nothing. A name
 * match is only a candidate: {@link resolveMappings} lets id matches win.
 */
export function matchGuideChannel(
  index: ChannelIndex,
  guide: { id: string; names: readonly string[] },
): GuideMatch {
  const byId = index.byGuideId.get(guide.id);
  if (byId !== undefined) return { keys: [...byId], byId: true };
  const found = new Set<string>();
  for (const name of guide.names) {
    const fold = foldText(name);
    const keys = fold === '' ? undefined : index.byFold.get(fold);
    if (keys?.length === 1) found.add(keys[0] as string);
  }
  return { keys: found.size === 1 ? [...found] : [], byId: false };
}

/**
 * The final `[channelKey, guideId]` pairs of a guide: every id match, then the name matches of channels that have
 * no id match and that exactly one guide channel names.
 */
export function resolveMappings(
  byId: readonly (readonly [string, string])[],
  byName: readonly (readonly [string, string])[],
): [string, string][] {
  const out = new Map<string, string>();
  for (const [key, guideId] of byId) if (!out.has(key)) out.set(key, guideId);
  const named = new Map<string, Set<string>>();
  for (const [key, guideId] of byName) {
    if (out.has(key)) continue;
    const ids = named.get(key) ?? new Set<string>();
    ids.add(guideId);
    named.set(key, ids);
  }
  for (const [key, ids] of named) {
    if (ids.size === 1) out.set(key, [...ids][0] as string);
  }
  return [...out];
}
