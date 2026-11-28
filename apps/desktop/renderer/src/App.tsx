import { createCoalescedCatalog } from '@elv/data';
import {
  extractSyncablePreferences,
  type PreferencesSnapshot,
  type ProfilePreferencesManager,
} from '@elv/domain';
import {
  type AppLifecyclePort,
  type AppLifecycleState,
  AppProviders,
  AppShell,
  type AppShellProps,
  createLazyCatalog,
  type DesktopWindowPort,
  type DiagnosticsPort,
  type LanPairingPort,
  type ReminderHostPort,
  type SourceImportHost,
  type ThermalDevicePort,
  type VideoHost,
} from '@elv/features';
import { createAppI18n, resolveLocale } from '@elv/i18n';
import { UiAdaptersProvider } from '@elv/ui-kit';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { WindowBridge } from '../../src/shared/window-ipc.ts';
import { attachAccessibilityFonts } from './accessibility-fonts.ts';
import { attachMouseBackGuard } from './browser-back.ts';
import {
  attemptCatalogReconnect,
  CatalogCrashBanner,
  subscribeCatalogDisconnected,
} from './CatalogCrashBanner.tsx';
import { createDesktopCatalog } from './catalog/index.ts';
import { createDesktopDiagnosticsPort } from './diagnostics-port.ts';
import { createDesktopDownloadsPort } from './downloads/desktop-downloads-port.ts';
import { GateScreen } from './gate/GateScreen.tsx';
import { resolveGate } from './gate/params.ts';
import { createDesktopLanPairingPort } from './lan-pairing/adapter.ts';
import { createDesktopVideoHost } from './player/desktop-video-host.tsx';
import { PopoutApp } from './popout/PopoutApp.tsx';
import {
  createDesktopThermalDevicePort,
  createDesktopWindowPort,
  isPopoutSearch,
} from './popout/popout-controller.ts';
import { createDesktopReminderHost } from './reminders/adapter.ts';
import { attachScrollBlurGuard } from './scroll-blur-guard.ts';
import { createDesktopKeymapStore } from './storage/keymap.ts';
import { createDesktopPreferencesStore } from './storage/preferences.ts';
import {
  createDesktopSyncPorts,
  type DesktopFeedbackPort,
  type DesktopSyncAccountPort,
  type DesktopTelemetryPort,
  extractSafeRendererErrorSignature,
} from './sync/desktop-sync-ports.ts';
import { createDesktopTrailerExternalPort } from './trailer-external-port.ts';
import { attachDeadHostOnlineReset, createDesktopUiAdapters } from './ui/desktop-adapters.tsx';
import { shouldMountWorkbench } from './workbench/presets.ts';

declare const __DEV__: boolean;

// Computed once: a re-render must never hand the gate new params, which would restart the run. Main loads the query only
// for an unpackaged `--elv-gate=` launch, and the preload flags gate mode; a page with just the query gets no gate.
const GATE = resolveGate(window.location.search, window.elv);
const IS_POPOUT = GATE === undefined && isPopoutSearch(window.location.search);
const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;
const MOUNT_WORKBENCH =
  IS_DEV &&
  !IS_POPOUT &&
  shouldMountWorkbench({
    isDev: IS_DEV,
    hasGate: GATE !== undefined,
    hasElectronBridge: window.elv !== undefined,
    search: window.location.search,
  });
const WorkbenchShell = IS_DEV
  ? lazy(() =>
      import('./workbench/WorkbenchShell.tsx').then((m) => ({ default: m.WorkbenchShell })),
    )
  : null;

