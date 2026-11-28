import {
  Icon,
  type IconName,
  MicroPill,
  TABULAR_NUMS_STYLE,
  type Theme,
  Tooltip,
  webCursorPointer,
} from '@elv/ui-kit';
import { type ReactElement, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import type { SettingsRadioItem } from './settings-sheet-items';

const WEB_ROW_HOVER_TRANSITION = {
  transitionProperty: 'background-color, border-color, color',
  transitionDuration: '150ms',
  transitionTimingFunction: 'ease',
} as unknown as ViewStyle;

/** Blurs a focused web press target so Enter/Space never re-activates stale controls. */
export function blurWebTarget(target: unknown): void {
  if ((Platform.OS as string) === 'web') {
    (target as { blur?: () => void } | null | undefined)?.blur?.();
  }
}

/** Shared Cinema Quietude borderless list-row styles for `PlayerSettingsSheet`. */
export function settingsRowStyle(
  theme: Theme,
  focused: boolean,
  selected: boolean,
  isTv: boolean,
  hovered = false,
) {
  const safeFontScale = Number.isFinite(theme.fontScale) ? Math.max(1, theme.fontScale) : 1;
  const activeHover = hovered && !isTv;
  const webHoverTransition =
    (Platform.OS as string) === 'web' && !isTv && !theme.reduceMotion
      ? WEB_ROW_HOVER_TRANSITION
      : undefined;
  return [
    rowStyles.row,
    {
      minHeight: Math.round(38 * safeFontScale),
      borderRadius: focused || selected || activeHover ? theme.radius.button : 0,
      backgroundColor: selected
        ? theme.colors.accentTint
        : focused
          ? theme.colors.focusFill
          : activeHover
            ? theme.colors.actionGlassHoverBg
            : 'transparent',
      borderColor: focused ? theme.colors.focusRingColor : 'transparent',
      borderWidth: focused ? theme.focus.ringWidth : 0,
      borderBottomWidth: focused ? theme.focus.ringWidth : StyleSheet.hairlineWidth,
      borderBottomColor: focused ? theme.colors.focusRingColor : theme.colors.surfaceBorder,
    },
    webHoverTransition,
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

/** Props of {@link SettingsRow}. */
export interface SettingsRowProps {
  readonly testID: string;
  readonly icon: IconName;
  readonly label: string;
  readonly summary: string;
  readonly description?: string | undefined;
  readonly tabular: boolean;
  readonly focused: boolean;
  readonly isTv: boolean;
  readonly theme: Theme;
  readonly onPress: () => void;
}

/** Root navigation row with icon, title, summary, hover tint, and left tooltip for `PlayerSettingsSheet`. */
export function SettingsRow({
  testID,
  icon,
  label,
  summary,
  description,
  tabular,
  focused,
  isTv,
  theme,
  onPress,
}: SettingsRowProps): ReactElement {
  const [hovered, setHovered] = useState(false);
  const activeHover = hovered && !isTv;
  return (
    <Tooltip content={label} description={description} placement="left" disabled={isTv}>
      <Pressable
        testID={testID}
        focusable={!isTv}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${summary}`}
        onHoverIn={isTv ? undefined : () => setHovered(true)}
        onHoverOut={isTv ? undefined : () => setHovered(false)}
        onPress={(e) => {
          blurWebTarget(e.currentTarget);
          onPress();
        }}
        style={settingsRowStyle(theme, focused, false, isTv, activeHover)}
      >
        <Icon
          name={icon}
          size={18}
          color={activeHover ? theme.colors.accent : theme.colors.textSecondary}
        />
        <Text
          numberOfLines={1}
          style={[theme.typography.title, rowStyles.flex1, { color: theme.colors.textPrimary }]}
        >
          {label}
        </Text>
        <Text
          numberOfLines={1}
          style={[
            theme.typography.caption,
            tabular ? TABULAR_NUMS_STYLE : undefined,
            rowStyles.summary,
            { color: theme.colors.textSecondary },
          ]}
        >
          {summary}
        </Text>
        <Icon
          name="chevronRight"
          size={16}
          color={activeHover ? theme.colors.accent : theme.colors.textMuted}
        />
      </Pressable>
    </Tooltip>
  );
}

/** Props of {@link SettingsToggleRow}. */
export interface SettingsToggleRowProps {
  readonly testID: string;
  readonly icon: IconName;
  readonly label: string;
  readonly description?: string | undefined;
  readonly pillLabel: string;
  readonly active: boolean;
  readonly focused: boolean;
  readonly isTv: boolean;
  readonly role: 'button' | 'switch';
  readonly accessibilityLabel: string;
  readonly theme: Theme;
  readonly onPress: () => void;
}

/** Inline toggle row with icon, title, `TogglePill` badge, hover tint, and left tooltip for `PlayerSettingsSheet`. */
export function SettingsToggleRow({
  testID,
  icon,
  label,
  description,
  pillLabel,
  active,
  focused,
  isTv,
  role,
  accessibilityLabel,
  theme,
  onPress,
}: SettingsToggleRowProps): ReactElement {
  const [hovered, setHovered] = useState(false);
  const activeHover = hovered && !isTv;
  return (
    <Tooltip content={label} description={description} placement="left" disabled={isTv}>
      <Pressable
        testID={testID}
        focusable={!isTv}
        accessibilityRole={role}
        accessibilityLabel={accessibilityLabel}
        {...(role === 'switch' ? { accessibilityState: { checked: active } } : {})}
        onHoverIn={isTv ? undefined : () => setHovered(true)}
        onHoverOut={isTv ? undefined : () => setHovered(false)}
        onPress={(e) => {
          blurWebTarget(e.currentTarget);
          onPress();
        }}
        style={settingsRowStyle(theme, focused, false, isTv, activeHover)}
      >
        <Icon
          name={icon}
          size={18}
          color={activeHover ? theme.colors.accent : theme.colors.textSecondary}
        />
        <Text
          numberOfLines={1}
          style={[theme.typography.title, rowStyles.flex1, { color: theme.colors.textPrimary }]}
        >
          {label}
        </Text>
        <TogglePill theme={theme} active={active} label={pillLabel} />
      </Pressable>
    </Tooltip>
  );
}

/** Props of {@link SettingsRadioRow}. */
export interface SettingsRadioRowProps {
  readonly item: SettingsRadioItem;
  readonly focused: boolean;
  readonly isTv: boolean;
  readonly theme: Theme;
}

/** Level-2 radio/action row with pointer hover tint for `PlayerSettingsSheet`. */
export function SettingsRadioRow({
  item,
  focused,
  isTv,
  theme,
}: SettingsRadioRowProps): ReactElement {
  const [hovered, setHovered] = useState(false);
  const disabled = item.disabled === true;
  const activeHover = hovered && !isTv && !disabled;
  return (
    <Pressable
      testID={item.testID}
      disabled={disabled}
      focusable={!isTv && !disabled}
      accessibilityRole={item.role ?? 'radio'}
      accessibilityLabel={
        item.disabledHint !== undefined ? `${item.label} (${item.disabledHint})` : item.label
      }
      accessibilityState={
        (item.role ?? 'radio') === 'radio'
          ? {
              selected: item.selected,
              checked: item.selected,
              ...(disabled ? { disabled: true } : {}),
            }
          : { ...(disabled ? { disabled: true } : {}) }
      }
      {...((item.role ?? 'radio') === 'radio' ? { 'aria-checked': item.selected } : {})}
      onHoverIn={isTv || disabled ? undefined : () => setHovered(true)}
      onHoverOut={isTv || disabled ? undefined : () => setHovered(false)}
      onPress={(e) => {
        if (disabled) return;
        blurWebTarget(e.currentTarget);
        item.onPress();
      }}
      style={[
        settingsRowStyle(theme, focused, item.selected, isTv, activeHover),
        disabled ? rowStyles.disabledRow : undefined,
      ]}
    >
      <Text
        numberOfLines={1}
        style={[
          theme.typography.title,
          item.tabular === true ? TABULAR_NUMS_STYLE : undefined,
          rowStyles.flex1,
          {
            color: disabled
              ? theme.colors.textMuted
              : item.selected
                ? theme.colors.textPrimary
                : theme.colors.textSecondary,
            fontWeight: item.selected ? '700' : '500',
          },
        ]}
      >
        {item.label}
      </Text>
      {item.badgeLabel !== undefined ? <MicroPill label={item.badgeLabel} tone="accent" /> : null}
      {item.disabledHint !== undefined ? (
        <MicroPill label={item.disabledHint} tone="neutral" />
      ) : null}
      {item.trailingIcon !== undefined ? (
        <Icon
          name={item.trailingIcon}
          size={16}
          color={activeHover ? theme.colors.accent : theme.colors.textMuted}
        />
      ) : null}
      {item.selected ? <Icon name="check" size={16} color={theme.colors.accent} /> : null}
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
  summary: { maxWidth: 120, textAlign: 'right' },
  disabledRow: { opacity: 0.55 },
  togglePill: {
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
    minWidth: 44,
    alignItems: 'center',
  },
});
