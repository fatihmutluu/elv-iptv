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

/**
 * Finds the live channels a guide channel belongs to. An exact guide id wins and maps every channel that shares
 * it; otherwise a folded display name must point at exactly one channel. Ambiguous names map nothing.
 */
export function matchGuideChannel(
  index: ChannelIndex,
  guide: { id: string; names: readonly string[] },
): string[] {
  const byId = index.byGuideId.get(guide.id);
  if (byId !== undefined) return [...byId];
  const found = new Set<string>();
  for (const name of guide.names) {
    const fold = foldText(name);
    const keys = fold === '' ? undefined : index.byFold.get(fold);
    if (keys?.length === 1) found.add(keys[0] as string);
  }
  return found.size === 1 ? [...found] : [];
}
