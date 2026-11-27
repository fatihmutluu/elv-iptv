import { type CatalogService, createCoalescedCatalog } from '@elv/data';
import {
  DEFAULT_PREFERENCES,
  extractSyncablePreferences,
  type PreferencesSnapshot,
} from '@elv/domain';
import {
  type AppleSafeAreaInsets,
  canStartAetherPictureInPicture,
  configureAetherMultiView,
  enterAetherPictureInPicture,
  getAppleDeviceModel,
  getApplePhysicalMemoryBytes,
  getAppleSafeAreaInsets,
  getAppleThermalState,
  pickApplePlaylistFile,
  readAppleClipboardText,
  setAetherAutoEnterPictureInPicture,
  setAetherBackgroundAudioEnabled,
  setAetherMediaMetadata,
  setAppleEngineMuted,
  setAppleEngineVolume,
  subscribeAetherPictureInPicture,
  subscribeAetherRemoteMediaAction,
  subscribeAppleHardwareKeys,
  subscribeAppleSafeAreaInsets,
  subscribeAppleThermalState,
} from '@elv/engine-aether';
import {
  type AndroidSafeAreaInsets,
  applyAndroidShortEdgesCutoutMode,
  configureMedia3MultiView,
  enterAndroidPictureInPicture,
  getAndroidDeviceMemoryInfo,
  getAndroidSafeAreaInsets,
  getAndroidThermalState,
  pickAndroidPlaylistFile,
  readAndroidClipboardText,
  requestTemporaryOrientation,
  setAndroidAutoEnterPictureInPicture,
  setMedia3BackgroundAudioEnabled,
  setMedia3MediaMetadata,
  setMedia3PitchLock,
  setOrientationLocked,
  subscribeAndroidPictureInPicture,
  subscribeAndroidSafeAreaInsets,
  subscribeAndroidStandby,
  subscribeAndroidThermalState,
  subscribeMedia3RemoteMediaAction,
} from '@elv/engine-media3';
import {
  type AppLifecyclePort,
  AppProviders,
  AppShell,
  type AppShellProps,
  createLazyCatalog,
  type SourceImportHost,
  type ThermalDevicePort,
  type VideoHost,
} from '@elv/features';
import { resolveLocale } from '@elv/i18n';
import { remoteKeys, remotePanGestures } from '@elv/remote-keys';
import { RemoteKeysProvider, TvFocusAnchor, UiAdaptersProvider } from '@elv/ui-kit';
import Constants from 'expo-constants';
import { getLocales } from 'expo-localization';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Dimensions, Platform, StyleSheet, View } from 'react-native';
import { createComposedAppLifecycle } from './android-lifecycle';
import { createDeviceCatalog } from './catalog';
import { waitForCatalogForeground } from './catalog/ios-prewarm-gate';
import { createMobileDownloadManagerPort } from './downloads';
import { ContractGateScreen } from './gate/contract/ContractGateScreen';
import { CorpusGateScreen } from './gate/corpus/CorpusGateScreen';
import { EpgGateScreen } from './gate/epg/EpgGateScreen';
import { GateListScreen } from './gate/GateListScreen';
import { ImportGateScreen } from './gate/import/ImportGateScreen';
import { PlayerGateScreen } from './gate/player/PlayerGateScreen';
import { useGateRoute } from './gate/useGateParams';
import { createMobileLanPairingPort } from './lan-pairing/adapter';
import { createMobileExternalPlayerPort } from './playback/external-player';
import { PlayerSurface } from './playback/PlayerSurface';
import { createPlatformEngine } from './playback/platform-engine';
import {
  createDeviceKeymapStore,
  createDevicePreferencesStore,
  createSecureSecretStore,
} from './storage';
import { createMobileDiagnosticsPort } from './storage/diag-log';
import { createTvMobileCatalogSnapshotBridge } from './sync/catalog-snapshot';
import { createMobileQrScannerPort } from './sync/qr-scanner-port';
import { classifyMobileRamBucket, extractSafeMobileErrorSignature } from './sync/sync-helpers';
import {
  createTvMobileSyncPorts,
  type FeedbackPort,
  type SyncAccountPort,
  type TelemetryPort,
} from './sync/sync-runtime';
import { usePairDeepLink } from './sync/use-pair-deep-link';
import { createMobileVideoHost } from './thermal-and-pip';
import { createMobileThermalDevicePort } from './thermal-device-port';
import { createTvHomeChannelsPort } from './tv-home-channels/adapter';
import { usePlayDeepLink } from './tv-home-channels/use-play-deep-link';
import { attachAppStateDeadHostReset, createMobileTvUiAdapters } from './ui/platform-adapters';

