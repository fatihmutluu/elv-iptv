export {
  type CatalogUiCache,
  type CatalogUiCacheOptions,
  CatalogUiCacheProvider,
  type CatalogUiCacheProviderProps,
  createCatalogUiCache,
  RouteActiveProvider,
  type RouteActiveProviderProps,
  useActiveEffect,
  useCatalogUiCache,
  useDocumentVisible,
  useRouteActive,
} from '../shared';
export { AdaptiveNavShell } from './AdaptiveNavShell';
export {
  AppProviders,
  type AppProvidersProps,
  type PreferencesContextValue,
  usePreferences,
} from './AppProviders';
export {
  CrashRecoveryBoundary,
  type CrashRecoveryBoundaryProps,
  formatRedactedErrorCode,
} from './CrashRecoveryBoundary';
export type { AdaptiveNavShellProps, NavDestination, NavUtility } from './types';
export {
  type RunCatalogPrewarmOptions,
  runCatalogPrewarm,
  type UseCatalogPrewarmOptions,
  useCatalogPrewarm,
} from './useCatalogPrewarm';
export { type UseShellFlushOptions, useShellFlush } from './useShellFlush';
export {
  type ShellSourcesState,
  type UseShellSourcesOptions,
  useShellSources,
} from './useShellSources';
