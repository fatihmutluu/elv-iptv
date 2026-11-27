import { Surface, useI18n, useTheme } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text } from 'react-native';
import { SettingsToggleRow } from './SettingsRowParts';
import type { AppearanceFocusId } from './useTvSettingsNavigation';

/** Props of {@link DiagnosticsSettingsCard}. */
export interface DiagnosticsSettingsCardProps {
  /** Unified opt-in flag covering anonymous diagnostics, crash reports, and performance metrics. */
  readonly diagnosticsEnabled: boolean;
  readonly focusedControlId: AppearanceFocusId | null;
  readonly isTv: boolean;
  readonly onToggleDiagnostics: () => void;
  readonly onLayoutBox?: (box: { readonly y: number; readonly height: number }) => void;
}

/**
 * Cinema Quietude unified Diagnostics & Performance Telemetry settings card (`#509`, `[1.6]`).
 * Placed directly above Reset at the bottom of `Settings -> Appearance`.
 */
export function DiagnosticsSettingsCard({
  diagnosticsEnabled,
  focusedControlId,
  isTv,
  onToggleDiagnostics,
  onLayoutBox,
}: DiagnosticsSettingsCardProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  return (
    <Surface
      testID="settings-section-diagnostics"
      tone="surface"
      bordered
      rounded="modal"
      style={styles.sectionCard}
      onLayout={
        onLayoutBox !== undefined
          ? (e) =>
              onLayoutBox({
                y: e.nativeEvent.layout.y,
                height: e.nativeEvent.layout.height,
              })
          : undefined
      }
    >
      <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
        {i18n.t('settings.diagnostics.unifiedTitle')}
      </Text>
      <SettingsToggleRow
        testID="settings-diagnostics-unified-toggle"
        title={i18n.t('settings.diagnostics.unifiedToggle')}
        description={i18n.t('settings.diagnostics.unifiedDescription')}
        checked={diagnosticsEnabled}
        focused={focusedControlId === 'toggle-crash-reports-opt-in'}
        isTv={isTv}
        onToggle={onToggleDiagnostics}
      />
    </Surface>
  );
}

const styles = StyleSheet.create({
  sectionCard: { padding: 18, gap: 14 },
});
