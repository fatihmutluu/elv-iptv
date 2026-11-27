import type { CatalogService, ProfileAvatarToken } from '@elv/data';
import type { PreferencesPatch } from '@elv/domain';
import { useI18n } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { AccountBidirectionalPairingPanel } from './account';
import {
  type OnboardingAvatarSlotProps,
  OnboardingFlowOverlay,
  type OnboardingTransferSlotProps,
  resolveStartupGateDecision,
  StartupRefreshOverlay,
} from './onboarding';
import type { LanPairingPort } from './ports/lan-pairing-host';
import type { QrScannerPort, SyncAccountPort, TelemetryPort } from './ports/wave-f9-ports';
import { ProfileAvatarBadge } from './profiles';
import {
  isUntouchedDefaultProfile,
  type ProfileContextValue,
  pickRandomOnboardingProfile,
} from './shared';
import {
  type CatalogUiCache,
  type OnboardingImportCoordinator,
  type PreferencesContextValue,
  type ShellSourcesState,
  type StartupRefreshCoordinator,
  useGuideAutoRefresh,
  useOnboardingImportCoordinator,
  useStartupRefreshCoordinator,
} from './shell';
import { QrPairingOverlay } from './sources';

type OnboardingGatePhase = 'pending' | 'onboarding' | 'returning' | 'completed';

/** Optional host ports consumed by Wave E3 onboarding from `AppShellProps`. */
interface OnboardingHostPorts {
  readonly syncAccount?: SyncAccountPort | undefined;
  readonly telemetry?: TelemetryPort | undefined;
  readonly qrScanner?: QrScannerPort | undefined;
  readonly pendingPairUri?: string | null | undefined;
  readonly onPairUriHandled?: (() => void) | undefined;
  readonly lanPairing?: LanPairingPort | undefined;
}

/** Options for {@link useAppShellOnboarding}. */
export interface UseAppShellOnboardingOptions {
  readonly catalog: CatalogService;
  readonly observedCatalog: CatalogService;
  readonly preferences: PreferencesContextValue;
  readonly profile: ProfileContextValue;
  readonly shell: ShellSourcesState;
  readonly uiCache: CatalogUiCache;
  readonly guideAutoRefreshActive: boolean;
  readonly onEnterHome: () => void;
  readonly onOpenSources: () => void;
  readonly onSuppressAutoProfilePickerChange?: (suppress: boolean) => void;
  readonly ports?: OnboardingHostPorts | undefined;
}

/** Root Wave E3 smart onboarding & returning-user startup controller owned by `AppShell`. */
export interface AppShellOnboardingController {
  readonly startupReady: boolean;
  readonly gatePhase: OnboardingGatePhase;
  readonly isOnboardingVisible: boolean;
  readonly isStartupRefreshOverlayVisible: boolean;
  readonly hasOverlay: boolean;
  readonly suppressLegacyWaveF9Overlays: boolean;
  readonly pauseGuideAutoRefresh: boolean;
  readonly catalog: CatalogService;
  readonly observedCatalog: CatalogService;
  readonly preferences: PreferencesContextValue;
  readonly profile: ProfileContextValue;
  readonly syncAccount?: SyncAccountPort | undefined;
  readonly qrScanner?: QrScannerPort | undefined;
  readonly pendingPairUri?: string | null | undefined;
  readonly onPairUriHandled?: (() => void) | undefined;
  readonly lanPairing?: LanPairingPort | undefined;
  readonly importCoordinator: OnboardingImportCoordinator;
  readonly startupRefresh: StartupRefreshCoordinator;
  readonly onUpdatePreferences: (patch: PreferencesPatch) => void;
  readonly onUpdateProfile: (
    id: string,
    patch: { readonly name?: string; readonly avatarToken?: ProfileAvatarToken },
  ) => void;
  readonly onCommitConsent: (diagnosticsOptIn: boolean) => void;
  readonly onPrepareFreshProfile: () => void;
  readonly onCompleteOnboarding: (result: { readonly restoredSources: boolean }) => void;
}

