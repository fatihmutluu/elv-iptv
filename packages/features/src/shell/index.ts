export {
  type CatalogUiCache,
  type CatalogUiCacheOptions,
  CatalogUiCacheProvider,
  type CatalogUiCacheProviderProps,
  createCatalogUiCache,
  RouteActiveProvider,
  type RouteActiveProviderProps,
  type StreamHealthContextValue,
  StreamHealthProvider,
  type StreamHealthProviderProps,
  useActiveEffect,
  useCatalogUiCache,
  useChannelHealthStatus,
  useDocumentVisible,
  useRouteActive,
  useStreamHealth,
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
  sanitizeStackSignature,
} from './CrashRecoveryBoundary';
export {
  type CommandPaletteItem,
  type CommandPaletteSettingsSection,
  type CommandPaletteTab,
  DesktopCommandPalette,
  type DesktopCommandPaletteProps,
  filterCommandPaletteItems,
} from './DesktopCommandPalette';
export {
  DesktopShortcutSheet,
  type DesktopShortcutSheetProps,
} from './DesktopShortcutSheet';
export {
  PrivacyConsentOverlay,
  type PrivacyConsentOverlayProps,
} from './PrivacyConsentOverlay';
export {
  ProfileDropdownMenu,
  type ProfileDropdownMenuProps,
} from './ProfileDropdownMenu';
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
  type DesktopShellKeyEventLike,
  type DesktopShellShortcutAction,
  type DesktopShellShortcutGuardState,
  formatShortcutModifier,
  isMacPlatform,
  matchDesktopShellShortcut,
  type UseDesktopShellShortcutsOptions,
  useDesktopShellShortcuts,
} from './useDesktopShellShortcuts';
export {
  type UseGuideAutoRefreshOptions,
  useGuideAutoRefresh,
} from './useGuideAutoRefresh';
export {
  type ImportHealthState,
  type UseImportHealthOptions,
  useImportHealth,
} from './useImportHealth';
export {
  type OnboardingImportCoordinator,
  type OnboardingImportState,
  type OnboardingImportStatus,
  type UseOnboardingImportCoordinatorOptions,
  useOnboardingImportCoordinator,
} from './useOnboardingImportCoordinator';
export { type UseShellFlushOptions, useShellFlush } from './useShellFlush';
export {
  type ShellSourcesState,
  type UseShellSourcesOptions,
  useShellSources,
} from './useShellSources';
export {
  computeDueStartupRefreshTasks,
  type StartupRefreshCoordinator,
  type StartupRefreshState,
  type StartupRefreshTask,
  type UseStartupRefreshCoordinatorOptions,
  useStartupRefreshCoordinator,
} from './useStartupRefreshCoordinator';
