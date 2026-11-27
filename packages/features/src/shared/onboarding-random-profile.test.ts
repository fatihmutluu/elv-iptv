import { isProfileAvatarToken, PROFILE_AVATAR_TOKENS } from '@elv/data';
import { describe, expect, it } from 'vitest';
import {
  isUntouchedDefaultProfile,
  ONBOARDING_PROFILE_NAMES_EN,
  ONBOARDING_PROFILE_NAMES_TR,
  pickRandomOnboardingProfile,
} from './onboarding-random-profile';

describe('pickRandomOnboardingProfile', () => {
  it('picks an English cinema-themed name and valid built-in avatar token by default', () => {
    const picked = pickRandomOnboardingProfile({ random: () => 0 });
    expect(picked.name).toBe(ONBOARDING_PROFILE_NAMES_EN[0]);
    expect(picked.avatarToken).toBe(PROFILE_AVATAR_TOKENS[0]);
    expect(isProfileAvatarToken(picked.avatarToken)).toBe(true);
  });

  it('picks from Turkish cinema-themed pool for tr and tr-TR locales', () => {
    const tr = pickRandomOnboardingProfile({ locale: 'tr', random: () => 0.5 });
    expect(ONBOARDING_PROFILE_NAMES_TR).toContain(tr.name);
    expect(isProfileAvatarToken(tr.avatarToken)).toBe(true);

    const trRegional = pickRandomOnboardingProfile({ locale: 'TR-tr', random: () => 0.99 });
    expect(trRegional.name).toBe(
      ONBOARDING_PROFILE_NAMES_TR[ONBOARDING_PROFILE_NAMES_TR.length - 1],
    );
    expect(trRegional.avatarToken).toBe(PROFILE_AVATAR_TOKENS[PROFILE_AVATAR_TOKENS.length - 1]);
  });

  it('supports deterministic sequential RNG and safely clamps out-of-range values', () => {
    const seq = [0.2, 0.75];
    let idx = 0;
    const picked = pickRandomOnboardingProfile({
      locale: 'en-US',
      random: () => seq[idx++] ?? 0,
    });
    expect(picked.name).toBe(
      ONBOARDING_PROFILE_NAMES_EN[Math.floor(0.2 * ONBOARDING_PROFILE_NAMES_EN.length)],
    );
    expect(picked.avatarToken).toBe(
      PROFILE_AVATAR_TOKENS[Math.floor(0.75 * PROFILE_AVATAR_TOKENS.length)],
    );

    const high = pickRandomOnboardingProfile({ random: () => 1.5 });
    expect(ONBOARDING_PROFILE_NAMES_EN).toContain(high.name);
    expect(PROFILE_AVATAR_TOKENS).toContain(high.avatarToken);

    const invalid = pickRandomOnboardingProfile({ random: () => Number.NaN });
    expect(invalid.name).toBe(ONBOARDING_PROFILE_NAMES_EN[0]);
    expect(invalid.avatarToken).toBe(PROFILE_AVATAR_TOKENS[0]);
  });

  it('can reach all 9 built-in avatar tokens', () => {
    const seen = new Set<string>();
    for (let i = 0; i < PROFILE_AVATAR_TOKENS.length; i += 1) {
      const r = i / PROFILE_AVATAR_TOKENS.length + 0.01;
      seen.add(pickRandomOnboardingProfile({ random: () => r }).avatarToken);
    }
    expect(seen.size).toBe(9);
    expect([...seen].sort()).toEqual([...PROFILE_AVATAR_TOKENS].sort());
  });
});

describe('isUntouchedDefaultProfile', () => {
  it('returns true only for an unmodified Default profile where createdAt === updatedAt', () => {
    expect(
      isUntouchedDefaultProfile({
        id: 'default',
        name: 'Default',
        isDefault: true,
        createdAt: 0,
        updatedAt: 0,
      }),
    ).toBe(true);

    expect(
      isUntouchedDefaultProfile({
        id: 'default',
        name: 'Default',
        isDefault: false,
        createdAt: 1000,
        updatedAt: 1000,
      }),
    ).toBe(true);
  });

  it('returns false when profile was renamed, edited, or is a non-default profile', () => {
    expect(
      isUntouchedDefaultProfile({
        id: 'default',
        name: 'Cinema Fan',
        isDefault: true,
        createdAt: 0,
        updatedAt: 0,
      }),
    ).toBe(false);

    expect(
      isUntouchedDefaultProfile({
        id: 'default',
        name: 'Default',
        isDefault: true,
        createdAt: 0,
        updatedAt: 1700000000000,
      }),
    ).toBe(false);

    expect(
      isUntouchedDefaultProfile({
        id: 'p_custom_1',
        name: 'Default',
        isDefault: false,
        createdAt: 500,
        updatedAt: 500,
      }),
    ).toBe(false);
  });
});
