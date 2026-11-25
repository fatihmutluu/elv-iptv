import { CtaButton, Surface, useI18n, useTheme } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SettingsDivider, SettingsToggleRow } from './SettingsRowParts';
import type { AppearanceFocusId } from './useTvSettingsNavigation';

/** Props of {@link DiagnosticsSettingsCard}. */
export interface DiagnosticsSettingsCardProps {
  readonly crashReportsOptIn: boolean;
  readonly crashReportsIncludeLogs: boolean;
  readonly focusedControlId: AppearanceFocusId | null;
  readonly isTv: boolean;
  readonly onToggleOptIn: () => void;
  readonly onToggleIncludeLogs: () => void;
  readonly onPreviewReport?: () => void;
  readonly onLayoutBox?: (box: { readonly y: number; readonly height: number }) => void;
}

/**
 * Cinema Quietude opt-in Crash Diagnostics settings card (`#226`):
 * opt-in toggle, redacted log-tail toggle, and Preview Diagnostic Report button.
 */
export function DiagnosticsSettingsCard({
  crashReportsOptIn,
  crashReportsIncludeLogs,
  focusedControlId,
  isTv,
  onToggleOptIn,
  onToggleIncludeLogs,
  onPreviewReport,
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
        {i18n.t('settings.diagnostics.title')}
      </Text>
      <SettingsToggleRow
        testID="settings-diagnostics-toggle-opt-in"
        title={i18n.t('settings.diagnostics.optInLabel')}
        description={i18n.t('settings.diagnostics.optInHint')}
        checked={crashReportsOptIn}
        focused={focusedControlId === 'toggle-crash-reports-opt-in'}
        isTv={isTv}
        onToggle={onToggleOptIn}
      />
      <SettingsDivider />
      <SettingsToggleRow
        testID="settings-diagnostics-toggle-include-logs"
        title={i18n.t('settings.diagnostics.includeLogsLabel')}
        description={i18n.t('settings.diagnostics.includeLogsHint')}
        checked={crashReportsIncludeLogs}
        focused={focusedControlId === 'toggle-crash-reports-include-logs'}
        isTv={isTv}
        onToggle={onToggleIncludeLogs}
      />
      {onPreviewReport !== undefined ? (
        <>
          <SettingsDivider />
          <View style={styles.actionRow}>
            <CtaButton
              testID="settings-diagnostics-preview"
              variant="secondary"
              label={i18n.t('settings.diagnostics.previewAction')}
              focused={focusedControlId === 'preview-diagnostic-report'}
              focusable={!isTv}
              onPress={onPreviewReport}
            />
          </View>
        </>
      ) : null}
    </Surface>
  );
}

const styles = StyleSheet.create({
  sectionCard: { padding: 18, gap: 14 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
});
