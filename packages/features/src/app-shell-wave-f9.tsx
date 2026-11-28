import { type ReactElement, useCallback, useEffect, useRef } from 'react';
import { AccountSettingsPanel, useSyncAccountState, WelcomeSyncOverlay } from './account';
import type { AppTab } from './app-shell-state';
import { usePlaybackAutoSyncHooks } from './app-shell-sync-hooks';
import { FeedbackSettingsPanel } from './feedback';
import type {
  FeedbackPort,
  QrScannerPort,
  SyncAccountPort,
  TelemetryPort,
} from './ports/wave-f9-ports';
import type { SettingsPaneSlotProps } from './settings';
import { type PreferencesContextValue, PrivacyConsentOverlay } from './shell';

/** Optional Wave F9 / P9 port bundle forwarded from `AppShellProps`. */
interface WaveF9Ports {
  readonly syncAccount?: SyncAccountPort | undefined;
  readonly telemetry?: TelemetryPort | undefined;
  readonly feedback?: FeedbackPort | undefined;
  readonly qrScanner?: QrScannerPort | undefined;
  readonly pendingPairUri?: string | null | undefined;
  readonly onPairUriHandled?: (() => void) | undefined;
}

/** Options for {@link useWaveF9Controller}. */
export interface UseWaveF9ControllerOptions {
  readonly preferences: PreferencesContextValue;
  readonly activeTab: AppTab;
  readonly ports?: WaveF9Ports | undefined;
  readonly syncAccount?: SyncAccountPort | undefined;
  readonly telemetry?: TelemetryPort | undefined;
  readonly feedback?: FeedbackPort | undefined;
  readonly isViewingActive?: boolean | undefined;
  readonly hasPlayerTarget?: boolean | undefined;
  readonly onOpenAccountSettings?: (() => void) | undefined;
  /** Suppresses legacy `WelcomeSyncOverlay` when Wave E3 `OnboardingFlowOverlay` owns first-run auth (`#513`). */
  readonly suppressWelcomeOverlay?: boolean | undefined;
  /** Suppresses standalone `PrivacyConsentOverlay` while startup gate or Wave E3 onboarding is active (`#513`). */
  readonly suppressFirstRunOverlays?: boolean | undefined;
}

/** Controller returned by {@link useWaveF9Controller} for `AppShell` Wave F9 / P9 wiring. */
export interface WaveF9Controller {
  readonly syncAccount: SyncAccountPort | undefined;
  readonly isAccountSignedIn: boolean;
  readonly signOutAccount: () => Promise<void>;
  readonly isWelcomeVisible: boolean;
  readonly isPrivacyConsentVisible: boolean;
  readonly hasOverlay: boolean;
  readonly telemetryOptIn: boolean;
  readonly qrScanner: QrScannerPort | undefined;
  readonly pendingPairUri: string | null | undefined;
  readonly onPairUriHandled: (() => void) | undefined;
  readonly dismissWelcome: () => void;
  readonly onWelcomeToggleTelemetry: (next: boolean) => void;
  readonly onTelemetryOptInChange: (next: boolean) => void;
  readonly onCompletePrivacyConsent: (optedIn: boolean) => void;
  readonly notifyPlaybackExitOrSwitch: () => void;
  readonly renderAccount: (slot: SettingsPaneSlotProps) => ReactElement;
  readonly renderFeedback: (slot: SettingsPaneSlotProps) => ReactElement;
}

/**
 * Coordinates Wave F9 & Wave P9 features inside `AppShell` (`#26`, `#458`, `#509`, `#510`):
 * - Syncs unified `preferences.telemetryOptIn` into `telemetry.setOptIn(...)`
 * - Records screen/tab transitions when opted in
 * - Controls first-run `WelcomeSyncOverlay` (with embedded Privacy & Diagnostics toggle)
 *   and standalone `PrivacyConsentOverlay` for upgrading users
 * - Routes incoming `pendingPairUri` deep links into Account pairing
 * - Coordinates automatic background sync playback triggers
 * - Builds Settings `renderAccount` and `renderFeedback` slot renderers
 */
