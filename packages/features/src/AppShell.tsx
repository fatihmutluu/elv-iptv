import type { CatalogService, SearchScope } from '@elv/data';
import type { ProfilePreferencesManager } from '@elv/domain';
import type { ConnectionTracker } from '@elv/playback';
import {
  TvFocusAnchor,
  useI18n,
  useTheme,
  useUiAdapters,
  useViewport,
  webBackdropBlur,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  AppShellProfileOverlays,
  buildShellProfileUtility,
  useShellProfileEffects,
} from './app-shell-overlays';
import { AppShellPlayerView } from './app-shell-player';
import {
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
import { CatalogDiscoveryScreen, type CatalogTabMemory } from './catalog';
import { DetailScreen } from './detail';
import { HomeScreen } from './home';
import { EMPTY_LIVE_MEMORY, LiveScreen, type LiveTabMemory, recordChannelTune } from './live';
import { ThirdPartyNoticesScreen } from './notices';
import { ConnectionLimitDialog } from './player/ConnectionLimitDialog';
import type { AppLifecyclePort } from './ports/app-lifecycle';
import type { PlayTarget } from './ports/play-target';
import { createPlaybackGuard, type PlaybackGuard } from './ports/playback-guard';
import type { PickedPlaylistFile, SourceImportHost } from './ports/source-import-host';
import type { VideoHost } from './ports/video-host';
import { ProfilesAndParentalPanel } from './profiles';
import { OledScreensaverOverlay, useOledScreensaver } from './screensaver';
import { SearchScreen } from './search';
import { SettingsScreen, type SettingsSection } from './settings';
import {
  createProfileScopedCatalog,
  type DetailTarget,
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
import { SourcesScreen } from './sources';
import { CachedCatalogStrip } from './sources/CachedCatalogStrip';

/** Top-level shell tab identifier. */
export type AppTab = 'home' | 'live' | 'movie' | 'series' | 'search' | 'settings';

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
      <AppShellContent {...props} />
    </ProfileProvider>
  );
}

