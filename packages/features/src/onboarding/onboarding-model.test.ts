import { DEFAULT_HOME_LAYOUT } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import {
  computeImportPercent,
  createInitialOnboardingSourceDraft,
  mapOnboardingAuthError,
  moveOnboardingLayoutSection,
  nextQuoteIndex,
  ONBOARDING_QUOTE_KEYS,
  onboardingPhaseMessageId,
  resolveStartupGateDecision,
  resolveTipsMessageKeys,
  toggleOnboardingLayoutSection,
  validateOnboardingEmail,
  validateOnboardingSignIn,
  validateOnboardingSignUp,
  validateOnboardingSourceDraft,
} from './onboarding-model';

describe('onboarding-model pure helpers', () => {
  it('resolves startup gate decisions accurately for fresh, upgrading, and returning users', () => {
    expect(
      resolveStartupGateDecision({
        onboardingCompleted: true,
        welcomeDismissed: false,
        sourcesCount: 0,
      }),
    ).toBe('returning');

    expect(
      resolveStartupGateDecision({
        onboardingCompleted: false,
        welcomeDismissed: true,
        sourcesCount: 0,
      }),
    ).toBe('auto_migrate');

    expect(
      resolveStartupGateDecision({
        onboardingCompleted: false,
        welcomeDismissed: false,
        sourcesCount: 1,
      }),
    ).toBe('auto_migrate');

    expect(
      resolveStartupGateDecision({
        onboardingCompleted: false,
        welcomeDismissed: false,
        sourcesCount: 0,
        profilesCount: 2,
      }),
    ).toBe('auto_migrate');

    expect(
      resolveStartupGateDecision({
        onboardingCompleted: false,
        welcomeDismissed: false,
        sourcesCount: 0,
        profilesCount: 1,
      }),
    ).toBe('onboarding');
  });

  it('validates email, sign-in, sign-up, and maps auth errors', () => {
    expect(validateOnboardingEmail('not-an-email')).toBe('account.errorInvalidEmail');
    expect(validateOnboardingEmail('viewer@example.c')).toBe('account.errorInvalidEmail');
    expect(validateOnboardingEmail('viewer@example.com')).toBeNull();

    expect(validateOnboardingSignIn('viewer@example.com', '')).toBe('account.errorWeakPassword');
    expect(validateOnboardingSignIn('viewer@example.com', 'secret')).toBeNull();

    expect(validateOnboardingSignUp('viewer@example.com', 'short', 'short')).toBe(
      'account.errorWeakPassword',
    );
    expect(validateOnboardingSignUp('viewer@example.com', 'longpassword123', 'mismatch123')).toBe(
      'account.errorPasswordMismatch',
    );
    expect(
      validateOnboardingSignUp('viewer@example.com', 'longpassword123', 'longpassword123'),
    ).toBeNull();

    expect(mapOnboardingAuthError('invalid_email')).toBe('account.errorInvalidEmail');
    expect(mapOnboardingAuthError('weak_password')).toBe('account.errorWeakPassword');
    expect(mapOnboardingAuthError('password_mismatch')).toBe('account.errorPasswordMismatch');
    expect(mapOnboardingAuthError(undefined)).toBe('account.errorGeneric');
  });

  it('validates M3U, Xtream, and Stalker source drafts cleanly', () => {
    const m3uEmpty = createInitialOnboardingSourceDraft();
    expect(m3uEmpty.mode).toBe('m3u');
    expect(validateOnboardingSourceDraft(m3uEmpty).ok).toBe(false);

    const m3uOk = validateOnboardingSourceDraft({
      ...m3uEmpty,
      playlistUrl: 'https://iptv.example.test/list.m3u8',
    });
    expect(m3uOk.ok).toBe(true);
    if (m3uOk.ok && m3uOk.value.kind === 'link') {
      expect(m3uOk.value.input.name).toBe('iptv.example.test');
      expect(m3uOk.value.input.url).toBe('https://iptv.example.test/list.m3u8');
    }

    const xtreamBad = validateOnboardingSourceDraft({
      ...m3uEmpty,
      mode: 'xtream',
      server: 'http://panel.example.test:8080',
      username: 'u',
      password: '',
    });
    expect(xtreamBad.ok).toBe(false);

    const xtreamOk = validateOnboardingSourceDraft({
      ...m3uEmpty,
      mode: 'xtream',
      server: 'http://panel.example.test:8080/player_api.php',
      username: 'demo',
      password: ['p', 'w'].join(''),
    });
    expect(xtreamOk.ok).toBe(true);
    if (xtreamOk.ok && xtreamOk.value.kind === 'xtream') {
      expect(xtreamOk.value.input.server).toBe('http://panel.example.test:8080');
      expect(xtreamOk.value.input.name).toBe('panel.example.test:8080');
    }

    const stalkerBad = validateOnboardingSourceDraft({
      ...m3uEmpty,
      mode: 'stalker',
      portalUrl: 'http://portal.example.test/c/',
      macAddress: 'not-a-mac',
    });
    expect(stalkerBad.ok).toBe(false);

    const stalkerOk = validateOnboardingSourceDraft({
      ...m3uEmpty,
      mode: 'stalker',
      portalUrl: 'portal.example.test/c/',
      macAddress: '00:1a:79:aa:bb:cc',
    });
    expect(stalkerOk.ok).toBe(true);
    if (stalkerOk.ok && stalkerOk.value.kind === 'stalker') {
      expect(stalkerOk.value.input.portalUrl).toBe('http://portal.example.test/c/');
      expect(stalkerOk.value.input.mac).toBe('00:1A:79:AA:BB:CC');
    }
  });

  it('computes progress percent, phase labels, quote cycling, layout moves/toggles, and platform tips', () => {
    expect(computeImportPercent(null)).toBeNull();
    expect(computeImportPercent({ phase: 'live', done: 50, total: 200 })).toBe(25);
    expect(computeImportPercent({ phase: 'movies', done: 10 })).toBeNull();
    expect(onboardingPhaseMessageId('categories')).toBe('sources.phase.categories');
    expect(onboardingPhaseMessageId('cleanup')).toBe('sources.phase.cleanup');

    expect(ONBOARDING_QUOTE_KEYS).toHaveLength(6);
    expect(nextQuoteIndex(0)).toBe(1);
    expect(nextQuoteIndex(5)).toBe(0);

    const moved = moveOnboardingLayoutSection(DEFAULT_HOME_LAYOUT, 1, 'up');
    expect(moved[0]?.id).toBe(DEFAULT_HOME_LAYOUT[1]?.id);
    expect(moved[1]?.id).toBe(DEFAULT_HOME_LAYOUT[0]?.id);

    const toggled = toggleOnboardingLayoutSection(DEFAULT_HOME_LAYOUT, 'live');
    expect(toggled.find((s) => s.id === 'live')?.visible).toBe(false);

    expect(resolveTipsMessageKeys('desktop')).toEqual([
      'onboarding.personalize.tipDesktop1',
      'onboarding.personalize.tipDesktop2',
    ]);
    expect(resolveTipsMessageKeys('tv')).toEqual([
      'onboarding.personalize.tipTv1',
      'onboarding.personalize.tipTv2',
    ]);
    expect(resolveTipsMessageKeys('phone')).toEqual([
      'onboarding.personalize.tipMobile1',
      'onboarding.personalize.tipMobile2',
    ]);
    expect(resolveTipsMessageKeys('tablet')).toEqual([
      'onboarding.personalize.tipMobile1',
      'onboarding.personalize.tipMobile2',
    ]);
  });
});