export function useWaveF9Controller({
  preferences,
  activeTab,
  ports,
  syncAccount: directSyncAccount,
  telemetry: directTelemetry,
  feedback: directFeedback,
  isViewingActive = false,
  hasPlayerTarget = false,
  onOpenAccountSettings,
  suppressWelcomeOverlay = false,
  suppressFirstRunOverlays = false,
}: UseWaveF9ControllerOptions): WaveF9Controller {
  const syncAccount = directSyncAccount ?? ports?.syncAccount;
  const telemetry = directTelemetry ?? ports?.telemetry;
  const feedback = directFeedback ?? ports?.feedback;
  const qrScanner = ports?.qrScanner;
  const pendingPairUri = ports?.pendingPairUri;
  const onPairUriHandled = ports?.onPairUriHandled;

  const accountState = useSyncAccountState(syncAccount);
  const telemetryOptIn =
    preferences.preferences.telemetryOptIn || preferences.preferences.crashReportsOptIn;
  const welcomeDismissed = preferences.preferences.welcomeDismissed;
  const privacyConsentAnswered = preferences.preferences.privacyConsentAnswered;

  useEffect(() => {
    telemetry?.setOptIn(telemetryOptIn);
  }, [telemetry, telemetryOptIn]);

  usePlaybackAutoSyncHooks({
    syncAccount,
    isViewingActive,
    hasPlayerTarget,
  });

  const prevTabRef = useRef<AppTab>(activeTab);
  const tabEnteredAtRef = useRef<number>(Date.now());
  useEffect(() => {
    if (prevTabRef.current === activeTab) return;
    prevTabRef.current = activeTab;
    const now = Date.now();
    const durationMs = Math.max(0, now - tabEnteredAtRef.current);
    tabEnteredAtRef.current = now;
    if (telemetryOptIn && telemetry !== undefined) {
      telemetry.recordScreenTransition(activeTab, durationMs);
    }
  }, [activeTab, telemetry, telemetryOptIn]);

  const dismissWelcome = useCallback(() => {
    void preferences.updatePreferences({
      welcomeDismissed: true,
      privacyConsentAnswered: true,
    });
  }, [preferences]);

  const onWelcomeToggleTelemetry = useCallback(
    (next: boolean) => {
      telemetry?.setOptIn(next);
      void preferences.updatePreferences({
        telemetryOptIn: next,
        crashReportsOptIn: next,
      });
    },
    [preferences, telemetry],
  );

  const onTelemetryOptInChange = useCallback(
    (next: boolean) => {
      telemetry?.setOptIn(next);
    },
    [telemetry],
  );

  const onCompletePrivacyConsent = useCallback(
    (optedIn: boolean) => {
      telemetry?.setOptIn(optedIn);
      void preferences.updatePreferences({
        telemetryOptIn: optedIn,
        crashReportsOptIn: optedIn,
        privacyConsentAnswered: true,
      });
    },
    [preferences, telemetry],
  );

  const notifyPlaybackExitOrSwitch = useCallback(() => {
    syncAccount?.notifyPlaybackExitOrSwitch?.();
  }, [syncAccount]);

  const isWelcomeVisible =
    !suppressWelcomeOverlay &&
    !suppressFirstRunOverlays &&
    !preferences.preferences.onboardingCompleted &&
    syncAccount !== undefined &&
    !welcomeDismissed &&
    (accountState.status === 'signed_out' ||
      accountState.status === 'signing_in' ||
      accountState.pendingRecoveryCode !== null);

  const isPrivacyConsentVisible =
    !suppressFirstRunOverlays &&
    preferences.ready &&
    !privacyConsentAnswered &&
    telemetry !== undefined &&
    !isWelcomeVisible;

  const lastRoutedPairUriRef = useRef<string | null>(null);
  const onOpenAccountRef = useRef(onOpenAccountSettings);
  onOpenAccountRef.current = onOpenAccountSettings;
  useEffect(() => {
    if (!pendingPairUri || pendingPairUri.trim().length === 0) {
      lastRoutedPairUriRef.current = null;
      return;
    }
    if (isWelcomeVisible || suppressFirstRunOverlays) return;
    if (lastRoutedPairUriRef.current === pendingPairUri) return;
    lastRoutedPairUriRef.current = pendingPairUri;
    onOpenAccountRef.current?.();
  }, [isWelcomeVisible, pendingPairUri, suppressFirstRunOverlays]);

  const renderAccount = useCallback(
    (slot: SettingsPaneSlotProps): ReactElement => (
      <AccountSettingsPanel
        {...(syncAccount !== undefined ? { syncAccount } : {})}
        {...(qrScanner !== undefined ? { qrScanner } : {})}
        {...(pendingPairUri !== undefined ? { pendingPairUri } : {})}
        {...(onPairUriHandled !== undefined ? { onPairUriHandled } : {})}
        {...slot}
      />
    ),
    [onPairUriHandled, pendingPairUri, qrScanner, syncAccount],
  );

  const renderFeedback = useCallback(
    (slot: SettingsPaneSlotProps): ReactElement => (
      <FeedbackSettingsPanel {...(feedback !== undefined ? { feedback } : {})} {...slot} />
    ),
    [feedback],
  );

  const isAccountSignedIn =
    accountState.status === 'signed_in' || accountState.status === 'syncing';
  const signOutAccount = useCallback(async () => {
    await syncAccount?.signOut();
  }, [syncAccount]);

  return {
    syncAccount,
    isAccountSignedIn,
    signOutAccount,
    isWelcomeVisible,
    isPrivacyConsentVisible,
    hasOverlay: isWelcomeVisible || isPrivacyConsentVisible,
    telemetryOptIn,
    qrScanner,
    pendingPairUri,
    onPairUriHandled,
    dismissWelcome,
    onWelcomeToggleTelemetry,
    onTelemetryOptInChange,
    onCompletePrivacyConsent,
    notifyPlaybackExitOrSwitch,
    renderAccount,
    renderFeedback,
  };
}

