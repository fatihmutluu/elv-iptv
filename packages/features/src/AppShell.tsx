import type { CatalogService, SearchScope } from '@elv/data';
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
import { Platform, StyleSheet, Text, View } from 'react-native';
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
import { DEFAULT_AUTO_HIDE_OSD_MS, PlayerScreen } from './player';
import { ConnectionLimitDialog } from './player/ConnectionLimitDialog';
import type { AppLifecyclePort } from './ports/app-lifecycle';
import type { PlayTarget } from './ports/play-target';
import { createPlaybackGuard, type PlaybackGuard } from './ports/playback-guard';
import type { SourceImportHost } from './ports/source-import-host';
import type { VideoHost } from './ports/video-host';
import { OledScreensaverOverlay, useOledScreensaver } from './screensaver';
import { SearchScreen } from './search';
import { SettingsScreen, type SettingsSection } from './settings';
import type { DetailTarget } from './shared';
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
  const { catalog, videoHost, appLifecycle, onPlaybackGuardReady } = props;
  const externalRefreshToken = props.externalRefreshToken ?? 0;
  const i18n = useI18n();
  const theme = useTheme();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';
  const preferences = usePreferences();
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
  uiCache.setRevision(catalogRevision, locale);
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
    () => createObservedCatalog(catalog, playbackGuard, shell.syncSourcesAndBump),
    [catalog, playbackGuard, shell.syncSourcesAndBump],
  );
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
    uiCache,
    activeTab,
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: locale invalidates translated labels on live language switch
  const { destinations, utilities } = useMemo(
    () =>
      buildShellNavigation({
        t: i18n.t,
        activeTab,
        hasActiveDetail: activeDetail !== null,
        onOpenSearch: () => selectTab('search', false),
        onOpenSettings: openSettings,
      }),
    [i18n, locale, activeTab, activeDetail, selectTab, openSettings],
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
  const isResolvingInitialSources = !sourcesResolved && !userPickedTab && activeDetail === null;
  const hasHeroOverlay = activeDetail !== null || (sourcesResolved && activeTab === 'home');
  const stageProps = {
    catalog: observedCatalog,
    refreshToken,
    onFocusTopNav: handleFocusTopNav,
    isActiveScope: !topNavFocused,
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
                <PlayerScreen
                  catalog={observedCatalog}
                  videoHost={videoHost}
                  target={playTarget}
                  playbackGuard={playbackGuard}
                  autoHideOsdMs={DEFAULT_AUTO_HIDE_OSD_MS}
                  initialVolume={preferences.preferences.playerVolume}
                  onPersistVolume={(volume) => {
                    void preferences.updatePreferences({ playerVolume: volume });
                  }}
                  autoSubtitlesOnSkipBack={preferences.preferences.autoSubtitlesOnSkipBack}
                  onToggleAutoSubtitlesOnSkipBack={() => {
                    void preferences.updatePreferences({
                      autoSubtitlesOnSkipBack: !preferences.preferences.autoSubtitlesOnSkipBack,
                    });
                  }}
                  autoPlayNextEpisode={preferences.preferences.autoPlayNextEpisode}
                  onToggleAutoPlayNextEpisode={() => {
                    void preferences.updatePreferences({
                      autoPlayNextEpisode: !preferences.preferences.autoPlayNextEpisode,
                    });
                  }}
                  reduceMotion={preferences.preferences.reduceMotion}
                  bufferPreset={preferences.preferences.bufferPreset}
                  useTextureView={preferences.preferences.useTextureView}
                  seekStepSec={preferences.preferences.seekStepSec}
                  defaultResizeMode={preferences.preferences.defaultResizeMode}
                  preferredAudioLang={preferences.preferences.preferredAudioLang}
                  preferredSubtitleLang={preferences.preferences.preferredSubtitleLang}
                  preferredAudioLanguages={preferences.preferences.preferredAudioLanguages}
                  preferredSubtitleLanguages={preferences.preferences.preferredSubtitleLanguages}
                  preferDefaultAudioTrack={preferences.preferences.preferDefaultAudioTrack}
                  preferHevcOverDolbyVision={preferences.preferences.preferHevcOverDolbyVision}
                  filterSdhSubtitles={preferences.preferences.filterSdhSubtitles}
                  subtitleMode={preferences.preferences.subtitleMode}
                  subtitleFontFamily={preferences.preferences.subtitleFontFamily}
                  tvClockMode={preferences.preferences.tvClockMode}
                  osdTimeDisplayMode={preferences.preferences.osdTimeDisplayMode}
                  onPersistOsdTimeDisplayMode={(osdTimeDisplayMode) => {
                    void preferences.updatePreferences({ osdTimeDisplayMode });
                  }}
                  sleepTimerDefaultAction={preferences.preferences.sleepTimerDefaultAction}
                  onPersistSleepTimerAction={(sleepTimerDefaultAction) => {
                    void preferences.updatePreferences({ sleepTimerDefaultAction });
                  }}
                  stillWatchingTimeoutMin={preferences.preferences.stillWatchingTimeoutMin}
                  onPlaybackActiveChange={setPlayerPlaybackActive}
                  preferredAudioDevice={preferences.preferences.preferredAudioDevice}
                  onPersistAudioDevice={(preferredAudioDevice) => {
                    void preferences.updatePreferences({ preferredAudioDevice });
                  }}
                  deinterlaceMode={preferences.preferences.deinterlaceMode}
                  onPersistDeinterlaceMode={(deinterlaceMode) => {
                    void preferences.updatePreferences({ deinterlaceMode });
                  }}
                  pitchLock={preferences.preferences.pitchLock}
                  onPersistPitchLock={(pitchLock) => {
                    void preferences.updatePreferences({ pitchLock });
                  }}
                  audioNormalization={preferences.preferences.audioNormalization}
                  onPersistAudioNormalization={(audioNormalization) => {
                    void preferences.updatePreferences({ audioNormalization });
                  }}
                  windowAspectRatioLock={preferences.preferences.windowAspectRatioLock}
                  {...(Platform.OS === 'android'
                    ? {
                        androidDecoderMode: preferences.preferences.androidDecoderMode,
                        onSelectAndroidDecoderMode: (androidDecoderMode) => {
                          void preferences.updatePreferences({ androidDecoderMode });
                        },
                      }
                    : {})}
                  {...(appLifecycle !== undefined ? { appLifecycle } : {})}
                  liveChannelSwitchMode={preferences.preferences.liveChannelSwitchMode}
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
                navFocused={topNavFocused}
                onExitNavFocus={handleExitNavFocus}
                onBack={handleNavBack}
                overlay={hasHeroOverlay}
                frosted={hasHeroOverlay ? heroScrolled : true}
                tvClockMode={preferences.preferences.tvClockMode}
                testID="app-shell"
              >
                <CrashRecoveryBoundary
                  resetKey={`${activeTab}:${activeDetail?.itemKey ?? ''}`}
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
                      key={activeDetail.itemKey}
                      target={activeDetail}
                      userStateVersion={userStateVersion}
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
                      isActiveScope={!topNavFocused}
                      renderSources={(slot) => (
                        <SourcesScreen
                          catalog={observedCatalog}
                          embedded
                          playbackGuard={playbackGuard}
                          {...(props.sourceImportHost !== undefined
                            ? { sourceImportHost: props.sourceImportHost }
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
                      userStateVersion={userStateVersion}
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
                      sources={sources}
                      userStateVersion={userStateVersion}
                      onPlay={handlePlay}
                      onOpenTab={selectTab}
                      onOpenDetail={openDetail}
                      onOpenSources={openSources}
                      onScrollTopChange={setHeroScrolled}
                      {...stageProps}
                    />
                  ) : activeTab === 'movie' || activeTab === 'series' ? (
                    <CatalogDiscoveryScreen
                      key={activeTab}
                      kind={activeTab}
                      sources={sources}
                      userStateVersion={userStateVersion}
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
                      sources={sources}
                      userStateVersion={userStateVersion}
                      memory={liveMemory}
                      onMemoryChange={handleLiveMemoryChange}
                      videoHost={videoHost}
                      playbackGuard={playbackGuard}
                      defaultLiveMode={preferences.preferences.defaultLiveMode}
                      epgTimeSpanHours={preferences.preferences.epgTimeSpanHours}
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
