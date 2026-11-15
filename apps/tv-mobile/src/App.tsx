import { createLazyCatalog, SourcesScreen } from '@elv/features';
import { createAppI18n, resolveLocale } from '@elv/i18n';
import { remoteKeys } from '@elv/remote-keys';
import { FormFactorProvider, I18nProvider, RemoteKeysProvider } from '@elv/ui-kit';
import Constants from 'expo-constants';
import { getLocales } from 'expo-localization';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { createDeviceCatalog } from './catalog';
import { GateListScreen } from './gate/GateListScreen';
import { ImportGateScreen } from './gate/import/ImportGateScreen';
import { PlayerGateScreen } from './gate/player/PlayerGateScreen';
import { useGateRoute } from './gate/useGateParams';
import { createSecureSecretStore } from './storage';

/**
 * Root component that `index.ts` registers, with the raw Android key source provided to both branches.
 * Development builds (`extra.gate`) open the list, import or player gate when an `elviptv://gate/*`
 * link started the app; otherwise mounts the cross-platform `SourcesScreen` (#71).
 */
export function App() {
  const gate = useGateRoute();
  const [refreshToken, setRefreshToken] = useState(0);

  const i18n = useMemo(() => {
    const tags = getLocales().map((locale) => locale.languageTag);
    return createAppI18n(resolveLocale(tags));
  }, []);

  const catalog = useMemo(() => createLazyCatalog(() => createDeviceCatalog()), []);

  useEffect(() => {
    if (gate !== undefined) return;
    let cancelled = false;
    if (__DEV__) {
      const { readEmbeddedDevSeed, runDevSeedOnce } =
        require('./seed/dev-seeder') as typeof import('./seed/dev-seeder');
      const seed = readEmbeddedDevSeed(Constants.expoConfig?.extra);
      if (seed !== undefined) {
        void createDeviceCatalog()
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
  }, [gate]);

  if (gate !== undefined) {
    return (
      <RemoteKeysProvider android={remoteKeys}>
        {gate.name === 'list' && <GateListScreen key={JSON.stringify(gate)} params={gate.params} />}
        {gate.name === 'import' && (
          <ImportGateScreen key={JSON.stringify(gate)} params={gate.params} />
        )}
        {gate.name === 'player' && (
          <PlayerGateScreen key={JSON.stringify(gate)} params={gate.params} />
        )}
        <StatusBar style="light" />
      </RemoteKeysProvider>
    );
  }

  return (
    <RemoteKeysProvider android={remoteKeys}>
      <FormFactorProvider>
        <I18nProvider i18n={i18n}>
          <SourcesScreen catalog={catalog} externalRefreshToken={refreshToken} />
          <StatusBar style="light" />
        </I18nProvider>
      </FormFactorProvider>
    </RemoteKeysProvider>
  );
}