const APP_MODULE_BOOT_MS = Date.now();

function readBakedSyncServerUrl(): string {
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined;
  if (typeof extra?.syncServerUrl === 'string' && extra.syncServerUrl.trim().length > 0) {
    return extra.syncServerUrl.trim();
  }
  return typeof process !== 'undefined' ? (process.env.EXPO_PUBLIC_SYNC_SERVER_URL ?? '') : '';
}

function AppRoot() {
  const [refreshToken, setRefreshToken] = useState(0);
  const isAndroidMobile = Platform.OS === 'android' && !Platform.isTV;
  const isAppleMobile = Platform.OS === 'ios' && !Platform.isTV;
  const isAppleTv = Platform.OS === 'ios' && Platform.isTV;
  const [safeArea, setSafeArea] = useState<AndroidSafeAreaInsets | AppleSafeAreaInsets | undefined>(
    () =>
      isAndroidMobile
        ? getAndroidSafeAreaInsets()
        : isAppleMobile
          ? getAppleSafeAreaInsets()
          : undefined,
  );

  const systemLocale = useMemo(
    () => resolveLocale(getLocales().map((locale) => locale.languageTag)),
    [],
  );

  const preferencesStore = useMemo(() => createDevicePreferencesStore(), []);
  const keymapStore = useMemo(() => createDeviceKeymapStore(), []);
  const lanPairingPort = useMemo(() => createMobileLanPairingPort(), []);
  const tvHomeChannelsPort = useMemo(() => createTvHomeChannelsPort(), []);
  const externalPlayerPort = useMemo(() => createMobileExternalPlayerPort(), []);
  const diagnosticsPort = useMemo(() => createMobileDiagnosticsPort(), []);
  const telemetryRef = useRef<TelemetryPort | null>(null);
  const openSharedCatalog = useMemo(() => {
    let cached: Promise<CatalogService> | undefined;
    return () => {
      cached ??= waitForCatalogForeground(Platform.OS, AppState)
        .then(() =>
          createDeviceCatalog({
            onSlowQuery: (op, durationMs) =>
              telemetryRef.current?.recordSqliteSlowOp({ op, durationMs }),
            recordCatalogImport: (meta) => telemetryRef.current?.recordCatalogImport(meta),
          }),
        )
        .catch((err: unknown) => {
          cached = undefined;
          throw err;
        });
      return cached;
    };
  }, []);

  const catalog = useMemo(
    () => createCoalescedCatalog(createLazyCatalog(openSharedCatalog), { windowMs: 500 }),
    [openSharedCatalog],
  );
  const downloadManagerPort = useMemo(() => createMobileDownloadManagerPort(catalog), [catalog]);

  const syncSecretStore = useMemo(() => createSecureSecretStore(), []);
  const catalogSnapshotBridge = useMemo(
    () =>
      createTvMobileCatalogSnapshotBridge({
        getCatalog: openSharedCatalog,
        secretStore: syncSecretStore,
        onApplied: () => setRefreshToken((n) => n + 1),
      }),
    [openSharedCatalog, syncSecretStore],
  );
  const syncPrefsRef = useRef<{ telemetryOptIn: boolean; syncServerUrl: string }>({
    telemetryOptIn: false,
    syncServerUrl: '',
  });
  const latestPrefsRef = useRef<PreferencesSnapshot>(DEFAULT_PREFERENCES);
  const qrScannerPort = useMemo(() => createMobileQrScannerPort(), []);
  const syncPorts = useMemo(
    () =>
      createTvMobileSyncPorts({
        secretStore: syncSecretStore,
        getServerUrl: () => readBakedSyncServerUrl(),
        getPreferences: () => syncPrefsRef.current,
        getSyncablePreferences: () => extractSyncablePreferences(latestPrefsRef.current),
        applyInitialPreferences: async (patch) => {
          await preferencesStore.update(patch);
        },
        getLocalSnapshot: catalogSnapshotBridge.getLocalSnapshot,
        applyMergedSnapshot: catalogSnapshotBridge.applyMergedSnapshot,
        onTelemetryOptInChange: (enabled) => {
          syncPrefsRef.current = { ...syncPrefsRef.current, telemetryOptIn: enabled };
          void preferencesStore
            .update({ telemetryOptIn: enabled, crashReportsOptIn: enabled })
            .catch(() => undefined);
        },
        getDeviceMeta: () => {
          const dims = Dimensions.get('screen');
          const resW = Math.round(dims.width * (dims.scale || 1));
          const resH = Math.round(dims.height * (dims.scale || 1));
          const resolution = resW > 0 && resH > 0 ? `${resW}x${resH}` : undefined;
          const totalMemBytes =
            Platform.OS === 'android'
              ? getAndroidDeviceMemoryInfo()?.totalMemBytes
              : Platform.OS === 'ios'
                ? getApplePhysicalMemoryBytes()
                : null;
          const ramBucket = classifyMobileRamBucket(totalMemBytes);
          const formFactor = Platform.isTV
            ? 'tv'
            : Math.min(dims.width, dims.height) >= 600
              ? 'tablet'
              : 'phone';
          return {
            platform:
              Platform.OS === 'android'
                ? Platform.isTV
                  ? 'android-tv'
                  : 'android'
                : Platform.OS === 'ios'
                  ? Platform.isTV
                    ? 'tvos'
                    : 'ios'
                  : Platform.OS,
            appVersion: Constants.expoConfig?.version ?? '0.0.0',
            locale: systemLocale,
            formFactor,
            ...(ramBucket !== undefined ? { ramBucket } : {}),
            ...(resolution !== undefined ? { resolution } : {}),
            ...(Platform.Version !== undefined
              ? { osVersion: `${Platform.OS} ${String(Platform.Version)}` }
              : {}),
          };
        },
        getRecentLogs: (maxLines) => diagnosticsPort.readLogTail(maxLines),
        subscribeAppState: (listener) => {
          const sub = AppState.addEventListener('change', listener);
          return () => sub.remove();
        },
      }),
    [catalogSnapshotBridge, diagnosticsPort, preferencesStore, syncSecretStore, systemLocale],
  );
  const { pendingDeepLink, clearPendingDeepLink } = usePlayDeepLink();
  const { pendingPairUri, clearPendingPairUri } = usePairDeepLink();
  telemetryRef.current = syncPorts.telemetry;
  const uiAdapters = useMemo(() => createMobileTvUiAdapters(), []);

  useEffect(() => {
    let active = true;
    let receivedLivePrefUpdate = false;
    let startupRecorded = false;
    const applyPrefs = (snap: PreferencesSnapshot, isLiveUpdate: boolean): void => {
      if (!active) return;
      if (isLiveUpdate) {
        receivedLivePrefUpdate = true;
      } else if (receivedLivePrefUpdate) {
        return;
      }
      latestPrefsRef.current = snap;
      const effectiveTelemetryOptIn = Boolean(snap.telemetryOptIn || snap.crashReportsOptIn);
      syncPrefsRef.current = {
        telemetryOptIn: effectiveTelemetryOptIn,
        syncServerUrl: snap.syncServerUrl,
      };
      if (!startupRecorded && effectiveTelemetryOptIn) {
        startupRecorded = true;
        syncPorts.telemetry.recordStartup(Math.max(0, Date.now() - APP_MODULE_BOOT_MS), true);
      }
    };
    const onOnline = (): void => {
      syncPorts.notifyReconnect();
    };
    const globalTarget = globalThis as {
      addEventListener?: (event: string, listener: () => void) => void;
      removeEventListener?: (event: string, listener: () => void) => void;
    };
    globalTarget.addEventListener?.('online', onOnline);
    const reconnectAppStateSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && syncPorts.syncAccount.getState().autoSyncState === 'offline') {
        syncPorts.notifyReconnect();
      }
    });
    const errorUtils = (
      globalThis as {
        ErrorUtils?: {
          getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
          setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
        };
      }
    ).ErrorUtils;
    const prevErrorHandler = errorUtils?.getGlobalHandler?.();
    if (errorUtils?.setGlobalHandler) {
      errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
        const sig = extractSafeMobileErrorSignature(error);
        if (isFatal) {
          syncPorts.telemetry.recordAppCrash({
            errorName: sig.errorName,
            stackSig: sig.stackSig,
            fatal: true,
            uptimeMs: Math.max(0, Date.now() - APP_MODULE_BOOT_MS),
          });
        } else {
          syncPorts.telemetry.recordUnhandledError({
            errorName: sig.errorName,
            stackSig: sig.stackSig,
            source: 'js',
          });
        }
        prevErrorHandler?.(error, isFatal);
      });
    }
    const unsubPrefs = preferencesStore.subscribe((snap) => applyPrefs(snap, true));
    void preferencesStore.load().then((snap) => applyPrefs(snap, false));
    void syncPorts.hydrate().then(() => syncPorts.notifyStartup());
    return () => {
      active = false;
      globalTarget.removeEventListener?.('online', onOnline);
      reconnectAppStateSub.remove();
      if (errorUtils?.setGlobalHandler && prevErrorHandler) {
        errorUtils.setGlobalHandler(prevErrorHandler);
      }
      unsubPrefs();
      syncPorts.dispose();
    };
  }, [preferencesStore, syncPorts]);

  useEffect(() => {
    if (isAndroidMobile) {
      applyAndroidShortEdgesCutoutMode();
      setSafeArea(getAndroidSafeAreaInsets());
      return subscribeAndroidSafeAreaInsets(setSafeArea);
    }
    if (isAppleMobile) {
      setSafeArea(getAppleSafeAreaInsets());
      return subscribeAppleSafeAreaInsets(setSafeArea);
    }
    setSafeArea(undefined);
    return undefined;
  }, [isAndroidMobile, isAppleMobile]);

  const viewportOverride = useMemo(
    () => (safeArea !== undefined ? { safeArea } : undefined),
    [safeArea],
  );

  const videoHost = useMemo<VideoHost>(
    () =>
      createMobileVideoHost({
        os: Platform.OS,
        isTV: Platform.isTV,
        createEngine: createPlatformEngine,
        renderSurface: (
          engine,
          {
            resizeMode,
            subtitleBottomInsetPx,
            subtitleFontFamily,
            subtitleStyle,
            surfaceRecreationToken,
            useTextureView,
            osdVisible,
            testID,
          },
        ) => (
          <PlayerSurface
            engine={engine}
            style={styles.surface}
            {...(resizeMode !== undefined ? { resizeMode } : {})}
            {...(subtitleBottomInsetPx !== undefined ? { subtitleBottomInsetPx } : {})}
            {...(subtitleFontFamily !== undefined ? { subtitleFontFamily } : {})}
            {...(subtitleStyle !== undefined ? { subtitleStyle } : {})}
            {...(surfaceRecreationToken !== undefined ? { surfaceRecreationToken } : {})}
            {...(useTextureView !== undefined ? { useTextureView } : {})}
            {...(osdVisible !== undefined ? { osdVisible } : {})}
            {...(testID !== undefined ? { testID } : {})}
          />
        ),
        getAndroidDeviceMemoryInfo,
        configureMedia3MultiView,
        setOrientationLocked,
        requestTemporaryOrientation,
        setMedia3PitchLock,
        setMedia3MediaMetadata,
        setMedia3BackgroundAudioEnabled,
        subscribeMedia3RemoteMediaAction,
        enterAndroidPictureInPicture,
        setAndroidAutoEnterPictureInPicture,
        subscribeAndroidPictureInPicture,
        setAetherMediaMetadata,
        setAetherBackgroundAudioEnabled,
        configureAetherMultiView,
        subscribeAetherRemoteMediaAction,
        subscribeAppleHardwareKeys,
        setAppleEngineMuted,
        setAppleEngineVolume,
        enterAetherPictureInPicture,
        canStartAetherPictureInPicture,
        setAetherAutoEnterPictureInPicture,
        subscribeAetherPictureInPicture,
        panGestures: isAppleTv ? remotePanGestures : null,
        telemetry: syncPorts.telemetry,
      }),
    [isAppleTv, syncPorts.telemetry],
  );

  const thermalDevice = useMemo<ThermalDevicePort>(
    () =>
      createMobileThermalDevicePort({
        os: Platform.OS,
        isTV: Platform.isTV,
        getAndroidThermalState,
        subscribeAndroidThermalState,
        getAndroidDeviceMemoryInfo,
        getAppleThermalState,
        subscribeAppleThermalState,
        getApplePhysicalMemoryBytes,
        getAppleDeviceModel,
      }),
    [],
  );

  const appLifecycle = useMemo<AppLifecyclePort>(
    () =>
      createComposedAppLifecycle({
        appState: AppState,
        ...(Platform.OS === 'android' ? { subscribeStandby: subscribeAndroidStandby } : {}),
        ...(isAndroidMobile
          ? { subscribePip: subscribeAndroidPictureInPicture }
          : Platform.OS === 'ios'
            ? { subscribePip: subscribeAetherPictureInPicture }
            : {}),
      }),
    [isAndroidMobile],
  );

  const sourceImportHost = useMemo<SourceImportHost | undefined>(() => {
    if (isAndroidMobile) {
      return {
        readClipboardText: readAndroidClipboardText,
        pickPlaylistFile: pickAndroidPlaylistFile,
      };
    }
    if (Platform.OS === 'android') {
      return { readClipboardText: readAndroidClipboardText };
    }
    if (isAppleMobile) {
      return {
        readClipboardText: readAppleClipboardText,
        pickPlaylistFile: pickApplePlaylistFile,
      };
    }
    return undefined;
  }, [isAndroidMobile, isAppleMobile]);

  useEffect(() => {
    let cancelled = false;
    if (__DEV__) {
      const { normalizeSeedForTarget, readEmbeddedDevSeed, runDevSeedOnce } =
        require('./seed/dev-seeder') as typeof import('./seed/dev-seeder');
      const rawSeed = readEmbeddedDevSeed(Constants.expoConfig?.extra);
      if (rawSeed !== undefined) {
        const seed = normalizeSeedForTarget(rawSeed, {
          os: Platform.OS,
          constants: Platform.constants as unknown as Readonly<Record<string, unknown>>,
        });
        void openSharedCatalog()
          .then((opened) =>
            runDevSeedOnce({
              seed,
              catalog: opened,
              secrets: createSecureSecretStore(),
              onChanged: () => {
                if (!cancelled) setRefreshToken((n) => n + 1);
              },
            }),
          )
          .catch(() => undefined);
      }
    }
    return () => {
      cancelled = true;
    };
  }, [openSharedCatalog]);

  useEffect(() => attachAppStateDeadHostReset(AppState), []);

  const shellProps: AppShellProps & {
    syncAccount?: SyncAccountPort;
    telemetry?: TelemetryPort;
    feedback?: FeedbackPort;
    pendingPairUri?: string | null;
    onPairUriHandled?: () => void;
    qrScanner?: ReturnType<typeof createMobileQrScannerPort>;
  } = {
    catalog,
    videoHost,
    appLifecycle,
    thermalDevice,
    profilePreferences: preferencesStore,
    keymapStore,
    lanPairing: lanPairingPort,
    tvHomeChannels: tvHomeChannelsPort,
    pendingDeepLink,
    onDeepLinkHandled: clearPendingDeepLink,
    pendingPairUri,
    onPairUriHandled: clearPendingPairUri,
    qrScanner: qrScannerPort,
    externalPlayer: externalPlayerPort,
    diagnostics: diagnosticsPort,
    syncAccount: syncPorts.syncAccount,
    telemetry: syncPorts.telemetry,
    feedback: syncPorts.feedback,
    downloadManager: downloadManagerPort,
    ...(sourceImportHost !== undefined ? { sourceImportHost } : {}),
    externalRefreshToken: refreshToken,
  };

  return (
    <UiAdaptersProvider adapters={uiAdapters}>
      <AppProviders
        preferencesStore={preferencesStore}
        profilePreferences={preferencesStore}
        keymapStore={keymapStore}
        systemLocale={systemLocale}
        {...(viewportOverride !== undefined ? { viewport: viewportOverride } : {})}
      >
        <AppShell {...shellProps} />
        <StatusBar style="light" />
      </AppProviders>
    </UiAdaptersProvider>
  );
}

