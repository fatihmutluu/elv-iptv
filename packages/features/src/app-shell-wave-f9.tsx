import { type ReactElement, useCallback, useEffect, useRef } from 'react';
import { AccountSettingsPanel, useSyncAccountState, WelcomeSyncOverlay } from './account';
import type { AppTab } from './app-shell-state';
import { FeedbackSettingsPanel } from './feedback';
import type { FeedbackPort, SyncAccountPort, TelemetryPort } from './ports/wave-f9-ports';
import type { SettingsPaneSlotProps } from './settings';
import type { PreferencesContextValue } from './shell';

/** Optional Wave F9 port bundle forwarded from `AppShellProps`. */
interface WaveF9Ports {
  readonly syncAccount?: SyncAccountPort | undefined;
  readonly telemetry?: TelemetryPort | undefined;
  readonly feedback?: FeedbackPort | undefined;
}

/** Options for {@link useWaveF9Controller}. */
export interface UseWaveF9ControllerOptions {
  readonly preferences: PreferencesContextValue;
  readonly activeTab: AppTab;
  readonly ports?: WaveF9Ports | undefined;
  readonly syncAccount?: SyncAccountPort | undefined;
  readonly telemetry?: TelemetryPort | undefined;
  readonly feedback?: FeedbackPort | undefined;
}

/** Controller returned by {@link useWaveF9Controller} for `AppShell` Wave F9 wiring. */
export interface WaveF9Controller {
  readonly syncAccount: SyncAccountPort | undefined;
  readonly isWelcomeVisible: boolean;
  readonly dismissWelcome: () => void;
  readonly renderAccount: (slot: SettingsPaneSlotProps) => ReactElement;
  readonly renderFeedback: (slot: SettingsPaneSlotProps) => ReactElement;
}

/**
 * Coordinates Wave F9 features inside `AppShell` (`#26`, `#458`):
 * - Syncs `preferences.telemetryOptIn` into `telemetry.setOptIn(...)`
 * - Records screen/tab transitions when opted in
 * - Controls first-run `WelcomeSyncOverlay` visibility and dismissal
 * - Builds Settings `renderAccount` and `renderFeedback` slot renderers
 */
export function useWaveF9Controller({
  preferences,
  activeTab,
  ports,
  syncAccount: directSyncAccount,
  telemetry: directTelemetry,
  feedback: directFeedback,
}: UseWaveF9ControllerOptions): WaveF9Controller {
  const syncAccount = directSyncAccount ?? ports?.syncAccount;
  const telemetry = directTelemetry ?? ports?.telemetry;
  const feedback = directFeedback ?? ports?.feedback;
  const accountState = useSyncAccountState(syncAccount);
  const telemetryOptIn = preferences.preferences.telemetryOptIn;
  const welcomeDismissed = preferences.preferences.welcomeDismissed;

  useEffect(() => {
    telemetry?.setOptIn(telemetryOptIn);
  }, [telemetry, telemetryOptIn]);

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
    void preferences.updatePreferences({ welcomeDismissed: true });
  }, [preferences]);

  const isWelcomeVisible =
    syncAccount !== undefined &&
    !welcomeDismissed &&
    (accountState.status === 'signed_out' ||
      accountState.status === 'signing_in' ||
      accountState.pendingRecoveryCode !== null);

  const renderAccount = useCallback(
    (slot: SettingsPaneSlotProps): ReactElement => (
      <AccountSettingsPanel {...(syncAccount !== undefined ? { syncAccount } : {})} {...slot} />
    ),
    [syncAccount],
  );

  const renderFeedback = useCallback(
    (slot: SettingsPaneSlotProps): ReactElement => (
      <FeedbackSettingsPanel
        {...(telemetry !== undefined ? { telemetry } : {})}
        {...(feedback !== undefined ? { feedback } : {})}
        preferences={preferences}
        {...slot}
      />
    ),
    [feedback, preferences, telemetry],
  );

  return {
    syncAccount,
    isWelcomeVisible,
    dismissWelcome,
    renderAccount,
    renderFeedback,
  };
}

/** Root overlay mount for Wave F9 (`WelcomeSyncOverlay`, `#26`). */
export function AppShellWaveF9Overlays({
  waveF9,
}: {
  readonly waveF9?: WaveF9Controller | undefined;
}): ReactElement | null {
  if (!waveF9?.isWelcomeVisible || !waveF9.syncAccount) return null;
  return (
    <WelcomeSyncOverlay
      visible={waveF9.isWelcomeVisible}
      syncAccount={waveF9.syncAccount}
      onContinueWithoutAccount={waveF9.dismissWelcome}
    />
  );
}
