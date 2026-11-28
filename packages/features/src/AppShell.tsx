import type { SearchScope } from '@elv/data';
import { useI18n, useViewport } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useShellPlaybackModes } from './app-shell-desktop';
import { useAppShellOnboarding } from './app-shell-onboarding';
import {
  useShellManagementOverlays,
  useShellObservedCatalog,
  useShellProfileEffects,
  useShellSourceControls,
} from './app-shell-overlays';
import { AppShellPlayerHost } from './app-shell-player';
import {
  AppShellContextProviders,
  type AppShellProps,
  AppShellStage,
  useShellArtworkCacheLimit,
  useShellExitBackGuard,
  useShellIncomingLocalPlaylist,
  useShellLiveTabMemory,
} from './app-shell-sections';
import {
  type AppTab,
  clearSourceFromCatalogMemory,
  clearSourceFromLiveMemory,
  enrichPlayTargetAccountKey,
  handleShellTopNavBack,
  INITIAL_CATALOG_MEMORY,
  type PrimaryNavTab,
} from './app-shell-state';
import { useSyncDirtyCatalog } from './app-shell-sync-hooks';
import {
  AppShellAllOverlays,
  buildShellStageOptionalProps,
  createShellPlayerExitHandler,
  useShellPlatformBridges,
  useShellStageNavHandlers,
  useShellTopOverlays,
} from './app-shell-top-overlays';
import { useAppShellWaveF7b } from './app-shell-wave-f7b';
import { useWaveF9Controller } from './app-shell-wave-f9';
import {
  AppShellProfileAndKeymapProviders,
  useAppShellDesktopErgonomics,
} from './app-shell-wave-q7';
import type { CatalogTabMemory } from './catalog';
import { recordChannelTune } from './live';
import type { PlayTarget } from './ports/play-target';
import { createPlaybackGuard } from './ports/playback-guard';
import { useOledScreensaver } from './screensaver';
import type { SettingsSection } from './settings';
import {
  buildElvCacheFingerprint,
  type DetailTarget,
  isElvFeatureActive,
  useElvBackgroundMatcher,
  useProfile,
} from './shared';
import { broadcastSessionGuardEvent } from './shared/session-guard-channel';
import {
  AdaptiveNavShell,
  CrashRecoveryBoundary,
  createBrowseFocusMemory,
  createCatalogUiCache,
  useCatalogPrewarm,
  useConnectionLimitGuard,
  useDocumentVisible,
  useImportHealth,
  usePreferences,
  useShellFlush,
  useShellSources,
} from './shell';
import { CachedCatalogStrip } from './sources/CachedCatalogStrip';

export type { AppShellProps, AppTab };

/** Top-level Cinema Quietude shell (`Home`, `Live`, `Movies`, `Series` + `Search`, `Settings`, `DetailScreen`, `PlayerScreen`). */
export function AppShell(props: AppShellProps): ReactElement {
  const syncCatalog = useSyncDirtyCatalog(props.catalog, props.syncAccount);
  const [suppressAutoPicker, setSuppressAutoPicker] = useState(true);
  return (
    <AppShellProfileAndKeymapProviders
      catalog={syncCatalog}
      suppressAutoProfilePicker={suppressAutoPicker}
      {...(props.externalRefreshToken !== undefined
        ? { externalRefreshToken: props.externalRefreshToken }
        : {})}
      {...(props.profilePreferences !== undefined
        ? { profilePreferences: props.profilePreferences }
        : {})}
      {...(props.keymapStore !== undefined ? { keymapStore: props.keymapStore } : {})}
    >
      <AppShellContent
        {...props}
        catalog={syncCatalog}
        onSuppressAutoProfilePickerChange={setSuppressAutoPicker}
      />
    </AppShellProfileAndKeymapProviders>
  );
}

type AppShellInternalProps = AppShellProps & {
  readonly onSuppressAutoProfilePickerChange: (s: boolean) => void;
};

