import { createLazyCatalog, SourcesScreen } from '@elv/features';
import { createAppI18n, resolveLocale } from '@elv/i18n';
import { FormFactorProvider, I18nProvider } from '@elv/ui-kit';
import { useEffect, useMemo, useState } from 'react';
import { createDesktopCatalog } from './catalog/index.ts';
import { GateScreen } from './gate/GateScreen.tsx';
import { resolveGate } from './gate/params.ts';

// Computed once: a re-render must never hand the gate new params, which would restart the run. Main loads the query only
// for an unpackaged `--elv-gate=` launch, and the preload flags gate mode; a page with just the query gets no gate.
const GATE = resolveGate(window.location.search, window.elv);

function SourcesRoot() {
  const [refreshToken, setRefreshToken] = useState(0);

  const i18n = useMemo(() => {
    const languages = typeof navigator === 'undefined' ? [] : navigator.languages;
    return createAppI18n(resolveLocale(languages));
  }, []);

  const catalog = useMemo(() => createLazyCatalog(() => createDesktopCatalog()), []);

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
        <SourcesScreen catalog={catalog} externalRefreshToken={refreshToken} />
      </I18nProvider>
    </FormFactorProvider>
  );
}

/** Root of the desktop renderer: mounts the gate harness on `--elv-gate=` launches and `SourcesScreen` (#71) otherwise. */
export function App() {
  if (GATE) return <GateScreen params={GATE} />;
  return <SourcesRoot />;
}
