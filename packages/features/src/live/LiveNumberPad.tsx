import {
  IconButton,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { LiveNumberFeedback } from './useLiveCatalog';

const NUMPAD_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['C', '0', '↵'],
] as const;

const NumpadKeyButton = memo(function NumpadKeyButtonInner(p: {
  readonly keyValue: string;
  readonly accessibilityLabel: string;
  readonly isTv: boolean;
  readonly isTouch: boolean;
  readonly focused: boolean;
  readonly onPressKey: (keyValue: string) => void;
}): ReactElement {
  const theme = useTheme();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, transform, opacity');
  const handlePress = useCallback(() => p.onPressKey(p.keyValue), [p.keyValue, p.onPressKey]);
  const isSubmit = p.keyValue === '↵';
  const minSize = p.isTouch ? 44 : 40;
  const bg = isSubmit
    ? theme.colors.ctaBg
    : p.focused
      ? theme.colors.focusFill
      : p.keyValue === 'C'
        ? theme.colors.chipBg
        : theme.colors.bgCard;

  return (
    <Pressable
      testID={`live-numpad-key-${p.keyValue}`}
      accessibilityRole="button"
      accessibilityLabel={p.accessibilityLabel}
      focusable={!p.isTv}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.numKey,
        {
          minWidth: minSize,
          minHeight: minSize,
          borderRadius: theme.radius.button,
          backgroundColor: bg,
          borderWidth: p.focused ? theme.focus.ringWidth : 1,
          borderColor: p.focused
            ? theme.colors.focusRingColor
            : isSubmit
              ? theme.colors.ctaBg
              : theme.colors.surfaceBorder,
          opacity: pressed ? 0.8 : 1,
          transform: [{ scale: p.focused ? theme.focus.buttonScale : 1 }],
        },
        cursor,
        transition,
      ]}
    >
      <Text
        style={[
          theme.typography.title,
          TABULAR_NUMS_STYLE,
          { color: isSubmit ? theme.colors.ctaFg : theme.colors.textPrimary, fontWeight: '700' },
        ]}
      >
        {p.keyValue}
      </Text>
    </Pressable>
  );
});

/** Props of {@link LiveNumberPad}. */
export interface LiveNumberPadProps {
  readonly visible: boolean;
  readonly buffer: string;
  readonly feedback: LiveNumberFeedback | null;
  readonly isTv: boolean;
  readonly isTouch: boolean;
  readonly focusedKey?: string | null;
  readonly onDigit: (digit: string) => void;
  readonly onClear: () => void;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
}

/**
 * Compact `0–9` elevated glass Channel Number Pad overlay (`#44`/`#54`) with tabular digit display,
 * not-found feedback, and `>= 40x40` touch keys.
 */
export const LiveNumberPad = memo(function LiveNumberPadInner(
  p: LiveNumberPadProps,
): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const handlePressKey = useCallback(
    (k: string) => {
      if (k === 'C') p.onClear();
      else if (k === '↵') p.onSubmit();
      else p.onDigit(k);
    },
    [p.onClear, p.onDigit, p.onSubmit],
  );
  if (!p.visible) return null;

  const clearLabel = i18n.t('live.numberClear');
  const submitLabel = i18n.t('live.numberJump');

  return (
    <View
      testID="live-numpad"
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.bgElevated,
          borderColor: theme.colors.glassBorder,
          borderRadius: theme.radius.modal,
          padding: theme.spacing.sm,
        },
        webBackdropBlur(16),
      ]}
    >
      <View style={styles.header}>
        <Text
          numberOfLines={1}
          style={[
            theme.typography.caption,
            { color: theme.colors.textSecondary, fontWeight: '600' },
          ]}
        >
          {i18n.t('live.numberPad')}
        </Text>
        <IconButton
          testID="live-numpad-close"
          icon="close"
          accessibilityLabel={i18n.t('ui.dismiss')}
          focusable={!p.isTv}
          onPress={p.onClose}
        />
      </View>

      <View
        style={[
          styles.displayBox,
          {
            backgroundColor: theme.colors.bgSurface,
            borderColor: theme.colors.surfaceBorder,
            borderRadius: theme.radius.button,
          },
        ]}
      >
        <Text
          testID="live-numpad-display"
          numberOfLines={1}
          style={[
            theme.typography.h2,
            TABULAR_NUMS_STYLE,
            { color: p.buffer.length > 0 ? theme.colors.textPrimary : theme.colors.textMuted },
          ]}
        >
          {p.buffer.length > 0 ? p.buffer : '—'}
        </Text>
      </View>

      {p.feedback ? (
        <Text
          testID="live-numpad-feedback"
          numberOfLines={1}
          style={[theme.typography.caption, { color: theme.colors.liveColor, marginBottom: 6 }]}
        >
          {i18n.t('live.numberNotFound', { number: p.feedback.number })}
        </Text>
      ) : null}

      <View style={styles.grid}>
        {NUMPAD_ROWS.map((row) => (
          <View key={row.join('-')} style={styles.row}>
            {row.map((k) => (
              <NumpadKeyButton
                key={k}
                keyValue={k}
                accessibilityLabel={k === 'C' ? clearLabel : k === '↵' ? submitLabel : k}
                isTv={p.isTv}
                isTouch={p.isTouch}
                focused={p.isTv && p.focusedKey === k}
                onPressKey={handlePressKey}
              />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  card: { width: 212, borderWidth: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  displayBox: {
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignItems: 'flex-end',
    marginBottom: 8,
  },
  grid: { gap: 6 },
  row: { flexDirection: 'row', gap: 6 },
  numKey: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
