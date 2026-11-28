import type { CatalogService } from '@elv/data';
import { type MutableRefObject, type ReactElement, useCallback, useMemo } from 'react';
import { AppShellProfileOverlays, type useShellManagementOverlays } from './app-shell-overlays';
import type { useProgrammeReminders } from './app-shell-reminders';
import { AppShellExitToast } from './app-shell-sections';
import { buildShellCrashProps } from './app-shell-state';
import { AppShellWaveF9Overlays, type WaveF9Controller } from './app-shell-wave-f9';
import { type AppShellDesktopErgonomics, AppShellDesktopOverlays } from './app-shell-wave-q7';
import { ConnectionLimitDialog } from './player/ConnectionLimitDialog';
import {
  ExternalHandoffErrorToast,
  ExternalPlayerPromptOverlay,
} from './player/ExternalPlayerPromptOverlay';
import { useExternalPlayerHandoff } from './player/useExternalPlayerHandoff';
import type { PlayTarget } from './ports/play-target';
import type { DiagnosticsPort, ExternalPlayerPort } from './ports/wave-f7b-ports';
import type { TelemetryPort } from './ports/wave-f9-ports';
import { ReminderToastBanner } from './reminders';
import { OledScreensaverOverlay, type useOledScreensaver } from './screensaver';
import type { PreferencesContextValue, useConnectionLimitGuard } from './shell';
import { GuideManagementOverlay } from './sources/GuideManagementOverlay';

/** Options for {@link useAppShellWaveF7b}. */
export interface UseAppShellWaveF7bOptions {
  readonly catalog: CatalogService;
  readonly preferences: PreferencesContextValue;
  readonly externalPlayer?: ExternalPlayerPort;
  readonly diagnostics?: DiagnosticsPort;
  readonly telemetry?: TelemetryPort;
  readonly stopEmbeddedPreviewRef: MutableRefObject<(() => Promise<void>) | null>;
  readonly stopActivePlayerRef: MutableRefObject<(() => Promise<void>) | null>;
  readonly onOpenIntegrated: (target: PlayTarget) => void;
  readonly onReleaseConnection: () => void;
  readonly onProgressSaved: () => void;
  readonly stageKey: number;
  readonly bumpStageKey: () => void;
  readonly clearCaches: () => void;
  readonly switchSource: () => void;
}

/**
 * Coordinates Wave F7B root-level features for `AppShell` (`#406` External Player handoff
 * and `#226`/`#509` crash boundary telemetry + diagnostics props) while keeping `AppShell.tsx` under 800 lines.
 */
export function useAppShellWaveF7b(opts: UseAppShellWaveF7bOptions) {
  const externalHandoff = useExternalPlayerHandoff({
    mode: opts.preferences.preferences.externalPlayerMode,
    customScheme: opts.preferences.preferences.externalPlayerCustomScheme,
    ...(opts.externalPlayer !== undefined ? { externalPlayer: opts.externalPlayer } : {}),
    catalog: opts.catalog,
    stopEmbeddedPreviewRef: opts.stopEmbeddedPreviewRef,
    stopActivePlayerRef: opts.stopActivePlayerRef,
    onOpenIntegrated: opts.onOpenIntegrated,
    onReleaseConnection: opts.onReleaseConnection,
    onProgressSaved: opts.onProgressSaved,
  });

  const toggleIncludeLogs = useCallback(
    (next: boolean) => {
      void opts.preferences.updatePreferences({ crashReportsIncludeLogs: next });
    },
    [opts.preferences],
  );

  const { stageKey, bumpStageKey, clearCaches, switchSource, diagnostics, telemetry } = opts;
  const { crashReportsOptIn, crashReportsIncludeLogs, telemetryOptIn } =
    opts.preferences.preferences;
  const effectiveCrashReportsOptIn = crashReportsOptIn || telemetryOptIn;

  const crashProps = useMemo(
    () =>
      buildShellCrashProps({
        stageKey,
        bumpStageKey,
        clearCaches,
        switchSource,
        crashReportsOptIn: effectiveCrashReportsOptIn,
        crashReportsIncludeLogs,
        ...(diagnostics !== undefined ? { diagnostics } : {}),
        ...(telemetry !== undefined ? { telemetry } : {}),
        onToggleIncludeLogs: toggleIncludeLogs,
      }),
    [
      stageKey,
      bumpStageKey,
      clearCaches,
      switchSource,
      effectiveCrashReportsOptIn,
      crashReportsIncludeLogs,
      diagnostics,
      telemetry,
      toggleIncludeLogs,
    ],
  );

  return {
    externalHandoff,
    crashProps,
    anyOverlayOpen: externalHandoff.promptTarget !== null,
  };
}

