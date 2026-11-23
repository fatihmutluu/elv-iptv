import type { TvClockMode } from '@elv/domain';
import { CtaButton, FilterChip, Surface, TABULAR_NUMS_STYLE, useI18n, useTheme } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TV_CLOCK_MODE_OPTIONS } from './appearance-controls';
import { SettingsDivider } from './SettingsRowParts';
import type { AppearanceFocusId } from './useTvSettingsNavigation';

/** Props of {@link TvDisplaySettingsCard}. */
export interface TvDisplaySettingsCardProps {
  readonly overscanX: number;
  readonly overscanY: number;
  readonly tvClockMode: TvClockMode;
  readonly focusedControlId: AppearanceFocusId | null;
  readonly onStepOverscan: (axis: 'x' | 'y', delta: number) => void;
  readonly onSelectTvClockMode: (mode: TvClockMode) => void;
  readonly onLayoutBox: (box: { readonly y: number; readonly height: number }) => void;
}

function OverscanAxisRow({
  axis,
  title,
  value,
  decFocusId,
  incFocusId,
  focusedControlId,
  onStep,
}: {
  readonly axis: 'x' | 'y';
  readonly title: string;
  readonly value: number;
  readonly decFocusId: AppearanceFocusId;
  readonly incFocusId: AppearanceFocusId;
  readonly focusedControlId: AppearanceFocusId | null;
  readonly onStep: (delta: number) => void;
}): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const pct = Math.round(value * 100);
  const valueLabel = i18n.t('settings.overscanValue', { pct });
  const atMin = pct <= 0;
  const atMax = pct >= 10;

  return (
    <View style={styles.rowHeader}>
      <View style={styles.rowText}>
        <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>{title}</Text>
      </View>
      <View style={[styles.stepperRow, { gap: theme.spacing.xs }]}>
        <CtaButton
          testID={`settings-overscan-${axis}-dec`}
          variant="secondary"
          label="−"
          accessibilityLabel={`${title}: −1% (${valueLabel})`}
          disabled={atMin}
          focused={focusedControlId === decFocusId}
          focusable={false}
          onPress={() => onStep(-0.01)}
          style={styles.stepButton}
        />
        <Text
          testID={`settings-overscan-${axis}-value`}
          style={[
            theme.typography.title,
            TABULAR_NUMS_STYLE,
            styles.valueText,
            { color: theme.colors.textPrimary },
          ]}
        >
          {valueLabel}
        </Text>
        <CtaButton
          testID={`settings-overscan-${axis}-inc`}
          variant="secondary"
          label="+"
          accessibilityLabel={`${title}: +1% (${valueLabel})`}
          disabled={atMax}
          focused={focusedControlId === incFocusId}
          focusable={false}
          onPress={() => onStep(0.01)}
          style={styles.stepButton}
        />
      </View>
    </View>
  );
}

/**
 * TV-only Display & Safe-Area card inside `AppearancePanel`:
 * configurable Horizontal & Vertical Overscan safe margins (`0%–10%`, `#133`)
 * and configurable Ambient TV Clock (`Always | Menus | Player | Never`, `#416`).
 */
export function TvDisplaySettingsCard({
  overscanX,
  overscanY,
  tvClockMode,
  focusedControlId,
  onStepOverscan,
  onSelectTvClockMode,
  onLayoutBox,
}: TvDisplaySettingsCardProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  return (
    <Surface
      testID="settings-section-tv-display"
      tone="surface"
      bordered
      rounded="modal"
      style={styles.sectionCard}
      onLayout={(e) => {
        onLayoutBox({
          y: e.nativeEvent.layout.y,
          height: e.nativeEvent.layout.height,
        });
      }}
    >
      <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
        {i18n.t('settings.overscanHint')}
      </Text>

      <OverscanAxisRow
        axis="x"
        title={i18n.t('settings.overscanX')}
        value={overscanX}
        decFocusId="overscan-x-dec"
        incFocusId="overscan-x-inc"
        focusedControlId={focusedControlId}
        onStep={(delta) => onStepOverscan('x', delta)}
      />

      <SettingsDivider />

      <OverscanAxisRow
        axis="y"
        title={i18n.t('settings.overscanY')}
        value={overscanY}
        decFocusId="overscan-y-dec"
        incFocusId="overscan-y-inc"
        focusedControlId={focusedControlId}
        onStep={(delta) => onStepOverscan('y', delta)}
      />

      <SettingsDivider />

      <View style={styles.rowHeader}>
        <View style={styles.rowText}>
          <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
            {i18n.t('settings.tvClockMode')}
          </Text>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {i18n.t('settings.tvClockModeHint')}
          </Text>
        </View>
        <View style={[styles.chipRow, { gap: theme.spacing.xs }]}>
          {TV_CLOCK_MODE_OPTIONS.map((opt) => (
            <FilterChip
              key={opt.id}
              testID={opt.testID}
              label={i18n.t(opt.labelKey)}
              selected={tvClockMode === opt.id}
              focused={focusedControlId === opt.focusId}
              focusable={false}
              onPress={() => onSelectTvClockMode(opt.id)}
            />
          ))}
        </View>
      </View>
    </Surface>
  );
}

const styles = StyleSheet.create({
  sectionCard: { padding: 18, gap: 14 },
  rowHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  rowText: { flex: 1, minWidth: 200, gap: 2 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  stepperRow: { flexDirection: 'row', alignItems: 'center' },
  stepButton: { minWidth: 44, minHeight: 40, paddingHorizontal: 14 },
  valueText: { minWidth: 48, textAlign: 'center', fontWeight: '700' },
});
