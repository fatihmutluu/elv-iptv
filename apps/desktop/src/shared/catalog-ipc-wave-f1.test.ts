import { describe, expect, it } from 'vitest';
import { isCatalogClientMessage } from './catalog-ipc.ts';

const call = (c: unknown) => ({ type: 'call', reqId: 1, call: c });

describe('Wave F1 catalog IPC guards (#15, #31)', () => {
  it('accepts valid profile CRUD calls and rejects malformed payloads', () => {
    expect(isCatalogClientMessage(call({ method: 'listProfiles' }))).toBe(true);
    expect(isCatalogClientMessage(call({ method: 'flushPendingWrites' }))).toBe(true);

    expect(
      isCatalogClientMessage(
        call({
          method: 'createProfile',
          input: { name: 'Kids', avatarToken: 'emerald', isKids: true },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(call({ method: 'createProfile', input: { name: 'Guest' } })),
    ).toBe(true);

    for (const bad of [
      null,
      {},
      { name: '' },
      { name: 'a'.repeat(129) },
      { name: 'Bad\nName' },
      { name: 'Ok', avatarToken: 'neon-pink' },
      { name: 'Ok', isKids: 'yes' },
      { name: 'Ok', extra: 1 },
    ]) {
      expect(isCatalogClientMessage(call({ method: 'createProfile', input: bad }))).toBe(false);
    }

    expect(
      isCatalogClientMessage(
        call({
          method: 'updateProfile',
          id: 'p_abc_123',
          patch: { name: 'Renamed', avatarToken: 'sapphire', isKids: false },
        }),
      ),
    ).toBe(true);

    for (const badId of ['', '../escape', 'has space', 'bad/id', 'a'.repeat(65)]) {
      expect(
        isCatalogClientMessage(
          call({ method: 'updateProfile', id: badId, patch: { name: 'Valid' } }),
        ),
      ).toBe(false);
      expect(isCatalogClientMessage(call({ method: 'deleteProfile', id: badId }))).toBe(false);
    }

    for (const badPatch of [
      null,
      { name: '' },
      { name: 'Bad\tName' },
      { avatarToken: 'invalid' },
      { isKids: 1 },
      { isDefault: true },
    ]) {
      expect(
        isCatalogClientMessage(call({ method: 'updateProfile', id: 'default', patch: badPatch })),
      ).toBe(false);
    }

    expect(isCatalogClientMessage(call({ method: 'deleteProfile', id: 'p_abc_123' }))).toBe(true);
  });

  it('accepts valid parental settings, locks, and PIN calls and rejects invalid payloads', () => {
    expect(isCatalogClientMessage(call({ method: 'getParentalSettings' }))).toBe(true);
    expect(
      isCatalogClientMessage(call({ method: 'getParentalSettings', profileId: 'p_kids_1' })),
    ).toBe(true);
    expect(
      isCatalogClientMessage(call({ method: 'getParentalSettings', profileId: '../bad' })),
    ).toBe(false);

    expect(
      isCatalogClientMessage(
        call({
          method: 'updateParentalSettings',
          profileId: 'default',
          patch: {
            enabled: true,
            blockAdultKeywords: true,
            maxRatingAge: 12,
            unlockTimeoutMin: 30,
          },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'updateParentalSettings',
          patch: { maxRatingAge: null },
        }),
      ),
    ).toBe(true);

    for (const badPatch of [
      null,
      { enabled: 'yes' },
      { blockAdultKeywords: 1 },
      { maxRatingAge: -1 },
      { maxRatingAge: 99 },
      { maxRatingAge: 12.5 },
      { unlockTimeoutMin: -5 },
      { unlockTimeoutMin: 10_000 },
      { unknownField: true },
    ]) {
      expect(
        isCatalogClientMessage(call({ method: 'updateParentalSettings', patch: badPatch })),
      ).toBe(false);
    }

    expect(isCatalogClientMessage(call({ method: 'listParentalLocks' }))).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'listParentalLocks',
          profileId: 'p_kids',
          filter: { sourceId: 's1', targetKind: 'category', itemKind: 'live' },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'listParentalLocks',
          filter: { targetKind: 'channel' },
        }),
      ),
    ).toBe(false);
    expect(
      isCatalogClientMessage(
        call({
          method: 'listParentalLocks',
          filter: { itemKind: 'episode' },
        }),
      ),
    ).toBe(false);

    expect(
      isCatalogClientMessage(
        call({
          method: 'setParentalLock',
          input: {
            profileId: 'p_kids',
            sourceId: 's1',
            targetKind: 'item',
            itemKind: 'movie',
            targetKey: 's1:movie:42',
          },
          locked: true,
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'setParentalLock',
          input: {
            sourceId: 's1',
            targetKind: 'category',
            itemKind: 'live',
            targetKey: 's1|live|18',
          },
          locked: 'true',
        }),
      ),
    ).toBe(false);
    expect(
      isCatalogClientMessage(
        call({
          method: 'setParentalLock',
          input: {
            sourceId: '',
            targetKind: 'category',
            itemKind: 'live',
            targetKey: 's1|live|18',
          },
          locked: true,
        }),
      ),
    ).toBe(false);

    expect(isCatalogClientMessage(call({ method: 'hasParentalPin' }))).toBe(true);
    expect(isCatalogClientMessage(call({ method: 'hasParentalPin', profileId: 'p_1' }))).toBe(true);
    expect(isCatalogClientMessage(call({ method: 'hasParentalPin', profileId: 'bad/id' }))).toBe(
      false,
    );

    expect(
      isCatalogClientMessage(
        call({ method: 'setParentalPin', pin: '1234', profileId: 'default', currentPin: '0000' }),
      ),
    ).toBe(true);
    expect(isCatalogClientMessage(call({ method: 'setParentalPin', pin: '' }))).toBe(false);
    expect(isCatalogClientMessage(call({ method: 'setParentalPin', pin: 1234 }))).toBe(false);
    expect(isCatalogClientMessage(call({ method: 'setParentalPin', pin: '1234\n' }))).toBe(false);

    expect(
      isCatalogClientMessage(call({ method: 'verifyParentalPin', pin: '1234', profileId: 'p_1' })),
    ).toBe(true);
    expect(isCatalogClientMessage(call({ method: 'verifyParentalPin', pin: null }))).toBe(false);

    expect(
      isCatalogClientMessage(
        call({ method: 'clearParentalPin', currentPin: '1234', profileId: 'p_1' }),
      ),
    ).toBe(true);
    expect(isCatalogClientMessage(call({ method: 'clearParentalPin', currentPin: 1234 }))).toBe(
      false,
    );
  });

  it('accepts parental/profile query options on existing catalog, EPG, stream, and user-state methods', () => {
    const parentalOpts = { profileId: 'p_kids', parentalUnlocked: false };

    expect(
      isCatalogClientMessage(
        call({
          method: 'categories',
          sourceId: 's1',
          kind: 'live',
          opts: { includeHidden: true, ...parentalOpts },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'categories',
          sourceId: 's1',
          kind: 'live',
          opts: { includeHidden: 'yes' },
        }),
      ),
    ).toBe(false);

    expect(
      isCatalogClientMessage(
        call({
          method: 'items',
          categoryId: 's1|live|1',
          offset: 0,
          limit: 20,
          opts: { parentalUnlocked: true, profileId: 'p_kids' },
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
          opts: { parentalUnlocked: 'true' },
        }),
      ),
    ).toBe(false);

    expect(
      isCatalogClientMessage(
        call({
          method: 'search',
          query: 'action',
          opts: { scope: 'movie', ...parentalOpts },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'searchSuggestions',
          options: { limit: 8, ...parentalOpts },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'alphabetIndex',
          input: { kind: 'movie', ...parentalOpts },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({ method: 'itemDetail', itemKey: 's1:movie:1', opts: parentalOpts }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({ method: 'nowNext', channelKeys: ['s1:live:1'], nowMs: 1000, opts: parentalOpts }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'epgWindow',
          channelKeys: ['s1:live:1'],
          fromMs: 1000,
          toMs: 2000,
          opts: parentalOpts,
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'epgSlice',
          sourceId: 's1',
          fromMs: 1000,
          toMs: 2000,
          limit: 100,
          opts: parentalOpts,
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'epgSlice',
          sourceId: '',
          fromMs: 1000,
          toMs: 2000,
        }),
      ),
    ).toBe(false);
    expect(
      isCatalogClientMessage(
        call({ method: 'channelByNumber', num: 10, sourceId: 's1', opts: parentalOpts }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({ method: 'resolveStream', itemKey: 's1:live:1', opts: parentalOpts }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'listContinueWatching',
          limit: 10,
          profileId: 'p_kids',
          opts: { parentalUnlocked: false },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'listFavorites',
          limit: 10,
          profileId: 'p_kids',
          opts: { parentalUnlocked: true },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'listRecentChannels',
          limit: 10,
          profileId: 'p_kids',
          opts: { parentalUnlocked: false },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'listFavorites',
          limit: 10,
          profileId: 'p_kids',
          opts: { parentalUnlocked: 1 },
        }),
      ),
    ).toBe(false);
  });
});
