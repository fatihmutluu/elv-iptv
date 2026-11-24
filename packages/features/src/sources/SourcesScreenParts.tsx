import type { AppI18n } from '@elv/i18n';
import {
  hexToRgba,
  MicroPill,
  type MicroPillTone,
  TvTextInput,
  type TvTextInputInstance,
  useFormFactor,
  useTheme,
  useViewport,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { createImeSubmitGuard } from '../shared/ime-guard';
import type { SourceAccountWarning } from './account-warning';
import { sourcesStyles } from './sources-styles';
import type { ControlLayoutRecorder } from './useTvSourcesNavigation';

export function ActionButton({
  focusId,
  testID,
  label,
  onPress,
  tvFocused,
  active = false,
  primary = false,
  segment = false,
  danger = false,
  disabled = false,
  recordLayout,
}: {
  focusId: string;
  testID: string;
  label: string;
  onPress: () => void;
  tvFocused: boolean;
  active?: boolean;
  primary?: boolean;
  segment?: boolean;
  danger?: boolean;
  disabled?: boolean;
  recordLayout?: ControlLayoutRecorder;
}): ReactElement {
  const isTv = useFormFactor() === 'tv';
  const theme = useTheme();
  const viewport = useViewport();
  const [hovered, setHovered] = useState(false);
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);

  const isTouch = viewport.inputModality === 'touch';
  const transition = webTransition(theme, 'background-color, border-color, opacity, transform');
  const cursor = !disabled ? webCursorPointer() : undefined;

  const isHighContrastFill = primary || active;
  const textColor = isHighContrastFill
    ? theme.colors.ctaFg
    : segment && !hovered
      ? theme.colors.textSecondary
      : theme.colors.textPrimary;

  return (
    <View
      ref={(node) => recordLayout?.(focusId, node)}
      testID={`sources-focus-${focusId}`}
      onLayout={(e) => recordLayout?.(focusId, null, e)}
      style={segment ? sourcesStyles.segmentItem : undefined}
    >
      <Pressable
        testID={testID}
        {...(isTv ? { focusable: false } : {})}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: tvFocused || active, disabled }}
        disabled={disabled}
        onPress={onPress}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
        style={({ pressed }) => {
          const backgroundColor = isHighContrastFill
            ? theme.colors.ctaBg
            : danger
              ? hovered || pressed
                ? hexToRgba(theme.colors.liveColor, 0.22)
                : hexToRgba(theme.colors.liveColor, 0.14)
              : segment
                ? tvFocused
                  ? theme.colors.focusFill
                  : hovered || pressed
                    ? theme.colors.chipHoverBg
                    : 'transparent'
                : tvFocused
                  ? theme.colors.focusFill
                  : hovered || pressed
                    ? theme.colors.actionGlassHoverBg
                    : theme.colors.actionGlassBg;

          const borderColor = danger
            ? hexToRgba(theme.colors.liveColor, 0.5)
            : isHighContrastFill || segment
              ? 'transparent'
              : theme.colors.actionGlassBorder;

          const borderRadius = segment ? theme.radius.card : theme.radius.button;

          return [
            sourcesStyles.button,
            segment ? sourcesStyles.segmentButton : null,
            isTouch ? sourcesStyles.touchTarget : null,
            { backgroundColor, borderColor, borderRadius, borderWidth: 1 },
            tvFocused && !theme.reduceMotion
              ? { transform: [{ scale: theme.focus.buttonScale }] }
              : null,
            pressed && !disabled ? sourcesStyles.buttonPressed : null,
            disabled ? sourcesStyles.buttonDisabled : null,
            transition,
            cursor,
          ];
        }}
      >
        {tvFocused ? (
          <View
            pointerEvents="none"
            testID={`${testID}-focus-ring`}
            style={[
              sourcesStyles.focusRing,
              {
                borderRadius: (segment ? theme.radius.card : theme.radius.button) + 4,
                borderWidth: theme.focus.ringWidth,
                borderColor: theme.colors.focusRingColor,
              },
            ]}
          />
        ) : null}
        <Text
          numberOfLines={1}
          style={[
            theme.typography.title,
            { color: textColor, fontWeight: isHighContrastFill ? '700' : '600' },
          ]}
        >
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

