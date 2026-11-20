import {
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  ok,
  type PreferencesPatch,
  type PreferencesSnapshot,
  type PreferencesStore,
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

/** Props of {@link AppProviders}. */
export interface AppProvidersProps {
  preferencesStore?: PreferencesStore;
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
  updatePreferences(patch: PreferencesPatch): Promise<Result<PreferencesSnapshot>>;
  resetPreferences(): Promise<Result<PreferencesSnapshot>>;
}

const DEFAULT_PREFERENCES_CONTEXT: PreferencesContextValue = {
  preferences: DEFAULT_PREFERENCES,
  ready: false,
  updatePreferences: async () => ok(DEFAULT_PREFERENCES),
  resetPreferences: async () => ok(DEFAULT_PREFERENCES),
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
  systemLocale,
  i18n,
  viewport,
  onError,
  children,
}: AppProvidersProps): ReactElement {
  const effectiveSystemLocale: AppLocale = systemLocale ?? i18n?.locale ?? 'en';

  const fallbackStore = useMemo(() => createMemoryPreferencesStore(), []);
  const store = preferencesStore ?? fallbackStore;

  const initialLocaleRef = useRef<AppLocale>(effectiveSystemLocale);
  const fallbackI18n = useMemo(() => createAppI18n(initialLocaleRef.current), []);
  const activeI18n = i18n ?? fallbackI18n;

  const [preferences, setPreferences] = useState<PreferencesSnapshot>(DEFAULT_PREFERENCES);
  const [ready, setReady] = useState(false);

  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;

  useEffect(() => {
    let cancelled = false;
    setReady(false);

    const unsubscribe = store.subscribe((snapshot) => {
      if (!cancelled) {
        setPreferences(snapshot);
        setReady(true);
      }
    });

    void store
      .load()
      .then((snapshot) => {
        if (!cancelled) {
          setPreferences(snapshot);
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
    (next: { preset: ThemePresetId; fontScale: number; reduceMotion: boolean | undefined }) => {
      const current = preferencesRef.current;
      const patch: {
        themePreset?: ThemePresetId;
        fontScale?: number;
        reduceMotion?: boolean;
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
      if (Object.keys(patch).length > 0) {
        void store.update(patch);
      }
    },
    [store],
  );

  const updatePreferences = useCallback((patch: PreferencesPatch) => store.update(patch), [store]);

  const resetPreferences = useCallback(() => store.reset(), [store]);

  const contextValue = useMemo<PreferencesContextValue>(
    () => ({
      preferences,
      ready,
      updatePreferences,
      resetPreferences,
    }),
    [preferences, ready, updatePreferences, resetPreferences],
  );

  return (
    <TvRemoteProvider>
      <ViewportProvider {...(viewport !== undefined ? { value: viewport } : {})}>
        <I18nProvider i18n={activeI18n}>
          <ThemeProvider
            preset={themePreset}
            fontScale={preferences.fontScale}
            reduceMotion={preferences.reduceMotion}
            onChange={handleThemeChange}
          >
            <PreferencesContext.Provider value={contextValue}>
              <ErrorBoundary {...(onError !== undefined ? { onError } : {})}>
                {children}
              </ErrorBoundary>
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
