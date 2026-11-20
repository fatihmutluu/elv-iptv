import { Platform, type TextStyle } from 'react-native';
import { hexToRgba } from './color-utils';
import {
  DEFAULT_THEME_PRESET,
  THEME_PRESETS,
  type ThemePalette,
  type ThemePresetId,
} from './presets';

/** Minimum and maximum supported user font scale multipliers (`UI_UX_PHILOSOPHY.md` §4). */
export const MIN_FONT_SCALE = 0.9;
export const MAX_FONT_SCALE = 1.2;

const WEB_FONT_FAMILY_SANS =
  "'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

/** Platform-aware Cinema Quietude sans-serif font stack (`undefined` on native to use system sans). */
export const FONT_FAMILY_SANS: string | undefined = Platform.select({
  web: WEB_FONT_FAMILY_SANS,
  default: undefined,
});

/** Reusable tabular-numerals style for timestamps, durations, channel numbers, and ratings. */
export const TABULAR_NUMS_STYLE: Readonly<Pick<TextStyle, 'fontVariant'>> = {
  fontVariant: ['tabular-nums'],
};

/** Dynamic translucent colors derived strictly from the active palette (zero hardcoded scrim hexes). */
export interface DerivedSurfaceColors {
  readonly scrimStrong: string;
  readonly scrimMedium: string;
  readonly scrimSoft: string;
  readonly scrimTransparent: string;
  readonly glassBg: string;
  readonly glassBorder: string;
  readonly surfaceBorder: string;
  readonly overlayBackdrop: string;
  readonly actionGlassBg: string;
  readonly actionGlassHoverBg: string;
  readonly actionGlassBorder: string;
  readonly chipBg: string;
  readonly chipHoverBg: string;
  readonly chipBorder: string;
  readonly topBarScrimStart: string;
  readonly topBarScrimMid: string;
  readonly hoverRingBorder: string;
  readonly focusFill: string;
  readonly accentTint: string;
  readonly subtleHighlight: string;
}

/** Complete resolved color table exposed on `theme.colors`. */
export interface ThemeColors extends ThemePalette, DerivedSurfaceColors {}

/** Typography scale entry ready to spread onto React Native `TextStyle`. */
export interface TypeScaleStep {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontWeight: TextStyle['fontWeight'];
  readonly letterSpacing?: number;
  readonly fontFamily?: string;
}

/** Resolved design tokens for one active Cinema Quietude theme configuration. */
export interface Theme {
  readonly preset: ThemePresetId | 'custom';
  readonly highContrast: boolean;
  readonly fontScale: number;
  readonly reduceMotion: boolean;
  readonly colors: ThemeColors;
  readonly radius: {
    readonly button: number;
    readonly card: number;
    readonly modal: number;
    readonly pill: number;
  };
  readonly spacing: {
    readonly xxs: number;
    readonly xs: number;
    readonly sm: number;
    readonly md: number;
    readonly lg: number;
    readonly xl: number;
    readonly gridGap: number;
  };
  readonly focus: {
    readonly ringWidth: number;
    readonly cardScale: number;
    readonly buttonScale: number;
  };
  readonly motion: {
    readonly fastMs: number;
    readonly normalMs: number;
    readonly sheetMs: number;
    readonly easing: string;
  };
  readonly typography: {
    readonly display: TypeScaleStep;
    readonly h1: TypeScaleStep;
    readonly h2: TypeScaleStep;
    readonly title: TypeScaleStep;
    readonly body: TypeScaleStep;
    readonly caption: TypeScaleStep;
    readonly micro: TypeScaleStep;
  };
}

/** Options for {@link buildTheme}. */
export interface ThemeOptions {
  readonly preset?: ThemePresetId;
  readonly palette?: ThemePalette;
  readonly fontScale?: number;
  readonly reduceMotion?: boolean;
}

/** Clamps a user font scale multiplier to `[0.9, 1.2]`. */
export function clampFontScale(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1.0;
  return Math.round(Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, value)) * 100) / 100;
}

function resolveSansFontFamily(): string | undefined {
  return Platform.OS === 'web' ? WEB_FONT_FAMILY_SANS : FONT_FAMILY_SANS;
}

