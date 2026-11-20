import type { MessageId } from '@elv/i18n';
import {
  THEME_PRESET_IDS,
  THEME_PRESETS,
  type ThemePresetId,
  useI18n,
  useTheme,
  useViewport,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AppearanceFocusId } from './useTvSettingsNavigation';

const THEME_LABEL_KEYS: Readonly<Record<ThemePresetId, MessageId>> = {
  obsidianCrimson: 'settings.theme.obsidianCrimson.label',
  abyssalSapphire: 'settings.theme.abyssalSapphire.label',
  theaterAmber: 'settings.theme.theaterAmber.label',
  velvetViolet: 'settings.theme.velvetViolet.label',
  pitchEmerald: 'settings.theme.pitchEmerald.label',
  highContrast: 'settings.theme.highContrast.label',
};

const THEME_DESC_KEYS: Readonly<Record<ThemePresetId, MessageId>> = {
  obsidianCrimson: 'settings.theme.obsidianCrimson.desc',
  abyssalSapphire: 'settings.theme.abyssalSapphire.desc',
  theaterAmber: 'settings.theme.theaterAmber.desc',
  velvetViolet: 'settings.theme.velvetViolet.desc',
  pitchEmerald: 'settings.theme.pitchEmerald.desc',
  highContrast: 'settings.theme.highContrast.desc',
};

/** Props of {@link ThemePresetGrid}. */
export interface ThemePresetGridProps {
  readonly activePreset: string;
  readonly focusedControlId: AppearanceFocusId | null;
  readonly onSelectPreset: (id: ThemePresetId) => void;
}

/**
 * Responsive grid of all 6 built-in Cinema Quietude theme presets (`#325`), each rendering 3 color
 * swatch squares (`bgCanvas`, `accent`, `textPrimary`), localized copy, active accent border, and
 * crisp 10-foot TV focus ring.
 */
export function ThemePresetGrid({
  activePreset,
  focusedControlId,
  onSelectPreset,
}: ThemePresetGridProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const [hoveredThemeId, setHoveredThemeId] = useState<ThemePresetId | null>(null);

  const isPortraitPhone = viewport.formFactor === 'phone' && viewport.orientation === 'portrait';
  const isTv = viewport.formFactor === 'tv';
  const cardTransition = webTransition(theme, 'transform, background-color, border-color');
  const cursorPointer = webCursorPointer();

  return (
    <View style={[styles.themeGrid, { gap: theme.spacing.sm }]}>
      {THEME_PRESET_IDS.map((presetId) => {
        const palette = THEME_PRESETS[presetId];
        const selected = activePreset === presetId;
        const tvFocused = focusedControlId === `theme-${presetId}`;
        const hovered = hoveredThemeId === presetId;
        const label = i18n.t(THEME_LABEL_KEYS[presetId]);
        const desc = i18n.t(THEME_DESC_KEYS[presetId]);

        const backgroundColor = tvFocused
          ? theme.colors.focusFill
          : selected
            ? theme.colors.accentTint
            : hovered
              ? theme.colors.bgElevated
              : theme.colors.bgCard;
        const borderColor = tvFocused
          ? theme.colors.focusRingColor
          : selected
            ? theme.colors.accent
            : hovered
              ? theme.colors.hoverRingBorder
              : theme.colors.surfaceBorder;
        const borderWidth = tvFocused ? theme.focus.ringWidth : selected ? 1.5 : 1;

        return (
          <Pressable
            key={presetId}
            testID={`settings-theme-${presetId}`}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected }}
            aria-selected={selected}
            {...(isTv ? { focusable: false } : {})}
            onPress={() => onSelectPreset(presetId)}
            onHoverIn={() => setHoveredThemeId(presetId)}
            onHoverOut={() => setHoveredThemeId((prev) => (prev === presetId ? null : prev))}
            style={({ pressed }) => [
              styles.themeCard,
              isPortraitPhone ? styles.themeCardFull : styles.themeCardGrid,
              cardTransition,
              cursorPointer,
              {
                backgroundColor,
                borderColor,
                borderWidth,
                borderRadius: theme.radius.card,
                transform: [
                  {
                    scale: pressed
                      ? theme.reduceMotion
                        ? 1
                        : 0.98
                      : tvFocused
                        ? theme.focus.buttonScale
                        : 1,
                  },
                ],
              },
            ]}
          >
            <View style={styles.swatchRow}>
              <View
                style={[
                  styles.swatch,
                  { backgroundColor: palette.bgCanvas, borderColor: theme.colors.chipBorder },
                ]}
              />
              <View
                style={[
                  styles.swatch,
                  { backgroundColor: palette.accent, borderColor: theme.colors.chipBorder },
                ]}
              />
              <View
                style={[
                  styles.swatch,
                  { backgroundColor: palette.textPrimary, borderColor: theme.colors.chipBorder },
                ]}
              />
            </View>
            <View style={styles.themeMeta}>
              <Text
                numberOfLines={1}
                style={[
                  theme.typography.title,
                  { color: theme.colors.textPrimary, fontWeight: selected ? '700' : '600' },
                ]}
              >
                {label}
              </Text>
              <Text
                numberOfLines={2}
                style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
              >
                {desc}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  themeGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  themeCard: { minHeight: 64, paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  themeCardGrid: { flexGrow: 1, flexBasis: '30%', minWidth: 180 },
  themeCardFull: { width: '100%' },
  swatchRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  swatch: { width: 14, height: 14, borderRadius: 3, borderWidth: 1 },
  themeMeta: { gap: 2 },
});
