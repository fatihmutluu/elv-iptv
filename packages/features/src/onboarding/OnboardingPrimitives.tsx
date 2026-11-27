import type { KeyEvent } from '@elv/focus-core';
import {
  CtaButton,
  TABULAR_NUMS_STYLE,
  TvTextInput,
  useI18n,
  useKeyInterpreter,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

/** Props of {@link OnboardingTextField}. */
export interface OnboardingTextFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  readonly placeholder?: string;
  readonly secureTextEntry?: boolean;
  readonly keyboardType?: 'default' | 'email-address' | 'url';
  readonly autoComplete?: 'email' | 'password' | 'new-password' | 'off';
  readonly editable?: boolean;
  readonly onBlur?: () => void;
  readonly onSubmitEditing?: () => void;
  readonly testID: string;
}

/** Cinema Quietude framed text field for onboarding inputs with TV text-entry suspension. */
export function OnboardingTextField({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry = false,
  keyboardType = 'default',
  autoComplete = 'off',
  editable = true,
  onBlur,
  onSubmitEditing,
  testID,
}: OnboardingTextFieldProps): ReactElement {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const transition = webTransition(theme, 'background-color, border-color');

  return (
    <View style={styles.field}>
      <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>{label}</Text>
      <View
        testID={`${testID}-frame`}
        style={[
          styles.inputFrame,
          transition,
          {
            backgroundColor: focused ? theme.colors.focusFill : theme.colors.bgSurface,
            borderColor: focused ? theme.colors.focusRingColor : theme.colors.chipBorder,
            borderWidth: focused ? theme.focus.ringWidth : 1,
            borderRadius: theme.radius.button,
          },
        ]}
      >
        <TvTextInput
          testID={testID}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textMuted}
          secureTextEntry={secureTextEntry}
          keyboardType={keyboardType}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete={autoComplete}
          editable={editable}
          accessibilityLabel={label}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            onBlur?.();
          }}
          onSubmitEditing={onSubmitEditing}
          style={[theme.typography.body, styles.input, { color: theme.colors.textPrimary }]}
        />
      </View>
    </View>
  );
}

/** Props of {@link OnboardingSwitchRow}. */
export interface OnboardingSwitchRowProps {
  readonly testID: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly compact?: boolean;
  readonly onToggle: () => void;
}

/** Accessible Cinema Quietude toggle switch row usable with TV D-pad, pointer, and touch. */
export function OnboardingSwitchRow({
  testID,
  title,
  subtitle,
  checked,
  disabled = false,
  compact = false,
  onToggle,
}: OnboardingSwitchRowProps): ReactElement {
  const theme = useTheme();
  const cursorPointer = !disabled ? webCursorPointer() : undefined;
  const transition = webTransition(theme, 'background-color, border-color, opacity');

  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={title}
      accessibilityState={{ checked, disabled }}
      aria-checked={checked}
      disabled={disabled}
      focusable={!disabled}
      onPress={onToggle}
      style={(state) => [
        compact ? styles.switchRowCompact : styles.switchRow,
        cursorPointer,
        transition,
        {
          borderRadius: theme.radius.card,
          backgroundColor: state.focused ? theme.colors.focusFill : theme.colors.bgCard,
          borderWidth: state.focused ? theme.focus.ringWidth : 1,
          borderColor: state.focused
            ? theme.colors.focusRingColor
            : checked
              ? theme.colors.glassBorder
              : theme.colors.surfaceBorder,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <View style={styles.flex1}>
        <Text
          style={[
            compact ? theme.typography.caption : theme.typography.title,
            { color: theme.colors.textPrimary },
          ]}
        >
          {title}
        </Text>
        {subtitle !== undefined ? (
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View
        style={[
          styles.switchTrack,
          {
            borderRadius: theme.radius.pill,
            backgroundColor: checked ? theme.colors.accent : theme.colors.bgSurface,
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

/** TV remote Back key + web Escape key handler for in-tree onboarding overlays. */
export function OnboardingBackBridge({
  enabled,
  isTv,
  onBack,
}: {
  readonly enabled: boolean;
  readonly isTv: boolean;
  readonly onBack: (() => void) | undefined;
}): null {
  const handleKey = useCallback(
    (event: KeyEvent): boolean => {
      if (!enabled || onBack === undefined) return false;
      if (event.kind === 'press' && event.key === 'back') {
        onBack();
        return true;
      }
      return false;
    },
    [enabled, onBack],
  );
  useKeyInterpreter(handleKey);

  useEffect(() => {
    if (!enabled || onBack === undefined || isTv || (Platform.OS as string) !== 'web') {
      return undefined;
    }
    const win = globalThis as {
      addEventListener?: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
      removeEventListener?: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
    };
    const onKeyDown = (e: { key?: string; preventDefault?: () => void }) => {
      if (e.key === 'Escape') {
        e.preventDefault?.();
        onBack();
      }
    };
    win.addEventListener?.('keydown', onKeyDown);
    return () => win.removeEventListener?.('keydown', onKeyDown);
  }, [enabled, isTv, onBack]);

  return null;
}

/** Recovery code acknowledgment card displayed after new-account E2EE registration in Screen 1. */
export function OnboardingRecoveryCard({
  recoveryCode,
  isTv,
  onAcknowledge,
}: {
  readonly recoveryCode: string;
  readonly isTv: boolean;
  readonly onAcknowledge: () => void;
}): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

  return (
    <View
      testID="onboarding-recovery-banner"
      style={[
        styles.recoveryBox,
        {
          backgroundColor: theme.colors.bgCard,
          borderColor: theme.colors.accent,
          borderRadius: theme.radius.card,
        },
      ]}
    >
      <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
        {i18n.t('account.recoveryTitle')}
      </Text>
      <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
        {i18n.t('account.recoveryBody')}
      </Text>
      <View
        style={[
          styles.codeBox,
          {
            backgroundColor: theme.colors.bgCanvas,
            borderColor: theme.colors.surfaceBorder,
            borderRadius: theme.radius.button,
          },
        ]}
      >
        <Text
          testID="onboarding-recovery-code"
          selectable
          style={[
            theme.typography.title,
            TABULAR_NUMS_STYLE,
            { color: theme.colors.textPrimary, fontFamily: monoFont, textAlign: 'center' },
          ]}
        >
          {recoveryCode}
        </Text>
      </View>
      <CtaButton
        testID="onboarding-recovery-saved-btn"
        variant="primary"
        label={i18n.t('account.recoverySavedAction')}
        hasTVPreferredFocus={isTv}
        onPress={onAcknowledge}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  inputFrame: { minHeight: 42, borderWidth: 1, justifyContent: 'center' },
  input: { minHeight: 40, paddingHorizontal: 12, paddingVertical: 8 },
  flex1: { flex: 1, gap: 2 },
  switchRow: {
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  switchRowCompact: {
    minHeight: 40,
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  switchTrack: { width: 38, height: 22, borderWidth: 1, padding: 2, justifyContent: 'center' },
  switchThumb: { width: 16, height: 16 },
  recoveryBox: { borderWidth: 1, padding: 16, gap: 12 },
  codeBox: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12 },
});
