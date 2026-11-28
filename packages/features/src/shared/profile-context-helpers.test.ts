import type { ParentalSettings, ProfileRecord } from '@elv/data';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildGuardPinCandidates,
  DEFAULT_PROFILE_CONTEXT,
  DEFAULT_PROFILE_ID,
  DEFAULT_PROFILE_RECORD,
  defaultParentalSettings,
  failClosedParentalSettings,
  isRelaxingParentalPatch,
  parentalUnavailableError,
} from './profile-context-helpers';
import { broadcastSessionGuardEvent } from './session-guard-channel';

describe('profile-context-helpers', () => {
  it('constructs strict fail-closed parental settings and typed unavailable error', () => {
    const closed = failClosedParentalSettings('kids-1');
    expect(closed).toEqual({
      profileId: 'kids-1',
      enabled: true,
      blockAdultKeywords: true,
      maxRatingAge: 0,
      unlockTimeoutMin: 30,
      updatedAt: 0,
    });
    expect(failClosedParentalSettings().profileId).toBe(DEFAULT_PROFILE_ID);

    const errRes = parentalUnavailableError();
    expect(errRes.ok).toBe(false);
    if (!errRes.ok) {
      expect(errRes.error.category).toBe('storage');
      expect(errRes.error.code).toBe('parental-state-unavailable');
    }
  });

  it('provides safe fallback no-op defaults on DEFAULT_PROFILE_CONTEXT', async () => {
    expect(DEFAULT_PROFILE_CONTEXT.parentalLoadError).toBe(false);
    expect(DEFAULT_PROFILE_CONTEXT.activeProfile).toBe(DEFAULT_PROFILE_RECORD);
    expect(await DEFAULT_PROFILE_CONTEXT.switchProfile('p1')).toBeUndefined();
    expect(
      (
        await DEFAULT_PROFILE_CONTEXT.createProfile({
          name: 'A',
          avatarToken: 'crimson',
          isKids: false,
        })
      ).ok,
    ).toBe(false);
    expect((await DEFAULT_PROFILE_CONTEXT.updateProfile('p1', { name: 'B' })).ok).toBe(false);
    expect((await DEFAULT_PROFILE_CONTEXT.deleteProfile('p1')).ok).toBe(false);
    expect((await DEFAULT_PROFILE_CONTEXT.verifyParentalPin('1234')).ok).toBe(false);
    expect((await DEFAULT_PROFILE_CONTEXT.unlockParental('1234')).ok).toBe(false);
    expect(DEFAULT_PROFILE_CONTEXT.lockParentalNow()).toBeUndefined();
    expect((await DEFAULT_PROFILE_CONTEXT.updateParentalSettings({ enabled: true })).ok).toBe(
      false,
    );
    expect(
      (
        await DEFAULT_PROFILE_CONTEXT.setParentalLock(
          { sourceId: 's1', targetKind: 'category', itemKind: 'live', targetKey: '1' },
          true,
        )
      ).ok,
    ).toBe(false);
    expect((await DEFAULT_PROFILE_CONTEXT.setParentalPin('1234')).ok).toBe(false);
    expect((await DEFAULT_PROFILE_CONTEXT.clearParentalPin('1234')).ok).toBe(false);
    expect(await DEFAULT_PROFILE_CONTEXT.hasProfilePin('p1')).toBe(false);
    expect(await DEFAULT_PROFILE_CONTEXT.refreshParental()).toBeUndefined();
    expect(await DEFAULT_PROFILE_CONTEXT.refreshProfiles()).toBeUndefined();
    expect(await DEFAULT_PROFILE_CONTEXT.retryParentalLoad()).toBeUndefined();
    expect(DEFAULT_PROFILE_CONTEXT.requestParentalUnlock(() => undefined)).toBeUndefined();
    expect(DEFAULT_PROFILE_CONTEXT.openPinDialog({ mode: 'verify' })).toBeUndefined();
    expect(DEFAULT_PROFILE_CONTEXT.closePinDialog()).toBeUndefined();
    expect(DEFAULT_PROFILE_CONTEXT.openProfilePicker()).toBeUndefined();
    expect(DEFAULT_PROFILE_CONTEXT.closeProfilePicker()).toBeUndefined();
  });

  it('orders guard PIN candidates active -> default -> other adult profiles without duplicates', () => {
    const kids: ProfileRecord = {
      ...DEFAULT_PROFILE_RECORD,
      id: 'kids',
      isKids: true,
      isDefault: false,
    };
    const adult: ProfileRecord = {
      ...DEFAULT_PROFILE_RECORD,
      id: 'adult-2',
      isKids: false,
      isDefault: false,
    };
    expect(buildGuardPinCandidates('kids', [kids, DEFAULT_PROFILE_RECORD, adult])).toEqual([
      'kids',
      DEFAULT_PROFILE_ID,
      'adult-2',
    ]);
    // Also includes DEFAULT_PROFILE_ID when list has no explicit default record
    expect(buildGuardPinCandidates('kids', [kids, adult])).toEqual([
      'kids',
      DEFAULT_PROFILE_ID,
      'adult-2',
    ]);
  });

  it('detects relaxing vs tightening parental patches accurately', () => {
    const active: ParentalSettings = {
      ...defaultParentalSettings('p1'),
      enabled: true,
      blockAdultKeywords: true,
      maxRatingAge: 12,
      unlockTimeoutMin: 15,
    };
    expect(isRelaxingParentalPatch(active, { enabled: false })).toBe(true);
    expect(isRelaxingParentalPatch(active, { enabled: true })).toBe(false);
    expect(isRelaxingParentalPatch(active, { blockAdultKeywords: false })).toBe(true);
    expect(isRelaxingParentalPatch(active, { maxRatingAge: null })).toBe(true);
    expect(isRelaxingParentalPatch(active, { maxRatingAge: 16 })).toBe(true);
    expect(isRelaxingParentalPatch(active, { maxRatingAge: 7 })).toBe(false);
    expect(isRelaxingParentalPatch(active, { unlockTimeoutMin: 0 })).toBe(true);
    expect(isRelaxingParentalPatch(active, { unlockTimeoutMin: 30 })).toBe(true);
    expect(isRelaxingParentalPatch(active, { unlockTimeoutMin: 5 })).toBe(false);
    expect(isRelaxingParentalPatch(active, { unlockTimeoutMin: 15 })).toBe(false);
  });
});

