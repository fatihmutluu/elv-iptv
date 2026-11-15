import { AppShell, createLazyCatalog, type VideoHost } from '@elv/features';
import { createAppI18n, resolveLocale } from '@elv/i18n';
import { FormFactorProvider, I18nProvider } from '@elv/ui-kit';
import { useEffect, useMemo, useState } from 'react';
import { createDesktopCatalog } from './catalog/index.ts';
import { GateScreen } from './gate/GateScreen.tsx';
import { resolveGate } from './gate/params.ts';
import { createDesktopEngine } from './player/desktop-engine.ts';
import { PlayerView } from './player/PlayerView.tsx';

// Computed once: a re-render must never hand the gate new params, which would restart the run. Main loads the query only
// for an unpackaged `--elv-gate=` launch, and the preload flags gate mode; a page with just the query gets no gate.
const GATE = resolveGate(window.location.search, window.elv);

function AppRoot() {
  const [refreshToken, setRefreshToken] = useState(0);

  const i18n = useMemo(() => {
    const languages = typeof navigator === 'undefined' ? [] : navigator.languages;
    return createAppI18n(resolveLocale(languages));
  }, []);

  const catalog = useMemo(() => createLazyCatalog(() => createDesktopCatalog()), []);

  const videoHost = useMemo<VideoHost>(
    () => ({
      async open() {
        const playerBridge = window.elv?.player;
        if (!playerBridge) return null;
        const engine = await createDesktopEngine(playerBridge, () => performance.now());
        return {
          engine,
          renderSurface: ({ failed }) => <PlayerView engine={engine} status="" failed={failed} />,
          onHostKey: (listener) =>
            engine.onUi((event) => {
              if (event.type === 'closed') {
                listener('back');
              } else if (event.type === 'key') {
                if (event.key === 'fullscreen') {
                  engine.toggleFullscreen();
                } else if (event.key === 'back' || event.key === 'close') {
                  listener('back');
                } else if (event.key === 'channel-up' || event.key === 'channel-down') {
                  listener(event.key);
                }
              }
            }),
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

  return (
    <FormFactorProvider value="desktop">
      <I18nProvider i18n={i18n}>
        <AppShell catalog={catalog} videoHost={videoHost} externalRefreshToken={refreshToken} />
      </I18nProvider>
    </FormFactorProvider>
  );
}

/** Root of the desktop renderer: mounts the gate harness on `--elv-gate=` launches and `AppShell` (#13) otherwise. */
export function App() {
  if (GATE) return <GateScreen params={GATE} />;
  return <AppRoot />;
}
