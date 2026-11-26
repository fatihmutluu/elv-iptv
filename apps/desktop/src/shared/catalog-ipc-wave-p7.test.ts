import { describe, expect, it } from 'vitest';
import { isCatalogClientMessage } from './catalog-ipc.ts';

const call = (c: unknown) => ({ type: 'call', reqId: 1, call: c });

const ALL_NINE_AVATAR_TOKENS = [
  'crimson',
  'sapphire',
  'amber',
  'violet',
  'emerald',
  'slate',
  'coral',
  'teal',
  'indigo',
] as const;

describe('Wave P7 catalog IPC guards (#505, #506)', () => {
  it('validates renameSource payloads and rejects empty, oversized, control-char, or extra-key calls', () => {
    expect(
      isCatalogClientMessage(
        call({ method: 'renameSource', sourceId: 'src_1', name: 'Living Room TV' }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({ method: 'renameSource', sourceId: 'src_1', name: 'a'.repeat(80) }),
      ),
    ).toBe(true);

    const invalidCalls: unknown[] = [
      { method: 'renameSource', sourceId: '', name: 'Valid' },
      { method: 'renameSource', sourceId: 'src_1', name: '' },
      { method: 'renameSource', sourceId: 'src_1', name: '   ' },
      { method: 'renameSource', sourceId: 'src_1', name: 'a'.repeat(81) },
      { method: 'renameSource', sourceId: 'src_1', name: 'Bad\nName' },
      { method: 'renameSource', sourceId: 'src_1', name: 'Valid', extra: true },
      { method: 'renameSource', sourceId: 123, name: 'Valid' },
    ];
    for (const bad of invalidCalls) {
      expect(isCatalogClientMessage(call(bad))).toBe(false);
    }
  });

  it('validates setSourceExcludedProfiles payloads and rejects malformed profile IDs, oversized arrays, or extra keys', () => {
    expect(
      isCatalogClientMessage(
        call({
          method: 'setSourceExcludedProfiles',
          sourceId: 'src_1',
          excludedProfileIds: [],
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'setSourceExcludedProfiles',
          sourceId: 'src_1',
          excludedProfileIds: ['p_kids', 'p_guest-2', 'profile.3'],
        }),
      ),
    ).toBe(true);

    const invalidCalls: unknown[] = [
      { method: 'setSourceExcludedProfiles', sourceId: '', excludedProfileIds: [] },
      { method: 'setSourceExcludedProfiles', sourceId: 'src_1', excludedProfileIds: 'p_kids' },
      {
        method: 'setSourceExcludedProfiles',
        sourceId: 'src_1',
        excludedProfileIds: ['bad/profile'],
      },
      {
        method: 'setSourceExcludedProfiles',
        sourceId: 'src_1',
        excludedProfileIds: [''],
      },
      {
        method: 'setSourceExcludedProfiles',
        sourceId: 'src_1',
        excludedProfileIds: Array.from({ length: 65 }, (_, i) => `p_${i}`),
      },
      {
        method: 'setSourceExcludedProfiles',
        sourceId: 'src_1',
        excludedProfileIds: ['p_kids'],
        extra: 1,
      },
    ];
    for (const bad of invalidCalls) {
      expect(isCatalogClientMessage(call(bad))).toBe(false);
    }
  });

  it('accepts all 9 profile avatar tokens in createProfile and updateProfile IPC payloads', () => {
    for (const avatarToken of ALL_NINE_AVATAR_TOKENS) {
      expect(
        isCatalogClientMessage(
          call({
            method: 'createProfile',
            input: { name: 'Member', avatarToken, isKids: false },
          }),
        ),
      ).toBe(true);
      expect(
        isCatalogClientMessage(
          call({
            method: 'updateProfile',
            id: 'p_member',
            patch: { avatarToken },
          }),
        ),
      ).toBe(true);
    }
    expect(
      isCatalogClientMessage(
        call({
          method: 'createProfile',
          input: { name: 'Member', avatarToken: 'unknown-color' },
        }),
      ),
    ).toBe(false);
  });
});
