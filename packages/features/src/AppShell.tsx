import type { CatalogService, SearchScope } from '@elv/data';
import type { KeymapStore, ProfilePreferencesManager } from '@elv/domain';
import type { ConnectionTracker } from '@elv/playback';
import { useI18n, useViewport } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { usePlayDeepLinkHandler } from './app-shell-deep-link';
import {
  AppShellProfileOverlays,
  buildShellProfileUtility,
  useShellProfileEffects,
} from './app-shell-overlays';
import { AppShellPlayerView } from './app-shell-player';
import {
  AppShellExitToast,
  AppShellStage,
  useShellArtworkCacheLimit,
  useShellIncomingLocalPlaylist,
} from './app-shell-sections';
import {
  type AppTab,
  buildShellCrashProps,
  buildShellNavigation,
  clearSourceFromCatalogMemory,
  clearSourceFromLiveMemory,
  createExitBackConfirmGuard,
  createObservedCatalog,
  DEFAULT_EXIT_BACK_CONFIRM_MS,
  type ExitBackConfirmGuard,
  enrichPlayTargetAccountKey,
  handleShellTopNavBack,
  INITIAL_CATALOG_MEMORY,
  type PrimaryNavTab,
  pushDetailStack,
} from './app-shell-state';
import { useTvHomeChannelsSync } from './app-shell-tv-channels';
import type { CatalogTabMemory } from './catalog';
import {
  ChannelManagementOverlay,
  EMPTY_LIVE_MEMORY,
  type LiveTabMemory,
  recordChannelTune,
} from './live';
import { ConnectionLimitDialog } from './player/ConnectionLimitDialog';
import type { AppLifecyclePort } from './ports/app-lifecycle';
import type { LanPairingPort } from './ports/lan-pairing-host';
import type { PlayDeepLinkTarget } from './ports/play-deep-link';
import type { PlayTarget } from './ports/play-target';
import { createPlaybackGuard, type PlaybackGuard } from './ports/playback-guard';
import type { SourceImportHost } from './ports/source-import-host';
import type { TvHomeChannelsPort } from './ports/tv-home-channels';
import type { VideoHost } from './ports/video-host';
import { OledScreensaverOverlay, useOledScreensaver } from './screensaver';
import type { SettingsSection } from './settings';
import {
  createProfileScopedCatalog,
  type DetailTarget,
  KeymapProvider,
  ProfileProvider,
  useProfile,
} from './shared';
import {
  AdaptiveNavShell,
  BrowseFocusMemoryProvider,
  CatalogUiCacheProvider,
  CrashRecoveryBoundary,
  createBrowseFocusMemory,
  createCatalogUiCache,
  RouteActiveProvider,
  useCatalogPrewarm,
  useConnectionLimitGuard,
  useDocumentVisible,
  useGuideAutoRefresh,
  useImportHealth,
  usePreferences,
  useShellFlush,
  useShellSources,
} from './shell';
import { CachedCatalogStrip } from './sources/CachedCatalogStrip';

export type { AppTab };

/** Props of {@link AppShell}. */
export interface AppShellProps {
  catalog: CatalogService;
  videoHost: VideoHost;
  appLifecycle?: AppLifecyclePort;
  /** Optional multi-profile preferences manager (`#15`); falls back to `usePreferences().profilePreferences`. */
  profilePreferences?: ProfilePreferencesManager;
  externalRefreshToken?: number;
  /** Optional shared per-account connection tracker for multi-surface pre-flight limits (`#87`). */
  connectionTracker?: ConnectionTracker;
  /** Optional platform clipboard & sandboxed local playlist picker port (`#51`). */
  sourceImportHost?: SourceImportHost;
  /** Optional platform local LAN QR pairing port (`#50`). */
  lanPairing?: LanPairingPort;
  /** Optional dedicated sparse remote keymap store (`#33`). */
  keymapStore?: KeymapStore;
  /** Optional Android TV Home Screen preview channels port (`#273`). */
  tvHomeChannels?: TvHomeChannelsPort;
  /** Optional incoming `elviptv://play?key=...` deep-link target (`#273`). */
  pendingDeepLink?: PlayDeepLinkTarget | null;
  /** Invoked once `pendingDeepLink` has been consumed by `AppShell` (`#273`). */
  onDeepLinkHandled?: () => void;
  /** Optional test/host hook notified with the active {@link PlaybackGuard}. */
  onPlaybackGuardReady?: (guard: PlaybackGuard) => void;
}

