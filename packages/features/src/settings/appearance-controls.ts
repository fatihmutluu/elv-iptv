import {
  type AccessibilityFontFamily,
  type ArtworkCacheFormFactor,
  type ArtworkCacheLimitMbPref,
  DEFAULT_HOME_LAYOUT,
  getPlatformDefaultArtworkCacheLimitMb,
  isHomeLayoutSectionId,
  MAX_PREF_OVERSCAN,
  MIN_PREF_OVERSCAN,
  normalizeHomeLayout,
  type PreferencesPatch,
  type PreferencesSnapshot,
  type Result,
  type TvClockMode,
} from '@elv/domain';
import type { MessageId } from '@elv/i18n';
import { THEME_PRESETS, type ThemePresetId } from '@elv/ui-kit';
import { moveHomeLayoutSection } from './HomeLayoutEditor';
import type { AppearanceFocusId } from './useTvSettingsNavigation';

/** Preferences read/write contract consumed by settings panels and {@link SettingsScreen}. */
export interface SettingsPreferencesController {
  readonly preferences: PreferencesSnapshot;
  updatePreferences(patch: PreferencesPatch): Promise<Result<PreferencesSnapshot>>;
  resetPreferences(): Promise<Result<PreferencesSnapshot>>;
}

export const LANGUAGE_OPTIONS: ReadonlyArray<{
  readonly id: 'system' | 'en' | 'tr';
  readonly testID: string;
  readonly labelKey: MessageId;
}> = [
  { id: 'system', testID: 'settings-lang-system', labelKey: 'settings.language.system' },
  { id: 'en', testID: 'settings-lang-en', labelKey: 'settings.language.en' },
  { id: 'tr', testID: 'settings-lang-tr', labelKey: 'settings.language.tr' },
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

export const UI_FONT_OPTIONS: ReadonlyArray<{
  readonly id: AccessibilityFontFamily;
  readonly focusId: AppearanceFocusId;
  readonly testID: string;
  readonly labelKey: MessageId;
}> = [
  {
    id: 'system',
    focusId: 'ui-font-system',
    testID: 'settings-ui-font-system',
    labelKey: 'settings.fontSystem',
  },
  {
    id: 'atkinson',
    focusId: 'ui-font-atkinson',
    testID: 'settings-ui-font-atkinson',
    labelKey: 'settings.fontAtkinson',
  },
  {
    id: 'opendyslexic',
    focusId: 'ui-font-opendyslexic',
    testID: 'settings-ui-font-opendyslexic',
    labelKey: 'settings.fontOpenDyslexic',
  },
];

export const SUBTITLE_FONT_OPTIONS: ReadonlyArray<{
  readonly id: AccessibilityFontFamily;
  readonly focusId: AppearanceFocusId;
  readonly testID: string;
  readonly labelKey: MessageId;
}> = [
  {
    id: 'system',
    focusId: 'sub-font-system',
    testID: 'settings-sub-font-system',
    labelKey: 'settings.fontSystem',
  },
  {
    id: 'atkinson',
    focusId: 'sub-font-atkinson',
    testID: 'settings-sub-font-atkinson',
    labelKey: 'settings.fontAtkinson',
  },
  {
    id: 'opendyslexic',
    focusId: 'sub-font-opendyslexic',
    testID: 'settings-sub-font-opendyslexic',
    labelKey: 'settings.fontOpenDyslexic',
  },
];

export const TV_CLOCK_MODE_OPTIONS: ReadonlyArray<{
  readonly id: TvClockMode;
  readonly focusId: AppearanceFocusId;
  readonly testID: string;
  readonly labelKey: MessageId;
}> = [
  {
    id: 'always',
    focusId: 'tv-clock-always',
    testID: 'settings-tv-clock-always',
    labelKey: 'settings.tvClockAlways',
  },
  {
    id: 'menus',
    focusId: 'tv-clock-menus',
    testID: 'settings-tv-clock-menus',
    labelKey: 'settings.tvClockMenus',
  },
  {
    id: 'player',
    focusId: 'tv-clock-player',
    testID: 'settings-tv-clock-player',
    labelKey: 'settings.tvClockPlayer',
  },
  {
    id: 'never',
    focusId: 'tv-clock-never',
    testID: 'settings-tv-clock-never',
    labelKey: 'settings.tvClockNever',
  },
];

export const ARTWORK_CACHE_OPTIONS: ReadonlyArray<{
  readonly mb: ArtworkCacheLimitMbPref;
  readonly testID: string;
}> = [
  { mb: 64, testID: 'settings-artwork-cache-64' },
  { mb: 128, testID: 'settings-artwork-cache-128' },
  { mb: 256, testID: 'settings-artwork-cache-256' },
  { mb: 512, testID: 'settings-artwork-cache-512' },
];

/** Builds a preferences patch that resets ONLY Appearance-tab settings for the given platform form factor. */
export function buildAppearanceResetPatch(formFactor: ArtworkCacheFormFactor): {
  readonly patch: PreferencesPatch;
  readonly platformDefaultMb: ArtworkCacheLimitMbPref;
} {
  const platformDefaultMb = getPlatformDefaultArtworkCacheLimitMb(formFactor);
  return {
    platformDefaultMb,
    patch: {
      locale: 'system',
      themePreset: 'obsidianCrimson',
      fontScale: 1,
      uiFontFamily: 'system',
      subtitleFontFamily: 'system',
      reduceMotion: false,
      confirmExitOnBack: true,
      overscanX: 0,
      overscanY: 0,
      tvClockMode: 'never',
      artworkCacheLimitMb: platformDefaultMb,
      telemetryOptIn: false,
      crashReportsOptIn: false,
      crashReportsIncludeLogs: false,
      homeLayout: DEFAULT_HOME_LAYOUT,
    },
  };
}

/** Steps an overscan ratio cleanly by `delta` (`±0.01`), clamped to `[0, 0.1]`. */
export function stepOverscanRatio(current: number, delta: number): number {
  const safe = Number.isFinite(current) ? current : 0.05;
  const clamped = Math.max(MIN_PREF_OVERSCAN, Math.min(MAX_PREF_OVERSCAN, safe + delta));
  return Math.round(clamped * 100) / 100;
}

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
      'theme' | 'font' | 'tvDisplay' | 'artworkCache' | 'reset' | 'diagnostics' | 'homeLayout',
      { readonly y: number; readonly height: number }
    >
  >,
  motionOffsetY: number,
): number | undefined {
  if (controlId === 'lang-dropdown') return 0;
  if (controlId.startsWith('theme-')) {
    const box = layouts.theme;
    if (!box) return undefined;
    return SECOND_THEME_ROW_IDS.has(controlId)
      ? Math.max(0, box.y + Math.round(box.height * 0.45) - 12)
      : Math.max(0, box.y - 12);
  }
  if (controlId.startsWith('home-layout-')) {
    return layouts.homeLayout ? Math.max(0, layouts.homeLayout.y - 12) : undefined;
  }
  if (
    controlId.startsWith('font-') ||
    controlId.startsWith('ui-font-') ||
    controlId.startsWith('sub-font-')
  ) {
    return layouts.font ? Math.max(0, layouts.font.y - 12) : undefined;
  }
  if (controlId === 'toggle-reduce-motion' || controlId === 'toggle-confirm-exit') {
    return layouts.font ? Math.max(0, layouts.font.y + motionOffsetY - 12) : undefined;
  }
  if (controlId.startsWith('overscan-') || controlId.startsWith('tv-clock-')) {
    return layouts.tvDisplay ? Math.max(0, layouts.tvDisplay.y - 12) : undefined;
  }
  if (controlId === 'artwork-cache-dropdown' || controlId === 'artwork-cache-clear') {
    return layouts.artworkCache ? Math.max(0, layouts.artworkCache.y - 12) : undefined;
  }
  if (controlId === 'toggle-crash-reports-opt-in') {
    return layouts.diagnostics ? Math.max(0, layouts.diagnostics.y - 12) : undefined;
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
    platformFormFactor?: ArtworkCacheFormFactor;
    setPreset: (id: ThemePresetId) => void;
    setFontScale: (scale: number) => void;
    setReduceMotion: (next: boolean) => void;
    setUiFontFamily?: (family: AccessibilityFontFamily) => void;
    onOpenDropdown?: (dropdownId: 'lang-dropdown' | 'artwork-cache-dropdown') => void;
    onSetArtworkCacheLimitMb?: (mb: ArtworkCacheLimitMbPref) => void;
    onClearArtworkCache?: () => void;
    onTelemetryOptInChange?: (enabled: boolean) => void;
  },
): void {
  const { preferences } = deps;
  if (controlId === 'lang-dropdown' || controlId === 'artwork-cache-dropdown') {
    deps.onOpenDropdown?.(controlId);
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
  const uiFontOpt = UI_FONT_OPTIONS.find((opt) => opt.focusId === controlId);
  if (uiFontOpt) {
    if (preferences) void preferences.updatePreferences({ uiFontFamily: uiFontOpt.id });
    else deps.setUiFontFamily?.(uiFontOpt.id);
    return;
  }
  const subFontOpt = SUBTITLE_FONT_OPTIONS.find((opt) => opt.focusId === controlId);
  if (subFontOpt) {
    if (preferences) void preferences.updatePreferences({ subtitleFontFamily: subFontOpt.id });
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
  if (controlId === 'overscan-x-dec' || controlId === 'overscan-x-inc') {
    if (preferences) {
      const next = stepOverscanRatio(
        preferences.preferences.overscanX,
        controlId === 'overscan-x-inc' ? 0.01 : -0.01,
      );
      void preferences.updatePreferences({ overscanX: next });
    }
    return;
  }
  if (controlId === 'overscan-y-dec' || controlId === 'overscan-y-inc') {
    if (preferences) {
      const next = stepOverscanRatio(
        preferences.preferences.overscanY,
        controlId === 'overscan-y-inc' ? 0.01 : -0.01,
      );
      void preferences.updatePreferences({ overscanY: next });
    }
    return;
  }
  const clockOpt = TV_CLOCK_MODE_OPTIONS.find((opt) => opt.focusId === controlId);
  if (clockOpt) {
    if (preferences) void preferences.updatePreferences({ tvClockMode: clockOpt.id });
    return;
  }
  if (controlId === 'artwork-cache-clear') {
    deps.onClearArtworkCache?.();
    return;
  }
  if (controlId === 'reset-preferences') {
    const { patch, platformDefaultMb } = buildAppearanceResetPatch(deps.platformFormFactor ?? 'tv');
    if (preferences) {
      void preferences.updatePreferences(patch);
    } else {
      deps.setPreset('obsidianCrimson');
      deps.setFontScale(1);
      deps.setReduceMotion(false);
      deps.setUiFontFamily?.('system');
    }
    deps.onSetArtworkCacheLimitMb?.(platformDefaultMb);
    deps.onTelemetryOptInChange?.(false);
    return;
  }
  if (controlId === 'toggle-crash-reports-opt-in') {
    if (preferences) {
      const next = !(
        preferences.preferences.telemetryOptIn || preferences.preferences.crashReportsOptIn
      );
      deps.onTelemetryOptInChange?.(next);
      void preferences.updatePreferences({
        telemetryOptIn: next,
        crashReportsOptIn: next,
        privacyConsentAnswered: true,
      });
    }
    return;
  }
  if (controlId === 'home-layout-reset') {
    if (preferences) void preferences.updatePreferences({ homeLayout: DEFAULT_HOME_LAYOUT });
    return;
  }
  if (controlId.startsWith('home-layout-')) {
    const sectionId = controlId.slice('home-layout-'.length);
    if (preferences && isHomeLayoutSectionId(sectionId)) {
      const current = normalizeHomeLayout(preferences.preferences.homeLayout);
      const next = current.map((entry) =>
        entry.id === sectionId ? { ...entry, visible: !entry.visible } : entry,
      );
      void preferences.updatePreferences({ homeLayout: next });
    }
  }
}

/** Applies a TV D-pad Left/Right adjustment on an Appearance control (reordering Home sections). */
export function adjustAppearanceControl(
  controlId: AppearanceFocusId,
  delta: -1 | 1,
  preferences?: SettingsPreferencesController,
): void {
  if (!preferences || controlId === 'home-layout-reset' || !controlId.startsWith('home-layout-')) {
    return;
  }
  const sectionId = controlId.slice('home-layout-'.length);
  if (!isHomeLayoutSectionId(sectionId)) return;
  const current = normalizeHomeLayout(preferences.preferences.homeLayout);
  const index = current.findIndex((entry) => entry.id === sectionId);
  if (index < 0) return;
  const next = moveHomeLayoutSection(current, index, delta < 0 ? 'up' : 'down');
  if (next !== current) {
    void preferences.updatePreferences({ homeLayout: next });
  }
}
