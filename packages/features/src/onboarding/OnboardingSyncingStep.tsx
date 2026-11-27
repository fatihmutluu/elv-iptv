import type { CatalogService } from '@elv/data';
import { useI18n, useTheme } from '@elv/ui-kit';
import { type ReactElement, useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SyncAccountPort } from '../ports/wave-f9-ports';

/** Props of {@link OnboardingSyncingStep}. */
export interface OnboardingSyncingStepProps {
  readonly catalog: CatalogService;
  readonly syncAccount?: SyncAccountPort | undefined;
  readonly onRefreshProfiles: () => Promise<void>;
  /** Invoked once initial vault sync & catalog/profile refresh finishes with restored source count. */
  readonly onSyncComplete: (sourcesCount: number) => void;
}

/**
 * Brief vault synchronization step shown strictly after existing-account sign-in or QR transfer (`#513`).
 * Routes straight into the app when `>= 1` source is restored, or advances to Screen 2 if `0`.
 */
export function OnboardingSyncingStep({
  catalog,
  syncAccount,
  onRefreshProfiles,
  onSyncComplete,
}: OnboardingSyncingStepProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const startedRef = useRef(false);
  const callbacksRef = useRef({ onRefreshProfiles, onSyncComplete });
  callbacksRef.current = { onRefreshProfiles, onSyncComplete };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let alive = true;

    void (async () => {
      try {
        await syncAccount?.syncNow();
      } catch {
        // Proceed with locally available sources if network sync fails transiently.
      }
      const [sources] = await Promise.all([
        catalog.listSources().catch(() => []),
        callbacksRef.current.onRefreshProfiles().catch(() => undefined),
      ]);
      if (alive) {
        callbacksRef.current.onSyncComplete(sources.length);
      }
    })();

    return () => {
      alive = false;
    };
  }, [catalog, syncAccount]);

  return (
    <View testID="onboarding-syncing-step" style={styles.root}>
      <Text
        accessibilityRole="header"
        style={[theme.typography.h1, styles.center, { color: theme.colors.textPrimary }]}
      >
        {i18n.t('onboarding.syncing.title')}
      </Text>
      <Text style={[theme.typography.body, styles.center, { color: theme.colors.textSecondary }]}>
        {i18n.t('onboarding.syncing.subtitle')}
      </Text>
      <View
        style={[
          styles.track,
          { backgroundColor: theme.colors.bgSurface, borderRadius: theme.radius.pill },
        ]}
      >
        <View
          style={[
            styles.fill,
            { backgroundColor: theme.colors.accent, borderRadius: theme.radius.pill },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { width: '100%', paddingVertical: 32, alignItems: 'center', gap: 14 },
  center: { textAlign: 'center' },
  track: { width: '72%', maxWidth: 320, height: 6, overflow: 'hidden', marginTop: 6 },
  fill: { width: '58%', height: '100%' },
});
