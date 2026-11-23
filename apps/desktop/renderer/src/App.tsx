import { createCoalescedCatalog } from '@elv/data';
import type { AccessibilityFontFamily } from '@elv/domain';
import {
  AppProviders,
  AppShell,
  type AppShellProps,
  createLazyCatalog,
  type SourceImportHost,
  type VideoHost,
} from '@elv/features';
import { resolveLocale } from '@elv/i18n';
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
import { GateScreen } from './gate/GateScreen.tsx';
import { resolveGate } from './gate/params.ts';
import { bindDesktopMediaSession, createDesktopMediaSession } from './media-session.ts';
import { createDesktopEngine } from './player/desktop-engine.ts';
import {
  type DesktopHostKey,
  dispatchDesktopClose,
  routeDesktopUiEvent,
} from './player/host-keys.ts';
import { PlayerView } from './player/PlayerView.tsx';
import { attachScrollBlurGuard } from './scroll-blur-guard.ts';
import { createDesktopPreferencesStore } from './storage/preferences.ts';
import { attachDeadHostOnlineReset, createDesktopUiAdapters } from './ui/desktop-adapters.tsx';
import { shouldMountWorkbench } from './workbench/presets.ts';

declare const __DEV__: boolean;

// Computed once: a re-render must never hand the gate new params, which would restart the run. Main loads the query only
// for an unpackaged `--elv-gate=` launch, and the preload flags gate mode; a page with just the query gets no gate.
const GATE = resolveGate(window.location.search, window.elv);
const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;
const MOUNT_WORKBENCH =
  IS_DEV &&
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
  const uiAdapters = useMemo(() => createDesktopUiAdapters(), []);

  const catalog = useMemo(
    () =>
      createCoalescedCatalog(
        createLazyCatalog(() => createDesktopCatalog()),
        { windowMs: 500 },
      ),
    [],
  );

  const videoHost = useMemo<VideoHost>(
    () => ({
      async open() {
        const playerBridge = window.elv?.player;
        if (!playerBridge) return null;
        const rawEngine = await createDesktopEngine(playerBridge, () => performance.now());
        const mediaSession = createDesktopMediaSession();
        let activeHostKeyListener: ((key: DesktopHostKey) => void) | null = null;
        let overlayMode: 'floating' | 'docked' = 'floating';
        const overlayModeListeners = new Set<(mode: 'floating' | 'docked') => void>();
        const offPresenterOverlay = rawEngine.onUi((event) => {
          if (event.type !== 'presenter') return;
          const nextMode: 'floating' | 'docked' =
            event.kind === 'canvas' || !event.coversArea ? 'floating' : 'docked';
          if (nextMode === overlayMode) return;
          overlayMode = nextMode;
          for (const listener of [...overlayModeListeners]) {
            try {
              listener(nextMode);
            } catch {
              // isolate overlay mode subscribers
            }
          }
        });
        const windowBridge = window.elv?.window;
        let alwaysOnTop = windowBridge
          ? await windowBridge.getAlwaysOnTop().catch(() => false)
          : false;
        const alwaysOnTopListeners = new Set<(pinned: boolean) => void>();
        const notifyAlwaysOnTop = (pinned: boolean): void => {
          if (alwaysOnTop === pinned) return;
          alwaysOnTop = pinned;
          for (const listener of [...alwaysOnTopListeners]) {
            try {
              listener(pinned);
            } catch {
              // isolate always-on-top subscribers
            }
          }
        };
        let offWindowAlwaysOnTop = windowBridge?.onAlwaysOnTopChanged((pinned) => {
          notifyAlwaysOnTop(pinned);
        });
        const boundEngine = bindDesktopMediaSession(rawEngine, mediaSession, {
          onTrackStep: (dir) =>
            activeHostKeyListener?.(dir === 'next' ? 'channel-up' : 'channel-down'),
        });
        const engine = {
          ...boundEngine,
          release() {
            offPresenterOverlay();
            overlayModeListeners.clear();
            offWindowAlwaysOnTop?.();
            offWindowAlwaysOnTop = undefined;
            alwaysOnTopListeners.clear();
            boundEngine.release();
          },
        };
        const opened = {
          engine,
          get overlayMode(): 'floating' | 'docked' {
            return overlayMode;
          },
          onOverlayModeChange: (listener: (mode: 'floating' | 'docked') => void) => {
            overlayModeListeners.add(listener);
            return () => {
              overlayModeListeners.delete(listener);
            };
          },
          renderSurface: ({
            failed,
            resizeMode,
          }: {
            failed: boolean;
            resizeMode?: 'fit' | 'fill' | 'stretch';
          }) => <PlayerView engine={engine} status="" failed={failed} resizeMode={resizeMode} />,
          toggleFullscreen: () => rawEngine.toggleFullscreen(),
          isFullscreen: () => rawEngine.isFullscreen(),
          onFullscreenChange: (listener: (fullscreen: boolean) => void) => {
            let last: boolean | undefined;
            return rawEngine.onUi((event) => {
              if (event.type !== 'fullscreen-changed' || event.fullscreen === last) return;
              last = event.fullscreen;
              listener(event.fullscreen);
            });
          },
          toggleMute: () => rawEngine.toggleMute(),
          setVolume: (volume: number) => rawEngine.setVolume(volume),
          setDeinterlace: (enabled: boolean) => rawEngine.setDeinterlace(enabled),
          setResizeMode: (mode: 'fit' | 'fill' | 'stretch') => rawEngine.setResizeMode(mode),
          setFilterSdh: (enabled: boolean) => rawEngine.setFilterSdh(enabled),
          setSubtitleFontFamily: (family: AccessibilityFontFamily) =>
            rawEngine.setSubtitleFontFamily(family),
          setMediaMetadata: (metadata: Parameters<typeof engine.setMediaMetadata>[0]) =>
            engine.setMediaMetadata(metadata),
          getAudioDevices: () => rawEngine.getAudioDevices(),
          getActiveAudioDevice: () => rawEngine.getActiveAudioDevice(),
          setAudioDevice: (name: string) => rawEngine.setAudioDevice(name),
          onAudioDevicesChange: (listener: Parameters<typeof rawEngine.onAudioDevicesChange>[0]) =>
            rawEngine.onAudioDevicesChange(listener),
          ...(windowBridge
            ? {
                toggleAlwaysOnTop: () => {
                  void windowBridge
                    .setAlwaysOnTop(!alwaysOnTop)
                    .then((pinned) => notifyAlwaysOnTop(pinned))
                    .catch(() => undefined);
                },
                isAlwaysOnTop: () => alwaysOnTop,
                onAlwaysOnTopChange: (listener: (pinned: boolean) => void) => {
                  alwaysOnTopListeners.add(listener);
                  return () => {
                    alwaysOnTopListeners.delete(listener);
                  };
                },
              }
            : {}),
          onHostKey: (listener: (key: DesktopHostKey) => void) => {
            activeHostKeyListener = listener;
            const offUi = rawEngine.onUi((event) =>
              routeDesktopUiEvent(event, {
                toggleFullscreen: () => listener('fullscreen'),
                onHostKey: listener,
                onClose: () => dispatchDesktopClose(listener),
              }),
            );
            return () => {
              if (activeHostKeyListener === listener) activeHostKeyListener = null;
              offUi();
            };
          },
        };
        return opened;
      },
    }),
    [],
  );

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

  const sourceImportHost = useMemo<SourceImportHost | undefined>(() => {
    const sourcesBridge = window.elv?.sources;
    if (!sourcesBridge) return undefined;
    return {
      readClipboardText: () => sourcesBridge.readClipboardText(),
      pickPlaylistFile: () => sourcesBridge.pickPlaylistFile(),
    };
  }, []);

  const shellProps: AppShellProps & { sourceImportHost?: SourceImportHost } = {
    catalog,
    videoHost,
    externalRefreshToken: refreshToken,
    ...(sourceImportHost === undefined ? {} : { sourceImportHost }),
  };

  return (
    <UiAdaptersProvider adapters={uiAdapters}>
      <AppProviders
        preferencesStore={preferencesStore}
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

/** Root of the desktop renderer: mounts the gate harness on `--elv-gate=`, the dev-only UI Workbench in plain browser dev mode, and `AppShell` (#13) otherwise. */
export function App() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    return attachAccessibilityFonts(window);
  }, []);

  if (GATE) return <GateScreen params={GATE} />;
  if (MOUNT_WORKBENCH && WorkbenchShell !== null) {
    return (
      <Suspense fallback={null}>
        <WorkbenchShell />
      </Suspense>
    );
  }
  return <AppRoot />;
}
