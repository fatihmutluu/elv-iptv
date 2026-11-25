import type { AccessibilityFontFamily } from '@elv/domain';
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
import { AccessibilityInfo, Platform } from 'react-native';
import { DEFAULT_THEME_PRESET, type ThemePalette, type ThemePresetId } from './presets';
import { buildTheme, clampFontScale, FONT_FAMILY_SANS, type Theme } from './tokens';
import { TooltipHostProvider } from './tooltip-host';
import { buildFocusVisibleCss } from './web-styles';

const WEB_BASE_STYLE_ID = 'elv-ui-kit-web-base';
const WEB_FOCUS_VISIBLE_STYLE_ID = 'elv-focus-visible-styles';
const WEB_BASE_FONT_FAMILY =
  FONT_FAMILY_SANS ??
  "'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

const WEB_BASE_CSS = [
  `html, body { font-family: ${WEB_BASE_FONT_FAMILY}; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; }`,
  '* { scrollbar-width: thin; scrollbar-color: var(--elv-scroll-thumb, rgba(255, 255, 255, 0.14)) transparent; }',
  '::-webkit-scrollbar { width: 6px; height: 6px; }',
  '::-webkit-scrollbar-track { background: transparent; }',
  '::-webkit-scrollbar-thumb { background: var(--elv-scroll-thumb, rgba(255, 255, 255, 0.14)); border-radius: 999px; }',
  '::-webkit-scrollbar-thumb:hover { background: var(--elv-scroll-thumb-hover, rgba(255, 255, 255, 0.24)); }',
].join('\n');

interface WebStyleElementLike {
  id: string;
  textContent: string | null;
  remove?: () => void;
  parentNode?: { removeChild?: (node: WebStyleElementLike) => void } | null;
}

interface WebDocumentLike {
  getElementById(id: string): unknown;
  createElement(tag: 'style'): WebStyleElementLike;
  head?: {
    appendChild(node: WebStyleElementLike): void;
    removeChild?: (node: WebStyleElementLike) => void;
  } | null;
  documentElement?: {
    style?: { setProperty(name: string, value: string): void };
  } | null;
}

const focusVisibleRefCounts = new WeakMap<object, number>();

function getWebDocument(): WebDocumentLike | undefined {
  if (Platform.OS !== 'web') return undefined;
  return (globalThis as { document?: WebDocumentLike }).document;
}

function ensureWebBaseStyles(): void {
  const doc = getWebDocument();
  if (!doc?.head || doc.getElementById(WEB_BASE_STYLE_ID)) return;
  const styleEl = doc.createElement('style');
  styleEl.id = WEB_BASE_STYLE_ID;
  styleEl.textContent = WEB_BASE_CSS;
  doc.head.appendChild(styleEl);
}

function retainWebFocusVisibleStyles(): () => void {
  const doc = getWebDocument();
  if (!doc?.head) return () => undefined;
  focusVisibleRefCounts.set(doc, (focusVisibleRefCounts.get(doc) ?? 0) + 1);
  return () => {
    const next = (focusVisibleRefCounts.get(doc) ?? 1) - 1;
    if (next > 0) {
      focusVisibleRefCounts.set(doc, next);
      return;
    }
    focusVisibleRefCounts.delete(doc);
    const existing = doc.getElementById(WEB_FOCUS_VISIBLE_STYLE_ID) as WebStyleElementLike | null;
    if (!existing) return;
    if (typeof existing.remove === 'function') {
      existing.remove();
    } else if (typeof existing.parentNode?.removeChild === 'function') {
      existing.parentNode.removeChild(existing);
    } else if (typeof doc.head?.removeChild === 'function') {
      doc.head.removeChild(existing);
    }
  };
}

function syncWebFocusVisibleStyles(cssText: string): void {
  const doc = getWebDocument();
  if (!doc?.head) return;
  let styleEl = doc.getElementById(WEB_FOCUS_VISIBLE_STYLE_ID) as WebStyleElementLike | null;
  if (!styleEl) {
    styleEl = doc.createElement('style');
    styleEl.id = WEB_FOCUS_VISIBLE_STYLE_ID;
    doc.head.appendChild(styleEl);
  }
  styleEl.textContent = cssText;
}

