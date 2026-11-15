import type { CatalogService } from '@elv/data';
import { type AppLifecyclePort, AppShell, createLazyCatalog, type VideoHost } from '@elv/features';
import { createAppI18n, resolveLocale } from '@elv/i18n';
import { remoteKeys } from '@elv/remote-keys';
import { FormFactorProvider, I18nProvider, RemoteKeysProvider } from '@elv/ui-kit';
import Constants from 'expo-constants';
import { getLocales } from 'expo-localization';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import { createDeviceCatalog } from './catalog';
import { ContractGateScreen } from './gate/contract/ContractGateScreen';
import { GateListScreen } from './gate/GateListScreen';
import { ImportGateScreen } from './gate/import/ImportGateScreen';
import { PlayerGateScreen } from './gate/player/PlayerGateScreen';
import { useGateRoute } from './gate/useGateParams';
import { PlayerSurface } from './playback/PlayerSurface';
import { createPlatformEngine } from './playback/platform-engine';
import { createSecureSecretStore } from './storage';

function AppRoot() {
  const [refreshToken, setRefreshToken] = useState(0);

  const i18n = useMemo(() => {
    const tags = getLocales().map((locale) => locale.languageTag);
    return createAppI18n(resolveLocale(tags));
  }, []);

  const openSharedCatalog = useMemo(() => {
    let cached: Promise<CatalogService> | undefined;
    return () => {
      cached ??= createDeviceCatalog().catch((err: unknown) => {
        cached = undefined;
        throw err;
      });
      return cached;
    };
  }, []);

  const catalog = useMemo(() => createLazyCatalog(openSharedCatalog), [openSharedCatalog]);

  const videoHost = useMemo<VideoHost>(
    () => ({
      open() {
        const engine = createPlatformEngine();
        if (engine === null) return null;
        return {
          engine,
          renderSurface: ({ testID }) => (
            <PlayerSurface
              engine={engine}
              style={styles.surface}
              {...(testID !== undefined ? { testID } : {})}
            />
          ),
        };
      },
    }),
    [],
  );

  const appLifecycle = useMemo<AppLifecyclePort>(
    () => ({
      subscribe(listener) {
        const sub = AppState.addEventListener('change', (nextState) => {
          if (nextState === 'active') listener('active');
          else if (nextState === 'background') listener('background');
        });
        return () => {
          sub.remove();
        };
      },
    }),
    [],
  );

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

  return (
    <FormFactorProvider>
      <I18nProvider i18n={i18n}>
        <AppShell
          catalog={catalog}
          videoHost={videoHost}
          appLifecycle={appLifecycle}
          externalRefreshToken={refreshToken}
        />
        <StatusBar style="light" />
      </I18nProvider>
    </FormFactorProvider>
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

  if (gate === 'pending') {
    return (
      <RemoteKeysProvider android={remoteKeys}>
        <View style={styles.pending}>
          <StatusBar style="light" />
        </View>
      </RemoteKeysProvider>
    );
  }

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
        {gate.name === 'contract' && (
          <ContractGateScreen key={JSON.stringify(gate)} params={gate.params} />
        )}
        <StatusBar style="light" />
      </RemoteKeysProvider>
    );
  }

  return (
    <RemoteKeysProvider android={remoteKeys}>
      <AppRoot />
    </RemoteKeysProvider>
  );
}

const styles = StyleSheet.create({
  pending: { flex: 1, backgroundColor: '#0b0e14' },
  surface: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
});
