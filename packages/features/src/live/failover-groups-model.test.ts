import type { FailoverGroupRecord, ItemRow } from '@elv/data';
import { describe, expect, it } from 'vitest';
import {
  buildFailoverTabFocusRows,
  formatFailoverMemberLabel,
  getAvailableFailoverChannels,
  reorderFailoverMemberKeys,
} from './failover-groups-model';

function makeLive(sourceId: string, num: number, overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: num,
    key: `m:${sourceId}:live:${num}`,
    kind: 'live',
    sourceId,
    providerId: String(num),
    name: `Channel ${sourceId}-${num}`,
    logo: null,
    rating: null,
    year: null,
    num,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<FailoverGroupRecord> = {}): FailoverGroupRecord {
  return {
    id: 'fg_1',
    name: 'Sports One',
    autoMatched: false,
    createdAt: 100,
    updatedAt: 100,
    members: [
      {
        groupId: 'fg_1',
        sourceId: 's1',
        channelKey: 'm:s1:live:1',
        position: 0,
        channelName: 'Sports One HD',
        sourceName: 'Provider A',
      },
      {
        groupId: 'fg_1',
        sourceId: 's2',
        channelKey: 'm:s2:live:1',
        position: 1,
        channelName: 'Sports One FHD',
        sourceName: 'Provider B',
      },
      {
        groupId: 'fg_1',
        sourceId: 's3',
        channelKey: 'm:s3:live:1',
        position: 2,
        channelName: 'Sports One Backup',
        sourceName: 'Provider C',
      },
    ],
    ...overrides,
  };
}

describe('failover-groups-model (#157)', () => {
  it('filters live channels not yet present in the failover group', () => {
    const ch1 = makeLive('s1', 1);
    const ch2 = makeLive('s2', 1);
    const ch3 = makeLive('s3', 2);
    const vod: ItemRow = { ...makeLive('s1', 99), key: 'm:s1:movie:99', kind: 'movie' };
    const group = makeGroup({
      members: [
        { groupId: 'fg_1', sourceId: 's1', channelKey: ch1.key, position: 0 },
        { groupId: 'fg_1', sourceId: 's2', channelKey: ch2.key, position: 1 },
      ],
    });

    expect(getAvailableFailoverChannels([ch1, ch2, ch3, vod], group)).toEqual([ch3]);
  });

  it('computes priority reorder swaps and guards out-of-bounds moves', () => {
    const group = makeGroup();
    expect(reorderFailoverMemberKeys(group.members, 0, -1)).toBeNull();
    expect(reorderFailoverMemberKeys(group.members, 2, 1)).toBeNull();
    expect(reorderFailoverMemberKeys(group.members, 1, -1)).toEqual([
      'm:s2:live:1',
      'm:s1:live:1',
      'm:s3:live:1',
    ]);
    expect(reorderFailoverMemberKeys(group.members, 0, 1)).toEqual([
      'm:s2:live:1',
      'm:s1:live:1',
      'm:s3:live:1',
    ]);
  });

  it('builds deterministic 2D TV focus rows including suggestions, picker, and members', () => {
    const group = makeGroup({
      members: [
        { groupId: 'fg_1', sourceId: 's1', channelKey: 'm:s1:live:1', position: 0 },
        { groupId: 'fg_1', sourceId: 's2', channelKey: 'm:s2:live:1', position: 1 },
      ],
    });
    const extra = makeLive('s3', 5);

    const withoutSuggestions = buildFailoverTabFocusRows({
      groups: [group],
      hasSuggestions: false,
      pickingGroupId: null,
      availableChannelsByGroupId: {},
    });
    expect(withoutSuggestions).toEqual([
      { kind: 'auto-match', cols: ['autoMatch'] },
      { kind: 'create', cols: ['input', 'create'] },
      { kind: 'group-header', groupId: 'fg_1', cols: ['addChannel', 'rename', 'delete'] },
      {
        kind: 'member',
        groupId: 'fg_1',
        channelKey: 'm:s1:live:1',
        index: 0,
        cols: ['moveUp', 'moveDown', 'remove'],
      },
      {
        kind: 'member',
        groupId: 'fg_1',
        channelKey: 'm:s2:live:1',
        index: 1,
        cols: ['moveUp', 'moveDown', 'remove'],
      },
    ]);

    const withRename = buildFailoverTabFocusRows({
      groups: [group],
      hasSuggestions: false,
      pickingGroupId: null,
      renamingGroupId: 'fg_1',
      availableChannelsByGroupId: {},
    });
    expect(withRename[2]).toEqual({
      kind: 'group-edit',
      groupId: 'fg_1',
      cols: ['input', 'save', 'cancel'],
    });

    const withPicker = buildFailoverTabFocusRows({
      groups: [group],
      hasSuggestions: true,
      pickingGroupId: 'fg_1',
      availableChannelsByGroupId: { fg_1: [extra] },
    });
    expect(withPicker[0]).toEqual({ kind: 'auto-match', cols: ['autoMatch', 'apply'] });
    expect(withPicker[3]).toEqual({
      kind: 'picker-channel',
      groupId: 'fg_1',
      channelKey: extra.key,
      cols: ['pick'],
    });
  });

  it('formats member labels using member channelName, catalog lookup, or key fallback', () => {
    const ch1 = makeLive('s1', 1, { name: 'Catalog Name' });
    const byKey = new Map<string, ItemRow>([[ch1.key, ch1]]);

    expect(
      formatFailoverMemberLabel(
        {
          groupId: 'fg_1',
          sourceId: 's1',
          channelKey: ch1.key,
          position: 0,
          channelName: 'Stored Name',
        },
        byKey,
      ),
    ).toBe('Stored Name');
    expect(
      formatFailoverMemberLabel(
        { groupId: 'fg_1', sourceId: 's1', channelKey: ch1.key, position: 0 },
        byKey,
      ),
    ).toBe('Catalog Name');
    expect(
      formatFailoverMemberLabel(
        { groupId: 'fg_1', sourceId: 's9', channelKey: 'm:s9:live:7', position: 0 },
        byKey,
      ),
    ).toBe('m:s9:live:7');
  });
});