/** Top-level Cinema Quietude shell (`Home`, `Live`, `Movies`, `Series` + `Search`, `Settings`, `DetailScreen`, `PlayerScreen`). */
export function AppShell(props: AppShellProps): ReactElement {
  const preferences = usePreferences();
  const effectiveProfilePreferences = props.profilePreferences ?? preferences.profilePreferences;
  return (
    <ProfileProvider
      catalog={props.catalog}
      {...(effectiveProfilePreferences !== undefined
        ? { profilePreferences: effectiveProfilePreferences }
        : {})}
    >
      <AppShellWithKeymap {...props} />
    </ProfileProvider>
  );
}

function AppShellWithKeymap(props: AppShellProps): ReactElement {
  const preferences = usePreferences();
  const profile = useProfile();
  const effectiveKeymapStore = props.keymapStore ?? preferences.keymapStore;
  return (
    <KeymapProvider
      activeProfileId={profile.activeProfileId}
      {...(effectiveKeymapStore !== undefined ? { keymapStore: effectiveKeymapStore } : {})}
    >
      <AppShellContent {...props} />
    </KeymapProvider>
  );
}

function AppShellContent(props: AppShellProps): ReactElement {
  const { catalog, videoHost, appLifecycle, onPlaybackGuardReady } = props;
  const externalRefreshToken = props.externalRefreshToken ?? 0;
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';
  const preferences = usePreferences();
  const profile = useProfile();
  const profileScopeRef = useRef({
    profileId: profile.activeProfileId,
    parentalUnlocked: profile.parentalUnlocked,
  });
  profileScopeRef.current = {
    profileId: profile.activeProfileId,
    parentalUnlocked: profile.parentalUnlocked,
  };
  const [settingsChannelManagerOpen, setSettingsChannelManagerOpen] = useState(false);
  const hasProfileOverlay = profile.profilePickerOpen || profile.pinDialog !== null;
  const hasRootOverlay = hasProfileOverlay || settingsChannelManagerOpen;
  const confirmExitOnBack = preferences.preferences.confirmExitOnBack;
  const confirmExitOnBackRef = useRef(confirmExitOnBack);
  confirmExitOnBackRef.current = confirmExitOnBack;
  const [exitToastVisible, setExitToastVisible] = useState(false);
  const exitBackGuardRef = useRef<ExitBackConfirmGuard | null>(null);
  exitBackGuardRef.current ??= createExitBackConfirmGuard(DEFAULT_EXIT_BACK_CONFIRM_MS, {
    onVisibleChange: setExitToastVisible,
  });
  useEffect(() => () => exitBackGuardRef.current?.dispose(), []);
  useShellArtworkCacheLimit(preferences.preferences.artworkCacheLimitMb);
  const [activeTab, setActiveTab] = useState<AppTab>('settings');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('sources');
  const [topNavFocused, setTopNavFocused] = useState(false);
  const [heroScrolled, setHeroScrolled] = useState(false);
  const [userPickedTab, setUserPickedTab] = useState(false);
  const [userStateVersion, setUserStateVersion] = useState(0);
  const defaultLiveMode = preferences.preferences.defaultLiveMode;
  const userPickedLiveModeRef = useRef(false);
  const prevDefaultLiveModeRef = useRef(defaultLiveMode);
  const defaultLiveModeRef = useRef(defaultLiveMode);
  defaultLiveModeRef.current = defaultLiveMode;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const [liveMemory, setLiveMemory] = useState<LiveTabMemory>(() => ({
    ...EMPTY_LIVE_MEMORY,
    mode: defaultLiveMode,
  }));
  useEffect(() => {
    if (prevDefaultLiveModeRef.current === defaultLiveMode) return;
    prevDefaultLiveModeRef.current = defaultLiveMode;
    if (!userPickedLiveModeRef.current || activeTabRef.current !== 'live') {
      userPickedLiveModeRef.current = false;
      setLiveMemory((prev) =>
        prev.mode === defaultLiveMode ? prev : { ...prev, mode: defaultLiveMode },
      );
    }
  }, [defaultLiveMode]);
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
  const oledScreensaver = useOledScreensaver({
    timeoutMin: preferences.preferences.oledScreensaverTimeoutMin,
    isBlocked:
      (playTarget !== null && playerPlaybackActive) ||
      (playTarget === null && activeTab === 'live' && liveEmbeddedPlaybackActive),
  });
  const userPickedTabRef = useRef(false);
  const userPickedSettingsSectionRef = useRef(false);
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
  const profileScopeKey = `${profile.activeProfileId}:${profile.parentalUnlocked ? '1' : '0'}:${profile.profileRevision}`;
  uiCache.setRevision(catalogRevision, locale, profileScopeKey);
  const openPlayTarget = useCallback((enriched: PlayTarget) => {
    exitBackGuardRef.current?.reset();
    setHeroScrolled(false);
    playTargetRef.current = enriched;
    setPlayTarget(enriched);
    if (enriched.kind === 'live') {
      setLiveMemory((p) => ({ ...p, ...recordChannelTune(p, enriched.itemKey) }));
    }
  }, []);
  const replacePlayTarget = useCallback((enriched: PlayTarget) => {
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
  }, []);
  const connectionGuard = useConnectionLimitGuard({
    sourcesRef,
    enrichTarget: enrichPlayTargetAccountKey,
    ...(props.connectionTracker !== undefined
      ? { connectionTracker: props.connectionTracker }
      : {}),
    onOpenTarget: openPlayTarget,
    onReplaceTarget: replacePlayTarget,
  });
  const stopForSource = useCallback(
    (sourceId: string): void => {
      if (playTargetRef.current?.sourceId === sourceId) {
        playTargetRef.current = null;
        setPlayTarget(null);
        connectionGuard.releaseActive();
      }
      uiCache.invalidateSource(sourceId);
      setLiveMemory((prev) => clearSourceFromLiveMemory(prev, sourceId));
      setCatalogMemoryByTab((prev) => clearSourceFromCatalogMemory(prev, sourceId));
      setDetailStack((prev) => prev.filter((entry) => entry.sourceId !== sourceId));
    },
    [connectionGuard.releaseActive, uiCache],
  );
  const playbackGuard = useMemo(() => createPlaybackGuard(stopForSource), [stopForSource]);
  useEffect(() => onPlaybackGuardReady?.(playbackGuard), [onPlaybackGuardReady, playbackGuard]);
  const handlePlay = connectionGuard.requestPlay;
  const observedCatalog = useMemo(
    () =>
      createProfileScopedCatalog(
        createObservedCatalog(catalog, playbackGuard, shell.syncSourcesAndBump),
        () => profileScopeRef.current,
      ),
    [catalog, playbackGuard, shell.syncSourcesAndBump],
  );
  const stopActivePlayback = useCallback(() => {
    connectionGuard.releaseActive();
    playTargetRef.current = null;
    setPlayTarget(null);
  }, [connectionGuard.releaseActive]);
  const resetTransientMemory = useCallback(() => {
    focusMemory.clear();
    userPickedLiveModeRef.current = false;
    setLiveMemory({ ...EMPTY_LIVE_MEMORY, mode: defaultLiveModeRef.current });
    setCatalogMemoryByTab(INITIAL_CATALOG_MEMORY);
    setDetailStack([]);
    clearSearchSession();
    setHeroScrolled(false);
  }, [clearSearchSession, focusMemory]);
  useShellProfileEffects({
    profile,
    catalog: observedCatalog,
    appForeground: appForeground && documentVisible,
    playTargetRef,
    onResetTransientMemory: resetTransientMemory,
    onStopPlayback: stopActivePlayback,
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
    sources,
    catalogRevision,
    locale,
    profileKey: profileScopeKey,
    uiCache,
    activeTab,
    enabled: profile.profilesReady,
    groupVodVersions: preferences.preferences.groupVodVersions,
  });
  const handleGuideRefreshed = useCallback(() => {
    void shell.syncSourcesAndBump();
  }, [shell.syncSourcesAndBump]);
  useGuideAutoRefresh({
    catalog,
    sources,
    catalogRefreshHours: preferences.preferences.catalogRefreshHours,
    guideRefreshHours: preferences.preferences.guideRefreshHours,
    sessionImportedIdsRef: shell.autoImportedIdsRef,
    enabled:
      documentVisible &&
      appForeground &&
      playTarget === null &&
      !(activeTab === 'live' && liveEmbeddedPlaybackActive),
    onGuideRefreshed: handleGuideRefreshed,
  });
  const selectTab = useCallback((tab: AppTab, focusContent = true) => {
    exitBackGuardRef.current?.reset();
    userPickedTabRef.current = true;
    setUserPickedTab(true);
    setActiveTab(tab);
    setDetailStack([]);
    setHeroScrolled(false);
    if (focusContent) setTopNavFocused(false);
  }, []);
  const handleSettingsSectionChange = useCallback((next: SettingsSection) => {
    userPickedSettingsSectionRef.current = true;
    setSettingsSection(next);
  }, []);
  const openSettings = useCallback(() => {
    if (sourcesRef.current.length > 0 && !userPickedSettingsSectionRef.current)
      setSettingsSection('appearance');
    selectTab('settings', false);
  }, [selectTab, sourcesRef]);
  const openSources = useCallback(() => {
    userPickedSettingsSectionRef.current = true;
    setSettingsSection('sources');
    selectTab('settings', true);
  }, [selectTab]);
  const openProfilesSettings = useCallback(() => {
    userPickedSettingsSectionRef.current = true;
    setSettingsSection('profiles');
    selectTab('settings', true);
  }, [selectTab]);
  const handlePrepareIncomingLocalPlaylist = useCallback(() => {
    if (playTargetRef.current !== null) {
      connectionGuard.releaseActive();
      playTargetRef.current = null;
      setPlayTarget(null);
    }
    openSources();
  }, [connectionGuard.releaseActive, openSources]);
  const { incomingLocalPlaylist, consumeIncomingLocalPlaylist } = useShellIncomingLocalPlaylist({
    ...(props.sourceImportHost !== undefined ? { sourceImportHost: props.sourceImportHost } : {}),
    onIncomingFile: handlePrepareIncomingLocalPlaylist,
  });
  const openDetail = useCallback((target: DetailTarget) => {
    exitBackGuardRef.current?.reset();
    setDetailStack((prev) => pushDetailStack(prev, target));
    setHeroScrolled(false);
    setTopNavFocused(false);
  }, []);
  const popDetail = useCallback(() => {
    setDetailStack((prev) => prev.slice(0, -1));
    setHeroScrolled(false);
    setUserStateVersion((v) => v + 1);
  }, []);
  const handleSearchPerson = useCallback(
    (personName: string) => {
      const trimmed = personName.trim();
      if (trimmed.length === 0) return;
      setSearchQuery(trimmed);
      setSearchScope('all');
      selectTab('search', true);
    },
    [selectTab],
  );
  const activeDetail = detailStack[detailStack.length - 1] ?? null;
  const profileUtility = useMemo(() => buildShellProfileUtility(profile), [profile]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: locale invalidates translated labels on live language switch
  const { destinations, utilities } = useMemo(
    () =>
      buildShellNavigation({
        t: i18n.t,
        activeTab,
        hasActiveDetail: activeDetail !== null,
        onOpenSearch: () => selectTab('search', false),
        onOpenSettings: openSettings,
        ...(profileUtility !== undefined ? { profileUtility } : {}),
      }),
    [i18n, locale, activeTab, activeDetail, selectTab, openSettings, profileUtility],
  );
  const handleSelectDestination = useCallback(
    (t: PrimaryNavTab) => selectTab(t, false),
    [selectTab],
  );
  const handleExitNavFocus = useCallback(() => {
    exitBackGuardRef.current?.reset();
    setTopNavFocused(false);
  }, []);
  const handleFocusTopNav = useCallback(() => setTopNavFocused(true), []);
  useEffect(() => {
    if (
      !confirmExitOnBack ||
      playTarget !== null ||
      activeTab !== 'home' ||
      activeDetail !== null
    ) {
      exitBackGuardRef.current?.reset();
    }
  }, [activeDetail, activeTab, confirmExitOnBack, playTarget]);
  const handleNavBack = useCallback(
    () =>
      handleShellTopNavBack({
        activeTab,
        hasActiveDetail: activeDetail !== null,
        popDetail,
        exitNavFocus: handleExitNavFocus,
        selectHomeInTopNav: () => selectTab('home', false),
        onRootHomeBack: () =>
          exitBackGuardRef.current?.onRootBack(confirmExitOnBackRef.current) ?? false,
      }),
    [activeDetail, activeTab, handleExitNavFocus, popDetail, selectTab],
  );
  const handleLiveMemoryChange = useCallback((next: LiveTabMemory) => {
    setLiveMemory((prev) => {
      if (next.mode !== prev.mode) userPickedLiveModeRef.current = true;
      return next;
    });
  }, []);
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
  const crashProps = useMemo(
    () =>
      buildShellCrashProps({
        stageKey,
        bumpStageKey: () => setStageKey((k) => k + 1),
        clearCaches: () => {
          uiCache.clear();
          focusMemory.clear();
          shell.bumpCatalogRevision();
          userPickedLiveModeRef.current = false;
          setLiveMemory({ ...EMPTY_LIVE_MEMORY, mode: defaultLiveModeRef.current });
          setCatalogMemoryByTab(INITIAL_CATALOG_MEMORY);
          setDetailStack([]);
          clearSearchSession();
          setHeroScrolled(false);
        },
        switchSource: () => {
          playTargetRef.current = null;
          setPlayTarget(null);
          openSources();
        },
      }),
    [stageKey, shell.bumpCatalogRevision, clearSearchSession, openSources, uiCache, focusMemory],
  );
  const readySourcesCount = sources.filter((s) => !s.needsImport).length;
  const isResolvingInitialSources =
    !profile.profilesReady || (!sourcesResolved && !userPickedTab && activeDetail === null);
  const hasHeroOverlay =
    activeDetail !== null || (sourcesResolved && profile.profilesReady && activeTab === 'home');
  const contentIsolationKey = `${profile.activeProfileId}:${profile.parentalUnlocked ? 'u' : 'l'}`;
  const effectiveRefreshToken = refreshToken + profile.profileRevision;
  const effectiveUserStateVersion = userStateVersion + profile.profileRevision;

  useTvHomeChannelsSync({
    catalog: observedCatalog,
    ...(props.tvHomeChannels !== undefined ? { tvHomeChannels: props.tvHomeChannels } : {}),
    profilesReady: profile.profilesReady,
    syncKey: `${catalogRevision}:${effectiveUserStateVersion}:${profileScopeKey}:${locale}`,
    continueWatchingLabel: i18n.t('tvHomeChannels.continueWatching'),
    favoritesLabel: i18n.t('tvHomeChannels.favorites'),
  });

  usePlayDeepLinkHandler({
    catalog: observedCatalog,
    profile,
    pendingDeepLink: props.pendingDeepLink ?? null,
    onPlay: handlePlay,
    onOpenDetail: openDetail,
    ...(props.onDeepLinkHandled !== undefined
      ? { onDeepLinkHandled: props.onDeepLinkHandled }
      : {}),
  });

  const onPlayerTargetChange = connectionGuard.replaceActiveTarget;
  const onPlayerExit = () => {
    const exiting = playTargetRef.current;
    if (exiting?.kind === 'live') {
      setLiveMemory((p) => ({
        ...p,
        activeChannelKey: exiting.itemKey,
        ...(exiting.previousChannel !== undefined
          ? { previousChannelKey: exiting.previousChannel.itemKey }
          : {}),
      }));
    }
    connectionGuard.releaseActive();
    playTargetRef.current = null;
    setPlayTarget(null);
    setHeroScrolled(false);
    setUserStateVersion((v) => v + 1);
  };
  const showCachedStrip =
    !isResolvingInitialSources &&
    activeDetail === null &&
    activeTab !== 'settings' &&
    importHealth.health.length > 0;

  return (
    <RouteActiveProvider active={documentVisible && appForeground}>
      <CatalogUiCacheProvider cache={uiCache}>
        <BrowseFocusMemoryProvider memory={focusMemory}>
          <View style={styles.root} onTouchStart={oledScreensaver.recordActivity}>
            {playTarget !== null ? (
              <CrashRecoveryBoundary resetKey={playTarget.itemKey} {...crashProps}>
                <AppShellPlayerView
                  catalog={observedCatalog}
                  videoHost={videoHost}
                  target={playTarget}
                  playbackGuard={playbackGuard}
                  preferences={preferences}
                  {...(appLifecycle !== undefined ? { appLifecycle } : {})}
                  externalOverlayOpen={hasRootOverlay}
                  onPlaybackActiveChange={setPlayerPlaybackActive}
                  onTargetChange={onPlayerTargetChange}
                  onExit={onPlayerExit}
                />
              </CrashRecoveryBoundary>
            ) : (
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
                    sources={sources}
                    readySourcesCount={readySourcesCount}
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
                    {...(props.sourceImportHost !== undefined
                      ? { sourceImportHost: props.sourceImportHost }
                      : {})}
                    {...(props.lanPairing !== undefined ? { lanPairing: props.lanPairing } : {})}
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
                    onSelectTab={selectTab}
                    onOpenSources={openSources}
                    onOpenChannelManagement={() => setSettingsChannelManagerOpen(true)}
                    onChannelsMutated={handleChannelsMutated}
                    onScrollTopChange={setHeroScrolled}
                    onFocusTopNav={handleFocusTopNav}
                  />
                </CrashRecoveryBoundary>
              </AdaptiveNavShell>
            )}
            <AppShellExitToast visible={exitToastVisible && playTarget === null} />
            {connectionGuard.pending !== null ? (
              <ConnectionLimitDialog
                check={connectionGuard.pending.check}
                onStopOther={connectionGuard.handleStopOther}
                onCancel={connectionGuard.handleCancel}
                onContinueAnyway={connectionGuard.handleContinueAnyway}
              />
            ) : null}
            <ChannelManagementOverlay
              visible={settingsChannelManagerOpen}
              catalog={observedCatalog}
              sources={sources}
              onMutated={handleChannelsMutated}
              onClose={() => setSettingsChannelManagerOpen(false)}
            />
            <AppShellProfileOverlays onOpenProfilesSettings={openProfilesSettings} />
            <OledScreensaverOverlay state={oledScreensaver.state} onWake={oledScreensaver.wake} />
          </View>
        </BrowseFocusMemoryProvider>
      </CatalogUiCacheProvider>
    </RouteActiveProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  cachedStripWrap: { paddingHorizontal: 16, paddingTop: 8 },
});