function syncWebScrollbarColors(thumb: string, thumbHover: string): void {
  const rootStyle = getWebDocument()?.documentElement?.style;
  if (!rootStyle || typeof rootStyle.setProperty !== 'function') return;
  rootStyle.setProperty('--elv-scroll-thumb', thumb);
  rootStyle.setProperty('--elv-scroll-thumb-hover', thumbHover);
}

/** Live theme controller exposed by {@link useThemeController}. */
export interface ThemeController {
  readonly theme: Theme;
  readonly preset: ThemePresetId;
  readonly fontScale: number;
  readonly reduceMotion: boolean;
  readonly uiFontFamily: AccessibilityFontFamily;
  setPreset(next: ThemePresetId): void;
  setFontScale(next: number): void;
  setReduceMotion(next: boolean | undefined): void;
  setUiFontFamily(next: AccessibilityFontFamily): void;
}

/** Props of {@link ThemeProvider}. */
export interface ThemeProviderProps {
  /** Controlled or initial preset id (defaults to `obsidianCrimson`). */
  preset?: ThemePresetId;
  /** Optional custom palette override (useful for experiments or custom themes). */
  palette?: ThemePalette;
  /** Controlled or initial font scale multiplier (`0.9..1.2`). */
  fontScale?: number;
  /** Explicit reduce-motion override (`true`/`false`), `'system'` (controlled follow-OS), or omitted (uncontrolled). */
  reduceMotion?: boolean | 'system';
  /** Controlled or initial UI typography family (`'system'`, `'atkinson'`, or `'opendyslexic'`). */
  uiFontFamily?: AccessibilityFontFamily;
  /** Notified when preset, font scale, reduce-motion, or UI font family changes through {@link useThemeController}. */
  onChange?: (next: {
    preset: ThemePresetId;
    fontScale: number;
    reduceMotion: boolean | undefined;
    uiFontFamily: AccessibilityFontFamily;
  }) => void;
  children: ReactNode;
}

const DEFAULT_THEME = buildTheme();

const ThemeContext = createContext<ThemeController>({
  theme: DEFAULT_THEME,
  preset: DEFAULT_THEME_PRESET,
  fontScale: 1.0,
  reduceMotion: false,
  uiFontFamily: 'system',
  setPreset: () => undefined,
  setFontScale: () => undefined,
  setReduceMotion: () => undefined,
  setUiFontFamily: () => undefined,
});

