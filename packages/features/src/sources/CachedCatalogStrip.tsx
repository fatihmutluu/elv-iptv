import type { SourceImportHealth } from '@elv/data';
import { CtaButton, hexToRgba, Icon, useI18n, useTheme } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';

/** Props of {@link CachedCatalogStrip}. */
export interface CachedCatalogStripProps {
  /** Failed-refresh health entries from `CatalogService.latestImportHealth()`; strip stays hidden when healthy. */
  readonly health: readonly SourceImportHealth[] | SourceImportHealth | null | undefined;
  /** Invoked when the user triggers the "Check again" retry action. */
  readonly onRetry: () => void;
  /** Disables the retry action and renders a busy label while refreshing. */
  readonly retrying?: boolean;
  /** Optional explicit TV focus highlight override for the retry button. */
  readonly retryFocused?: boolean;
  readonly testID?: string;
}

function hasStaleCachedFailure(
  health: readonly SourceImportHealth[] | SourceImportHealth | null | undefined,
): boolean {
  if (health === null || health === undefined) return false;
  const list = Array.isArray(health) ? health : [health];
  return list.some((entry) => entry.status === 'failed' && entry.hasCachedItems);
}

/**
 * Compact, non-blocking Cinema Quietude status strip displayed when a source's latest catalog
 * refresh failed while cached SQLite rows remain browsable (`#141`). Hidden when healthy.
 */
export function CachedCatalogStrip({
  health,
  onRetry,
  retrying = false,
  retryFocused,
  testID = 'cached-catalog-strip',
}: CachedCatalogStripProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();

  if (!hasStaleCachedFailure(health)) return null;

  const message = i18n.t('sources.cachedCatalog.banner');
  const retryLabel = i18n.t(
    retrying ? 'sources.cachedCatalog.retrying' : 'sources.cachedCatalog.retry',
  );

  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[
        styles.strip,
        {
          backgroundColor: theme.colors.bgElevated,
          borderColor: hexToRgba(theme.colors.liveColor, 0.45),
          borderRadius: theme.radius.card,
        },
      ]}
    >
      <View style={styles.messageRow}>
        <Icon name="warning" size={16} color={theme.colors.liveColor} />
        <Text
          testID="cached-catalog-message"
          numberOfLines={2}
          style={[
            theme.typography.caption,
            styles.messageText,
            { color: theme.colors.textPrimary },
          ]}
        >
          {message}
        </Text>
      </View>
      <CtaButton
        testID="cached-catalog-retry"
        variant="secondary"
        icon="refresh"
        label={retryLabel}
        accessibilityLabel={retryLabel}
        disabled={retrying}
        focused={retryFocused}
        onPress={onRetry}
        style={styles.retryButton}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    minWidth: 180,
  },
  messageText: {
    flex: 1,
  },
  retryButton: {
    minHeight: 40,
  },
});
