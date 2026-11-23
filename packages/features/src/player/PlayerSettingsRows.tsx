import { Icon, type IconName, type Theme, webCursorPointer, webTransition } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

/** Blurs a focused web press target so Enter/Space never re-activates stale controls. */
export function blurWebTarget(target: unknown): void {
  if ((Platform.OS as string) === 'web') {
    (target as { blur?: () => void } | null | undefined)?.blur?.();
  }
}

/** Shared Cinema Quietude borderless list-row styles for `PlayerSettingsSheet`. */
export function settingsRowStyle(theme: Theme, focused: boolean, selected: boolean, isTv: boolean) {
  const safeFontScale = Number.isFinite(theme.fontScale) ? Math.max(1, theme.fontScale) : 1;
  return [
    rowStyles.row,
    {
      minHeight: Math.round(38 * safeFontScale),
      borderRadius: focused || selected ? theme.radius.button : 0,
      backgroundColor: selected
        ? theme.colors.accentTint
        : focused
          ? theme.colors.focusFill
          : 'transparent',
      borderColor: focused ? theme.colors.focusRingColor : 'transparent',
      borderWidth: focused ? theme.focus.ringWidth : 0,
      borderBottomWidth: focused ? theme.focus.ringWidth : StyleSheet.hairlineWidth,
      borderBottomColor: focused ? theme.colors.focusRingColor : theme.colors.surfaceBorder,
    },
    webTransition(theme, 'border-color, background-color'),
    !isTv ? webCursorPointer() : undefined,
  ];
}

function TogglePill({
  theme,
  active,
  label,
}: {
  readonly theme: Theme;
  readonly active: boolean;
  readonly label: string;
}): ReactElement {
  return (
    <View
      style={[
        rowStyles.togglePill,
        {
          borderRadius: theme.radius.pill,
          backgroundColor: active ? theme.colors.accent : theme.colors.chipBg,
          borderColor: active ? theme.colors.accent : theme.colors.chipBorder,
        },
      ]}
    >
      <Text
        style={[
          theme.typography.micro,
          { color: active ? theme.colors.accentContrast : theme.colors.textSecondary },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

/** Props of {@link SettingsToggleRow}. */
export interface SettingsToggleRowProps {
  readonly testID: string;
  readonly icon: IconName;
  readonly label: string;
  readonly pillLabel: string;
  readonly active: boolean;
  readonly focused: boolean;
  readonly isTv: boolean;
  readonly role: 'button' | 'switch';
  readonly accessibilityLabel: string;
  readonly theme: Theme;
  readonly onPress: () => void;
}

/** Inline toggle row with icon, title, and `TogglePill` badge for `PlayerSettingsSheet`. */
export function SettingsToggleRow({
  testID,
  icon,
  label,
  pillLabel,
  active,
  focused,
  isTv,
  role,
  accessibilityLabel,
  theme,
  onPress,
}: SettingsToggleRowProps): ReactElement {
  return (
    <Pressable
      testID={testID}
      focusable={!isTv}
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel}
      {...(role === 'switch' ? { accessibilityState: { checked: active } } : {})}
      onPress={(e) => {
        blurWebTarget(e.currentTarget);
        onPress();
      }}
      style={settingsRowStyle(theme, focused, false, isTv)}
    >
      <Icon name={icon} size={18} color={theme.colors.textSecondary} />
      <Text
        numberOfLines={1}
        style={[theme.typography.title, rowStyles.flex1, { color: theme.colors.textPrimary }]}
      >
        {label}
      </Text>
      <TogglePill theme={theme} active={active} label={pillLabel} />
    </Pressable>
  );
}

const rowStyles = StyleSheet.create({
  flex1: { flex: 1 },
  row: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  togglePill: {
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
    minWidth: 44,
    alignItems: 'center',
  },
});