function AppShellContent(props: AppShellProps): ReactElement {
  const { catalog, videoHost, appLifecycle, onPlaybackGuardReady } = props;
  const externalRefreshToken = props.externalRefreshToken ?? 0;
  const i18n = useI18n();
  const theme = useTheme();
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
  const hasProfileOverlay = profile.profilePickerOpen || profile.pinDialog !== null;
  const confirmExitOnBack = preferences.preferences.confirmExitOnBack;
  const confirmExitOnBackRef = useRef(confirmExitOnBack);
  confirmExitOnBackRef.current = confirmExitOnBack;
  const [exitToastVisible, setExitToastVisible] = useState(false);
  const exitBackGuardRef = useRef<ExitBackConfirmGuard | null>(null);
  exitBackGuardRef.current ??= createExitBackConfirmGuard(DEFAULT_EXIT_BACK_CONFIRM_MS, {
    onVisibleChange: setExitToastVisible,
  });
  useEffect(() => () => exitBackGuardRef.current?.dispose(), []);
  const uiAdapters = useUiAdapters();
  const artworkCacheLimitMb = preferences.preferences.artworkCacheLimitMb;
  useEffect(() => {
    const setLimitBytes = uiAdapters.artworkCache?.setLimitBytes;
    if (setLimitBytes === undefined) return;
    void Promise.resolve(setLimitBytes(artworkCacheLimitMb * 1024 * 1024)).catch(() => undefined);
  }, [artworkCacheLimitMb, uiAdapters.artworkCache]);
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
  const [incomingLocalPlaylist, setIncomingLocalPlaylist] = useState<PickedPlaylistFile | null>(
    null,
  );
  const consumeIncomingLocalPlaylist = useCallback(() => {
    setIncomingLocalPlaylist(null);
  }, []);
  const handleIncomingLocalPlaylist = useCallback(
    (file: PickedPlaylistFile) => {
      if (playTargetRef.current !== null) {
        connectionGuard.releaseActive();
        playTargetRef.current = null;
        setPlayTarget(null);
      }
      setIncomingLocalPlaylist(file);
      openSources();
    },
    [connectionGuard.releaseActive, openSources],
  );
  const sourceImportHost = props.sourceImportHost;
  useEffect(() => {
    let active = true;
    const unsubscribe = sourceImportHost?.onOpenPlaylistFile?.((file) => {
      if (active) handleIncomingLocalPlaylist(file);
    });
    const consumePending = sourceImportHost?.consumePendingPlaylistFiles;
    if (consumePending !== undefined) {
      void Promise.resolve(consumePending())
        .then((pending) => {
          if (!active || pending.length === 0) return;
          const latest = pending[pending.length - 1];
          if (latest !== undefined) handleIncomingLocalPlaylist(latest);
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [handleIncomingLocalPlaylist, sourceImportHost]);
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
      if (next.mode !== prev.mode) {
        userPickedLiveModeRef.current = true;
      }
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
  const stageProps = {
    catalog: observedCatalog,
    refreshToken: effectiveRefreshToken,
    onFocusTopNav: handleFocusTopNav,
    isActiveScope: !topNavFocused && !hasProfileOverlay,
  };
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
                  externalOverlayOpen={hasProfileOverlay}
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
                navFocused={topNavFocused && !hasProfileOverlay}
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
                  {isResolvingInitialSources ? (
                    <View testID="app-shell-boot" style={styles.bootCanvas}>
                      {isTv && !topNavFocused ? (
                        <TvFocusAnchor testID="app-shell-boot-focus-anchor" />
                      ) : null}
                    </View>
                  ) : activeDetail !== null ? (
                    <DetailScreen
                      key={`${activeDetail.itemKey}:${contentIsolationKey}`}
                      target={activeDetail}
                      userStateVersion={effectiveUserStateVersion}
                      preferredAudioLang={preferences.preferences.preferredAudioLang}
                      preferredSubtitleLang={preferences.preferences.preferredSubtitleLang}
                      onSearchPerson={handleSearchPerson}
                      onBack={popDetail}
                      onPlay={handlePlay}
                      onOpenDetail={openDetail}
                      onScrollTopChange={setHeroScrolled}
                      {...stageProps}
                    />
                  ) : activeTab === 'settings' ? (
                    <SettingsScreen
                      section={settingsSection}
                      onSectionChange={handleSettingsSectionChange}
                      preferences={preferences}
                      onFocusTopNav={handleFocusTopNav}
                      isActiveScope={!topNavFocused && !hasProfileOverlay}
                      hasTransientOverlay={hasProfileOverlay}
                      renderProfiles={(slot) => (
                        <ProfilesAndParentalPanel
                          catalog={observedCatalog}
                          sources={sources}
                          {...slot}
                        />
                      )}
                      renderSources={(slot) => (
                        <SourcesScreen
                          catalog={observedCatalog}
                          embedded
                          playbackGuard={playbackGuard}
                          {...(props.sourceImportHost !== undefined
                            ? { sourceImportHost: props.sourceImportHost }
                            : {})}
                          {...(incomingLocalPlaylist !== null
                            ? {
                                incomingLocalPlaylist,
                                onConsumeIncomingLocalPlaylist: consumeIncomingLocalPlaylist,
                              }
                            : {})}
                          externalRefreshToken={externalRefreshToken + refreshToken}
                          {...(readySourcesCount > 0
                            ? { onOpenMenu: () => selectTab('home') }
                            : {})}
                          {...slot}
                        />
                      )}
                      renderLicenses={(slot) => <ThirdPartyNoticesScreen embedded {...slot} />}
                    />
                  ) : activeTab === 'search' ? (
                    <SearchScreen
                      key={contentIsolationKey}
                      userStateVersion={effectiveUserStateVersion}
                      initialQuery={searchQuery}
                      onQueryChange={setSearchQuery}
                      initialScope={searchScope}
                      onScopeChange={setSearchScope}
                      recentSearches={recentSearches}
                      onRecentSearchesChange={setRecentSearches}
                      onPlay={handlePlay}
                      onOpenDetail={openDetail}
                      {...stageProps}
                    />
                  ) : activeTab === 'home' ? (
                    <HomeScreen
                      key={contentIsolationKey}
                      sources={sources}
                      userStateVersion={effectiveUserStateVersion}
                      onPlay={handlePlay}
                      onOpenTab={selectTab}
                      onOpenDetail={openDetail}
                      onOpenSources={openSources}
                      onScrollTopChange={setHeroScrolled}
                      {...stageProps}
                    />
                  ) : activeTab === 'movie' || activeTab === 'series' ? (
                    <CatalogDiscoveryScreen
                      key={`${activeTab}:${contentIsolationKey}`}
                      kind={activeTab}
                      sources={sources}
                      userStateVersion={effectiveUserStateVersion}
                      groupVersions={
                        activeTab === 'movie' ? preferences.preferences.groupVodVersions : false
                      }
                      memory={catalogMemoryByTab[activeTab]}
                      onMemoryChange={
                        activeTab === 'movie' ? handleMovieMemoryChange : handleSeriesMemoryChange
                      }
                      onPlay={handlePlay}
                      onOpenDetail={openDetail}
                      onOpenSources={openSources}
                      {...stageProps}
                    />
                  ) : (
                    <LiveScreen
                      key={contentIsolationKey}
                      sources={sources}
                      userStateVersion={effectiveUserStateVersion}
                      memory={liveMemory}
                      onMemoryChange={handleLiveMemoryChange}
                      videoHost={videoHost}
                      playbackGuard={playbackGuard}
                      defaultLiveMode={preferences.preferences.defaultLiveMode}
                      epgTimeSpanHours={preferences.preferences.epgTimeSpanHours}
                      epgRowDensity={preferences.preferences.epgRowDensity}
                      epgGenreTints={preferences.preferences.epgGenreTints}
                      epgShowClock={preferences.preferences.epgShowClock}
                      logoBackdropMode={preferences.preferences.logoBackdropMode}
                      showSourceBadges={preferences.preferences.showSourceBadges}
                      liveOkTwoStepPreview={preferences.preferences.liveOkTwoStepPreview}
                      cleanChannelTitles={preferences.preferences.cleanChannelTitles}
                      collapseVariants={preferences.preferences.collapseLiveVariants}
                      onEmbeddedPlaybackActiveChange={setLiveEmbeddedPlaybackActive}
                      onPlay={handlePlay}
                      onOpenSources={openSources}
                      {...stageProps}
                    />
                  )}
                </CrashRecoveryBoundary>
              </AdaptiveNavShell>
            )}
            {exitToastVisible && playTarget === null ? (
              <View
                pointerEvents="none"
                style={[
                  styles.exitToastWrap,
                  {
                    bottom: 28 + viewport.safeArea.bottom + viewport.overscan.y,
                    left: viewport.overscan.x,
                    right: viewport.overscan.x,
                  },
                ]}
              >
                <View
                  testID="shell-exit-confirm-toast"
                  accessibilityLiveRegion="polite"
                  style={[
                    styles.exitToastPill,
                    {
                      backgroundColor: theme.colors.glassBg,
                      borderColor: theme.colors.glassBorder,
                      borderRadius: theme.radius.pill,
                    },
                    webBackdropBlur(16),
                  ]}
                >
                  <Text style={[theme.typography.caption, { color: theme.colors.textPrimary }]}>
                    {i18n.t('shell.backToExitToast')}
                  </Text>
                </View>
              </View>
            ) : null}
            {connectionGuard.pending !== null ? (
              <ConnectionLimitDialog
                check={connectionGuard.pending.check}
                onStopOther={connectionGuard.handleStopOther}
                onCancel={connectionGuard.handleCancel}
                onContinueAnyway={connectionGuard.handleContinueAnyway}
              />
            ) : null}
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
  bootCanvas: { flex: 1 },
  cachedStripWrap: { paddingHorizontal: 16, paddingTop: 8 },
  exitToastWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  exitToastPill: {
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
});