/**
 * Coordinates Wave E3 Smart First-Run Onboarding, Zero-Blink Startup Gate, Auto-Migration,
 * Quiet Random Profile Assignment, Lifted Background Import, Returning-User Startup Refresh,
 * and `2+` Startup Profile Picker suppression inside `AppShell` (`#513`).
 */
export function useAppShellOnboarding({
  catalog,
  observedCatalog,
  preferences,
  profile,
  shell,
  uiCache,
  guideAutoRefreshActive,
  onEnterHome,
  onOpenSources,
  onSuppressAutoProfilePickerChange,
  ports,
}: UseAppShellOnboardingOptions): AppShellOnboardingController {
  const { sources, sourcesRef, sourcesResolved, syncSourcesAndBump, autoImportedIdsRef } = shell;
  const syncAccount = ports?.syncAccount;
  const telemetry = ports?.telemetry;
  const qrScanner = ports?.qrScanner;
  const pendingPairUri = ports?.pendingPairUri;
  const onPairUriHandled = ports?.onPairUriHandled;
  const lanPairing = ports?.lanPairing;
  const i18n = useI18n();
  const [gatePhase, setGatePhase] = useState<OnboardingGatePhase>('pending');
  const gateEvaluatedRef = useRef(false);
  const assignedRandomProfileRef = useRef(false);
  const sharedRefreshFailureAtRef = useRef<Map<string, number>>(new Map());

  const startupReady = preferences.ready && profile.profilesReady && sourcesResolved;

  useEffect(() => {
    if (!startupReady || gateEvaluatedRef.current) return;
    gateEvaluatedRef.current = true;
    const profilesCount = profile.profiles.length;
    const decision = resolveStartupGateDecision({
      onboardingCompleted: preferences.preferences.onboardingCompleted,
      welcomeDismissed: preferences.preferences.welcomeDismissed,
      sourcesCount: sources.length,
      profilesCount,
    });
    if (decision === 'auto_migrate') {
      void preferences.updatePreferences({
        onboardingCompleted: true,
        welcomeDismissed: true,
        ...(profilesCount >= 2 ? { privacyConsentAnswered: true } : {}),
      });
      setGatePhase('returning');
    } else if (decision === 'onboarding') {
      setGatePhase('onboarding');
    } else {
      setGatePhase('returning');
    }
  }, [
    preferences,
    preferences.preferences.onboardingCompleted,
    preferences.preferences.welcomeDismissed,
    profile.profiles.length,
    sources.length,
    startupReady,
  ]);

  const handleImportOrRefreshComplete = useCallback(async () => {
    uiCache.clear();
    await syncSourcesAndBump();
  }, [syncSourcesAndBump, uiCache]);

  const importCoordinator = useOnboardingImportCoordinator({
    catalog,
    onImportComplete: handleImportOrRefreshComplete,
  });

  const startupRefreshEnabled = gatePhase === 'returning' && startupReady && sources.length > 0;

  const startupRefresh = useStartupRefreshCoordinator({
    catalog,
    sources,
    catalogRefreshHours: preferences.preferences.catalogRefreshHours,
    guideRefreshHours: preferences.preferences.guideRefreshHours,
    enabled: startupRefreshEnabled,
    sharedFailureAtRef: sharedRefreshFailureAtRef,
    onRefreshComplete: handleImportOrRefreshComplete,
  });

  const isOnboardingVisible = gatePhase === 'onboarding';
  const isStartupRefreshOverlayVisible = startupRefresh.state.overlayVisible;
  const waitingForRefreshEval = startupRefreshEnabled && !startupRefresh.state.evaluated;
  const pauseGuideAutoRefresh =
    !startupReady ||
    gatePhase === 'pending' ||
    waitingForRefreshEval ||
    startupRefresh.state.running ||
    isOnboardingVisible ||
    importCoordinator.state.status === 'importing';

  const handleGuideRefreshed = useCallback(() => void syncSourcesAndBump(), [syncSourcesAndBump]);
  useGuideAutoRefresh({
    catalog,
    sources,
    catalogRefreshHours: preferences.preferences.catalogRefreshHours,
    guideRefreshHours: preferences.preferences.guideRefreshHours,
    sessionImportedIdsRef: autoImportedIdsRef,
    sharedFailureAtRef: sharedRefreshFailureAtRef,
    enabled: guideAutoRefreshActive && !pauseGuideAutoRefresh,
    onGuideRefreshed: handleGuideRefreshed,
  });

  const suppressAutoProfilePicker =
    !startupReady ||
    gatePhase === 'pending' ||
    isOnboardingVisible ||
    waitingForRefreshEval ||
    isStartupRefreshOverlayVisible;

  useEffect(() => {
    onSuppressAutoProfilePickerChange?.(suppressAutoProfilePicker);
  }, [onSuppressAutoProfilePickerChange, suppressAutoProfilePicker]);

  const onUpdatePreferences = useCallback(
    (patch: PreferencesPatch) => {
      void preferences.updatePreferences(patch);
    },
    [preferences],
  );

  const onUpdateProfile = useCallback(
    (id: string, patch: { readonly name?: string; readonly avatarToken?: ProfileAvatarToken }) => {
      void profile.updateProfile(id, patch);
    },
    [profile],
  );

  const onCommitConsent = useCallback(
    (diagnosticsOptIn: boolean) => {
      telemetry?.setOptIn(diagnosticsOptIn);
      void preferences.updatePreferences({
        telemetryOptIn: diagnosticsOptIn,
        crashReportsOptIn: diagnosticsOptIn,
        privacyConsentAnswered: true,
        welcomeDismissed: true,
      });
    },
    [preferences, telemetry],
  );

  const onPrepareFreshProfile = useCallback(() => {
    if (assignedRandomProfileRef.current) return;
    if (profile.profiles.length !== 1) return;
    const defaultProfile = profile.profiles.find((p) => p.id === 'default' || p.isDefault);
    if (defaultProfile === undefined || !isUntouchedDefaultProfile(defaultProfile)) return;
    assignedRandomProfileRef.current = true;
    const picked = pickRandomOnboardingProfile({ locale: i18n.locale });
    void profile.updateProfile(defaultProfile.id, {
      name: picked.name,
      avatarToken: picked.avatarToken,
    });
  }, [i18n.locale, profile]);

  const onCompleteOnboarding = useCallback(
    ({ restoredSources }: { readonly restoredSources: boolean }) => {
      void preferences.updatePreferences({
        onboardingCompleted: true,
        welcomeDismissed: true,
        privacyConsentAnswered: true,
      });
      setGatePhase('completed');
      const hasSources =
        restoredSources ||
        importCoordinator.state.status === 'ready' ||
        sourcesRef.current.length > 0;
      if (hasSources) {
        uiCache.clear();
        void syncSourcesAndBump();
        onEnterHome();
      } else {
        onOpenSources();
      }
    },
    [
      importCoordinator.state.status,
      onEnterHome,
      onOpenSources,
      preferences,
      sourcesRef,
      syncSourcesAndBump,
      uiCache,
    ],
  );

  return {
    startupReady,
    gatePhase,
    isOnboardingVisible,
    isStartupRefreshOverlayVisible,
    hasOverlay: isOnboardingVisible || isStartupRefreshOverlayVisible,
    suppressLegacyWaveF9Overlays: gatePhase === 'pending' || isOnboardingVisible,
    pauseGuideAutoRefresh,
    catalog,
    observedCatalog,
    preferences,
    profile,
    syncAccount,
    qrScanner,
    pendingPairUri,
    onPairUriHandled,
    lanPairing,
    importCoordinator,
    startupRefresh,
    onUpdatePreferences,
    onUpdateProfile,
    onCommitConsent,
    onPrepareFreshProfile,
    onCompleteOnboarding,
  };
}