describe('session-guard-channel', () => {
  const originalBroadcastChannel = (globalThis as Record<string, unknown>).BroadcastChannel;
  const originalLocalStorage = (globalThis as Record<string, unknown>).localStorage;

  afterEach(() => {
    if (originalBroadcastChannel === undefined) {
      delete (globalThis as Record<string, unknown>).BroadcastChannel;
    } else {
      (globalThis as Record<string, unknown>).BroadcastChannel = originalBroadcastChannel;
    }
    if (originalLocalStorage === undefined) {
      delete (globalThis as Record<string, unknown>).localStorage;
    } else {
      (globalThis as Record<string, unknown>).localStorage = originalLocalStorage;
    }
  });

  it('broadcasts via BroadcastChannel and closes channel cleanly', () => {
    const postMessage = vi.fn();
    const close = vi.fn();
    class MockChannel {
      readonly name: string;
      constructor(name: string) {
        this.name = name;
      }
      postMessage = postMessage;
      close = close;
    }
    (globalThis as Record<string, unknown>).BroadcastChannel = MockChannel;
    broadcastSessionGuardEvent({ type: 'parental-relock', profileId: 'p1' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'parental-relock', profileId: 'p1' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('falls back to localStorage when BroadcastChannel throws or is absent', () => {
    (globalThis as Record<string, unknown>).BroadcastChannel = class {
      constructor() {
        throw new Error('blocked');
      }
    };
    const setItem = vi.fn();
    (globalThis as Record<string, unknown>).localStorage = { setItem };
    broadcastSessionGuardEvent({ type: 'source-deleted', sourceId: 'src-1' });
    expect(setItem).toHaveBeenCalledWith(
      'elv:session-guard',
      expect.stringContaining('"source-deleted"'),
    );

    // Also swallows storage errors cleanly
    const throwingSet = vi.fn(() => {
      throw new Error('quota');
    });
    (globalThis as Record<string, unknown>).localStorage = { setItem: throwingSet };
    expect(() =>
      broadcastSessionGuardEvent({ type: 'profile-switch', profileId: 'p2' }),
    ).not.toThrow();
  });
});
