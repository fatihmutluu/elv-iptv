import type { CustomGroupRecord, ItemRow } from '@elv/data';

/** Active tab inside {@link ChannelManagementOverlay}. */
export type ChannelManageTab = 'channels' | 'groups';

/** Focusable controls in the top header / tabs bar of {@link ChannelManagementOverlay}. */
export type OverlayHeaderControl = 'tab-channels' | 'tab-groups' | 'show-hidden' | 'close';

/** Focusable row action buttons for one live channel row. */
export type ChannelRowAction =
  | 'rename'
  | 'resetName'
  | 'toggleHide'
  | 'moveUp'
  | 'moveDown'
  | 'addToGroup';

/** Focusable controls inside an inline channel rename editor. */
export type InlineRenameControl = 'input' | 'save' | 'cancel';

/** Virtual 2D TV focus row descriptor inside {@link ChannelGroupsManagerTab}. */
export type GroupTabFocusRow =
  | { readonly kind: 'create'; readonly cols: readonly ['input', 'add'] }
  | {
      readonly kind: 'group-edit';
      readonly groupId: string;
      readonly cols: readonly ['input', 'save', 'cancel'];
    }
  | {
      readonly kind: 'group-header';
      readonly groupId: string;
      readonly cols: readonly ['expand', 'edit', 'delete'];
    }
  | {
      readonly kind: 'member';
      readonly groupId: string;
      readonly itemKey: string;
      readonly cols: readonly ['remove'];
    };

/** Result of computing a same-source channel swap across the full (including hidden) channel list. */
export interface SameSourceReorderPlan {
  readonly sourceId: string;
  readonly updatedSourceKeys: readonly string[];
  readonly nextVisibleIndex: number;
  readonly targetSortOrder: number;
}

/** Returns ordered focusable header controls for the active tab. */
export function buildOverlayHeaderControls(tab: ChannelManageTab): readonly OverlayHeaderControl[] {
  return tab === 'channels'
    ? ['tab-channels', 'tab-groups', 'show-hidden', 'close']
    : ['tab-channels', 'tab-groups', 'close'];
}

/** Returns ordered focusable action buttons rendered on a channel row. */
export function buildChannelRowActions(
  channel: ItemRow,
  hasGroups: boolean,
): readonly ChannelRowAction[] {
  const actions: ChannelRowAction[] = ['rename'];
  if (channel.originalName !== undefined && channel.originalName !== null) {
    actions.push('resetName');
  }
  actions.push('toggleHide', 'moveUp', 'moveDown');
  if (hasGroups) {
    actions.push('addToGroup');
  }
  return actions;
}

/** Returns whether `visibleChannels[visibleIndex]` has an adjacent neighbor in the same source. */
export function canMoveChannelInSource(
  visibleChannels: readonly ItemRow[],
  visibleIndex: number,
  delta: -1 | 1,
): boolean {
  const current = visibleChannels[visibleIndex];
  if (!current) return false;
  for (let i = visibleIndex + delta; i >= 0 && i < visibleChannels.length; i += delta) {
    if (visibleChannels[i]?.sourceId === current.sourceId) return true;
  }
  return false;
}

/**
 * Computes the updated full-source channel order (including hidden channels) when moving
 * `visibleChannels[visibleIndex]` up (`-1`) or down (`+1`).
 *
 * Skips rows belonging to other sources so multi-source channel lists reorder cleanly, and
 * operates on the full `allChannels` list for `current.sourceId` so hidden channels keep distinct
 * `sort_order` slots without collisions.
 */
export function computeSameSourceReorder(params: {
  readonly allChannels: readonly ItemRow[];
  readonly visibleChannels: readonly ItemRow[];
  readonly visibleIndex: number;
  readonly delta: -1 | 1;
}): SameSourceReorderPlan | null {
  const { allChannels, visibleChannels, visibleIndex, delta } = params;
  const current = visibleChannels[visibleIndex];
  if (!current) return null;

  let nextVisibleIndex = visibleIndex + delta;
  while (
    nextVisibleIndex >= 0 &&
    nextVisibleIndex < visibleChannels.length &&
    visibleChannels[nextVisibleIndex]?.sourceId !== current.sourceId
  ) {
    nextVisibleIndex += delta;
  }
  const neighbor = visibleChannels[nextVisibleIndex];
  if (!neighbor) return null;

  const sourceChannels = allChannels.filter((ch) => ch.sourceId === current.sourceId);
  const curPos = sourceChannels.findIndex((ch) => ch.key === current.key);
  const nbrPos = sourceChannels.findIndex((ch) => ch.key === neighbor.key);
  if (curPos < 0 || nbrPos < 0 || curPos === nbrPos) return null;

  const reordered = [...sourceChannels];
  reordered[curPos] = neighbor;
  reordered[nbrPos] = current;

  return {
    sourceId: current.sourceId,
    updatedSourceKeys: reordered.map((ch) => ch.key),
    nextVisibleIndex,
    targetSortOrder: nbrPos,
  };
}

/** Flattens {@link ChannelGroupsManagerTab} controls into deterministic 2D TV focus rows. */
export function buildGroupTabFocusRows(
  groups: readonly CustomGroupRecord[],
  editingGroupId: string | null,
  expandedGroupId: string | null,
  membersByGroupId: Readonly<Record<string, readonly ItemRow[]>>,
): readonly GroupTabFocusRow[] {
  const rows: GroupTabFocusRow[] = [{ kind: 'create', cols: ['input', 'add'] }];
  for (const group of groups) {
    if (editingGroupId === group.id) {
      rows.push({ kind: 'group-edit', groupId: group.id, cols: ['input', 'save', 'cancel'] });
    } else {
      rows.push({ kind: 'group-header', groupId: group.id, cols: ['expand', 'edit', 'delete'] });
    }
    if (expandedGroupId === group.id) {
      const members = membersByGroupId[group.id] ?? [];
      for (const ch of members) {
        rows.push({ kind: 'member', groupId: group.id, itemKey: ch.key, cols: ['remove'] });
      }
    }
  }
  return rows;
}
