import { describe, expect, it } from 'vitest';
import { isCatalogClientMessage } from './catalog-ipc.ts';

const call = (c: unknown) => ({ type: 'call', reqId: 1, call: c });

describe('Wave F2 catalog IPC guards (#60)', () => {
  it('accepts valid channel override calls and rejects malformed payloads', () => {
    expect(isCatalogClientMessage(call({ method: 'listChannelOverrides' }))).toBe(true);
    expect(
      isCatalogClientMessage(call({ method: 'listChannelOverrides', profileId: 'p_living' })),
    ).toBe(true);
    expect(
      isCatalogClientMessage(call({ method: 'listChannelOverrides', profileId: '../bad' })),
    ).toBe(false);
    expect(isCatalogClientMessage(call({ method: 'listChannelOverrides', extra: true }))).toBe(
      false,
    );

    expect(
      isCatalogClientMessage(
        call({
          method: 'setChannelOverride',
          input: {
            profileId: 'p_living',
            itemKey: 'm:s1:ch1',
            sourceId: 's1',
            customName: 'News HD',
            isHidden: false,
            sortOrder: 0,
          },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'setChannelOverride',
          input: {
            itemKey: 'm:s1:ch1',
            sourceId: 's1',
            customName: null,
            sortOrder: null,
          },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'setChannelOverride',
          input: {
            itemKey: 'm:s1:ch1',
            sourceId: 's1',
            isHidden: true,
          },
        }),
      ),
    ).toBe(true);

    for (const badInput of [
      null,
      {},
      { itemKey: '', sourceId: 's1' },
      { itemKey: 'http://evil.test/ch', sourceId: 's1' },
      { itemKey: 'm:s1:ch1?token=secret', sourceId: 's1' },
      { itemKey: 'm:s1:ch1', sourceId: '' },
      { itemKey: 'm:s1:ch1', sourceId: 's1', profileId: '../bad' },
      { itemKey: 'm:s1:ch1', sourceId: 's1', customName: 'a'.repeat(161) },
      { itemKey: 'm:s1:ch1', sourceId: 's1', customName: 'Bad\nName' },
      { itemKey: 'm:s1:ch1', sourceId: 's1', isHidden: 'yes' },
      { itemKey: 'm:s1:ch1', sourceId: 's1', sortOrder: -1 },
      { itemKey: 'm:s1:ch1', sourceId: 's1', sortOrder: 1_000_000_000 },
      { itemKey: 'm:s1:ch1', sourceId: 's1', sortOrder: 1.5 },
      { itemKey: 'm:s1:ch1', sourceId: 's1', extra: 1 },
    ]) {
      expect(isCatalogClientMessage(call({ method: 'setChannelOverride', input: badInput }))).toBe(
        false,
      );
    }

    expect(
      isCatalogClientMessage(
        call({ method: 'clearChannelOverride', itemKey: 'm:s1:ch1', profileId: 'p_living' }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(call({ method: 'clearChannelOverride', itemKey: 'm:s1:ch1' })),
    ).toBe(true);
    expect(isCatalogClientMessage(call({ method: 'clearChannelOverride', itemKey: '' }))).toBe(
      false,
    );
    expect(
      isCatalogClientMessage(
        call({ method: 'clearChannelOverride', itemKey: 'http://evil.test/1' }),
      ),
    ).toBe(false);
    expect(
      isCatalogClientMessage(
        call({ method: 'clearChannelOverride', itemKey: 'm:s1:ch1', profileId: 'bad/id' }),
      ),
    ).toBe(false);

    expect(
      isCatalogClientMessage(
        call({
          method: 'reorderChannels',
          itemKeys: ['m:s1:ch2', 'm:s1:ch1'],
          sourceId: 's1',
          profileId: 'default',
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(call({ method: 'reorderChannels', itemKeys: [], sourceId: 's1' })),
    ).toBe(true);
    for (const badReorder of [
      { method: 'reorderChannels', itemKeys: 'not-an-array', sourceId: 's1' },
      { method: 'reorderChannels', itemKeys: ['http://bad.test/a'], sourceId: 's1' },
      { method: 'reorderChannels', itemKeys: ['m:s1:ch1'], sourceId: '' },
      { method: 'reorderChannels', itemKeys: ['m:s1:ch1'], sourceId: 's1', profileId: '../bad' },
      { method: 'reorderChannels', itemKeys: ['m:s1:ch1'], sourceId: 's1', extra: 1 },
    ]) {
      expect(isCatalogClientMessage(call(badReorder))).toBe(false);
    }
  });

  it('accepts valid custom group CRUD and membership calls and rejects malformed payloads', () => {
    expect(isCatalogClientMessage(call({ method: 'listCustomGroups' }))).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'listCustomGroups',
          profileId: 'p_living',
          opts: { includeHidden: true, parentalUnlocked: false },
        }),
      ),
    ).toBe(true);
    for (const badList of [
      { method: 'listCustomGroups', profileId: '../bad' },
      { method: 'listCustomGroups', opts: { includeHidden: 'yes' } },
      { method: 'listCustomGroups', opts: { parentalUnlocked: 1 } },
      { method: 'listCustomGroups', opts: { extra: true } },
    ]) {
      expect(isCatalogClientMessage(call(badList))).toBe(false);
    }

    expect(
      isCatalogClientMessage(
        call({
          method: 'createCustomGroup',
          input: { profileId: 'default', name: 'Sports', sortOrder: 1, isHidden: false },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(call({ method: 'createCustomGroup', input: { name: 'News' } })),
    ).toBe(true);
    for (const badCreate of [
      null,
      {},
      { name: '' },
      { name: '   ' },
      { name: 'a'.repeat(81) },
      { name: 'Bad\nGroup' },
      { name: 'Sports', profileId: '../bad' },
      { name: 'Sports', sortOrder: 1.5 },
      { name: 'Sports', isHidden: 'no' },
      { name: 'Sports', extra: 1 },
    ]) {
      expect(isCatalogClientMessage(call({ method: 'createCustomGroup', input: badCreate }))).toBe(
        false,
      );
    }

    expect(
      isCatalogClientMessage(
        call({
          method: 'updateCustomGroup',
          groupId: 'g_123_abc',
          patch: { name: 'Live Sports', sortOrder: 2, isHidden: true },
        }),
      ),
    ).toBe(true);
    for (const badUpdate of [
      { method: 'updateCustomGroup', groupId: '../escape', patch: { name: 'Ok' } },
      { method: 'updateCustomGroup', groupId: '', patch: { name: 'Ok' } },
      { method: 'updateCustomGroup', groupId: 'g_123', patch: null },
      { method: 'updateCustomGroup', groupId: 'g_123', patch: { name: '' } },
      { method: 'updateCustomGroup', groupId: 'g_123', patch: { name: 'a'.repeat(81) } },
      { method: 'updateCustomGroup', groupId: 'g_123', patch: { sortOrder: Number.NaN } },
      { method: 'updateCustomGroup', groupId: 'g_123', patch: { isHidden: 1 } },
      { method: 'updateCustomGroup', groupId: 'g_123', patch: { extra: 1 } },
    ]) {
      expect(isCatalogClientMessage(call(badUpdate))).toBe(false);
    }

    expect(isCatalogClientMessage(call({ method: 'deleteCustomGroup', groupId: 'g_123' }))).toBe(
      true,
    );
    expect(isCatalogClientMessage(call({ method: 'deleteCustomGroup', groupId: '../bad' }))).toBe(
      false,
    );

    expect(
      isCatalogClientMessage(
        call({
          method: 'setCustomGroupItems',
          groupId: 'g_123',
          items: [
            { itemKey: 'm:s1:ch1', sourceId: 's1' },
            { itemKey: 'm:s1:ch2', sourceId: 's1' },
          ],
        }),
      ),
    ).toBe(true);
    for (const badSetItems of [
      { method: 'setCustomGroupItems', groupId: '../bad', items: [] },
      { method: 'setCustomGroupItems', groupId: 'g_123', items: 'bad' },
      {
        method: 'setCustomGroupItems',
        groupId: 'g_123',
        items: [{ itemKey: 'http://bad/1', sourceId: 's1' }],
      },
      {
        method: 'setCustomGroupItems',
        groupId: 'g_123',
        items: [{ itemKey: 'm:s1:ch1', sourceId: '' }],
      },
      {
        method: 'setCustomGroupItems',
        groupId: 'g_123',
        items: [{ itemKey: 'm:s1:ch1', sourceId: 's1', extra: true }],
      },
    ]) {
      expect(isCatalogClientMessage(call(badSetItems))).toBe(false);
    }

    expect(
      isCatalogClientMessage(
        call({
          method: 'addChannelToCustomGroup',
          groupId: 'g_123',
          itemKey: 'm:s1:ch1',
          sourceId: 's1',
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'addChannelToCustomGroup',
          groupId: 'g_123',
          itemKey: 'http://bad/1',
          sourceId: 's1',
        }),
      ),
    ).toBe(false);
    expect(
      isCatalogClientMessage(
        call({
          method: 'addChannelToCustomGroup',
          groupId: 'bad/id',
          itemKey: 'm:s1:ch1',
          sourceId: 's1',
        }),
      ),
    ).toBe(false);

    expect(
      isCatalogClientMessage(
        call({
          method: 'removeChannelFromCustomGroup',
          groupId: 'g_123',
          itemKey: 'm:s1:ch1',
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'removeChannelFromCustomGroup',
          groupId: 'g_123',
          itemKey: '',
        }),
      ),
    ).toBe(false);
    expect(
      isCatalogClientMessage(
        call({
          method: 'removeChannelFromCustomGroup',
          groupId: 'g_123',
          itemKey: 'm:s1:ch1',
          extra: 1,
        }),
      ),
    ).toBe(false);
  });

  it('allows includeHidden on items, allSourcesItems, alphabetIndex, and listFavorites while rejecting non-booleans', () => {
    expect(
      isCatalogClientMessage(
        call({
          method: 'items',
          categoryId: 's1|live|1',
          offset: 0,
          limit: 20,
          opts: { includeHidden: true, profileId: 'default' },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'items',
          categoryId: 's1|live|1',
          offset: 0,
          limit: 20,
          opts: { includeHidden: 'yes' },
        }),
      ),
    ).toBe(false);

    expect(
      isCatalogClientMessage(
        call({
          method: 'allSourcesItems',
          kind: 'live',
          offset: 0,
          limit: 20,
          opts: { includeHidden: true },
        }),
      ),
    ).toBe(true);

    expect(
      isCatalogClientMessage(
        call({
          method: 'alphabetIndex',
          input: { kind: 'live', includeHidden: true, profileId: 'default' },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'alphabetIndex',
          input: { kind: 'live', includeHidden: 1 },
        }),
      ),
    ).toBe(false);

    expect(
      isCatalogClientMessage(
        call({
          method: 'listFavorites',
          limit: 20,
          profileId: 'default',
          opts: { includeHidden: true, parentalUnlocked: true },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'listFavorites',
          opts: { includeHidden: 'yes' },
        }),
      ),
    ).toBe(false);
  });
});