/** Root overlay mount for Wave E3 `OnboardingFlowOverlay` and `StartupRefreshOverlay` (`#513`). */
export function AppShellOnboardingOverlays({
  onboarding,
}: {
  readonly onboarding: AppShellOnboardingController;
}): ReactElement | null {
  const {
    isOnboardingVisible,
    isStartupRefreshOverlayVisible,
    observedCatalog,
    preferences,
    profile,
    syncAccount,
    qrScanner,
    pendingPairUri,
    onPairUriHandled,
    lanPairing,
    importCoordinator,
    startupRefresh,
    onUpdatePreferences,
    onUpdateProfile,
    onCommitConsent,
    onPrepareFreshProfile,
    onCompleteOnboarding,
  } = onboarding;

  const renderTransferPanel = useCallback(
    (slot: OnboardingTransferSlotProps): ReactElement | null => {
      if (syncAccount === undefined) {
        return null;
      }
      return (
        <AccountBidirectionalPairingPanel
          syncAccount={syncAccount}
          active={slot.active}
          onPaired={slot.onPaired}
          legacyTestIDPrefix="welcome-qr"
          {...(qrScanner !== undefined ? { qrScanner } : {})}
          {...(pendingPairUri !== undefined ? { pendingPairUri } : {})}
          {...(onPairUriHandled !== undefined ? { onPairUriHandled } : {})}
        />
      );
    },
    [onPairUriHandled, pendingPairUri, qrScanner, syncAccount],
  );

  const renderAvatarPreview = useCallback(
    (slot: OnboardingAvatarSlotProps): ReactElement => (
      <ProfileAvatarBadge
        name={slot.name}
        avatarToken={slot.avatarToken}
        size={slot.size}
        {...(slot.active !== undefined ? { active: slot.active } : {})}
      />
    ),
    [],
  );

  const renderLanQrOverlay = useCallback(
    (slot: {
      readonly visible: boolean;
      readonly onSourceAdded: (sourceId: string) => void;
      readonly onClose: () => void;
    }): ReactElement | null => {
      if (lanPairing === undefined) return null;
      return (
        <QrPairingOverlay
          visible={slot.visible}
          catalog={observedCatalog}
          lanPairing={lanPairing}
          onSourceAdded={(row) => slot.onSourceAdded(row.id)}
          onClose={slot.onClose}
        />
      );
    },
    [lanPairing, observedCatalog],
  );

  if (!isOnboardingVisible && !isStartupRefreshOverlayVisible) return null;

  return (
    <>
      {isOnboardingVisible ? (
        <OnboardingFlowOverlay
          visible={isOnboardingVisible}
          catalog={observedCatalog}
          preferences={preferences.preferences}
          onUpdatePreferences={onUpdatePreferences}
          activeProfile={profile.activeProfile}
          onUpdateProfile={onUpdateProfile}
          syncAccount={syncAccount}
          pendingPairUri={pendingPairUri}
          importState={importCoordinator.state}
          onStartImport={importCoordinator.startImport}
          onRetryImport={importCoordinator.retryImport}
          onResetImport={importCoordinator.reset}
          onCommitConsent={onCommitConsent}
          onPrepareFreshProfile={onPrepareFreshProfile}
          onRefreshProfiles={profile.refreshProfiles}
          onComplete={onCompleteOnboarding}
          renderTransferPanel={syncAccount !== undefined ? renderTransferPanel : undefined}
          renderAvatarPreview={renderAvatarPreview}
          hasLanPairing={lanPairing !== undefined}
          renderLanQrOverlay={lanPairing !== undefined ? renderLanQrOverlay : undefined}
        />
      ) : null}

      {isStartupRefreshOverlayVisible ? (
        <StartupRefreshOverlay
          visible={isStartupRefreshOverlayVisible}
          activeSourceName={startupRefresh.state.activeSourceName}
          progress={startupRefresh.state.progress}
          completedTasks={startupRefresh.state.completedTasks}
          totalTasks={startupRefresh.state.totalTasks}
          onCancelContinue={startupRefresh.dismissOverlay}
        />
      ) : null}
    </>
  );
}
