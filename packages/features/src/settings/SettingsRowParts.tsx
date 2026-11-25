import {
  FilterChip,
  TABULAR_NUMS_STYLE,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/** Single selectable chip option rendered inside {@link SettingsOptionRow}. */
export interface SettingsChipOption<T> {
  readonly value: T;
  readonly label: string;
  readonly focusId: string;
  readonly testID: string;
}

/** Props of {@link SettingsOptionRow}. */
export interface SettingsOptionRowProps<T> {
  readonly title: string;
  readonly description?: string;
  readonly options: readonly SettingsChipOption<T>[];
  readonly selectedValue: T;
  readonly focusedControlId: string | null;
  readonly isTv: boolean;
  readonly tabularNums?: boolean;
  readonly onSelect: (value: T) => void;
  readonly onLayoutY?: (y: number) => void;
}

/** Cinema Quietude preference row presenting wrap-safe selection chips with TV focus support. */
export function SettingsOptionRow<T>({
  title,
  description,
  options,
  selectedValue,
  focusedControlId,
  isTv,
  tabularNums = false,
  onSelect,
  onLayoutY,
}: SettingsOptionRowProps<T>): ReactElement {
  const theme = useTheme();
  return (
    <View
      style={styles.rowHeader}
      onLayout={onLayoutY ? (e) => onLayoutY(e.nativeEvent.layout.y) : undefined}
    >
      <View style={styles.rowText}>
        <Text
          style={[
            theme.typography.title,
            tabularNums ? TABULAR_NUMS_STYLE : undefined,
            { color: theme.colors.textPrimary },
          ]}
        >
          {title}
        </Text>
        {description ? (
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {description}
          </Text>
        ) : null}
      </View>
      <View style={[styles.chipRow, { gap: theme.spacing.xs }]}>
        {options.map((opt) => (
          <FilterChip
            key={opt.testID}
            testID={opt.testID}
            label={opt.label}
            selected={selectedValue === opt.value}
            focused={focusedControlId === opt.focusId}
            focusable={!isTv}
            onPress={() => onSelect(opt.value)}
          />
        ))}
      </View>
    </View>
  );
}

/** Props of {@link SettingsToggleRow}. */
export interface SettingsToggleRowProps {
  readonly testID: string;
  readonly title: string;
  readonly description?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly focused: boolean;
  readonly isTv: boolean;
  readonly onToggle: () => void;
  readonly onLayoutY?: (y: number) => void;
}

/** Cinema Quietude accessible switch row with hover highlight and 10-foot TV focus ring. */
export function SettingsToggleRow({
  testID,
  title,
  description,
  checked,
  disabled = false,
  focused,
  isTv,
  onToggle,
  onLayoutY,
}: SettingsToggleRowProps): ReactElement {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  const transition = webTransition(theme, 'transform, background-color, border-color');
  const cursorPointer = disabled ? undefined : webCursorPointer();

  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={title}
      accessibilityState={{ checked, disabled }}
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      {...(isTv ? { focusable: false } : {})}
      onLayout={onLayoutY ? (e) => onLayoutY(e.nativeEvent.layout.y) : undefined}
      onPress={() => {
        if (!disabled) onToggle();
      }}
      onHoverIn={() => {
        if (!disabled) setHovered(true);
      }}
      onHoverOut={() => setHovered(false)}
      style={[
        styles.toggleRow,
        transition,
        cursorPointer,
        disabled ? styles.disabledRow : undefined,
        {
          borderRadius: theme.radius.card,
          backgroundColor: focused
            ? theme.colors.focusFill
            : hovered && !disabled
              ? theme.colors.subtleHighlight
              : 'transparent',
          borderWidth: focused ? theme.focus.ringWidth : 1,
          borderColor: focused ? theme.colors.focusRingColor : 'transparent',
        },
      ]}
    >
      <View style={styles.rowText}>
        <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>{title}</Text>
        {description ? (
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {description}
          </Text>
        ) : null}
      </View>

      <View
        style={[
          styles.switchTrack,
          transition,
          {
            borderRadius: theme.radius.pill,
            backgroundColor: checked ? theme.colors.accent : theme.colors.bgCard,
            borderColor: checked ? theme.colors.accent : theme.colors.chipBorder,
          },
        ]}
      >
        <View
          style={[
            styles.switchThumb,
            {
              borderRadius: theme.radius.pill,
              backgroundColor: checked ? theme.colors.accentContrast : theme.colors.textPrimary,
              alignSelf: checked ? 'flex-end' : 'flex-start',
            },
          ]}
        />
      </View>
    </Pressable>
  );
}

/** Hairline horizontal separator matching Cinema Quietude card surfaces. */
export function SettingsDivider(): ReactElement {
  const theme = useTheme();
  return <View style={[styles.divider, { backgroundColor: theme.colors.surfaceBorder }]} />;
}

const styles = StyleSheet.create({
  rowHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  rowText: { flex: 1, minWidth: 200, gap: 2 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  divider: { height: 1, width: '100%' },
  toggleRow: {
    minHeight: 48,
    paddingHorizontal: 8,
    paddingVertical: 8,
    marginHorizontal: -8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  },
  switchTrack: { width: 38, height: 22, borderWidth: 1, padding: 2, justifyContent: 'center' },
  switchThumb: { width: 16, height: 16 },
  disabledRow: { opacity: 0.48 },
});
