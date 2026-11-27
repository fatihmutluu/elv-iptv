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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { type ReactElement, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { SyncAccountPort, SyncAccountState } from '../../ports/wave-f9-ports';
import { OnboardingFlowOverlay, type OnboardingFlowOverlayProps } from '../OnboardingFlowOverlay';
import type { OnboardingImportSnapshot } from '../onboarding-model';
import { StartupRefreshOverlay } from '../StartupRefreshOverlay';

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

function renderWithProviders(ui: ReactElement, formFactor: FormFactor = 'desktop') {
  return render(
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
    </TvRemoteProvider>,
  );
}

function StatefulOnboardingHarness(
  props: Omit<
    OnboardingFlowOverlayProps,
    | 'preferences'
    | 'onUpdatePreferences'
    | 'activeProfile'
    | 'onUpdateProfile'
    | 'renderAvatarPreview'
  > & {
    readonly initialPrefs?: Partial<PreferencesSnapshot>;
    readonly onPrefsSpy?: (patch: PreferencesPatch) => void;
    readonly onProfileSpy?: (
      id: string,
      patch: { name?: string; avatarToken?: ProfileAvatarToken },
    ) => void;
  },
): ReactElement {
  const { initialPrefs, onPrefsSpy, onProfileSpy, ...rest } = props;
  const [prefs, setPrefs] = useState<PreferencesSnapshot>({
    ...DEFAULT_PREFERENCES,
    ...initialPrefs,
  });
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

interface ImportDriverProps {
  readonly initialImport: OnboardingImportSnapshot;
  readonly catalog: CatalogService;
  readonly initialStep?: OnboardingFlowOverlayProps['initialStep'];
  readonly initialPersonalizeCard?: OnboardingFlowOverlayProps['initialPersonalizeCard'];
  readonly onStartImport?: (sourceId: string) => void;
  readonly onRetryImport?: () => void;
  readonly onComplete: (result: { readonly restoredSources: boolean }) => void;
  readonly onPrefsSpy?: (patch: PreferencesPatch) => void;
  readonly onProfileSpy?: (
    id: string,
    patch: { name?: string; avatarToken?: ProfileAvatarToken },
  ) => void;
  readonly onSetImportReady: (setter: (next: OnboardingImportSnapshot) => void) => void;
}

function OnboardingImportDriver({
  initialImport,
  catalog,
  initialStep,
  initialPersonalizeCard,
  onStartImport,
  onRetryImport,
  onComplete,
  onPrefsSpy,
  onProfileSpy,
  onSetImportReady,
}: ImportDriverProps): ReactElement {
  const [imp, setImp] = useState<OnboardingImportSnapshot>(initialImport);
  onSetImportReady(setImp);
  return (
    <StatefulOnboardingHarness
      visible
      initialStep={initialStep}
      initialPersonalizeCard={initialPersonalizeCard}
      catalog={catalog}
      importState={imp}
      onStartImport={(id) => {
        onStartImport?.(id);
        setImp({
          status: 'importing',
          sourceId: id,
          progress: { phase: 'live', done: 10, total: 50 },
          errorMessageId: null,
        });
      }}
      onRetryImport={onRetryImport ?? jest.fn()}
      onResetImport={jest.fn()}
      onCommitConsent={jest.fn()}
      onPrepareFreshProfile={jest.fn()}
      onRefreshProfiles={jest.fn(async () => undefined)}
      onComplete={onComplete}
      {...(onPrefsSpy !== undefined ? { onPrefsSpy } : {})}
      {...(onProfileSpy !== undefined ? { onProfileSpy } : {})}
      renderTransferPanel={({ onPaired }) => (
        <Pressable testID="mock-transfer-complete" onPress={onPaired} />
      )}
    />
  );
}

describe('OnboardingFlowOverlay & StartupRefreshOverlay', () => {
  it('handles Screen 1 smart email exists -> signIn -> syncing -> exits when sources restored', async () => {
    const syncAccount = createSyncMock({
      checkEmail: jest.fn(async () => 'exists' as const),
    });
    const catalog = createCatalogMock({
      listSources: jest.fn(
        async (): Promise<SourceRow[]> => [
          { id: 's1', kind: 'm3u', name: 'Synced', createdAt: 1, needsImport: false },
        ],
      ),
    });
    const onCommitConsent = jest.fn();
    const onRefreshProfiles = jest.fn(async () => undefined);
    const onComplete = jest.fn();

    await renderWithProviders(
      <StatefulOnboardingHarness
        visible
        catalog={catalog}
        syncAccount={syncAccount}
        importState={{ status: 'idle', sourceId: null, progress: null, errorMessageId: null }}
        onStartImport={jest.fn()}
        onRetryImport={jest.fn()}
        onResetImport={jest.fn()}
        onCommitConsent={onCommitConsent}
        onPrepareFreshProfile={jest.fn()}
        onRefreshProfiles={onRefreshProfiles}
        onComplete={onComplete}
      />,
    );

    expect(screen.getByTestId('welcome-sync-overlay')).toBeTruthy();
    expect(screen.getByTestId('onboarding-welcome-step')).toBeTruthy();
    // OAuth hidden when supportedOAuthProviders is empty
    expect(screen.queryByTestId('onboarding-oauth-google')).toBeNull();
    // Diagnostics toggle starts ON locally, but zero consent persisted before user proceeds!
    expect(
      screen.getByTestId('privacy-consent-telemetry-toggle').props.accessibilityState.checked,
    ).toBe(true);
    expect(onCommitConsent).not.toHaveBeenCalled();

    // Privacy policy modal opens & closes in-tree
    await fireEvent.press(screen.getByTestId('onboarding-privacy-policy-link'));
    expect(screen.getByTestId('onboarding-privacy-modal')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('onboarding-privacy-close'));
    expect(screen.queryByTestId('onboarding-privacy-modal')).toBeNull();

    // User toggles diagnostics OFF before signing in
    await fireEvent.press(screen.getByTestId('privacy-consent-telemetry-toggle'));
    expect(
      screen.getByTestId('privacy-consent-telemetry-toggle').props.accessibilityState.checked,
    ).toBe(false);

    // Smart email check -> exists -> password prompt -> signIn -> syncing -> complete
    await fireEvent.changeText(screen.getByTestId('onboarding-email-input'), 'alice@example.com');
    await fireEvent.press(screen.getByTestId('onboarding-email-continue'));

    await waitFor(() => {
      expect(syncAccount.checkEmail).toHaveBeenCalledWith('alice@example.com');
      expect(screen.getByTestId('onboarding-password-input')).toBeTruthy();
    });

    await fireEvent.changeText(
      screen.getByTestId('onboarding-password-input'),
      'correct-horse-battery',
    );
    await fireEvent.press(screen.getByTestId('onboarding-signin-submit'));

    await waitFor(() => {
      expect(onCommitConsent).toHaveBeenCalledWith(false);
      expect(syncAccount.syncNow).toHaveBeenCalledTimes(1);
      expect(onRefreshProfiles).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith({ restoredSources: true });
    });
  });

  it('handles Screen 1 not_found -> 1-tap create -> recovery code -> straight to Screen 2 (no syncing)', async () => {
    const syncAccount = createSyncMock({
      checkEmail: jest.fn(async () => 'not_found' as const),
    });
    const catalog = createCatalogMock();
    const onPrepareFreshProfile = jest.fn();

    await renderWithProviders(
      <StatefulOnboardingHarness
        visible
        catalog={catalog}
        syncAccount={syncAccount}
        importState={{ status: 'idle', sourceId: null, progress: null, errorMessageId: null }}
        onStartImport={jest.fn()}
        onRetryImport={jest.fn()}
        onResetImport={jest.fn()}
        onCommitConsent={jest.fn()}
        onPrepareFreshProfile={onPrepareFreshProfile}
        onRefreshProfiles={jest.fn(async () => undefined)}
        onComplete={jest.fn()}
      />,
    );

    await fireEvent.changeText(screen.getByTestId('onboarding-email-input'), 'new@example.com');
    await fireEvent.press(screen.getByTestId('onboarding-email-continue'));

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-create-with-email')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('onboarding-create-with-email'));
    await fireEvent.changeText(screen.getByTestId('onboarding-password-input'), 'StrongPass1234');
    await fireEvent.changeText(
      screen.getByTestId('onboarding-confirm-password-input'),
      'StrongPass1234',
    );
    await fireEvent.press(screen.getByTestId('onboarding-signup-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-recovery-banner')).toBeTruthy();
      expect(screen.getByTestId('onboarding-recovery-code')).toHaveTextContent('ELV-REC-1234-5678');
    });

    await fireEvent.press(screen.getByTestId('onboarding-recovery-saved-btn'));
    await waitFor(() => {
      expect(syncAccount.acknowledgeRecoveryCode).toHaveBeenCalledTimes(1);
      expect(onPrepareFreshProfile).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('onboarding-source-step')).toBeTruthy();
    });
    expect(syncAccount.syncNow).not.toHaveBeenCalled();
  });

  it('walks Guest -> Screen 2 -> Screen 3 ELV Mode live preview -> Cards 1-4 -> Waiting -> Auto-Enter & Error Edit preservation', async () => {
    const catalog = createCatalogMock();
    const onStartImport = jest.fn();
    const onRetryImport = jest.fn();
    const onComplete = jest.fn();
    const onPrefsSpy = jest.fn();
    const onProfileSpy = jest.fn();
    let setImportState!: (next: OnboardingImportSnapshot) => void;

    await renderWithProviders(
      <OnboardingImportDriver
        initialImport={{ status: 'idle', sourceId: null, progress: null, errorMessageId: null }}
        catalog={catalog}
        onStartImport={onStartImport}
        onRetryImport={onRetryImport}
        onComplete={onComplete}
        onPrefsSpy={onPrefsSpy}
        onProfileSpy={onProfileSpy}
        onSetImportReady={(setter) => {
          setImportState = setter;
        }}
      />,
    );

    // Guest -> Screen 2
    await fireEvent.press(screen.getByTestId('welcome-continue-without-account'));
    expect(screen.queryByTestId('welcome-sync-overlay')).toBeNull();
    expect(screen.getByTestId('onboarding-source-step')).toBeTruthy();

    // Add M3U source -> starts import & advances immediately to Screen 3 (ELV Mode)
    await fireEvent.changeText(
      screen.getByTestId('onboarding-source-url'),
      'https://demo.example.test/list.m3u8',
    );
    await fireEvent.press(screen.getByTestId('onboarding-source-submit'));

    await waitFor(() => {
      expect(onStartImport).toHaveBeenCalledWith('src-new');
      expect(screen.getByTestId('onboarding-elv-step')).toBeTruthy();
      expect(screen.getByTestId('onboarding-import-bar')).toBeTruthy();
      expect(screen.getByTestId('elv-preview-root')).toBeTruthy();
    });

    // Master toggle starts ON; toggling sub-toggles updates prefs live including smart recommendations
    expect(
      screen.getByTestId('onboarding-elv-master-toggle').props.accessibilityState.checked,
    ).toBe(true);
    expect(screen.getByTestId('onboarding-elv-recs-toggle').props.accessibilityState.checked).toBe(
      true,
    );
    await fireEvent.press(screen.getByTestId('onboarding-elv-recs-toggle'));
    expect(onPrefsSpy).toHaveBeenCalledWith({ elvSmartRecommendations: false });
    await fireEvent.press(screen.getByTestId('onboarding-elv-categories-toggle'));
    expect(onPrefsSpy).toHaveBeenCalledWith({ elvCategorySource: 'provider' });

    // Simulate import error -> Edit source details jumps back to Screen 2 with URL preserved!
    await act(async () => {
      setImportState({
        status: 'error',
        sourceId: 'src-new',
        progress: null,
        errorMessageId: 'source.error.timeout',
      });
    });
    expect(screen.getByTestId('onboarding-import-retry')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('onboarding-import-retry'));
    expect(onRetryImport).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('onboarding-import-edit'));
    expect(screen.getByTestId('onboarding-source-step')).toBeTruthy();
    expect(screen.getByTestId('onboarding-source-url').props.value).toBe(
      'https://demo.example.test/list.m3u8',
    );

    // Re-submit back to Screen 3 -> step through Personalization Cards 1-4 -> Waiting -> Ready auto-enter
    await fireEvent.press(screen.getByTestId('onboarding-source-submit'));
    await waitFor(() => expect(screen.getByTestId('onboarding-elv-step')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('onboarding-next-cta'));
    expect(screen.getByTestId('onboarding-personalize-card-profile')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('onboarding-avatar-emerald'));
    expect(onProfileSpy).toHaveBeenCalledWith('default', { avatarToken: 'emerald' });

    await fireEvent.press(screen.getByTestId('onboarding-next-cta'));
    expect(screen.getByTestId('onboarding-personalize-card-theme')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('onboarding-theme-abyssalSapphire'));
    expect(onPrefsSpy).toHaveBeenCalledWith({ themePreset: 'abyssalSapphire' });

    await fireEvent.press(screen.getByTestId('onboarding-next-cta'));
    expect(screen.getByTestId('onboarding-personalize-card-layout')).toBeTruthy();
    expect(screen.getByTestId('onboarding-layout-preview')).toBeTruthy();

    // When import finishes on Card 3, CTA switches to green Enter App + Continue customizing
    await act(async () => {
      setImportState({
        status: 'ready',
        sourceId: 'src-new',
        progress: null,
        errorMessageId: null,
      });
    });
    expect(screen.getByTestId('onboarding-enter-app-cta')).toBeTruthy();
    expect(screen.getByTestId('onboarding-continue-customizing')).toBeTruthy();

    // Clicking Continue customizing proceeds to Card 4 (Platform Quick Tips)
    await fireEvent.press(screen.getByTestId('onboarding-continue-customizing'));
    expect(screen.getByTestId('onboarding-personalize-card-tips')).toBeTruthy();
    expect(screen.getByTestId('onboarding-tip-1')).toBeTruthy();
    expect(screen.getByTestId('onboarding-tip-2')).toBeTruthy();

    // Enter App completes onboarding
    await fireEvent.press(screen.getByTestId('onboarding-enter-app-cta'));
    expect(onComplete).toHaveBeenCalledWith({ restoredSources: false });
  });

  it('transitions to OnboardingWaitingStage after Card 4 when still importing and auto-enters when ready', async () => {
    const catalog = createCatalogMock();
    const onComplete = jest.fn();
    let setImportState!: (next: OnboardingImportSnapshot) => void;

    await renderWithProviders(
      <OnboardingImportDriver
        initialImport={{
          status: 'importing',
          sourceId: 'src-new',
          progress: { phase: 'movies', done: 25, total: 100 },
          errorMessageId: null,
        }}
        initialStep="personalize"
        initialPersonalizeCard={3}
        catalog={catalog}
        onComplete={onComplete}
        onSetImportReady={(setter) => {
          setImportState = setter;
        }}
      />,
    );
    expect(screen.getByTestId('onboarding-personalize-card-tips')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('onboarding-next-cta'));
    expect(screen.getByTestId('onboarding-waiting-stage')).toBeTruthy();
    expect(screen.getByTestId('onboarding-waiting-quote')).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();

    await act(async () => {
      setImportState({
        status: 'ready',
        sourceId: 'src-new',
        progress: null,
        errorMessageId: null,
      });
    });

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith({ restoredSources: false });
    });
  });

  it('renders StartupRefreshOverlay with progress, quote, and Cancel / Continue with old data', async () => {
    const onCancel = jest.fn();
    await renderWithProviders(
      <StartupRefreshOverlay
        visible
        activeSourceName="Main Provider"
        progress={{ phase: 'live', done: 50, total: 100 }}
        completedTasks={0}
        totalTasks={2}
        onCancelContinue={onCancel}
      />,
    );

    expect(screen.getByTestId('startup-refresh-overlay')).toBeTruthy();
    expect(screen.getByTestId('startup-refresh-quote')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('startup-refresh-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('supports checkEmail unknown fallback, OAuth provider seam, Transfer panel -> 0-source Screen 2, and Xtream/Stalker forms', async () => {
    const syncAccount = createSyncMock({
      checkEmail: jest.fn(async () => {
        throw new Error('offline');
      }),
      supportedOAuthProviders: ['google', 'apple'],
      signInWithOAuth: jest.fn(async () => ({ ok: true })),
    });
    const catalog = createCatalogMock({ listSources: jest.fn(async () => []) });
    const onStartImport = jest.fn();

    await renderWithProviders(
      <StatefulOnboardingHarness
        visible
        catalog={catalog}
        syncAccount={syncAccount}
        importState={{ status: 'idle', sourceId: null, progress: null, errorMessageId: null }}
        onStartImport={onStartImport}
        onRetryImport={jest.fn()}
        onResetImport={jest.fn()}
        onCommitConsent={jest.fn()}
        onPrepareFreshProfile={jest.fn()}
        onRefreshProfiles={jest.fn(async () => undefined)}
        onComplete={jest.fn()}
        renderTransferPanel={({ onPaired }) => (
          <Pressable testID="mock-transfer-paired" onPress={onPaired} />
        )}
      />,
    );

    // OAuth buttons appear when supportedOAuthProviders is populated
    expect(screen.getByTestId('onboarding-oauth-google')).toBeTruthy();
    expect(screen.getByTestId('onboarding-oauth-apple')).toBeTruthy();

    // Offline checkEmail falls back to 'unknown' -> password + 1-tap Create button
    await fireEvent.changeText(screen.getByTestId('onboarding-email-input'), 'offline@example.com');
    await fireEvent.press(screen.getByTestId('onboarding-email-continue'));
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-password-input')).toBeTruthy();
      expect(screen.getByTestId('onboarding-create-with-email')).toBeTruthy();
    });

    // Return to entry -> open Transfer -> pair -> Syncing with 0 sources -> advances to Screen 2
    await fireEvent.press(screen.getByTestId('onboarding-back-to-email'));
    await fireEvent.press(screen.getByTestId('onboarding-transfer-btn'));
    await fireEvent.press(screen.getByTestId('mock-transfer-paired'));
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-source-step')).toBeTruthy();
    });

    // Switch to Xtream tab and submit
    await fireEvent.press(screen.getByTestId('onboarding-source-tab-xtream'));
    await fireEvent.changeText(
      screen.getByTestId('onboarding-source-server'),
      'http://panel.example.test:8080',
    );
    await fireEvent.changeText(screen.getByTestId('onboarding-source-username'), 'demo');
    await fireEvent.changeText(
      screen.getByTestId('onboarding-source-password'),
      ['de', 'mo'].join(''),
    );
    await fireEvent.press(screen.getByTestId('onboarding-source-submit'));
    await waitFor(() => {
      expect(onStartImport).toHaveBeenCalledWith('src-new');
      expect(screen.getByTestId('onboarding-elv-step')).toBeTruthy();
    });
  });
});