/** Renders all `AppShell` root-level overlays (toasts, dialogs, drawers, Wave F7B/F9/P9 overlays, screensaver). */
export function AppShellRootOverlays(props: {
  readonly exitToastVisible: boolean;
  readonly connectionGuard: ReturnType<typeof useConnectionLimitGuard>;
  readonly mgmtOverlays: ReturnType<typeof useShellManagementOverlays>;
  readonly catalog: CatalogService;
  readonly onChannelsMutated: () => void;
  readonly onOpenProfilesSettings: () => void;
  readonly profileStartInAdd?: boolean;
  readonly onConsumeProfileStartInAdd?: () => void;
  readonly reminders: ReturnType<typeof useProgrammeReminders>;
  readonly oledScreensaver: ReturnType<typeof useOledScreensaver>;
  readonly wave: ReturnType<typeof useAppShellWaveF7b>;
  readonly waveF9?: WaveF9Controller;
  readonly desktopErgonomics?: AppShellDesktopErgonomics;
}): ReactElement {
  const {
    exitToastVisible,
    connectionGuard,
    mgmtOverlays,
    catalog,
    onChannelsMutated,
    onOpenProfilesSettings,
    profileStartInAdd,
    onConsumeProfileStartInAdd,
    reminders,
    oledScreensaver,
    wave,
    waveF9,
    desktopErgonomics,
  } = props;
  return (
    <>
      <AppShellExitToast visible={exitToastVisible} />
      {connectionGuard.pending !== null ? (
        <ConnectionLimitDialog
          check={connectionGuard.pending.check}
          onStopOther={connectionGuard.handleStopOther}
          onCancel={connectionGuard.handleCancel}
          onContinueAnyway={connectionGuard.handleContinueAnyway}
        />
      ) : null}
      <GuideManagementOverlay
        visible={mgmtOverlays.guideSource !== null}
        source={mgmtOverlays.guideSource}
        catalog={catalog}
        onMutated={onChannelsMutated}
        onClose={mgmtOverlays.closeGuideManager}
      />
      <AppShellProfileOverlays
        onOpenProfilesSettings={onOpenProfilesSettings}
        {...(profileStartInAdd !== undefined ? { startInAdd: profileStartInAdd } : {})}
        {...(onConsumeProfileStartInAdd !== undefined
          ? { onConsumeStartInAdd: onConsumeProfileStartInAdd }
          : {})}
      />
      <ReminderToastBanner
        banner={reminders.activeBanner}
        onTune={reminders.tuneActiveBanner}
        onDismiss={reminders.dismissBanner}
      />
      <ExternalPlayerPromptOverlay
        visible={wave.externalHandoff.promptTarget !== null}
        title={wave.externalHandoff.promptTarget?.title ?? ''}
        onChooseIntegrated={wave.externalHandoff.chooseIntegrated}
        onChooseExternal={wave.externalHandoff.chooseExternal}
        onCancel={wave.externalHandoff.cancelPrompt}
      />
      <ExternalHandoffErrorToast visible={wave.externalHandoff.handoffErrorVisible} />
      <AppShellWaveF9Overlays waveF9={waveF9} />
      <AppShellDesktopOverlays
        {...(desktopErgonomics !== undefined ? { desktop: desktopErgonomics } : {})}
      />
      <OledScreensaverOverlay state={oledScreensaver.state} onWake={oledScreensaver.wake} />
    </>
  );
}