interface VisibilityDocumentLike {
  readonly visibilityState?: string;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

/**
 * Builds the desktop {@link AppLifecyclePort} combining Electron tray hide/restore IPC and
 * DOM `visibilitychange` so minimizing or hiding to tray triggers immediate parental relock.
 */
export function createDesktopAppLifecyclePort(
  windowBridge: Pick<WindowBridge, 'onHiddenToTray' | 'onWindowRestored'> | undefined,
  doc: VisibilityDocumentLike | undefined = typeof document === 'undefined' ? undefined : document,
): AppLifecyclePort {
  return {
    subscribe(listener) {
      let lastState: AppLifecycleState | undefined;
      const emit = (next: AppLifecycleState): void => {
        if (next === lastState) return;
        lastState = next;
        listener(next);
      };
      const offHidden =
        typeof windowBridge?.onHiddenToTray === 'function'
          ? windowBridge.onHiddenToTray(() => emit('background'))
          : undefined;
      const offRestored =
        typeof windowBridge?.onWindowRestored === 'function'
          ? windowBridge.onWindowRestored(() => emit('active'))
          : undefined;
      const onVisibilityChange = (): void => {
        emit(doc?.visibilityState === 'hidden' ? 'background' : 'active');
      };
      if (
        doc !== undefined &&
        typeof doc.addEventListener === 'function' &&
        typeof doc.removeEventListener === 'function'
      ) {
        doc.addEventListener('visibilitychange', onVisibilityChange);
      }
      return () => {
        offHidden?.();
        offRestored?.();
        if (doc !== undefined && typeof doc.removeEventListener === 'function') {
          doc.removeEventListener('visibilitychange', onVisibilityChange);
        }
      };
    },
  };
}

function AppRoot() {
  const [refreshToken, setRefreshToken] = useState(0);
  const [catalogDisconnected, setCatalogDisconnected] = useState(false);
  const [reconnectingCatalog, setReconnectingCatalog] = useState(false);
  const [pendingPairUri, setPendingPairUri] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const reconnectingRef = useRef(false);

  const systemLocale = useMemo(() => {
    const languages = typeof navigator === 'undefined' ? [] : navigator.languages;
    return resolveLocale(languages);
  }, []);

  const preferencesStore = useMemo(() => createDesktopPreferencesStore(), []);
  const keymapStore = useMemo(() => createDesktopKeymapStore(), []);
  const uiAdapters = useMemo(() => createDesktopUiAdapters(), []);

  const catalog = useMemo(
    () =>
      createCoalescedCatalog(
        createLazyCatalog(() => createDesktopCatalog()),
        { windowMs: 500 },
      ),
    [],
  );

  const desktopSync = useMemo(() => createDesktopSyncPorts(window.elv), []);

  const videoHost = useMemo<VideoHost>(
    () => createDesktopVideoHost({ telemetry: desktopSync.telemetry }),
    [desktopSync.telemetry],
  );

  const desktopWindow = useMemo<DesktopWindowPort | undefined>(
    () => createDesktopWindowPort(window.elv?.window),
    [],
  );

  const appLifecycle = useMemo<AppLifecyclePort>(
    () => createDesktopAppLifecyclePort(window.elv?.window),
    [],
  );

  const thermalDevice = useMemo<ThermalDevicePort>(() => createDesktopThermalDevicePort(), []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const bridge = window.elv?.catalog;
    if (!bridge || typeof bridge.onChanged !== 'function') return;
    return bridge.onChanged(() => {
      setRefreshToken((n) => n + 1);
    });
  }, []);

  useEffect(() => {
    return subscribeCatalogDisconnected(window.elv?.catalog, () => {
      setCatalogDisconnected(true);
    });
  }, []);

