import type { CatalogService, ProfileAvatarToken, ProfileRecord, SourceRow } from '@elv/data';
import {
  DEFAULT_PREFERENCES,
  ok,
  type PreferencesPatch,
  type PreferencesSnapshot,
} from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  type FormFactor,
  I18nProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { type ReactElement, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { SyncAccountPort, SyncAccountState } from '../../ports/wave-f9-ports';
import { OnboardingFlowOverlay, type OnboardingFlowOverlayProps } from '../OnboardingFlowOverlay';

const DEFAULT_PROFILE: ProfileRecord = {
  id: 'default',
  name: 'Starlight',
  avatarToken: 'sapphire',
  isKids: false,
  isDefault: true,
  createdAt: 100,
  updatedAt: 200,
};

function createSyncMock(overrides: Partial<SyncAccountPort> = {}): SyncAccountPort {
  const state: SyncAccountState = {
    status: 'signed_out',
    email: null,
    lastSyncedAtIso: null,
    pendingRecoveryCode: null,
    errorCode: null,
  };
  return {
    getState: jest.fn(() => state),
    subscribe: jest.fn(() => () => undefined),
    checkEmail: jest.fn(async () => 'unknown' as const),
    supportedOAuthProviders: [],
    signIn: jest.fn(async () => ({ ok: true })),
    register: jest.fn(async () => ({ ok: true, recoveryCode: 'ELV-REC-1234-5678' })),
    acknowledgeRecoveryCode: jest.fn(),
    syncNow: jest.fn(async () => ({ ok: true })),
    signOut: jest.fn(async () => undefined),
    deleteAccount: jest.fn(async () => ({ ok: true })),
    createQrPairing: jest.fn(),
    pollQrPairing: jest.fn(),
    claimQrPairing: jest.fn(),
    ...overrides,
  };
}

function createCatalogMock(overrides: Partial<CatalogService> = {}): CatalogService {
  const addedRow: SourceRow = {
    id: 'src-new',
    kind: 'm3u',
    name: 'demo.example.test',
    createdAt: 100,
    needsImport: true,
  };
  return {
    listSources: jest.fn(async () => []),
    addSource: jest.fn(async () => ok(addedRow)),
    addSourceFromLink: jest.fn(async () => ok(addedRow)),
    removeSource: jest.fn(async () => ok(undefined)),
    importSource: jest.fn(),
    categories: jest.fn(async () => []),
    items: jest.fn(async () => []),
    seasons: jest.fn(async () => ok([])),
    episodes: jest.fn(async () => []),
    resolveStream: jest.fn(),
    close: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as CatalogService;
}

function wrapProviders(ui: ReactElement, formFactor: FormFactor = 'desktop'): ReactElement {
  return (
    <TvRemoteProvider>
      <ViewportProvider
        value={{
          formFactor,
          orientation: formFactor === 'phone' ? 'portrait' : 'landscape',
          inputModality:
            formFactor === 'tv' ? 'tv' : formFactor === 'desktop' ? 'pointer' : 'touch',
          width: formFactor === 'phone' ? 393 : 1280,
          height: formFactor === 'phone' ? 852 : 800,
        }}
      >
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider reduceMotion>{ui}</ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    </TvRemoteProvider>
  );
}

function StatefulHarness(
  props: Omit<
    OnboardingFlowOverlayProps,
    | 'preferences'
    | 'onUpdatePreferences'
    | 'activeProfile'
    | 'onUpdateProfile'
    | 'renderAvatarPreview'
  > & {
    readonly onPrefsSpy?: (patch: PreferencesPatch) => void;
    readonly onProfileSpy?: (
      id: string,
      patch: { name?: string; avatarToken?: ProfileAvatarToken },
    ) => void;
  },
): ReactElement {
  const { onPrefsSpy, onProfileSpy, ...rest } = props;
  const [prefs, setPrefs] = useState<PreferencesSnapshot>({ ...DEFAULT_PREFERENCES });
  const [profile, setProfile] = useState<ProfileRecord>(DEFAULT_PROFILE);

  return (
    <OnboardingFlowOverlay
      {...rest}
      preferences={prefs}
      onUpdatePreferences={(patch) => {
        onPrefsSpy?.(patch);
        setPrefs((prev) => ({ ...prev, ...patch }) as PreferencesSnapshot);
      }}
      activeProfile={profile}
      onUpdateProfile={(id, patch) => {
        onProfileSpy?.(id, patch);
        setProfile((prev) => ({ ...prev, ...patch }));
      }}
      renderAvatarPreview={({ avatarToken, name, size }) => (
        <View testID={`avatar-preview-${avatarToken}`}>
          <Text>{`${name}:${avatarToken}:${size}`}</Text>
        </View>
      )}
    />
  );
}

describe('OnboardingFlowOverlay Wave E3 regression coverage (#513)', () => {
  it('renders PrivacyPolicyModal as a sibling outside onboarding-focus-guide with D-pad focusable sections on TV', async () => {
    const catalog = createCatalogMock();
    await render(
      wrapProviders(
        <StatefulHarness
          visible
          catalog={catalog}
          importState={{ status: 'idle', sourceId: null, progress: null, errorMessageId: null }}
          onStartImport={jest.fn()}
          onRetryImport={jest.fn()}
          onResetImport={jest.fn()}
          onCommitConsent={jest.fn()}
          onPrepareFreshProfile={jest.fn()}
          onRefreshProfiles={jest.fn(async () => undefined)}
          onComplete={jest.fn()}
        />,
        'tv',
      ),
    );

    await fireEvent.press(screen.getByTestId('onboarding-privacy-policy-link'));
    const modal = screen.getByTestId('onboarding-privacy-modal');
    expect(modal).toBeTruthy();

    let cursor = modal.parent;
    const ancestorTestIds: string[] = [];
    while (cursor !== null) {
      if (typeof cursor.props?.testID === 'string') {
        ancestorTestIds.push(cursor.props.testID);
      }
      cursor = cursor.parent;
    }
    expect(ancestorTestIds).not.toContain('onboarding-focus-guide');
    expect(screen.getByTestId('onboarding-privacy-section-data').props.focusable).toBe(true);
  });

  it('preserves spaces while typing profile name on Card 1 and commits trimmed name on blur/advance', async () => {
    const catalog = createCatalogMock();
    const onProfileSpy = jest.fn();

    await render(
      wrapProviders(
        <StatefulHarness
          visible
          initialStep="personalize"
          initialPersonalizeCard={0}
          catalog={catalog}
          importState={{
            status: 'importing',
            sourceId: 'src-1',
            progress: null,
            errorMessageId: null,
          }}
          onStartImport={jest.fn()}
          onRetryImport={jest.fn()}
          onResetImport={jest.fn()}
          onCommitConsent={jest.fn()}
          onPrepareFreshProfile={jest.fn()}
          onRefreshProfiles={jest.fn(async () => undefined)}
          onComplete={jest.fn()}
          onProfileSpy={onProfileSpy}
        />,
      ),
    );

    const input = screen.getByTestId('onboarding-profile-name-input');
    await fireEvent.changeText(input, 'John');
    await fireEvent.changeText(input, 'John ');
    expect(screen.getByTestId('onboarding-profile-name-input').props.value).toBe('John ');
    expect(onProfileSpy).not.toHaveBeenCalled();

    await fireEvent.changeText(input, 'John Doe');
    expect(screen.getByTestId('onboarding-profile-name-input').props.value).toBe('John Doe');

    await fireEvent(screen.getByTestId('onboarding-profile-name-input'), 'blur');
    expect(onProfileSpy).toHaveBeenCalledWith('default', { name: 'John Doe' });

    onProfileSpy.mockClear();
    await fireEvent.changeText(screen.getByTestId('onboarding-profile-name-input'), '  Jane Roe  ');
    await fireEvent.press(screen.getByTestId('onboarding-next-cta'));
    expect(screen.getByTestId('onboarding-personalize-card-theme')).toBeTruthy();
    expect(onProfileSpy).toHaveBeenCalledWith('default', { name: 'Jane Roe' });
  });

  it('disables competing actions during checkEmail and ignores stale async signIn after reset', async () => {
    let resolveCheck!: (res: 'exists' | 'not_found' | 'unknown') => void;
    let resolveSignIn!: (res: { ok: boolean }) => void;
    const syncAccount = createSyncMock({
      checkEmail: jest.fn(
        () =>
          new Promise<'exists' | 'not_found' | 'unknown'>((resolve) => {
            resolveCheck = resolve;
          }),
      ),
      signIn: jest.fn(
        () =>
          new Promise<{ ok: boolean }>((resolve) => {
            resolveSignIn = resolve;
          }),
      ),
    });
    const onCommitConsent = jest.fn();
    const catalog = createCatalogMock();

    await render(
      wrapProviders(
        <StatefulHarness
          visible
          catalog={catalog}
          syncAccount={syncAccount}
          importState={{ status: 'idle', sourceId: null, progress: null, errorMessageId: null }}
          onStartImport={jest.fn()}
          onRetryImport={jest.fn()}
          onResetImport={jest.fn()}
          onCommitConsent={onCommitConsent}
          onPrepareFreshProfile={jest.fn()}
          onRefreshProfiles={jest.fn(async () => undefined)}
          onComplete={jest.fn()}
          renderTransferPanel={({ onPaired }) => (
            <Pressable testID="mock-transfer-panel" onPress={onPaired} />
          )}
        />,
      ),
    );

    await fireEvent.changeText(screen.getByTestId('onboarding-email-input'), 'race@example.com');
    await fireEvent.press(screen.getByTestId('onboarding-email-continue'));

    expect(screen.getByTestId('onboarding-transfer-btn').props.accessibilityState.disabled).toBe(
      true,
    );
    expect(
      screen.getByTestId('welcome-continue-without-account').props.accessibilityState.disabled,
    ).toBe(true);

    await act(async () => {
      resolveCheck('exists');
      await Promise.resolve();
    });

    await fireEvent.changeText(
      screen.getByTestId('onboarding-password-input'),
      'correct-horse-battery',
    );
    await fireEvent.press(screen.getByTestId('onboarding-signin-submit'));
    await fireEvent.press(screen.getByTestId('onboarding-back-to-email'));

    await act(async () => {
      resolveSignIn({ ok: true });
      await Promise.resolve();
    });

    expect(onCommitConsent).not.toHaveBeenCalled();
    expect(screen.getByTestId('onboarding-email-input')).toBeTruthy();
  });

  it('prevents Screen 3 ELV Mode 1-frame chaos flicker while async preferences update settles', async () => {
    const catalog = createCatalogMock();
    const onUpdatePreferences = jest.fn();
    const buildOverlay = (done: number) =>
      wrapProviders(
        <OnboardingFlowOverlay
          visible
          initialStep="elvMode"
          catalog={catalog}
          preferences={{ ...DEFAULT_PREFERENCES, elvModeEnabled: false }}
          onUpdatePreferences={onUpdatePreferences}
          activeProfile={DEFAULT_PROFILE}
          onUpdateProfile={jest.fn()}
          importState={{
            status: 'importing',
            sourceId: 'src-1',
            progress: { phase: 'live', done, total: 10 },
            errorMessageId: null,
          }}
          onStartImport={jest.fn()}
          onRetryImport={jest.fn()}
          onResetImport={jest.fn()}
          onCommitConsent={jest.fn()}
          onPrepareFreshProfile={jest.fn()}
          onRefreshProfiles={jest.fn(async () => undefined)}
          onComplete={jest.fn()}
          renderAvatarPreview={({ avatarToken }) => <View testID={`av-${avatarToken}`} />}
        />,
      );

    const view = await render(buildOverlay(1));
    expect(onUpdatePreferences).toHaveBeenCalledWith({ elvModeEnabled: true });
    expect(
      screen.getByTestId('onboarding-elv-master-toggle').props.accessibilityState.checked,
    ).toBe(true);

    await view.rerender(buildOverlay(5));
    expect(
      screen.getByTestId('onboarding-elv-master-toggle').props.accessibilityState.checked,
    ).toBe(true);

    await fireEvent.press(screen.getByTestId('onboarding-elv-master-toggle'));
    expect(onUpdatePreferences).toHaveBeenLastCalledWith({ elvModeEnabled: false });
    expect(
      screen.getByTestId('onboarding-elv-master-toggle').props.accessibilityState.checked,
    ).toBe(false);
  });

  it('cleans up orphaned failed source on Browse without source and on replacing via LAN QR', async () => {
    const catalog1 = createCatalogMock();
    const onComplete1 = jest.fn();
    await render(
      wrapProviders(
        <StatefulHarness
          visible
          initialStep="source"
          catalog={catalog1}
          importState={{
            status: 'error',
            sourceId: 'src-failed-1',
            progress: null,
            errorMessageId: 'source.error.timeout',
          }}
          onStartImport={jest.fn()}
          onRetryImport={jest.fn()}
          onResetImport={jest.fn()}
          onCommitConsent={jest.fn()}
          onPrepareFreshProfile={jest.fn()}
          onRefreshProfiles={jest.fn(async () => undefined)}
          onComplete={onComplete1}
        />,
      ),
    );

    await fireEvent.press(screen.getByTestId('onboarding-browse-without-source'));
    expect(catalog1.removeSource).toHaveBeenCalledWith('src-failed-1');
    expect(onComplete1).toHaveBeenCalledWith({ restoredSources: false });

    const catalog2 = createCatalogMock();
    const onStartImport2 = jest.fn();
    await render(
      wrapProviders(
        <StatefulHarness
          visible
          initialStep="source"
          catalog={catalog2}
          hasLanPairing
          renderLanQrOverlay={({ visible, onSourceAdded }) =>
            visible ? (
              <Pressable
                testID="mock-lan-qr-add"
                onPress={() => onSourceAdded('src-lan-replacement')}
              />
            ) : null
          }
          importState={{
            status: 'error',
            sourceId: 'src-failed-2',
            progress: null,
            errorMessageId: 'source.error.timeout',
          }}
          onStartImport={onStartImport2}
          onRetryImport={jest.fn()}
          onResetImport={jest.fn()}
          onCommitConsent={jest.fn()}
          onPrepareFreshProfile={jest.fn()}
          onRefreshProfiles={jest.fn(async () => undefined)}
          onComplete={jest.fn()}
        />,
      ),
    );

    await fireEvent.press(screen.getByTestId('onboarding-source-lan-qr'));
    await fireEvent.press(screen.getByTestId('mock-lan-qr-add'));
    expect(catalog2.removeSource).toHaveBeenCalledWith('src-failed-2');
    expect(onStartImport2).toHaveBeenCalledWith('src-lan-replacement');
  });
});