/** Root overlay mount for Wave F9 / P9 (`WelcomeSyncOverlay` & `PrivacyConsentOverlay`). */
export function AppShellWaveF9Overlays({
  waveF9,
}: {
  readonly waveF9?: WaveF9Controller | undefined;
}): ReactElement | null {
  if (!waveF9) return null;
  return (
    <>
      {waveF9.isWelcomeVisible && waveF9.syncAccount !== undefined ? (
        <WelcomeSyncOverlay
          visible={waveF9.isWelcomeVisible}
          syncAccount={waveF9.syncAccount}
          telemetryOptIn={waveF9.telemetryOptIn}
          onToggleTelemetryOptIn={waveF9.onWelcomeToggleTelemetry}
          onContinueWithoutAccount={waveF9.dismissWelcome}
          {...(waveF9.qrScanner !== undefined ? { qrScanner: waveF9.qrScanner } : {})}
          {...(waveF9.pendingPairUri !== undefined
            ? { pendingPairUri: waveF9.pendingPairUri }
            : {})}
          {...(waveF9.onPairUriHandled !== undefined
            ? { onPairUriHandled: waveF9.onPairUriHandled }
            : {})}
        />
      ) : null}
      {waveF9.isPrivacyConsentVisible ? (
        <PrivacyConsentOverlay
          visible={waveF9.isPrivacyConsentVisible}
          initialOptIn={waveF9.telemetryOptIn}
          onComplete={waveF9.onCompletePrivacyConsent}
        />
      ) : null}
    </>
  );
}