function scaleStep(
  fontSize: number,
  lineHeight: number,
  fontWeight: TextStyle['fontWeight'],
  scale: number,
  letterSpacing?: number,
): TypeScaleStep {
  const fontFamily = resolveSansFontFamily();
  return {
    fontSize: Math.round(fontSize * scale * 2) / 2,
    lineHeight: Math.round(lineHeight * scale),
    fontWeight,
    ...(letterSpacing !== undefined ? { letterSpacing } : {}),
    ...(fontFamily !== undefined ? { fontFamily } : {}),
  };
}

/** Builds a complete immutable {@link Theme} from a preset id or custom palette. */
export function buildTheme(options: ThemeOptions = {}): Theme {
  const presetId = options.preset ?? DEFAULT_THEME_PRESET;
  const palette = options.palette ?? THEME_PRESETS[presetId];
  const highContrast = Boolean(palette.highContrast);
  const fontScale = clampFontScale(options.fontScale);
  const reduceMotion = Boolean(options.reduceMotion);

  const colors: ThemeColors = {
    ...palette,
    scrimStrong: hexToRgba(palette.bgCanvas, 0.94),
    scrimMedium: hexToRgba(palette.bgCanvas, 0.68),
    scrimSoft: hexToRgba(palette.bgCanvas, 0.32),
    scrimTransparent: hexToRgba(palette.bgCanvas, 0),
    glassBg: hexToRgba(palette.bgCanvas, highContrast ? 0.96 : 0.82),
    glassBorder: hexToRgba(palette.textPrimary, highContrast ? 0.45 : 0.12),
    surfaceBorder: hexToRgba(palette.textPrimary, highContrast ? 0.35 : 0.08),
    overlayBackdrop: hexToRgba(palette.bgCanvas, highContrast ? 0.86 : 0.64),
    actionGlassBg: hexToRgba(palette.textPrimary, highContrast ? 0.22 : 0.13),
    actionGlassHoverBg: hexToRgba(palette.textPrimary, highContrast ? 0.34 : 0.22),
    actionGlassBorder: hexToRgba(palette.textPrimary, highContrast ? 0.55 : 0.15),
    chipBg: hexToRgba(palette.textPrimary, highContrast ? 0.14 : 0.06),
    chipHoverBg: hexToRgba(palette.textPrimary, highContrast ? 0.24 : 0.13),
    chipBorder: hexToRgba(palette.textPrimary, highContrast ? 0.45 : 0.12),
    topBarScrimStart: hexToRgba(palette.bgCanvas, 0.9),
    topBarScrimMid: hexToRgba(palette.bgCanvas, 0.42),
    hoverRingBorder: hexToRgba(palette.textPrimary, highContrast ? 0.72 : 0.38),
    focusFill: hexToRgba(palette.focusRingColor, highContrast ? 0.22 : 0.12),
    accentTint: hexToRgba(palette.accent, highContrast ? 0.24 : 0.16),
    subtleHighlight: hexToRgba(palette.textPrimary, highContrast ? 0.18 : 0.07),
  };

  return {
    preset: options.palette ? 'custom' : presetId,
    highContrast,
    fontScale,
    reduceMotion,
    colors,
    radius: {
      button: 4,
      card: 6,
      modal: 12,
      pill: 999,
    },
    spacing: {
      xxs: 4,
      xs: 6,
      sm: 10,
      md: 16,
      lg: 24,
      xl: 32,
      gridGap: 6,
    },
    focus: {
      ringWidth: highContrast ? 3 : 2.5,
      cardScale: reduceMotion ? 1 : 1.05,
      buttonScale: reduceMotion ? 1 : 1.04,
    },
    motion: {
      fastMs: reduceMotion ? 0 : 150,
      normalMs: reduceMotion ? 0 : 220,
      sheetMs: reduceMotion ? 0 : 280,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    },
    typography: {
      display: scaleStep(34, 38, '800', fontScale, -0.9),
      h1: scaleStep(24, 29, '800', fontScale, -0.5),
      h2: scaleStep(17, 23, '700', fontScale, -0.25),
      title: scaleStep(14, 19, '600', fontScale, -0.1),
      body: scaleStep(13.5, 20, '400', fontScale),
      caption: scaleStep(12, 16, '500', fontScale),
      micro: scaleStep(10.5, 14, '700', fontScale, 0.25),
    },
  };
}
