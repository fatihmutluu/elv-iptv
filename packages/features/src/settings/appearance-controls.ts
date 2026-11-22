import type {
  ArtworkCacheLimitMbPref,
  PreferencesPatch,
  PreferencesSnapshot,
  Result,
} from '@elv/domain';
import type { MessageId } from '@elv/i18n';
import { THEME_PRESETS, type ThemePresetId } from '@elv/ui-kit';
import type { AppearanceFocusId } from './useTvSettingsNavigation';

/** Preferences read/write contract consumed by settings panels and {@link SettingsScreen}. */
export interface SettingsPreferencesController {
  readonly preferences: PreferencesSnapshot;
  updatePreferences(patch: PreferencesPatch): Promise<Result<PreferencesSnapshot>>;
  resetPreferences(): Promise<Result<PreferencesSnapshot>>;
}

export const LANGUAGE_OPTIONS: ReadonlyArray<{
  readonly id: 'system' | 'tr' | 'en';
  readonly focusId: AppearanceFocusId;
  readonly testID: string;
  readonly labelKey: MessageId;
}> = [
  {
    id: 'system',
    focusId: 'lang-system',
    testID: 'settings-lang-system',
    labelKey: 'settings.language.system',
  },
  { id: 'tr', focusId: 'lang-tr', testID: 'settings-lang-tr', labelKey: 'settings.language.tr' },
  { id: 'en', focusId: 'lang-en', testID: 'settings-lang-en', labelKey: 'settings.language.en' },
];

export const FONT_SCALE_OPTIONS: ReadonlyArray<{
  readonly scale: number;
  readonly label: string;
  readonly focusId: AppearanceFocusId;
  readonly testID: string;
}> = [
  { scale: 0.9, label: '90%', focusId: 'font-90', testID: 'settings-font-90' },
  { scale: 1.0, label: '100%', focusId: 'font-100', testID: 'settings-font-100' },
  { scale: 1.1, label: '110%', focusId: 'font-110', testID: 'settings-font-110' },
  { scale: 1.2, label: '120%', focusId: 'font-120', testID: 'settings-font-120' },
];

export const ARTWORK_CACHE_OPTIONS: ReadonlyArray<{
  readonly mb: ArtworkCacheLimitMbPref;
  readonly focusId: AppearanceFocusId;
  readonly testID: string;
}> = [
  { mb: 64, focusId: 'artwork-cache-64', testID: 'settings-artwork-cache-64' },
  { mb: 128, focusId: 'artwork-cache-128', testID: 'settings-artwork-cache-128' },
  { mb: 256, focusId: 'artwork-cache-256', testID: 'settings-artwork-cache-256' },
];

const SECOND_THEME_ROW_IDS = new Set<AppearanceFocusId>([
  'theme-velvetViolet',
  'theme-pitchEmerald',
  'theme-highContrast',
]);

/** Computes the vertical scroll offset needed to keep a TV-focused Appearance control in view. */
export function computeAppearanceScrollY(
  controlId: AppearanceFocusId,
  layouts: Partial<
    Record<
      'theme' | 'font' | 'artworkCache' | 'reset',
      { readonly y: number; readonly height: number }
    >
  >,
  motionOffsetY: number,
): number | undefined {
  if (controlId.startsWith('lang-')) return 0;
  if (controlId.startsWith('theme-')) {
    const box = layouts.theme;
    if (!box) return undefined;
    return SECOND_THEME_ROW_IDS.has(controlId)
      ? Math.max(0, box.y + Math.round(box.height * 0.45) - 12)
      : Math.max(0, box.y - 12);
  }
  if (controlId.startsWith('font-')) {
    return layouts.font ? Math.max(0, layouts.font.y - 12) : undefined;
  }
  if (controlId === 'toggle-reduce-motion' || controlId === 'toggle-confirm-exit') {
    return layouts.font ? Math.max(0, layouts.font.y + motionOffsetY - 12) : undefined;
  }
  if (controlId.startsWith('artwork-cache-')) {
    return layouts.artworkCache ? Math.max(0, layouts.artworkCache.y - 12) : undefined;
  }
  if (controlId === 'reset-preferences') {
    return layouts.reset ? Math.max(0, layouts.reset.y - 12) : undefined;
  }
  return undefined;
}

/** Applies a TV D-pad activation on an Appearance control via `preferences` or direct controllers. */
export function activateAppearanceControl(
  controlId: AppearanceFocusId,
  deps: {
    preferences?: SettingsPreferencesController;
    reduceMotion: boolean;
    setPreset: (id: ThemePresetId) => void;
    setFontScale: (scale: number) => void;
    setReduceMotion: (next: boolean) => void;
    setLocale: (locale: 'tr' | 'en') => void;
    onSetArtworkCacheLimitMb?: (mb: ArtworkCacheLimitMbPref) => void;
    onClearArtworkCache?: () => void;
  },
): void {
  const { preferences } = deps;
  if (controlId === 'lang-system' || controlId === 'lang-tr' || controlId === 'lang-en') {
    const locale = controlId === 'lang-system' ? 'system' : controlId === 'lang-tr' ? 'tr' : 'en';
    if (preferences) void preferences.updatePreferences({ locale });
    else if (locale !== 'system') deps.setLocale(locale);
    return;
  }
  if (controlId.startsWith('theme-')) {
    const presetId = controlId.slice('theme-'.length) as ThemePresetId;
    if (presetId in THEME_PRESETS) {
      if (preferences) void preferences.updatePreferences({ themePreset: presetId });
      else deps.setPreset(presetId);
    }
    return;
  }
  const fontOpt = FONT_SCALE_OPTIONS.find((opt) => opt.focusId === controlId);
  if (fontOpt) {
    if (preferences) void preferences.updatePreferences({ fontScale: fontOpt.scale });
    else deps.setFontScale(fontOpt.scale);
    return;
  }
  if (controlId === 'toggle-reduce-motion') {
    const current = preferences ? preferences.preferences.reduceMotion : deps.reduceMotion;
    if (preferences) void preferences.updatePreferences({ reduceMotion: !current });
    else deps.setReduceMotion(!current);
    return;
  }
  if (controlId === 'toggle-confirm-exit') {
    if (preferences) {
      void preferences.updatePreferences({
        confirmExitOnBack: !preferences.preferences.confirmExitOnBack,
      });
    }
    return;
  }
  const cacheOpt = ARTWORK_CACHE_OPTIONS.find((opt) => opt.focusId === controlId);
  if (cacheOpt) {
    if (preferences) void preferences.updatePreferences({ artworkCacheLimitMb: cacheOpt.mb });
    deps.onSetArtworkCacheLimitMb?.(cacheOpt.mb);
    return;
  }
  if (controlId === 'artwork-cache-clear') {
    deps.onClearArtworkCache?.();
    return;
  }
  if (controlId === 'reset-preferences') {
    if (preferences) void preferences.resetPreferences();
    else {
      deps.setPreset('obsidianCrimson');
      deps.setFontScale(1);
      deps.setReduceMotion(false);
    }
  }
}
