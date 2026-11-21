import { AppProviders, AppShell, createLazyCatalog, type VideoHost } from '@elv/features';
import { resolveLocale } from '@elv/i18n';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { attachMouseBackGuard } from './browser-back.ts';
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

function isTrackPickerModalOpen(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.querySelector('[data-testid="player-tracks-panel"]') !== null
  );
}

function readActiveOsdTitle(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('[data-testid="osd-title"]')?.textContent?.trim() ?? '';
}

function AppRoot() {
  const [refreshToken, setRefreshToken] = useState(0);

  const systemLocale = useMemo(() => {
    const languages = typeof navigator === 'undefined' ? [] : navigator.languages;
    return resolveLocale(languages);
  }, []);

  const preferencesStore = useMemo(() => createDesktopPreferencesStore(), []);

  const catalog = useMemo(() => createLazyCatalog(() => createDesktopCatalog()), []);

  const videoHost = useMemo<VideoHost>(
    () => ({
      async open() {
        const playerBridge = window.elv?.player;
        if (!playerBridge) return null;
        const rawEngine = await createDesktopEngine(playerBridge, () => performance.now());
        const mediaSession = createDesktopMediaSession();
        let activeHostKeyListener: ((key: DesktopHostKey) => void) | null = null;
        const engine = bindDesktopMediaSession(rawEngine, mediaSession, {
          getTitle: readActiveOsdTitle,
          onTrackStep: (dir) =>
            activeHostKeyListener?.(dir === 'next' ? 'channel-up' : 'channel-down'),
        });
        return {
          engine,
          renderSurface: ({ failed }) => <PlayerView engine={engine} status="" failed={failed} />,
          toggleFullscreen: () => rawEngine.toggleFullscreen(),
          toggleMute: () => rawEngine.toggleMute(),
          onHostKey: (listener) => {
            activeHostKeyListener = listener;
            const offUi = rawEngine.onUi((event) =>
              routeDesktopUiEvent(event, {
                toggleFullscreen: () => listener('fullscreen'),
                onHostKey: listener,
                onClose: () => dispatchDesktopClose(listener, isTrackPickerModalOpen()),
              }),
            );
            return () => {
              if (activeHostKeyListener === listener) activeHostKeyListener = null;
              offUi();
            };
          },
        };
      },
    }),
    [],
  );

  useEffect(() => {
    const bridge = window.elv?.catalog;
    if (!bridge || typeof bridge.onChanged !== 'function') return;
    return bridge.onChanged(() => {
      setRefreshToken((n) => n + 1);
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

  return (
    <AppProviders
      preferencesStore={preferencesStore}
      systemLocale={systemLocale}
      viewport={{ formFactor: 'desktop' }}
    >
      <AppShell catalog={catalog} videoHost={videoHost} externalRefreshToken={refreshToken} />
    </AppProviders>
  );
}

/** Root of the desktop renderer: mounts the gate harness on `--elv-gate=`, the dev-only UI Workbench in plain browser dev mode, and `AppShell` (#13) otherwise. */
export function App() {
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
