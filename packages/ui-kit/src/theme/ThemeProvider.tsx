import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AccessibilityInfo } from 'react-native';
import { DEFAULT_THEME_PRESET, type ThemePalette, type ThemePresetId } from './presets';
import { buildTheme, clampFontScale, type Theme } from './tokens';

/** Live theme controller exposed by {@link useThemeController}. */
export interface ThemeController {
  readonly theme: Theme;
  readonly preset: ThemePresetId;
  readonly fontScale: number;
  readonly reduceMotion: boolean;
  setPreset(next: ThemePresetId): void;
  setFontScale(next: number): void;
  setReduceMotion(next: boolean | undefined): void;
}

/** Props of {@link ThemeProvider}. */
export interface ThemeProviderProps {
  /** Controlled or initial preset id (defaults to `obsidianCrimson`). */
  preset?: ThemePresetId;
  /** Optional custom palette override (useful for experiments or custom themes). */
  palette?: ThemePalette;
  /** Controlled or initial font scale multiplier (`0.9..1.2`). */
  fontScale?: number;
  /** Explicit reduce-motion override; when omitted, follows OS `AccessibilityInfo.isReduceMotionEnabled()`. */
  reduceMotion?: boolean;
  /** Notified when preset, font scale, or reduce-motion changes through {@link useThemeController}. */
  onChange?: (next: {
    preset: ThemePresetId;
    fontScale: number;
    reduceMotion: boolean | undefined;
  }) => void;
  children: ReactNode;
}

const DEFAULT_THEME = buildTheme();

const ThemeContext = createContext<ThemeController>({
  theme: DEFAULT_THEME,
  preset: DEFAULT_THEME_PRESET,
  fontScale: 1.0,
  reduceMotion: false,
  setPreset: () => undefined,
  setFontScale: () => undefined,
  setReduceMotion: () => undefined,
});

/** Provides reactive Cinema Quietude design tokens and live theme/accessibility switching. */
export function ThemeProvider({
  preset,
  palette,
  fontScale,
  reduceMotion,
  onChange,
  children,
}: ThemeProviderProps): ReactElement {
  const [internalPreset, setInternalPreset] = useState<ThemePresetId>(
    preset ?? DEFAULT_THEME_PRESET,
  );
  const [internalFontScale, setInternalFontScale] = useState<number>(clampFontScale(fontScale));
  const [internalReduceMotion, setInternalReduceMotion] = useState<boolean | undefined>(
    reduceMotion,
  );
  const [systemReduceMotion, setSystemReduceMotion] = useState(false);

  useEffect(() => {
    let active = true;
    if (typeof AccessibilityInfo?.isReduceMotionEnabled === 'function') {
      void AccessibilityInfo.isReduceMotionEnabled()
        .then((enabled) => {
          if (active) setSystemReduceMotion(Boolean(enabled));
        })
        .catch(() => undefined);
    }
    const sub =
      typeof AccessibilityInfo?.addEventListener === 'function'
        ? AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
            setSystemReduceMotion(Boolean(enabled));
          })
        : undefined;
    return () => {
      active = false;
      sub?.remove?.();
    };
  }, []);

  const activePreset = preset ?? internalPreset;
  const activeFontScale = fontScale !== undefined ? clampFontScale(fontScale) : internalFontScale;
  const activeReduceMotionOverride =
    reduceMotion !== undefined ? reduceMotion : internalReduceMotion;
  const activeReduceMotion = activeReduceMotionOverride ?? systemReduceMotion;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const setPreset = useCallback(
    (next: ThemePresetId) => {
      if (preset === undefined) setInternalPreset(next);
      onChangeRef.current?.({
        preset: next,
        fontScale: activeFontScale,
        reduceMotion: activeReduceMotionOverride,
      });
    },
    [preset, activeFontScale, activeReduceMotionOverride],
  );

  const setFontScale = useCallback(
    (next: number) => {
      const clamped = clampFontScale(next);
      if (fontScale === undefined) setInternalFontScale(clamped);
      onChangeRef.current?.({
        preset: activePreset,
        fontScale: clamped,
        reduceMotion: activeReduceMotionOverride,
      });
    },
    [fontScale, activePreset, activeReduceMotionOverride],
  );

  const setReduceMotion = useCallback(
    (next: boolean | undefined) => {
      if (reduceMotion === undefined) setInternalReduceMotion(next);
      onChangeRef.current?.({
        preset: activePreset,
        fontScale: activeFontScale,
        reduceMotion: next,
      });
    },
    [reduceMotion, activePreset, activeFontScale],
  );

  const theme = useMemo(
    () =>
      buildTheme({
        preset: activePreset,
        ...(palette !== undefined ? { palette } : {}),
        fontScale: activeFontScale,
        reduceMotion: activeReduceMotion,
      }),
    [activePreset, palette, activeFontScale, activeReduceMotion],
  );

  const controller = useMemo<ThemeController>(
    () => ({
      theme,
      preset: activePreset,
      fontScale: activeFontScale,
      reduceMotion: activeReduceMotion,
      setPreset,
      setFontScale,
      setReduceMotion,
    }),
    [
      theme,
      activePreset,
      activeFontScale,
      activeReduceMotion,
      setPreset,
      setFontScale,
      setReduceMotion,
    ],
  );

  return <ThemeContext.Provider value={controller}>{children}</ThemeContext.Provider>;
}

/** Reads the active {@link Theme} tokens (falls back to `obsidianCrimson` outside a provider). */
export function useTheme(): Theme {
  return useContext(ThemeContext).theme;
}

/** Reads the active theme and live setters (`setPreset`, `setFontScale`, `setReduceMotion`). */
export function useThemeController(): ThemeController {
  return useContext(ThemeContext);
}
