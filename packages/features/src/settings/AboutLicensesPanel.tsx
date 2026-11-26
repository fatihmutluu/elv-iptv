import { Surface, useI18n, useTheme, useViewport } from '@elv/ui-kit';
import type { ReactElement, ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

/** Props of {@link AboutLicensesPanel}. */
export interface AboutLicensesPanelProps {
  /** Embedded third-party notices component rendered below the About ELV IPTV summary card. */
  readonly children?: ReactNode;
}

/**
 * Cinema Quietude About & Licenses settings section: compact summary card paired
 * with the embedded offline Third-Party Notices browser (`flex: 1`).
 */
export function AboutLicensesPanel({ children }: AboutLicensesPanelProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const compactHeight = viewport.height <= 460;

  return (
    <View
      testID="settings-panel-licenses"
      style={[styles.root, { gap: compactHeight ? theme.spacing.xs : theme.spacing.sm }]}
    >
      <Surface
        testID="settings-about-card"
        tone="surface"
        bordered
        rounded="modal"
        style={styles.aboutCard}
      >
        <View style={styles.headerRow}>
          <Text
            numberOfLines={1}
            style={[theme.typography.title, styles.title, { color: theme.colors.textPrimary }]}
          >
            {i18n.t('settings.about.title')}
          </Text>
        </View>
        <Text
          numberOfLines={compactHeight ? 2 : undefined}
          style={[
            theme.typography.caption,
            styles.statement,
            { color: theme.colors.textSecondary },
          ]}
        >
          {i18n.t('settings.about.statement')}
        </Text>
      </Surface>

      <View style={styles.noticesWrap}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
  },
  aboutCard: {
    padding: 12,
    gap: 6,
  },
  headerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  title: {
    fontWeight: '700',
  },
  statement: {
    maxWidth: 680,
  },
  noticesWrap: {
    flex: 1,
    minHeight: 0,
  },
});
