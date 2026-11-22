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
  type BrowseFocusMemory,
  BrowseFocusMemoryProvider,
  type BrowseFocusMemoryProviderProps,
  createBrowseFocusMemory,
  DEFAULT_BROWSE_FOCUS_MAX_ENTRIES,
  useBrowseFocusMemory,
} from './browse-focus-memory';
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
export {
  type ConnectionLimitGuard,
  type PendingConnectionPrompt,
  type UseConnectionLimitGuardOptions,
  useConnectionLimitGuard,
} from './useConnectionLimitGuard';
export {
  type ImportHealthState,
  type UseImportHealthOptions,
  useImportHealth,
} from './useImportHealth';
export { type UseShellFlushOptions, useShellFlush } from './useShellFlush';
export {
  type ShellSourcesState,
  type UseShellSourcesOptions,
  useShellSources,
} from './useShellSources';
