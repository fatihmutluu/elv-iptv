import { type CatalogService, createCoalescedCatalog } from '@elv/data';
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
import { useEffect, useMemo, useState } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import { createComposedAppLifecycle } from './android-lifecycle';
import { createDeviceCatalog } from './catalog';
import { waitForCatalogForeground } from './catalog/ios-prewarm-gate';
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
import { createMobileVideoHost } from './thermal-and-pip';
import { createMobileThermalDevicePort } from './thermal-device-port';
import { createTvHomeChannelsPort } from './tv-home-channels/adapter';
import { usePlayDeepLink } from './tv-home-channels/use-play-deep-link';
import { attachAppStateDeadHostReset, createMobileTvUiAdapters } from './ui/platform-adapters';

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
  const { pendingDeepLink, clearPendingDeepLink } = usePlayDeepLink();
  const uiAdapters = useMemo(() => createMobileTvUiAdapters(), []);

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

  const openSharedCatalog = useMemo(() => {
    let cached: Promise<CatalogService> | undefined;
    return () => {
      cached ??= waitForCatalogForeground(Platform.OS, AppState)
        .then(() => createDeviceCatalog())
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
      }),
    [isAppleTv],
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

  return (
    <UiAdaptersProvider adapters={uiAdapters}>
      <AppProviders
        preferencesStore={preferencesStore}
        profilePreferences={preferencesStore}
        keymapStore={keymapStore}
        systemLocale={systemLocale}
        {...(viewportOverride !== undefined ? { viewport: viewportOverride } : {})}
      >
        <AppShell
          catalog={catalog}
          videoHost={videoHost}
          appLifecycle={appLifecycle}
          thermalDevice={thermalDevice}
          profilePreferences={preferencesStore}
          keymapStore={keymapStore}
          lanPairing={lanPairingPort}
          tvHomeChannels={tvHomeChannelsPort}
          pendingDeepLink={pendingDeepLink}
          onDeepLinkHandled={clearPendingDeepLink}
          externalPlayer={externalPlayerPort}
          diagnostics={diagnosticsPort}
          {...(sourceImportHost !== undefined ? { sourceImportHost } : {})}
          externalRefreshToken={refreshToken}
        />
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
