/** Built-in Cinema Quietude theme preset identifiers. */
export type ThemePresetId =
  | 'obsidianCrimson'
  | 'abyssalSapphire'
  | 'theaterAmber'
  | 'velvetViolet'
  | 'pitchEmerald'
  | 'highContrast';

/** Semantic color palette defining one complete ELV IPTV theme. */
export interface ThemePalette {
  readonly label: string;
  readonly description: string;
  readonly highContrast?: boolean;
  readonly accent: string;
  readonly accentSecondary: string;
  readonly accentContrast: string;
  readonly bgCanvas: string;
  readonly bgSurface: string;
  readonly bgCard: string;
  readonly bgElevated: string;
  readonly bgRail: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly textMuted: string;
  readonly focusRingColor: string;
  readonly liveColor: string;
  readonly successColor: string;
  readonly ctaBg: string;
  readonly ctaFg: string;
}

/** Default Cinema Quietude theme preset. */
export const DEFAULT_THEME_PRESET: ThemePresetId = 'obsidianCrimson';

/** Ordered list of built-in theme preset ids. */
export const THEME_PRESET_IDS: readonly ThemePresetId[] = [
  'obsidianCrimson',
  'abyssalSapphire',
  'theaterAmber',
  'velvetViolet',
  'pitchEmerald',
  'highContrast',
];

/** Canonical Cinema Quietude theme presets (`docs/design/UI_UX_PHILOSOPHY.md` §4.1). */
export const THEME_PRESETS: Readonly<Record<ThemePresetId, ThemePalette>> = {
  obsidianCrimson: {
    label: 'Obsidian Crimson',
    description: 'Pure cinema black + restrained crimson signal',
    accent: '#E11D48',
    accentSecondary: '#F43F5E',
    accentContrast: '#FFFFFF',
    bgCanvas: '#090A0E',
    bgSurface: '#12141C',
    bgCard: '#171A23',
    bgElevated: '#1C202B',
    bgRail: '#0B0C11',
    textPrimary: '#F7F8FA',
    textSecondary: '#A6AFBF',
    textMuted: '#6A7385',
    focusRingColor: '#FFFFFF',
    liveColor: '#EF4444',
    successColor: '#22C55E',
    ctaBg: '#FFFFFF',
    ctaFg: '#09090B',
  },
  abyssalSapphire: {
    label: 'Abyssal Sapphire',
    description: 'Deep theater midnight + crisp ice-blue signal',
    accent: '#3B82F6',
    accentSecondary: '#60A5FA',
    accentContrast: '#FFFFFF',
    bgCanvas: '#070A12',
    bgSurface: '#0F1523',
    bgCard: '#151D30',
    bgElevated: '#1A243B',
    bgRail: '#090D17',
    textPrimary: '#F4F7FB',
    textSecondary: '#98A6BD',
    textMuted: '#64748B',
    focusRingColor: '#FFFFFF',
    liveColor: '#EF4444',
    successColor: '#10B981',
    ctaBg: '#FFFFFF',
    ctaFg: '#070A12',
  },
  theaterAmber: {
    label: 'Theater Amber',
    description: 'Warm tungsten obsidian + golden cinema highlight',
    accent: '#F59E0B',
    accentSecondary: '#FBBF24',
    accentContrast: '#09090B',
    bgCanvas: '#0A0908',
    bgSurface: '#141311',
    bgCard: '#1B1916',
    bgElevated: '#23201C',
    bgRail: '#0D0C0B',
    textPrimary: '#FAF9F6',
    textSecondary: '#ADA8A0',
    textMuted: '#746F68',
    focusRingColor: '#FFFFFF',
    liveColor: '#EF4444',
    successColor: '#22C55E',
    ctaBg: '#FFFFFF',
    ctaFg: '#0A0908',
  },
  velvetViolet: {
    label: 'Velvet Violet',
    description: 'Low-key slate plum + luminous orchid signal',
    accent: '#A855F7',
    accentSecondary: '#C084FC',
    accentContrast: '#FFFFFF',
    bgCanvas: '#09080E',
    bgSurface: '#13111E',
    bgCard: '#1A1728',
    bgElevated: '#221E33',
    bgRail: '#0C0A13',
    textPrimary: '#F8F7FC',
    textSecondary: '#B2ABC6',
    textMuted: '#726B87',
    focusRingColor: '#FFFFFF',
    liveColor: '#FB7185',
    successColor: '#34D399',
    ctaBg: '#FFFFFF',
    ctaFg: '#09080E',
  },
  pitchEmerald: {
    label: 'Pitch Emerald',
    description: 'Carbon pitch dark + broadcast turf emerald',
    accent: '#10B981',
    accentSecondary: '#34D399',
    accentContrast: '#052E16',
    bgCanvas: '#070B0A',
    bgSurface: '#0F1614',
    bgCard: '#151F1C',
    bgElevated: '#1C2925',
    bgRail: '#0A0F0D',
    textPrimary: '#F2FAF6',
    textSecondary: '#9CB0A8',
    textMuted: '#60746C',
    focusRingColor: '#FFFFFF',
    liveColor: '#EF4444',
    successColor: '#22C55E',
    ctaBg: '#FFFFFF',
    ctaFg: '#070B0A',
  },
  highContrast: {
    label: 'High Contrast (AAA)',
    description: 'Pure black + maximum WCAG AAA text & focus contrast',
    highContrast: true,
    accent: '#FACC15',
    accentSecondary: '#FDE047',
    accentContrast: '#000000',
    bgCanvas: '#000000',
    bgSurface: '#0D0D0D',
    bgCard: '#141414',
    bgElevated: '#1C1C1C',
    bgRail: '#000000',
    textPrimary: '#FFFFFF',
    textSecondary: '#E5E7EB',
    textMuted: '#B3B8C2',
    focusRingColor: '#FACC15',
    liveColor: '#FF3B30',
    successColor: '#4ADE80',
    ctaBg: '#FFFFFF',
    ctaFg: '#000000',
  },
};

/** Checks whether an arbitrary string matches a built-in {@link ThemePresetId}. */
export function isThemePresetId(value: string): value is ThemePresetId {
  return Object.hasOwn(THEME_PRESETS, value);
}
