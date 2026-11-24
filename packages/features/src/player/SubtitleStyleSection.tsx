import {
  DEFAULT_SUBTITLE_STYLE,
  SUBTITLE_BG_COLORS,
  SUBTITLE_EDGE_STYLES,
  SUBTITLE_FONT_SIZES,
  SUBTITLE_TEXT_COLORS,
  SUBTITLE_VERTICAL_POSITIONS,
  type SubtitleBgColor,
  type SubtitleEdgeStyle,
  type SubtitleFontSize,
  type SubtitleStyleConfig,
  type SubtitleTextColor,
  type SubtitleVerticalPosition,
  subtitleStyleEquals,
} from '@elv/domain';
import type { AppI18n, MessageId } from '@elv/i18n';
import { Icon, useTheme, webCursorPointer, webTransition } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { blurWebTarget, settingsRowStyle } from './PlayerSettingsRows';
import {
  SUBTITLE_BG_COLOR_LABELS,
  SUBTITLE_EDGE_STYLE_LABELS,
  SUBTITLE_FONT_SIZE_LABELS,
  SUBTITLE_TEXT_COLOR_LABELS,
  SUBTITLE_VERTICAL_POS_LABELS,
  type SubtitleStyleField,
  stepSubtitleStyleField,
} from './subtitle-style-helpers';

interface StyleFieldDescriptor<T extends string> {
  readonly field: SubtitleStyleField;
  readonly labelId: MessageId;
  readonly options: readonly T[];
  readonly current: T;
  readonly optionLabel: (value: T) => MessageId;
  readonly apply: (value: T) => SubtitleStyleConfig;
}

/** Props of {@link SubtitleStyleSection}. */
export interface SubtitleStyleSectionProps {
  readonly style: SubtitleStyleConfig;
  readonly focusedIndex: number;
  readonly showCursor: boolean;
  readonly isTv: boolean;
  readonly i18n: AppI18n;
  readonly onChange: (next: SubtitleStyleConfig) => void;
}

/**
 * Live Cinema Quietude subtitle appearance controls inside `PlayerSettingsSheet` (`#32`).
 * 100% TV D-pad navigable via Up/Down/Left/Right/Select, zero hardcoded hex colors, zero restart.
 */