export function FieldInput({
  focusId,
  testID,
  label,
  placeholder,
  value,
  onChangeText,
  tvFocused,
  editingInputId,
  onEndEditing,
  onSubmit,
  secureTextEntry = false,
  multiline = false,
  registerRef,
  recordLayout,
}: {
  focusId: string;
  testID: string;
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (text: string) => void;
  tvFocused: boolean;
  editingInputId: string | null;
  onEndEditing: (focusId: string) => void;
  onSubmit?: () => void;
  secureTextEntry?: boolean;
  multiline?: boolean;
  registerRef: (id: string, node: TvTextInputInstance | null) => void;
  recordLayout?: ControlLayoutRecorder;
}): ReactElement {
  const isTv = useFormFactor() === 'tv';
  const theme = useTheme();
  const [inputFocused, setInputFocused] = useState(false);
  const imeGuardRef = useRef(createImeSubmitGuard());
  const allowNativeEdit = !isTv || editingInputId === focusId;
  const transition = webTransition(theme, 'border-color, background-color');

  const handleKeyPress = useCallback((event: unknown) => {
    imeGuardRef.current.onKeyPress(event);
  }, []);

  const handleSubmitEditing = useCallback(
    (event?: unknown) => {
      if (!imeGuardRef.current.shouldAllowSubmit(event)) return;
      onSubmit?.();
    },
    [onSubmit],
  );

  const borderColor = tvFocused
    ? theme.colors.focusRingColor
    : inputFocused
      ? theme.colors.hoverRingBorder
      : theme.colors.chipBorder;

  return (
    <View style={sourcesStyles.fieldGroup}>
      <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>{label}</Text>
      <View
        ref={(node) => recordLayout?.(focusId, node)}
        testID={`sources-focus-${focusId}`}
        accessibilityState={{ selected: tvFocused }}
        onLayout={(e) => recordLayout?.(focusId, null, e)}
        style={[
          sourcesStyles.inputFrame,
          {
            backgroundColor: theme.colors.bgCard,
            borderColor,
            borderWidth: tvFocused ? theme.focus.ringWidth : 1,
            borderRadius: theme.radius.button,
          },
          transition,
        ]}
      >
        <TvTextInput
          ref={(node) => registerRef(focusId, node)}
          testID={testID}
          accessibilityLabel={label}
          editable={allowNativeEdit}
          focusable={allowNativeEdit}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textMuted}
          value={value}
          onChangeText={onChangeText}
          onFocus={() => setInputFocused(true)}
          onBlur={() => {
            imeGuardRef.current.reset();
            setInputFocused(false);
            onEndEditing(focusId);
          }}
          onKeyPress={handleKeyPress}
          onSubmitEditing={handleSubmitEditing}
          secureTextEntry={secureTextEntry}
          multiline={multiline}
          textAlignVertical={multiline ? 'top' : undefined}
          autoCapitalize="none"
          autoCorrect={false}
          style={[
            sourcesStyles.input,
            multiline ? sourcesStyles.multilineInput : null,
            theme.typography.body,
            { color: theme.colors.textPrimary },
          ]}
        />
      </View>
    </View>
  );
}

/** Subtle Cinema Quietude warning badge for trial, expiring-soon, or expired source accounts (`#170`). */
export function SourceAccountWarningPill({
  sourceId,
  warning,
  i18n,
}: {
  sourceId: string;
  warning: SourceAccountWarning | null;
  i18n: AppI18n;
}): ReactElement | null {
  if (warning === null) return null;
  const label =
    warning.kind === 'expired'
      ? i18n.t('sources.badge.expired')
      : warning.kind === 'expiring-soon'
        ? i18n.t('sources.badge.expiringSoon', { days: warning.days })
        : i18n.t('sources.badge.trial');
  const tone: MicroPillTone = warning.kind === 'expired' ? 'live' : 'accent';
  return (
    <MicroPill
      testID={`source-account-warning-${sourceId}`}
      label={label}
      tone={tone}
      dot={false}
    />
  );
}
