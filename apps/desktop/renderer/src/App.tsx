import { createCoalescedCatalog } from '@elv/data';
import type { ProfilePreferencesManager } from '@elv/domain';
import {
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
import { attachAccessibilityFonts } from './accessibility-fonts.ts';
import { attachMouseBackGuard } from './browser-back.ts';
import {
  attemptCatalogReconnect,
  CatalogCrashBanner,
  subscribeCatalogDisconnected,
} from './CatalogCrashBanner.tsx';
import { createDesktopCatalog } from './catalog/index.ts';
import { createDesktopDiagnosticsPort } from './diagnostics-port.ts';
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
} from './sync/desktop-sync-ports.ts';
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

function AppRoot() {
  const [refreshToken, setRefreshToken] = useState(0);
  const [catalogDisconnected, setCatalogDisconnected] = useState(false);
  const [reconnectingCatalog, setReconnectingCatalog] = useState(false);
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

  const videoHost = useMemo<VideoHost>(() => createDesktopVideoHost(), []);

  const desktopWindow = useMemo<DesktopWindowPort | undefined>(
    () => createDesktopWindowPort(window.elv?.window),
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

  const desktopSync = useMemo(() => createDesktopSyncPorts(window.elv), []);

  useEffect(() => {
    let active = true;
    let lastServerUrl: string | undefined;
    const syncServerUrlPref = (nextUrl: string): void => {
      if (!active || lastServerUrl === nextUrl) return;
      lastServerUrl = nextUrl;
      void desktopSync.setServerUrl(nextUrl);
    };
    void desktopSync.hydrate();
    void preferencesStore.load().then((snap) => syncServerUrlPref(snap.syncServerUrl));
    const unsubPrefs = preferencesStore.subscribe((snap) => syncServerUrlPref(snap.syncServerUrl));
    return () => {
      active = false;
      unsubPrefs();
      desktopSync.dispose();
    };
  }, [desktopSync, preferencesStore]);

  const shellProps: AppShellProps & {
    sourceImportHost?: SourceImportHost;
    profilePreferences?: ProfilePreferencesManager;
    diagnostics?: DiagnosticsPort;
    syncAccount?: DesktopSyncAccountPort;
    telemetry?: DesktopTelemetryPort;
    feedback?: DesktopFeedbackPort;
  } = {
    catalog,
    videoHost,
    thermalDevice,
    profilePreferences: preferencesStore,
    keymapStore,
    reminderHost,
    diagnostics,
    externalRefreshToken: refreshToken,
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