/**
 * Root component that `index.ts` registers, with the raw Android key source provided to both branches.
 * Development builds (`extra.gate`) open the list, import, player or contract gate when an `elviptv://gate/*`
 * link started the app (holding off `AppRoot` until `Linking.getInitialURL()` settles so gate runs
 * never open `catalog.db`, localization, or `AppShell`); otherwise mounts `AppShell` (#13).
 */
export function App() {
  const gate = useGateRoute();
  const rawRemoteKeys =
    Platform.OS === 'android' || (Platform.OS === 'ios' && Platform.isTV) ? remoteKeys : null;

  if (gate === 'pending') {
    return (
      <RemoteKeysProvider android={rawRemoteKeys}>
        <View style={styles.pending}>
          {Platform.isTV ? <TvFocusAnchor testID="app-pending-focus-anchor" /> : null}
          <StatusBar style="light" />
        </View>
      </RemoteKeysProvider>
    );
  }

  if (gate !== undefined) {
    return (
      <RemoteKeysProvider android={rawRemoteKeys}>
        {gate.name === 'list' && <GateListScreen key={JSON.stringify(gate)} params={gate.params} />}
        {gate.name === 'epg' && <EpgGateScreen key={JSON.stringify(gate)} params={gate.params} />}
        {gate.name === 'import' && (
          <ImportGateScreen key={JSON.stringify(gate)} params={gate.params} />
        )}
        {gate.name === 'player' && (
          <PlayerGateScreen key={JSON.stringify(gate)} params={gate.params} />
        )}
        {gate.name === 'contract' && (
          <ContractGateScreen key={JSON.stringify(gate)} params={gate.params} />
        )}
        {gate.name === 'corpus' && (
          <CorpusGateScreen key={JSON.stringify(gate)} params={gate.params} />
        )}
        <StatusBar style="light" />
      </RemoteKeysProvider>
    );
  }

  return (
    <RemoteKeysProvider android={rawRemoteKeys}>
      <AppRoot />
    </RemoteKeysProvider>
  );
}

const styles = StyleSheet.create({
  pending: { flex: 1, backgroundColor: '#0b0e14' },
  surface: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
});
