import { type AppI18n, createAppI18n } from '@elv/i18n';
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from 'react';

const fallbackI18n: AppI18n = createAppI18n('en');

const I18nContext = createContext<AppI18n>(fallbackI18n);

/** Provides a reactive {@link AppI18n} instance to React Native / React Native Web components. */
export function I18nProvider({
  i18n,
  children,
}: {
  i18n: AppI18n;
  children: ReactNode;
}): ReactElement {
  return <I18nContext.Provider value={i18n}>{children}</I18nContext.Provider>;
}

/** Subscribes the calling component to locale changes and returns the active {@link AppI18n}. */
export function useI18n(): AppI18n {
  const i18n = useContext(I18nContext);
  useSyncExternalStore(
    i18n.subscribe,
    () => i18n.locale,
    () => i18n.locale,
  );
  return i18n;
}