export function SubtitleStyleSection({
  style,
  focusedIndex,
  showCursor,
  isTv,
  i18n,
  onChange,
}: SubtitleStyleSectionProps): ReactElement {
  const theme = useTheme();
  const isDefault = subtitleStyleEquals(style, DEFAULT_SUBTITLE_STYLE);

  const fields: readonly StyleFieldDescriptor<string>[] = [
    {
      field: 'fontSize',
      labelId: 'player.subtitleStyle.size',
      options: SUBTITLE_FONT_SIZES,
      current: style.fontSize,
      optionLabel: (v) => SUBTITLE_FONT_SIZE_LABELS[v as SubtitleFontSize],
      apply: (v) => ({ ...style, fontSize: v as SubtitleFontSize }),
    },
    {
      field: 'textColor',
      labelId: 'player.subtitleStyle.color',
      options: SUBTITLE_TEXT_COLORS,
      current: style.textColor,
      optionLabel: (v) => SUBTITLE_TEXT_COLOR_LABELS[v as SubtitleTextColor],
      apply: (v) => ({ ...style, textColor: v as SubtitleTextColor }),
    },
    {
      field: 'backgroundColor',
      labelId: 'player.subtitleStyle.background',
      options: SUBTITLE_BG_COLORS,
      current: style.backgroundColor,
      optionLabel: (v) => SUBTITLE_BG_COLOR_LABELS[v as SubtitleBgColor],
      apply: (v) => ({ ...style, backgroundColor: v as SubtitleBgColor }),
    },
    {
      field: 'edgeStyle',
      labelId: 'player.subtitleStyle.edge',
      options: SUBTITLE_EDGE_STYLES,
      current: style.edgeStyle,
      optionLabel: (v) => SUBTITLE_EDGE_STYLE_LABELS[v as SubtitleEdgeStyle],
      apply: (v) => ({ ...style, edgeStyle: v as SubtitleEdgeStyle }),
    },
    {
      field: 'verticalPosition',
      labelId: 'player.subtitleStyle.position',
      options: SUBTITLE_VERTICAL_POSITIONS,
      current: style.verticalPosition,
      optionLabel: (v) => SUBTITLE_VERTICAL_POS_LABELS[v as SubtitleVerticalPosition],
      apply: (v) => ({ ...style, verticalPosition: v as SubtitleVerticalPosition }),
    },
  ];

  const resetFocused = showCursor && focusedIndex === fields.length;

  return (
    <View testID="player-subtitle-style-section" style={styles.root}>
      {fields.map((row, idx) => {
        const focused = showCursor && focusedIndex === idx;
        const fieldLabel = i18n.t(row.labelId);
        const currentLabel = i18n.t(row.optionLabel(row.current));
        return (
          <View
            key={row.field}
            testID={`player-subtitle-style-row-${row.field}`}
            style={[
              styles.fieldBlock,
              {
                borderRadius: focused ? theme.radius.button : 0,
                backgroundColor: focused ? theme.colors.focusFill : 'transparent',
                borderColor: focused ? theme.colors.focusRingColor : 'transparent',
                borderWidth: focused ? theme.focus.ringWidth : 0,
                borderBottomWidth: focused ? theme.focus.ringWidth : StyleSheet.hairlineWidth,
                borderBottomColor: focused
                  ? theme.colors.focusRingColor
                  : theme.colors.surfaceBorder,
              },
              webTransition(theme, 'border-color, background-color'),
            ]}
          >
            <Pressable
              testID={`player-subtitle-style-cycle-${row.field}`}
              focusable={!isTv}
              accessibilityRole="button"
              accessibilityLabel={`${fieldLabel}: ${currentLabel}`}
              onPress={(e) => {
                blurWebTarget(e.currentTarget);
                onChange(stepSubtitleStyleField(style, row.field, 1));
              }}
              style={[styles.fieldHeader, !isTv ? webCursorPointer() : undefined]}
            >
              <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
                {fieldLabel}
              </Text>
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                {currentLabel}
              </Text>
            </Pressable>
            <View style={styles.segmentRow}>
              {row.options.map((opt) => {
                const selected = row.current === opt;
                const optText = i18n.t(row.optionLabel(opt));
                return (
                  <Pressable
                    key={opt}
                    testID={`player-subtitle-style-opt-${row.field}-${opt}`}
                    focusable={!isTv}
                    accessibilityRole="radio"
                    accessibilityLabel={`${fieldLabel}: ${optText}`}
                    accessibilityState={{ selected, checked: selected }}
                    aria-checked={selected}
                    onPress={(e) => {
                      blurWebTarget(e.currentTarget);
                      onChange(row.apply(opt));
                    }}
                    style={[
                      styles.segment,
                      {
                        borderRadius: theme.radius.button,
                        backgroundColor: selected ? theme.colors.ctaBg : theme.colors.bgSurface,
                        borderColor: selected ? theme.colors.ctaBg : theme.colors.surfaceBorder,
                      },
                      webTransition(theme, 'border-color, background-color'),
                      !isTv ? webCursorPointer() : undefined,
                    ]}
                  >
                    <Text
                      numberOfLines={1}
                      style={[
                        theme.typography.caption,
                        {
                          color: selected ? theme.colors.ctaFg : theme.colors.textSecondary,
                          fontWeight: selected ? '700' : '500',
                        },
                      ]}
                    >
                      {optText}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        );
      })}

      <Pressable
        testID="player-subtitle-style-reset"
        focusable={!isTv}
        accessibilityRole="button"
        accessibilityLabel={i18n.t('player.subtitleStyle.reset')}
        onPress={(e) => {
          blurWebTarget(e.currentTarget);
          onChange(DEFAULT_SUBTITLE_STYLE);
        }}
        style={settingsRowStyle(theme, resetFocused, false, isTv)}
      >
        <Icon name="refresh" size={16} color={theme.colors.textSecondary} />
        <Text
          style={[
            theme.typography.title,
            styles.flex1,
            { color: isDefault ? theme.colors.textMuted : theme.colors.textPrimary },
          ]}
        >
          {i18n.t('player.subtitleStyle.reset')}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 4 },
  flex1: { flex: 1 },
  fieldBlock: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
  },
  fieldHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  segmentRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  segment: {
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