function AppShellContent(props: AppShellInternalProps): ReactElement {
  const { catalog, videoHost, appLifecycle, onPlaybackGuardReady } = props;
  const externalRefreshToken = props.externalRefreshToken ?? 0;
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';
  const preferences = usePreferences();
  const profile = useProfile();
  const stopEmbeddedPreviewRef = useRef<(() => Promise<void>) | null>(null);
  const handleRegisterStopPreview = useCallback((s: (() => Promise<void>) | null) => {
    stopEmbeddedPreviewRef.current = s;
  }, []);
  const stopActivePlayerRef = useRef<(() => Promise<void>) | null>(null);
  const handleRegisterStopActivePlayer = useCallback((s: (() => Promise<void>) | null) => {
    stopActivePlayerRef.current = s;
  }, []);
  const hasProfileOverlay = profile.profilePickerOpen || profile.pinDialog !== null;
  useShellArtworkCacheLimit(preferences.preferences.artworkCacheLimitMb);
  const [activeTab, setActiveTab] = useState<AppTab>('settings');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('sources');
  const [topNavFocused, setTopNavFocused] = useState(false);
  const [heroScrolled, setHeroScrolled] = useState(false);
  const [userPickedTab, setUserPickedTab] = useState(false);
  const [userStateVersion, setUserStateVersion] = useState(0);
  const [reminderVersion, setReminderVersion] = useState(0);
  const { liveMemory, setLiveMemory, handleLiveMemoryChange, resetLiveMemory } =
    useShellLiveTabMemory(preferences.preferences.defaultLiveMode, activeTab);
  const [catalogMemoryByTab, setCatalogMemoryByTab] = useState(INITIAL_CATALOG_MEMORY);
  const [detailStack, setDetailStack] = useState<readonly DetailTarget[]>([]);
  const [recentSearches, setRecentSearches] = useState<readonly string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<SearchScope>('all');
  const [playTarget, setPlayTarget] = useState<PlayTarget | null>(null);
  const [playerPlaybackActive, setPlayerPlaybackActive] = useState(false);
  const [liveEmbeddedPlaybackActive, setLiveEmbeddedPlaybackActive] = useState(false);
  const [stageKey, setStageKey] = useState(0);
  const [appForeground, setAppForeground] = useState(true);
  const resetToFullModeRef = useRef<(clearAdoption?: boolean) => void>(() => undefined);
  const closeMultiViewForSourceRef = useRef<(sourceId: string) => void>(() => undefined);
  const userPickedTabRef = useRef(false);
  const userPickedSettingsSectionRef = useRef(false);
  const resetExitGuardRef = useRef<() => void>(() => undefined);
  const playTargetRef = useRef(playTarget);
  playTargetRef.current = playTarget;
  const documentVisible = useDocumentVisible();
  const locale = i18n.locale;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scoped UI caches reset strictly per catalog instance
  const { uiCache, focusMemory } = useMemo(
    () => ({ uiCache: createCatalogUiCache(), focusMemory: createBrowseFocusMemory() }),
    [catalog],
  );
  const clearSearchSession = useCallback(() => {
    setRecentSearches([]);
    setSearchQuery('');
    setSearchScope('all');
    uiCache.clearSearch();
  }, [uiCache]);
  const handleInitialSourcesReady = useCallback(() => {
    if (!userPickedTabRef.current) {
      setActiveTab('home');
      if (!userPickedSettingsSectionRef.current) setSettingsSection('appearance');
    }
  }, []);
  const shell = useShellSources({
    catalog,
    externalRefreshToken,
    onEmptySources: clearSearchSession,
    onInitialSourcesReady: handleInitialSourcesReady,
  });
  const { sources, sourcesRef, sourcesResolved, refreshToken, catalogRevision } = shell;
  const { visibleSources, profileScopeRef, onRefreshCatalogNow, onRefreshGuideNow } =
    useShellSourceControls({
      catalog,
      sources,
      sourcesRef,
      profile,
      uiCache,
      syncSourcesAndBump: shell.syncSourcesAndBump,
    });
  const mgmtOverlays = useShellManagementOverlays(profile, sources);
  const profileScopeKey = `${profile.activeProfileId}:${profile.parentalUnlocked ? '1' : '0'}:${profile.parentalLoadError ? '1' : '0'}:${profile.profileRevision}`;
  const elvCacheKey = buildElvCacheFingerprint(preferences.preferences);
  uiCache.setRevision(catalogRevision, locale, profileScopeKey, elvCacheKey);
  const openPlayTarget = useCallback(
    (enriched: PlayTarget) => {
      resetExitGuardRef.current();
      resetToFullModeRef.current();
      setHeroScrolled(false);
      playTargetRef.current = enriched;
      setPlayTarget(enriched);
      if (enriched.kind === 'live') {
        setLiveMemory((p) => ({ ...p, ...recordChannelTune(p, enriched.itemKey) }));
      }
    },
    [setLiveMemory],
  );
  const replacePlayTarget = useCallback(
    (enriched: PlayTarget) => {
      playTargetRef.current = enriched;
      setPlayTarget(enriched);
      if (enriched.kind === 'live') {
        setLiveMemory((p) => ({
          ...p,
          ...recordChannelTune(p, enriched.itemKey),
          ...(enriched.previousChannel !== undefined
            ? { previousChannelKey: enriched.previousChannel.itemKey }
            : {}),
        }));
      }
    },
    [setLiveMemory],
  );
  const interceptOpenPlayTargetRef = useRef<(enriched: PlayTarget) => void>(openPlayTarget);
  const stopOtherStreamRef = useRef<(streamId: string) => void>(() => undefined);
  const connectionGuard = useConnectionLimitGuard({
    sourcesRef,
    enrichTarget: enrichPlayTargetAccountKey,
    autoReplaceSingleConnection: preferences.preferences.autoReplaceSingleConnection,
    ...(props.connectionTracker !== undefined
      ? { connectionTracker: props.connectionTracker }
      : {}),
    onOpenTarget: useCallback((enriched: PlayTarget) => {
      interceptOpenPlayTargetRef.current(enriched);
    }, []),
    onAdoptTarget: openPlayTarget,
    onReplaceTarget: replacePlayTarget,
    onStopOtherStream: useCallback((streamId: string) => {
      stopOtherStreamRef.current(streamId);
    }, []),
  });
  const stopForSource = useCallback(
    (sourceId: string): void => {
      if (playTargetRef.current?.sourceId === sourceId) {
        playTargetRef.current = null;
        setPlayTarget(null);
        resetToFullModeRef.current(true);
        connectionGuard.releaseActive();
      }
      closeMultiViewForSourceRef.current(sourceId);
      broadcastSessionGuardEvent({ type: 'source-deleted', sourceId });
      uiCache.invalidateSource(sourceId);
      setLiveMemory((prev) => clearSourceFromLiveMemory(prev, sourceId));
      setCatalogMemoryByTab((prev) => clearSourceFromCatalogMemory(prev, sourceId));
      setDetailStack((prev) => prev.filter((entry) => entry.sourceId !== sourceId));
    },
    [connectionGuard.releaseActive, setLiveMemory, uiCache],
  );
  const playbackGuard = useMemo(() => createPlaybackGuard(stopForSource), [stopForSource]);
  useEffect(() => onPlaybackGuardReady?.(playbackGuard), [onPlaybackGuardReady, playbackGuard]);
  const handlePlay = connectionGuard.requestPlay;
  const bumpUserState = useCallback(() => setUserStateVersion((v) => v + 1), []);
  const observedCatalog = useShellObservedCatalog(
    catalog,
    playbackGuard,
    shell.syncSourcesAndBump,
    bumpUserState,
    profileScopeRef,
  );
  const stopActivePlayback = useCallback(() => {
    connectionGuard.releaseActive();
    playTargetRef.current = null;
    setPlayTarget(null);
    resetToFullModeRef.current(true);
  }, [connectionGuard.releaseActive]);
  const modes = useShellPlaybackModes({
    desktopWindow: props.desktopWindow,
    thermalDevice: props.thermalDevice,
    downloadManager: props.downloadManager,
    catalog: observedCatalog,
    getDockPolicy: () => ({
      ...profileScopeRef.current,
      parentalRestricted:
        profile.parentalSettings.enabled ||
        profile.parentalLocks.length > 0 ||
        profile.activeProfile.isKids,
    }),
    videoHost,
    stopActivePlayerRef,
    stopEmbeddedPreviewRef,
    minimizeToTray: preferences.preferences.minimizeToTray,
    backgroundAudioPlayback: preferences.preferences.backgroundAudioPlayback,
    playTarget,
    liveEmbeddedPlaybackActive,
    playTargetRef,
    onStopActivePlayback: stopActivePlayback,
    onRequestPlay: handlePlay,
    onAdoptPlay: connectionGuard.adoptPlay,
  });
  resetToFullModeRef.current = modes.resetToFullMode;
  stopOtherStreamRef.current = () => {
    if (modes.multiViewSeedRef.current !== null) modes.closeMultiView();
    void stopEmbeddedPreviewRef.current?.();
  };
  closeMultiViewForSourceRef.current = (sourceId: string) =>
    modes.closeMultiViewForSource(sourceId, sourcesRef.current, connectionGuard.tracker);
  const isBrowsing =
    modes.multiViewSeed === null && (playTarget === null || modes.playerViewMode === 'mini');
  const isFullPlayerActive =
    modes.multiViewSeed !== null || (playTarget !== null && modes.playerViewMode === 'full');
  const oledScreensaver = useOledScreensaver({
    timeoutMin: 0,
    isBlocked:
      modes.multiViewSeed !== null ||
      (playTarget !== null && playerPlaybackActive) ||
      (isBrowsing && activeTab === 'live' && liveEmbeddedPlaybackActive),
  });
  const resetTransientMemory = useCallback(() => {
    focusMemory.clear();
    resetLiveMemory();
    setCatalogMemoryByTab(INITIAL_CATALOG_MEMORY);
    setDetailStack([]);
    clearSearchSession();
    setHeroScrolled(false);
  }, [clearSearchSession, focusMemory, resetLiveMemory]);
  const closePopoutWindow = useCallback(() => {
    void props.desktopWindow?.closePopout?.();
  }, [props.desktopWindow]);
  useShellProfileEffects({
    profile,
    catalog: observedCatalog,
    appForeground: appForeground && documentVisible,
    playTargetRef,
    multiViewSeedRef: modes.multiViewSeedRef,
    onResetTransientMemory: resetTransientMemory,
    onStopPlayback: stopActivePlayback,
    onCloseMultiView: modes.closeMultiView,
    onClosePopout: closePopoutWindow,
  });
  const importHealth = useImportHealth({
    catalog: observedCatalog,
    refreshToken,
    externalRefreshToken,
  });
  useShellFlush({
    catalog: observedCatalog,
    ...(appLifecycle !== undefined ? { appLifecycle } : {}),
    flushPreferences: preferences.flushPreferences,
    onForegroundChange: setAppForeground,
  });
  useCatalogPrewarm({
    catalog: observedCatalog,
    sources: visibleSources,
    catalogRevision,
    locale,
    profileKey: profileScopeKey,
    elvKey: elvCacheKey,
    uiCache,
    activeTab,
    enabled: profile.profilesReady,
    groupVodVersions: preferences.preferences.groupVodVersions,
  });
  useElvBackgroundMatcher(observedCatalog, {
    enabled:
      profile.profilesReady &&
      visibleSources.length > 0 &&
      isElvFeatureActive(preferences.preferences, 'elvEnrichMetadata'),
    lang: locale,
    catalogRevision,
  });
  const {
    selectTab,
    handleSettingsSectionChange,
    openSettings,
    openSettingsSection,
    openSources,
    openProfilesSettings,
    openAccountSettings,
    handlePrepareIncomingLocalPlaylist,
    openDetail,
    popDetail,
    handleSearchPerson,
  } = useShellStageNavHandlers({
    sourcesRef,
    resetExitGuardRef,
    userPickedTabRef,
    userPickedSettingsSectionRef,
    playTargetRef,
    releaseConnection: connectionGuard.releaseActive,
    setPlayTarget,
    setUserPickedTab,
    setActiveTab,
    setSettingsSection,
    setDetailStack,
    setHeroScrolled,
    setTopNavFocused,
    setUserStateVersion,
    setSearchQuery,
    setSearchScope,
  });
  const { incomingLocalPlaylist, consumeIncomingLocalPlaylist } = useShellIncomingLocalPlaylist({
    ...(props.sourceImportHost !== undefined ? { sourceImportHost: props.sourceImportHost } : {}),
    onIncomingFile: handlePrepareIncomingLocalPlaylist,
  });
  const activeDetail = detailStack[detailStack.length - 1] ?? null;
  const { exitToastVisible, resetExitGuard, onRootHomeBack } = useShellExitBackGuard(
    preferences.preferences.confirmExitOnBack,
    !isFullPlayerActive && activeTab === 'home' && activeDetail === null,
  );
  resetExitGuardRef.current = resetExitGuard;
  const handleSelectDestination = useCallback(
    (t: PrimaryNavTab) => selectTab(t, false),
    [selectTab],
  );
  const handleExitNavFocus = useCallback(() => {
    resetExitGuard();
    setTopNavFocused(false);
  }, [resetExitGuard]);
  const handleFocusTopNav = useCallback(() => setTopNavFocused(true), []);
  const handleNavBack = useCallback(
    () =>
      handleShellTopNavBack({
        activeTab,
        hasActiveDetail: activeDetail !== null,
        popDetail,
        exitNavFocus: handleExitNavFocus,
        selectHomeInTopNav: () => selectTab('home', false),
        onRootHomeBack,
      }),
    [activeDetail, activeTab, handleExitNavFocus, onRootHomeBack, popDetail, selectTab],
  );
  const handleMovieMemoryChange = useCallback(
    (movie: CatalogTabMemory) => setCatalogMemoryByTab((p) => ({ ...p, movie })),
    [],
  );
  const handleSeriesMemoryChange = useCallback(
    (series: CatalogTabMemory) => setCatalogMemoryByTab((p) => ({ ...p, series })),
    [],
  );
  const handleChannelsMutated = useCallback(() => {
    uiCache.clear();
    shell.bumpCatalogRevision();
    setUserStateVersion((v) => v + 1);
  }, [shell.bumpCatalogRevision, uiCache]);
  const handleFavoritesMutated = useCallback(() => {
    uiCache.clearHome?.();
    setUserStateVersion((v) => v + 1);
  }, [uiCache]);
  const handleReminderChanged = useCallback(() => setReminderVersion((v) => v + 1), []);
  const clearAllCaches = useCallback(() => {
    uiCache.clear();
    shell.bumpCatalogRevision();
    resetTransientMemory();
  }, [resetTransientMemory, shell.bumpCatalogRevision, uiCache]);
  const switchSourceOnCrash = useCallback(() => {
    playTargetRef.current = null;
    setPlayTarget(null);
    openSources();
  }, [openSources]);
  const waveF7b = useAppShellWaveF7b({
    catalog: observedCatalog,
    preferences,
    ...(props.externalPlayer !== undefined ? { externalPlayer: props.externalPlayer } : {}),
    ...(props.diagnostics !== undefined ? { diagnostics: props.diagnostics } : {}),
    ...(props.telemetry !== undefined ? { telemetry: props.telemetry } : {}),
    stopEmbeddedPreviewRef,
    stopActivePlayerRef,
    onOpenIntegrated: openPlayTarget,
    onReleaseConnection: stopActivePlayback,
    onProgressSaved: bumpUserState,
    stageKey,
    bumpStageKey: useCallback(() => setStageKey((k) => k + 1), []),
    clearCaches: clearAllCaches,
    switchSource: switchSourceOnCrash,
  });
  const onboarding = useAppShellOnboarding({
    catalog,
    observedCatalog,
    preferences,
    profile,
    shell,
    uiCache,
    guideAutoRefreshActive:
      documentVisible &&
      appForeground &&
      isBrowsing &&
      !(activeTab === 'live' && liveEmbeddedPlaybackActive),
    onEnterHome: handleInitialSourcesReady,
    onOpenSources: openSources,
    onSuppressAutoProfilePickerChange: props.onSuppressAutoProfilePickerChange,
    ports: props,
  });
  const waveF9 = useWaveF9Controller({
    preferences,
    activeTab,
    ports: props,
    isViewingActive: playerPlaybackActive || liveEmbeddedPlaybackActive,
    hasPlayerTarget: playTarget !== null,
    onOpenAccountSettings: openAccountSettings,
    suppressWelcomeOverlay: true,
    suppressFirstRunOverlays: onboarding.suppressLegacyWaveF9Overlays,
  });
  const visibleSourceIds = useMemo(() => visibleSources.map((s) => s.id), [visibleSources]);
  const { reminders } = useShellPlatformBridges({
    t: i18n.t,
    locale,
    catalog: observedCatalog,
    profile,
    catalogRevision,
    userStateVersion,
    reminderVersion,
    visibleSourceIds,
    onTuneReminder: modes.tuneFromReminder,
    onPlay: handlePlay,
    onOpenDetail: openDetail,
    ...(props.reminderHost !== undefined ? { reminderHost: props.reminderHost } : {}),
    ...(props.tvHomeChannels !== undefined ? { tvHomeChannels: props.tvHomeChannels } : {}),
    pendingDeepLink: props.pendingDeepLink ?? null,
    ...(props.onDeepLinkHandled !== undefined
      ? { onDeepLinkHandled: props.onDeepLinkHandled }
      : {}),
  });
  const topOverlays = useShellTopOverlays({
    t: i18n.t,
    locale,
    activeTab,
    hasActiveDetail: activeDetail !== null,
    isBrowsing,
    profile,
    waveF9,
    onSelectTab: selectTab,
    onOpenProfilesSettings: openProfilesSettings,
    onOpenSettings: openSettings,
    onSearchQueryChange: setSearchQuery,
  });
  const { destinations, utilities } = topOverlays;
  interceptOpenPlayTargetRef.current = waveF7b.externalHandoff.interceptPlayTarget;
  const hasOtherRootOverlay =
    hasProfileOverlay ||
    topOverlays.anyOverlayOpen ||
    mgmtOverlays.anyOpen ||
    connectionGuard.pending !== null ||
    oledScreensaver.state.active ||
    waveF7b.anyOverlayOpen ||
    waveF9.hasOverlay ||
    onboarding.hasOverlay ||
    (isTv && reminders.activeBanner !== null);
  const desktopErgonomics = useAppShellDesktopErgonomics({
    isPlayerOpen: isFullPlayerActive,
    hasOtherModalOverlay: hasOtherRootOverlay,
    preferences,
    profile,
    catalog: observedCatalog,
    uiCache,
    onBumpUserState: bumpUserState,
    onSelectTab: selectTab,
    onOpenSettingsSection: openSettingsSection,
    onOpenSearchPopup: topOverlays.openSearchPopup,
  });
  const hasRootOverlay = hasOtherRootOverlay || desktopErgonomics.anyOverlayOpen;
  const crashProps = waveF7b.crashProps;
  const isResolvingInitialSources =
    !profile.profilesReady ||
    (preferences.ready && onboarding.gatePhase === 'pending') ||
    (!sourcesResolved && !userPickedTab && activeDetail === null);
  const hasHeroOverlay =
    activeDetail !== null || (sourcesResolved && profile.profilesReady && activeTab === 'home');
  const contentIsolationKey = `${profile.activeProfileId}:${profile.parentalUnlocked ? 'u' : 'l'}:${profile.parentalLoadError ? 'e' : 'ok'}`;
  const effectiveRefreshToken = refreshToken + profile.profileRevision;
  const effectiveUserStateVersion = userStateVersion + profile.profileRevision;
  const onPlayerTargetChange = useCallback(
    (next: PlayTarget) => {
      connectionGuard.replaceActiveTarget(next);
      waveF9.notifyPlaybackExitOrSwitch();
    },
    [connectionGuard, waveF9],
  );
  const onPlayerExit = createShellPlayerExitHandler({
    playTargetRef,
    setPlayTarget,
    setLiveMemory,
    recordTune: recordChannelTune,
    releaseConnection: connectionGuard.releaseActive,
    resetToFullMode: modes.resetToFullMode,
    setHeroScrolled,
    bumpUserState,
    notifyPlaybackExitOrSwitch: waveF9.notifyPlaybackExitOrSwitch,
  });
  const showCachedStrip =
    !isResolvingInitialSources &&
    activeDetail === null &&
    activeTab !== 'settings' &&
    importHealth.health.length > 0;
  const stageOptionalProps = buildShellStageOptionalProps({
    ...(props.sourceImportHost !== undefined ? { sourceImportHost: props.sourceImportHost } : {}),
    ...(props.lanPairing !== undefined ? { lanPairing: props.lanPairing } : {}),
    ...(props.trailerExternal !== undefined ? { trailerExternal: props.trailerExternal } : {}),
    ...(props.updater !== undefined ? { updater: props.updater } : {}),
    hasClearRecentChannels: observedCatalog.clearRecentChannels !== undefined,
    onClearRecentChannels: desktopErgonomics.onClearRecentChannels,
    onTelemetryOptInChange: waveF9.onTelemetryOptInChange,
  });
  return (
    <AppShellContextProviders
      routeActive={documentVisible && appForeground}
      uiCache={uiCache}
      focusMemory={focusMemory}
      {...(props.downloadManager !== undefined ? { downloadManager: props.downloadManager } : {})}
      catalog={observedCatalog}
      catalogRevision={catalogRevision}
      elvEnrichActive={isElvFeatureActive(preferences.preferences, 'elvEnrichMetadata')}
      hoverPreviewDisabled={!isBrowsing || hasRootOverlay || isTv}
      hoverPreviewDismissKey={`${activeTab}:${activeDetail?.itemKey ?? ''}:${contentIsolationKey}:${playTarget?.itemKey ?? ''}`}
      onHoverPreviewUserStateMutated={handleFavoritesMutated}
      profileId={profile.activeProfileId}
    >
      <View style={styles.root} onTouchStart={oledScreensaver.recordActivity}>
        {isBrowsing ? (
          <AdaptiveNavShell
            brandTitle={i18n.t('app.title')}
            showBrand
            destinations={destinations}
            utilities={utilities}
            activeId={activeTab}
            onSelectDestination={handleSelectDestination}
            navFocused={topNavFocused && !hasRootOverlay}
            onExitNavFocus={handleExitNavFocus}
            onBack={handleNavBack}
            overlay={hasHeroOverlay}
            frosted={hasHeroOverlay ? heroScrolled : true}
            tvClockMode={preferences.preferences.tvClockMode}
            testID="app-shell"
          >
            <CrashRecoveryBoundary
              resetKey={`${activeTab}:${activeDetail?.itemKey ?? ''}:${contentIsolationKey}`}
              screenName={activeTab}
              {...crashProps}
            >
              {showCachedStrip ? (
                <View style={styles.cachedStripWrap}>
                  <CachedCatalogStrip
                    health={importHealth.health}
                    retrying={importHealth.retrying}
                    onRetry={importHealth.retryFailedSources}
                  />
                </View>
              ) : null}
              <AppShellStage
                isTv={isTv}
                topNavFocused={topNavFocused}
                isResolvingInitialSources={isResolvingInitialSources}
                activeTab={activeTab}
                activeDetail={activeDetail}
                contentIsolationKey={contentIsolationKey}
                catalog={observedCatalog}
                sources={visibleSources}
                allSources={sources}
                refreshToken={refreshToken}
                externalRefreshToken={externalRefreshToken}
                effectiveRefreshToken={effectiveRefreshToken}
                effectiveUserStateVersion={effectiveUserStateVersion}
                hasTransientOverlay={hasRootOverlay}
                isActiveScope={!topNavFocused && !hasRootOverlay}
                preferences={preferences}
                settingsSection={settingsSection}
                onSettingsSectionChange={handleSettingsSectionChange}
                playbackGuard={playbackGuard}
                videoHost={videoHost}
                {...stageOptionalProps}
                incomingLocalPlaylist={incomingLocalPlaylist}
                onConsumeIncomingLocalPlaylist={consumeIncomingLocalPlaylist}
                searchQuery={searchQuery}
                onSearchQueryChange={setSearchQuery}
                searchScope={searchScope}
                onSearchScopeChange={setSearchScope}
                recentSearches={recentSearches}
                onRecentSearchesChange={setRecentSearches}
                catalogMemoryByTab={catalogMemoryByTab}
                onMovieMemoryChange={handleMovieMemoryChange}
                onSeriesMemoryChange={handleSeriesMemoryChange}
                liveMemory={liveMemory}
                onLiveMemoryChange={handleLiveMemoryChange}
                onEmbeddedPlaybackActiveChange={setLiveEmbeddedPlaybackActive}
                onSearchPerson={handleSearchPerson}
                onPopDetail={popDetail}
                onOpenDetail={openDetail}
                onPlay={handlePlay}
                {...modes.browseStageActions}
                onSelectTab={selectTab}
                onOpenSources={openSources}
                onOpenGuideManagement={mgmtOverlays.openGuideManager}
                onRefreshCatalogNow={onRefreshCatalogNow}
                onRefreshGuideNow={onRefreshGuideNow}
                onRegisterStopPreview={handleRegisterStopPreview}
                suppressEmbeddedPreview={playTarget !== null}
                onChannelsMutated={handleChannelsMutated}
                onFavoritesMutated={handleFavoritesMutated}
                reminderVersion={reminderVersion}
                onReminderChanged={handleReminderChanged}
                onScrollTopChange={setHeroScrolled}
                onFocusTopNav={handleFocusTopNav}
                waveF9={waveF9}
              />
            </CrashRecoveryBoundary>
          </AdaptiveNavShell>
        ) : null}
        <AppShellPlayerHost
          catalog={observedCatalog}
          videoHost={videoHost}
          tracker={connectionGuard.tracker}
          sources={visibleSources}
          thermalDevice={props.thermalDevice}
          playTarget={playTarget}
          modes={modes}
          playbackGuard={playbackGuard}
          preferences={preferences}
          {...(appLifecycle !== undefined ? { appLifecycle } : {})}
          externalOverlayOpen={hasRootOverlay}
          crashProps={crashProps}
          onPlaybackActiveChange={setPlayerPlaybackActive}
          onRegisterStopActivePlayer={handleRegisterStopActivePlayer}
          onTargetChange={onPlayerTargetChange}
          onExit={onPlayerExit}
        />
        <AppShellAllOverlays
          isBrowsing={isBrowsing}
          hasRootOverlay={hasRootOverlay}
          exitToastVisible={exitToastVisible}
          topOverlays={topOverlays}
          profile={profile}
          catalog={observedCatalog}
          videoHost={videoHost}
          {...(props.trailerExternal !== undefined
            ? { trailerExternal: props.trailerExternal }
            : {})}
          effectiveRefreshToken={effectiveRefreshToken}
          effectiveUserStateVersion={effectiveUserStateVersion}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          elvPreferences={preferences.preferences}
          onPlay={handlePlay}
          onOpenDetail={openDetail}
          connectionGuard={connectionGuard}
          mgmtOverlays={mgmtOverlays}
          onChannelsMutated={handleChannelsMutated}
          onOpenProfilesSettings={openProfilesSettings}
          reminders={reminders}
          oledScreensaver={oledScreensaver}
          wave={waveF7b}
          waveF9={waveF9}
          desktopErgonomics={desktopErgonomics}
          onboarding={onboarding}
        />
      </View>
    </AppShellContextProviders>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  cachedStripWrap: { paddingHorizontal: 16, paddingTop: 8 },
});
