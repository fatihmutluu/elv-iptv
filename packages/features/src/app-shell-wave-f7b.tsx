import type { CatalogService, SourceRow } from '@elv/data';
import { type MutableRefObject, type ReactElement, useCallback, useMemo, useState } from 'react';
import { AppShellProfileOverlays, type useShellManagementOverlays } from './app-shell-overlays';
import type { useProgrammeReminders } from './app-shell-reminders';
import { AppShellExitToast } from './app-shell-sections';
import { buildShellCrashProps } from './app-shell-state';
import { ChannelManagementOverlay } from './live';
import { ConnectionLimitDialog } from './player/ConnectionLimitDialog';
import {
  ExternalHandoffErrorToast,
  ExternalPlayerPromptOverlay,
} from './player/ExternalPlayerPromptOverlay';
import { useExternalPlayerHandoff } from './player/useExternalPlayerHandoff';
import type { PlayTarget } from './ports/play-target';
import type { DiagnosticsPort, ExternalPlayerPort } from './ports/wave-f7b-ports';
import { ReminderToastBanner } from './reminders';
import { OledScreensaverOverlay, type useOledScreensaver } from './screensaver';
import type { PreferencesContextValue, useConnectionLimitGuard } from './shell';
import { CrashReportPreviewModal } from './shell/CrashReportPreviewModal';
import { GuideManagementOverlay } from './sources/GuideManagementOverlay';

/** Options for {@link useAppShellWaveF7b}. */
export interface UseAppShellWaveF7bOptions {
  readonly catalog: CatalogService;
  readonly preferences: PreferencesContextValue;
  readonly externalPlayer?: ExternalPlayerPort;
  readonly diagnostics?: DiagnosticsPort;
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
 * and `#226` Settings Diagnostic Report preview + crash props) while keeping `AppShell.tsx` under 800 lines.
 */
export function useAppShellWaveF7b(opts: UseAppShellWaveF7bOptions) {
  const [diagnosticsPreviewOpen, setDiagnosticsPreviewOpen] = useState(false);

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

  const openDiagnosticsPreview = useCallback(() => {
    setDiagnosticsPreviewOpen(true);
  }, []);

  const closeDiagnosticsPreview = useCallback(() => {
    setDiagnosticsPreviewOpen(false);
  }, []);

  const toggleIncludeLogs = useCallback(
    (next: boolean) => {
      void opts.preferences.updatePreferences({ crashReportsIncludeLogs: next });
    },
    [opts.preferences],
  );

  const { stageKey, bumpStageKey, clearCaches, switchSource, diagnostics } = opts;
  const { crashReportsOptIn, crashReportsIncludeLogs } = opts.preferences.preferences;

  const crashProps = useMemo(
    () =>
      buildShellCrashProps({
        stageKey,
        bumpStageKey,
        clearCaches,
        switchSource,
        crashReportsOptIn,
        crashReportsIncludeLogs,
        ...(diagnostics !== undefined ? { diagnostics } : {}),
        onToggleIncludeLogs: toggleIncludeLogs,
      }),
    [
      stageKey,
      bumpStageKey,
      clearCaches,
      switchSource,
      crashReportsOptIn,
      crashReportsIncludeLogs,
      diagnostics,
      toggleIncludeLogs,
    ],
  );

  return {
    externalHandoff,
    crashProps,
    diagnosticsPreviewOpen,
    openDiagnosticsPreview: opts.diagnostics !== undefined ? openDiagnosticsPreview : undefined,
    closeDiagnosticsPreview,
    toggleIncludeLogs,
    anyOverlayOpen: externalHandoff.promptTarget !== null || diagnosticsPreviewOpen,
  };
}

/** Renders all `AppShell` root-level overlays (toasts, dialogs, drawers, Wave F7B modals, screensaver). */
export function AppShellRootOverlays(props: {
  readonly exitToastVisible: boolean;
  readonly connectionGuard: ReturnType<typeof useConnectionLimitGuard>;
  readonly mgmtOverlays: ReturnType<typeof useShellManagementOverlays>;
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly onChannelsMutated: () => void;
  readonly onOpenProfilesSettings: () => void;
  readonly reminders: ReturnType<typeof useProgrammeReminders>;
  readonly oledScreensaver: ReturnType<typeof useOledScreensaver>;
  readonly wave: ReturnType<typeof useAppShellWaveF7b>;
  readonly diagnostics?: DiagnosticsPort;
  readonly includeLogs: boolean;
}): ReactElement {
  const {
    exitToastVisible,
    connectionGuard,
    mgmtOverlays,
    catalog,
    sources,
    onChannelsMutated,
    onOpenProfilesSettings,
    reminders,
    oledScreensaver,
    wave,
    diagnostics,
    includeLogs,
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
      <ChannelManagementOverlay
        visible={mgmtOverlays.channelManagerOpen}
        catalog={catalog}
        sources={sources}
        onMutated={onChannelsMutated}
        onClose={mgmtOverlays.closeChannelManager}
      />
      <GuideManagementOverlay
        visible={mgmtOverlays.guideSource !== null}
        source={mgmtOverlays.guideSource}
        catalog={catalog}
        onMutated={onChannelsMutated}
        onClose={mgmtOverlays.closeGuideManager}
      />
      <AppShellProfileOverlays onOpenProfilesSettings={onOpenProfilesSettings} />
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
      {diagnostics !== undefined ? (
        <CrashReportPreviewModal
          visible={wave.diagnosticsPreviewOpen}
          diagnostics={diagnostics}
          errorCode="DIAGNOSTIC_PREVIEW"
          includeLogs={includeLogs}
          onToggleIncludeLogs={wave.toggleIncludeLogs}
          onClose={wave.closeDiagnosticsPreview}
        />
      ) : null}
      <OledScreensaverOverlay state={oledScreensaver.state} onWake={oledScreensaver.wake} />
    </>
  );
}