  const handleReconnectCatalog = useCallback(() => {
    if (reconnectingRef.current) return;
    reconnectingRef.current = true;
    setReconnectingCatalog(true);
    void attemptCatalogReconnect(window.elv?.catalog).then((reconnected) => {
      reconnectingRef.current = false;
      if (!mountedRef.current) return;
      setReconnectingCatalog(false);
      if (reconnected) {
        setCatalogDisconnected(false);
        setRefreshToken((n) => n + 1);
      }
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    return attachMouseBackGuard(window);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    return attachScrollBlurGuard(window);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    return attachDeadHostOnlineReset(window);
  }, []);

  useEffect(() => {
    const windowBridge = window.elv?.window;
    if (!windowBridge || typeof windowBridge.setAspectRatioLock !== 'function') return;
    let active = true;
    let lastSent: boolean | undefined;
    const syncLock = (enabled: boolean): void => {
      if (!active || lastSent === enabled) return;
      lastSent = enabled;
      void windowBridge.setAspectRatioLock(enabled).catch(() => undefined);
    };
    void preferencesStore.load().then((snap) => syncLock(snap.windowAspectRatioLock));
    const unsubscribe = preferencesStore.subscribe((snap) => syncLock(snap.windowAspectRatioLock));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [preferencesStore]);

  useEffect(() => {
    const windowBridge = window.elv?.window;
    if (!windowBridge || typeof windowBridge.setMinimizeToTray !== 'function') return;
    let active = true;
    let lastSent: string | undefined;
    const trayI18n = createAppI18n(systemLocale);
    const syncTray = (enabled: boolean, localePref: string): void => {
      const resolved = localePref === 'system' ? systemLocale : resolveLocale([localePref]);
      trayI18n.setLocale(resolved);
      const labels = {
        restore: trayI18n.t('desktop.tray.restore'),
        quit: trayI18n.t('desktop.tray.quit'),
      };
      const key = `${enabled ? '1' : '0'}|${labels.restore}|${labels.quit}`;
      if (!active || lastSent === key) return;
      lastSent = key;
      void windowBridge.setMinimizeToTray(enabled, labels).catch(() => undefined);
    };
    void preferencesStore.load().then((snap) => syncTray(snap.minimizeToTray, snap.locale));
    const unsubscribe = preferencesStore.subscribe((snap) =>
      syncTray(snap.minimizeToTray, snap.locale),
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [preferencesStore, systemLocale]);

  useEffect(() => {
    const windowBridge = window.elv?.window;
    if (!windowBridge || typeof windowBridge.onWindowRestored !== 'function') return;
    return windowBridge.onWindowRestored(() => {
      if (typeof document !== 'undefined' && document.body) {
        document.body.style.cursor = '';
      }
    });
  }, []);

  const sourceImportHost = useMemo<SourceImportHost | undefined>(() => {
    const sourcesBridge = window.elv?.sources;
    if (!sourcesBridge) return undefined;
    return {
      readClipboardText: () => sourcesBridge.readClipboardText(),
      pickPlaylistFile: () => sourcesBridge.pickPlaylistFile(),
      ...(typeof sourcesBridge.consumePendingPlaylistFiles === 'function'
        ? {
            consumePendingPlaylistFiles: () => sourcesBridge.consumePendingPlaylistFiles(),
          }
        : {}),
      ...(typeof sourcesBridge.onOpenPlaylistFile === 'function'
        ? {
            onOpenPlaylistFile: (listener) => sourcesBridge.onOpenPlaylistFile(listener),
          }
        : {}),
    };
  }, []);

  const lanPairing = useMemo<LanPairingPort | undefined>(
    () => createDesktopLanPairingPort(window.elv?.lanPairing),
    [],
  );

  const reminderHost = useMemo<ReminderHostPort>(() => createDesktopReminderHost(), []);

  const diagnostics = useMemo<DiagnosticsPort>(
    () => createDesktopDiagnosticsPort(window.elv?.diagnostics),
    [],
  );

  const downloadManager = useMemo(() => createDesktopDownloadsPort(window.elv?.downloads), []);
  const trailerExternal = useMemo(() => createDesktopTrailerExternalPort(window.elv?.window), []);

  useEffect(() => {
    let active = true;
    let lastServerUrl: string | undefined;
    let lastTelemetryOptIn: boolean | undefined;
    let lastSyncableJson: string | undefined;
    let startupRecorded = false;
    const syncPrefs = (snap: PreferencesSnapshot): void => {
      if (!active) return;
      // Never clobber baked __ELV_SYNC_SERVER_URL__ with an empty preference override (#510).
      const trimmedUrl = snap.syncServerUrl.trim();
      if (trimmedUrl.length > 0 && lastServerUrl !== trimmedUrl) {
        lastServerUrl = trimmedUrl;
        void desktopSync.setServerUrl(trimmedUrl);
      }
      const effectiveTelemetryOptIn = Boolean(snap.telemetryOptIn || snap.crashReportsOptIn);
      if (lastTelemetryOptIn !== effectiveTelemetryOptIn) {
        lastTelemetryOptIn = effectiveTelemetryOptIn;
        if (desktopSync.telemetry?.isOptedIn() !== effectiveTelemetryOptIn) {
          desktopSync.telemetry?.setOptIn(effectiveTelemetryOptIn);
        }
      }
      if (!startupRecorded && effectiveTelemetryOptIn && typeof performance !== 'undefined') {
        startupRecorded = true;
        desktopSync.telemetry?.recordStartup(Math.max(0, Math.round(performance.now())), true);
      }
      const syncable = extractSyncablePreferences(snap);
      const syncableJson = JSON.stringify(syncable);
      if (lastSyncableJson !== syncableJson) {
        lastSyncableJson = syncableJson;
        void desktopSync.setSyncablePreferences(syncable);
      }
    };
    const unsubInitialPrefs = desktopSync.onInitialPreferences((patch) => {
      if (!active) return;
      void preferencesStore.update(patch);
    });
    const unsubPairDeepLink = desktopSync.onPairDeepLink((uri) => {
      if (active) setPendingPairUri(uri);
    });
    const onOnline = (): void => {
      desktopSync.notifyReconnect();
    };
    const onWinError = (ev: ErrorEvent): void => {
      const sig = extractSafeRendererErrorSignature(ev.error, ev.filename, ev.lineno);
      desktopSync.telemetry?.recordUnhandledError({
        errorName: sig.errorName,
        stackSig: sig.stackSig,
        source: 'renderer',
      });
    };
    const onRejection = (ev: PromiseRejectionEvent): void => {
      const sig =
        ev.reason instanceof Error
          ? extractSafeRendererErrorSignature(ev.reason)
          : { errorName: 'UnhandledRejection', stackSig: 'UnhandledRejection' };
      desktopSync.telemetry?.recordUnhandledError({
        errorName: sig.errorName,
        stackSig: sig.stackSig,
        source: 'renderer',
      });
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onOnline);
      window.addEventListener('error', onWinError);
      window.addEventListener('unhandledrejection', onRejection);
    }
    void desktopSync.hydrate().then(() =>
      desktopSync.consumePendingPairUri().then((uri) => {
        if (active && uri !== null) setPendingPairUri(uri);
      }),
    );
    void preferencesStore.load().then(syncPrefs);
    const unsubPrefs = preferencesStore.subscribe(syncPrefs);
    return () => {
      active = false;
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('error', onWinError);
        window.removeEventListener('unhandledrejection', onRejection);
      }
      unsubInitialPrefs();
      unsubPairDeepLink();
      unsubPrefs();
      desktopSync.dispose();
    };
  }, [desktopSync, preferencesStore]);

  const handlePairUriHandled = useCallback(() => {
    setPendingPairUri(null);
  }, []);

  const shellProps: AppShellProps & {
    sourceImportHost?: SourceImportHost;
    profilePreferences?: ProfilePreferencesManager;
    diagnostics?: DiagnosticsPort;
    syncAccount?: DesktopSyncAccountPort;
    telemetry?: DesktopTelemetryPort;
    feedback?: DesktopFeedbackPort;
    pendingPairUri?: string | null;
    onPairUriHandled?: () => void;
  } = {
    catalog,
    videoHost,
    appLifecycle,
    thermalDevice,
    profilePreferences: preferencesStore,
    keymapStore,
    reminderHost,
    diagnostics,
    downloadManager,
    trailerExternal,
    externalRefreshToken: refreshToken,
    pendingPairUri,
    onPairUriHandled: handlePairUriHandled,
    ...(desktopWindow === undefined ? {} : { desktopWindow }),
    ...(sourceImportHost === undefined ? {} : { sourceImportHost }),
    ...(lanPairing === undefined ? {} : { lanPairing }),
    ...(desktopSync.syncAccount === undefined ? {} : { syncAccount: desktopSync.syncAccount }),
    ...(desktopSync.telemetry === undefined ? {} : { telemetry: desktopSync.telemetry }),
    ...(desktopSync.feedback === undefined ? {} : { feedback: desktopSync.feedback }),
  };

  return (
    <UiAdaptersProvider adapters={uiAdapters}>
      <AppProviders
        preferencesStore={preferencesStore}
        profilePreferences={preferencesStore}
        keymapStore={keymapStore}
        systemLocale={systemLocale}
        viewport={{ formFactor: 'desktop' }}
      >
        <View style={appStyles.root}>
          {catalogDisconnected ? (
            <CatalogCrashBanner
              reconnecting={reconnectingCatalog}
              onRetry={handleReconnectCatalog}
            />
          ) : null}
          <View style={appStyles.shell}>
            <AppShell {...shellProps} />
          </View>
        </View>
      </AppProviders>
    </UiAdaptersProvider>
  );
}

const appStyles = StyleSheet.create({
  root: { flex: 1 },
  shell: { flex: 1, minHeight: 0 },
});

/** Root of the desktop renderer: mounts the gate harness on `--elv-gate=`, standalone popout on `?popout=1`, the dev-only UI Workbench in plain browser dev mode, and `AppShell` (#13) otherwise. */
export function App() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    return attachAccessibilityFonts(window);
  }, []);

  if (GATE) return <GateScreen params={GATE} />;
  if (IS_POPOUT) return <PopoutApp />;
  if (MOUNT_WORKBENCH && WorkbenchShell !== null) {
    return (
      <Suspense fallback={null}>
        <WorkbenchShell />
      </Suspense>
    );
  }
  return <AppRoot />;
}
