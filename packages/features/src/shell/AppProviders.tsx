import {
  type AccessibilityFontFamily,
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  type KeymapStore,
  ok,
  type PreferencesPatch,
  type PreferencesSnapshot,
  type PreferencesStore,
  type ProfilePreferencesManager,
  type Result,
} from '@elv/domain';
import { type AppI18n, type AppLocale, createAppI18n, resolveLocale } from '@elv/i18n';
import {
  DEFAULT_THEME_PRESET,
  ErrorBoundary,
  I18nProvider,
  isThemePresetId,
  type ThemePresetId,
  ThemeProvider,
  TvRemoteProvider,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
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
import { StreamHealthProvider } from '../shared';

/** Props of {@link AppProviders}. */
export interface AppProvidersProps {
  preferencesStore?: PreferencesStore;
  /** Optional multi-profile preferences manager (`#15`); used as `preferencesStore` when omitted. */
  profilePreferences?: ProfilePreferencesManager;
  /** Optional dedicated sparse remote keymap store (`#33`). */
  keymapStore?: KeymapStore;
  systemLocale?: AppLocale;
  i18n?: AppI18n;
  viewport?: ViewportOverride;
  onError?: (error: Error) => void;
  children: ReactNode;
}

/** Reactive preferences context value exposed by {@link usePreferences}. */
export interface PreferencesContextValue {
  readonly preferences: PreferencesSnapshot;
  readonly ready: boolean;
  readonly profilePreferences?: ProfilePreferencesManager;
  readonly keymapStore?: KeymapStore;
  updatePreferences(patch: PreferencesPatch): Promise<Result<PreferencesSnapshot>>;
  resetPreferences(): Promise<Result<PreferencesSnapshot>>;
  flushPreferences(): Promise<void>;
}

const DEFAULT_PREFERENCES_CONTEXT: PreferencesContextValue = {
  preferences: DEFAULT_PREFERENCES,
  ready: false,
  updatePreferences: async () => ok(DEFAULT_PREFERENCES),
  resetPreferences: async () => ok(DEFAULT_PREFERENCES),
  flushPreferences: async () => undefined,
};

const PreferencesContext = createContext<PreferencesContextValue>(DEFAULT_PREFERENCES_CONTEXT);

/**
 * Reusable root provider tree wiring `TvRemoteProvider`, `ViewportProvider`, reactive `I18nProvider`,
 * live `ThemeProvider`, persisted `PreferencesStore`, and `ErrorBoundary`.
 *
 * Switching locale updates `i18n.setLocale(...)` in place so screens re-render with updated copy
 * without remounting child state (`#16`).
 */
export function AppProviders({
  preferencesStore,
  profilePreferences,
  keymapStore,
  systemLocale,
  i18n,
  viewport,
  onError,
  children,
}: AppProvidersProps): ReactElement {
  const initialI18nRef = useRef<{ i18n: AppI18n | undefined; locale: AppLocale }>({
    i18n,
    locale: i18n?.locale ?? 'en',
  });
  if (initialI18nRef.current.i18n !== i18n) {
    initialI18nRef.current = { i18n, locale: i18n?.locale ?? 'en' };
  }
  const effectiveSystemLocale: AppLocale = systemLocale ?? initialI18nRef.current.locale;

  const fallbackStore = useMemo(() => createMemoryPreferencesStore(), []);
  const store = preferencesStore ?? profilePreferences ?? fallbackStore;

  const initialLocaleRef = useRef<AppLocale>(effectiveSystemLocale);
  const fallbackI18n = useMemo(() => createAppI18n(initialLocaleRef.current), []);
  const activeI18n = i18n ?? fallbackI18n;

  const [preferences, setPreferences] = useState<PreferencesSnapshot>(DEFAULT_PREFERENCES);
  const [ready, setReady] = useState(false);

  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;

  useEffect(() => {
    let cancelled = false;
    let settledBySubscription = false;
    setReady(false);

    const unsubscribe = store.subscribe((snapshot) => {
      if (!cancelled) {
        settledBySubscription = true;
        setPreferences(snapshot);
        setReady(true);
      }
    });

    void store
      .load()
      .then((snapshot) => {
        if (!cancelled) {
          if (!settledBySubscription) setPreferences(snapshot);
          setReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [store]);

  const resolvedLocale: AppLocale =
    preferences.locale === 'system' ? effectiveSystemLocale : resolveLocale([preferences.locale]);

  useEffect(() => {
    activeI18n.setLocale(resolvedLocale);
  }, [activeI18n, resolvedLocale]);

  const themePreset: ThemePresetId = isThemePresetId(preferences.themePreset)
    ? preferences.themePreset
    : DEFAULT_THEME_PRESET;

  const handleThemeChange = useCallback(
    (next: {
      preset: ThemePresetId;
      fontScale: number;
      reduceMotion: boolean | undefined;
      uiFontFamily: AccessibilityFontFamily;
    }) => {
      const current = preferencesRef.current;
      const patch: {
        themePreset?: ThemePresetId;
        fontScale?: number;
        reduceMotion?: boolean;
        uiFontFamily?: AccessibilityFontFamily;
      } = {};
      if (next.preset !== current.themePreset) {
        patch.themePreset = next.preset;
      }
      if (next.fontScale !== current.fontScale) {
        patch.fontScale = next.fontScale;
      }
      const nextReduceMotion = next.reduceMotion ?? false;
      if (nextReduceMotion !== current.reduceMotion) {
        patch.reduceMotion = nextReduceMotion;
      }
      if (next.uiFontFamily !== current.uiFontFamily) {
        patch.uiFontFamily = next.uiFontFamily;
      }
      if (Object.keys(patch).length > 0) {
        void store.update(patch);
      }
    },
    [store],
  );

  const updatePreferences = useCallback((patch: PreferencesPatch) => store.update(patch), [store]);

  const resetPreferences = useCallback(() => store.reset(), [store]);

  const flushPreferences = useCallback(() => store.flush?.() ?? Promise.resolve(), [store]);

  useEffect(() => {
    return () => {
      void Promise.resolve()
        .then(() => store.flush?.())
        .catch(() => undefined);
    };
  }, [store]);

  const contextValue = useMemo<PreferencesContextValue>(
    () => ({
      preferences,
      ready,
      ...(profilePreferences !== undefined ? { profilePreferences } : {}),
      ...(keymapStore !== undefined ? { keymapStore } : {}),
      updatePreferences,
      resetPreferences,
      flushPreferences,
    }),
    [
      preferences,
      ready,
      profilePreferences,
      keymapStore,
      updatePreferences,
      resetPreferences,
      flushPreferences,
    ],
  );

  return (
    <TvRemoteProvider>
      <ViewportProvider
        overscanX={preferences.overscanX}
        overscanY={preferences.overscanY}
        {...(viewport !== undefined ? { value: viewport } : {})}
      >
        <I18nProvider i18n={activeI18n}>
          <ThemeProvider
            preset={themePreset}
            fontScale={preferences.fontScale}
            reduceMotion={preferences.reduceMotion ? true : 'system'}
            uiFontFamily={preferences.uiFontFamily}
            onChange={handleThemeChange}
          >
            <PreferencesContext.Provider value={contextValue}>
              <StreamHealthProvider>
                <ErrorBoundary {...(onError !== undefined ? { onError } : {})}>
                  {children}
                </ErrorBoundary>
              </StreamHealthProvider>
            </PreferencesContext.Provider>
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    </TvRemoteProvider>
  );
}

/** Reads and mutates user preferences provided by {@link AppProviders}. */
export function usePreferences(): PreferencesContextValue {
  return useContext(PreferencesContext);
}
