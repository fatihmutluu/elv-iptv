import type { FailoverGroupMember, FailoverGroupRecord, ItemRow } from '@elv/data';

/** Focusable action columns on one ordered failover member row (`#157`). */
type FailoverMemberAction = 'moveUp' | 'moveDown' | 'remove';

/** Virtual 2D TV focus row descriptor inside {@link FailoverGroupsTab} (`#157`). */
export type FailoverTabFocusRow =
  | {
      readonly kind: 'auto-match';
      readonly cols: readonly ['autoMatch'] | readonly ['autoMatch', 'apply'];
    }
  | { readonly kind: 'create'; readonly cols: readonly ['input', 'create'] }
  | {
      readonly kind: 'group-header';
      readonly groupId: string;
      readonly cols: readonly ['addChannel', 'delete'];
    }
  | {
      readonly kind: 'picker-channel';
      readonly groupId: string;
      readonly channelKey: string;
      readonly cols: readonly ['pick'];
    }
  | {
      readonly kind: 'member';
      readonly groupId: string;
      readonly channelKey: string;
      readonly index: number;
      readonly cols: readonly FailoverMemberAction[];
    };

/** Returns live channels from `channels` that are not yet members of `group`. */
export function getAvailableFailoverChannels(
  channels: readonly ItemRow[],
  group: FailoverGroupRecord,
): readonly ItemRow[] {
  const existing = new Set(group.members.map((m) => m.channelKey));
  return channels.filter((ch) => ch.kind === 'live' && !existing.has(ch.key));
}

/**
 * Computes the reordered `channelKey[]` after moving `members[index]` up (`-1`) or down (`+1`),
 * or returns `null` when the move is out of bounds.
 */
export function reorderFailoverMemberKeys(
  members: readonly FailoverGroupMember[],
  index: number,
  delta: -1 | 1,
): readonly string[] | null {
  const target = index + delta;
  if (index < 0 || index >= members.length || target < 0 || target >= members.length) {
    return null;
  }
  const next = members.map((m) => m.channelKey);
  const currentKey = next[index];
  const neighborKey = next[target];
  if (currentKey === undefined || neighborKey === undefined) return null;
  next[index] = neighborKey;
  next[target] = currentKey;
  return next;
}

/** Resolves a human-readable display label for one failover group member. */
export function formatFailoverMemberLabel(
  member: FailoverGroupMember,
  channelsByKey: ReadonlyMap<string, ItemRow>,
): string {
  return member.channelName ?? channelsByKey.get(member.channelKey)?.name ?? member.channelKey;
}

/** Flattens {@link FailoverGroupsTab} interactive controls into deterministic 2D TV focus rows. */
export function buildFailoverTabFocusRows(params: {
  readonly groups: readonly FailoverGroupRecord[];
  readonly hasSuggestions: boolean;
  readonly pickingGroupId: string | null;
  readonly availableChannelsByGroupId: Readonly<Record<string, readonly ItemRow[]>>;
}): readonly FailoverTabFocusRow[] {
  const { groups, hasSuggestions, pickingGroupId, availableChannelsByGroupId } = params;
  const rows: FailoverTabFocusRow[] = [
    { kind: 'auto-match', cols: hasSuggestions ? ['autoMatch', 'apply'] : ['autoMatch'] },
    { kind: 'create', cols: ['input', 'create'] },
  ];

  for (const group of groups) {
    rows.push({ kind: 'group-header', groupId: group.id, cols: ['addChannel', 'delete'] });
    if (pickingGroupId === group.id) {
      const candidates = availableChannelsByGroupId[group.id] ?? [];
      for (const ch of candidates) {
        rows.push({
          kind: 'picker-channel',
          groupId: group.id,
          channelKey: ch.key,
          cols: ['pick'],
        });
      }
    }
    group.members.forEach((member, index) => {
      rows.push({
        kind: 'member',
        groupId: group.id,
        channelKey: member.channelKey,
        index,
        cols: ['moveUp', 'moveDown', 'remove'],
      });
    });
  }

  return rows;
}
