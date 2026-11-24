import type { CustomGroupRecord, ItemRow } from '@elv/data';
import { describe, expect, it } from 'vitest';
import {
  buildChannelRowActions,
  buildGroupTabFocusRows,
  buildOverlayHeaderControls,
  canMoveChannelInSource,
  computeSameSourceReorder,
} from './channel-management-model';

function ch(sourceId: string, num: number, overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: num,
    key: `m:${sourceId}:live:${num}`,
    kind: 'live',
    sourceId,
    providerId: String(num),
    name: `${sourceId.toUpperCase()} Ch ${num}`,
    logo: null,
    rating: null,
    year: null,
    num,
    ...overrides,
  };
}

describe('channel-management-model (#60)', () => {
  it('reorders channels within the same source across interleaved multi-source rows and preserves hidden channels', () => {
    const s1a = ch('s1', 1);
    const s2x = ch('s2', 1);
    const s1Hidden = ch('s1', 2, { isHidden: true });
    const s1b = ch('s1', 3);
    const allChannels = [s1a, s2x, s1Hidden, s1b];
    const visibleChannels = [s1a, s2x, s1b]; // showHidden === false

    expect(canMoveChannelInSource(visibleChannels, 0, -1)).toBe(false);
    expect(canMoveChannelInSource(visibleChannels, 0, 1)).toBe(true);
    expect(canMoveChannelInSource(visibleChannels, 1, -1)).toBe(false);
    expect(canMoveChannelInSource(visibleChannels, 1, 1)).toBe(false);

    // Moving s1a down skips s2x and swaps with s1b while preserving s1Hidden in the full source order
    const plan = computeSameSourceReorder({
      allChannels,
      visibleChannels,
      visibleIndex: 0,
      delta: 1,
    });
    expect(plan).toEqual({
      sourceId: 's1',
      updatedSourceKeys: ['m:s1:live:3', 'm:s1:live:2', 'm:s1:live:1'],
      nextVisibleIndex: 2,
      targetSortOrder: 2,
    });

    // Moving s2x (sole channel of s2) returns null
    expect(
      computeSameSourceReorder({
        allChannels,
        visibleChannels,
        visibleIndex: 1,
        delta: 1,
      }),
    ).toBeNull();
  });

  it('builds deterministic header controls, channel row actions, and group focus rows', () => {
    expect(buildOverlayHeaderControls('channels')).toEqual([
      'tab-channels',
      'tab-groups',
      'show-hidden',
      'close',
    ]);
    expect(buildOverlayHeaderControls('groups')).toEqual(['tab-channels', 'tab-groups', 'close']);

    expect(buildChannelRowActions(ch('s1', 1), false)).toEqual([
      'rename',
      'toggleHide',
      'moveUp',
      'moveDown',
    ]);
    expect(buildChannelRowActions(ch('s1', 1, { originalName: 'Orig' }), true)).toEqual([
      'rename',
      'resetName',
      'toggleHide',
      'moveUp',
      'moveDown',
      'addToGroup',
    ]);

    const groups: CustomGroupRecord[] = [
      {
        id: 'g1',
        profileId: 'default',
        name: 'Sports',
        sortOrder: 0,
        isHidden: false,
        itemCount: 1,
        updatedAt: 1,
      },
      {
        id: 'g2',
        profileId: 'default',
        name: 'News',
        sortOrder: 1,
        isHidden: false,
        itemCount: 0,
        updatedAt: 2,
      },
    ];
    const rows = buildGroupTabFocusRows(groups, 'g2', 'g1', { g1: [ch('s1', 1)] });
    expect(rows).toEqual([
      { kind: 'create', cols: ['input', 'add'] },
      { kind: 'group-header', groupId: 'g1', cols: ['expand', 'edit', 'delete'] },
      { kind: 'member', groupId: 'g1', itemKey: 'm:s1:live:1', cols: ['remove'] },
      { kind: 'group-edit', groupId: 'g2', cols: ['input', 'save', 'cancel'] },
    ]);
  });
});