/** Provides reactive Cinema Quietude design tokens and live theme/accessibility switching. */
export function ThemeProvider({
  preset,
  palette,
  fontScale,
  reduceMotion,
  uiFontFamily,
  onChange,
  children,
}: ThemeProviderProps): ReactElement {
  const [internalPreset, setInternalPreset] = useState<ThemePresetId>(
    preset ?? DEFAULT_THEME_PRESET,
  );
  const [internalFontScale, setInternalFontScale] = useState<number>(clampFontScale(fontScale));
  const [internalReduceMotion, setInternalReduceMotion] = useState<boolean | undefined>(
    typeof reduceMotion === 'boolean' ? reduceMotion : undefined,
  );
  const [internalUiFontFamily, setInternalUiFontFamily] = useState<AccessibilityFontFamily>(
    uiFontFamily ?? 'system',
  );
  const [systemReduceMotion, setSystemReduceMotion] = useState(false);

  useEffect(() => {
    ensureWebBaseStyles();
    return retainWebFocusVisibleStyles();
  }, []);

  useEffect(() => {
    let active = true;
    if (typeof AccessibilityInfo?.isReduceMotionEnabled === 'function') {
      const pending = AccessibilityInfo.isReduceMotionEnabled();
      if (pending && typeof pending.then === 'function') {
        void pending
          .then((enabled) => {
            if (active) setSystemReduceMotion(Boolean(enabled));
          })
          .catch(() => undefined);
      }
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
    reduceMotion === 'system'
      ? undefined
      : reduceMotion !== undefined
        ? reduceMotion
        : internalReduceMotion;
  const activeReduceMotion = activeReduceMotionOverride ?? systemReduceMotion;
  const activeUiFontFamily: AccessibilityFontFamily = uiFontFamily ?? internalUiFontFamily;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const setPreset = useCallback(
    (next: ThemePresetId) => {
      if (preset === undefined) setInternalPreset(next);
      onChangeRef.current?.({
        preset: next,
        fontScale: activeFontScale,
        reduceMotion: activeReduceMotionOverride,
        uiFontFamily: activeUiFontFamily,
      });
    },
    [preset, activeFontScale, activeReduceMotionOverride, activeUiFontFamily],
  );

  const setFontScale = useCallback(
    (next: number) => {
      const clamped = clampFontScale(next);
      if (fontScale === undefined) setInternalFontScale(clamped);
      onChangeRef.current?.({
        preset: activePreset,
        fontScale: clamped,
        reduceMotion: activeReduceMotionOverride,
        uiFontFamily: activeUiFontFamily,
      });
    },
    [fontScale, activePreset, activeReduceMotionOverride, activeUiFontFamily],
  );

  const setReduceMotion = useCallback(
    (next: boolean | undefined) => {
      if (reduceMotion === undefined) setInternalReduceMotion(next);
      onChangeRef.current?.({
        preset: activePreset,
        fontScale: activeFontScale,
        reduceMotion: next,
        uiFontFamily: activeUiFontFamily,
      });
    },
    [reduceMotion, activePreset, activeFontScale, activeUiFontFamily],
  );

  const setUiFontFamily = useCallback(
    (next: AccessibilityFontFamily) => {
      if (uiFontFamily === undefined) setInternalUiFontFamily(next);
      onChangeRef.current?.({
        preset: activePreset,
        fontScale: activeFontScale,
        reduceMotion: activeReduceMotionOverride,
        uiFontFamily: next,
      });
    },
    [uiFontFamily, activePreset, activeFontScale, activeReduceMotionOverride],
  );

  const theme = useMemo(
    () =>
      buildTheme({
        preset: activePreset,
        ...(palette !== undefined ? { palette } : {}),
        fontScale: activeFontScale,
        reduceMotion: activeReduceMotion,
        uiFontFamily: activeUiFontFamily,
      }),
    [activePreset, palette, activeFontScale, activeReduceMotion, activeUiFontFamily],
  );

  const focusVisibleCss = useMemo(() => buildFocusVisibleCss(theme), [theme]);

  useEffect(() => {
    syncWebFocusVisibleStyles(focusVisibleCss);
  }, [focusVisibleCss]);

  useEffect(() => {
    syncWebScrollbarColors(theme.colors.glassBorder, theme.colors.hoverRingBorder);
  }, [theme.colors.glassBorder, theme.colors.hoverRingBorder]);

  const controller = useMemo<ThemeController>(
    () => ({
      theme,
      preset: activePreset,
      fontScale: activeFontScale,
      reduceMotion: activeReduceMotion,
      uiFontFamily: activeUiFontFamily,
      setPreset,
      setFontScale,
      setReduceMotion,
      setUiFontFamily,
    }),
    [
      theme,
      activePreset,
      activeFontScale,
      activeReduceMotion,
      activeUiFontFamily,
      setPreset,
      setFontScale,
      setReduceMotion,
      setUiFontFamily,
    ],
  );

  return (
    <ThemeContext.Provider value={controller}>
      <TooltipHostProvider theme={theme}>{children}</TooltipHostProvider>
    </ThemeContext.Provider>
  );
}

/** Reads the active {@link Theme} tokens (falls back to `obsidianCrimson` outside a provider). */
export function useTheme(): Theme {
  return useContext(ThemeContext).theme;
}

/** Reads the active theme and live setters (`setPreset`, `setFontScale`, `setReduceMotion`). */
export function useThemeController(): ThemeController {
  return useContext(ThemeContext);
}
