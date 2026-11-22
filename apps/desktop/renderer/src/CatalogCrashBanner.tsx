import { useI18n, useTheme } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { CatalogBridge } from '../../src/shared/catalog-ipc.ts';

/** Props for {@link CatalogCrashBanner}. */
export interface CatalogCrashBannerProps {
  readonly reconnecting: boolean;
  readonly onRetry: () => void;
}

/**
 * Safely subscribes to `CatalogBridge.onDisconnected` (guarding optional test mocks) and notifies
 * `onDisconnect` when the SQLite `catalog-worker` utility process exits unexpectedly (`#435`).
 */
export function subscribeCatalogDisconnected(
  bridge: Partial<Pick<CatalogBridge, 'onDisconnected'>> | undefined,
  onDisconnect: () => void,
): (() => void) | undefined {
  if (!bridge || typeof bridge.onDisconnected !== 'function') return undefined;
  return bridge.onDisconnected(() => {
    onDisconnect();
  });
}

/**
 * Reopens the desktop `catalog-worker` bridge after an unexpected exit (`#435`).
 * Resolves `true` only when `bridge.open()` returns `{ ok: true }`.
 */
export async function attemptCatalogReconnect(
  bridge: Pick<CatalogBridge, 'open'> | undefined,
): Promise<boolean> {
  if (!bridge) return false;
  try {
    const res = await bridge.open();
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Compact Cinema Quietude top alert bar surfaced when the desktop SQLite `catalog-worker` exits
 * unexpectedly, offering one-click reconnect (`#435`).
 */
export function CatalogCrashBanner({
  reconnecting,
  onRetry,
}: CatalogCrashBannerProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const actionLabel = reconnecting
    ? i18n.t('desktop.catalogDisconnected.reconnecting')
    : i18n.t('desktop.catalogDisconnected.retry');

  return (
    <View
      testID="catalog-crash-banner"
      accessibilityRole="alert"
      style={[
        styles.banner,
        {
          backgroundColor: theme.colors.bgElevated,
          borderBottomColor: theme.colors.glassBorder,
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.sm,
          gap: theme.spacing.sm,
        },
      ]}
    >
      <View style={[styles.lead, { gap: theme.spacing.sm }]}>
        <View style={[styles.indicator, { backgroundColor: theme.colors.liveColor }]} />
        <Text
          numberOfLines={1}
          style={[theme.typography.title, { color: theme.colors.textPrimary, flexShrink: 1 }]}
        >
          {i18n.t('desktop.catalogDisconnected.title')}
        </Text>
      </View>

      <Pressable
        testID="catalog-crash-retry"
        accessibilityRole="button"
        accessibilityLabel={actionLabel}
        accessibilityState={{ disabled: reconnecting, busy: reconnecting }}
        disabled={reconnecting}
        onPress={onRetry}
        style={({ pressed }) => [
          styles.button,
          {
            backgroundColor: theme.colors.ctaBg,
            borderRadius: theme.radius.button,
            paddingHorizontal: theme.spacing.md,
            paddingVertical: theme.spacing.xs,
            opacity: reconnecting ? 0.65 : pressed ? 0.86 : 1,
          },
        ]}
      >
        <Text style={[theme.typography.caption, { color: theme.colors.ctaFg, fontWeight: '700' }]}>
          {actionLabel}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    zIndex: 1000,
  },
  lead: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
  },
  indicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    flexShrink: 0,
  },
  button: {
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
