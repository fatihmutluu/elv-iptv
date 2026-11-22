import type { CatalogService, SearchScope } from '@elv/data';
import { useI18n } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  buildShellCrashProps,
  buildShellNavigation,
  clearSourceFromCatalogMemory,
  clearSourceFromLiveMemory,
  createObservedCatalog,
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
import type { AppLifecyclePort } from './ports/app-lifecycle';
import type { PlayTarget } from './ports/play-target';
import { createPlaybackGuard, type PlaybackGuard } from './ports/playback-guard';
import type { VideoHost } from './ports/video-host';
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
  useDocumentVisible,
  usePreferences,
  useShellFlush,
  useShellSources,
} from './shell';
import { SourcesScreen } from './sources';

/** Top-level shell tab identifier. */
export type AppTab = 'home' | 'live' | 'movie' | 'series' | 'search' | 'settings';

/** Props of {@link AppShell}. */
export interface AppShellProps {
  catalog: CatalogService;
  videoHost: VideoHost;
  appLifecycle?: AppLifecyclePort;
  externalRefreshToken?: number;
  /** Optional test/host hook notified with the active {@link PlaybackGuard}. */
  onPlaybackGuardReady?: (guard: PlaybackGuard) => void;
}

/** Top-level Cinema Quietude shell (`Home`, `Live`, `Movies`, `Series` + `Search`, `Settings`, `DetailScreen`, `PlayerScreen`). */
export function AppShell(props: AppShellProps): ReactElement {
  const { catalog, videoHost, appLifecycle, onPlaybackGuardReady } = props;
  const externalRefreshToken = props.externalRefreshToken ?? 0;
  const i18n = useI18n();
  const preferences = usePreferences();
  const [activeTab, setActiveTab] = useState<AppTab>('settings');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('sources');
  const [topNavFocused, setTopNavFocused] = useState(false);
  const [heroScrolled, setHeroScrolled] = useState(false);
  const [userPickedTab, setUserPickedTab] = useState(false);
  const [userStateVersion, setUserStateVersion] = useState(0);
  const [liveMemory, setLiveMemory] = useState<LiveTabMemory>(EMPTY_LIVE_MEMORY);
  const [catalogMemoryByTab, setCatalogMemoryByTab] = useState(INITIAL_CATALOG_MEMORY);
  const [detailStack, setDetailStack] = useState<readonly DetailTarget[]>([]);
  const [recentSearches, setRecentSearches] = useState<readonly string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<SearchScope>('all');
  const [playTarget, setPlayTarget] = useState<PlayTarget | null>(null);
  const [stageKey, setStageKey] = useState(0);
  const [appForeground, setAppForeground] = useState(true);
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
  const stopForSource = useCallback(
    (sourceId: string): void => {
      if (playTargetRef.current?.sourceId === sourceId) {
        playTargetRef.current = null;
        setPlayTarget(null);
      }
      uiCache.invalidateSource(sourceId);
      setLiveMemory((prev) => clearSourceFromLiveMemory(prev, sourceId));
      setCatalogMemoryByTab((prev) => clearSourceFromCatalogMemory(prev, sourceId));
      setDetailStack((prev) => prev.filter((entry) => entry.sourceId !== sourceId));
    },
    [uiCache],
  );
  const playbackGuard = useMemo(() => createPlaybackGuard(stopForSource), [stopForSource]);
  useEffect(() => onPlaybackGuardReady?.(playbackGuard), [onPlaybackGuardReady, playbackGuard]);
  const handlePlay = useCallback(
    (target: PlayTarget) => {
      const enriched = enrichPlayTargetAccountKey(target, sourcesRef.current);
      setHeroScrolled(false);
      playTargetRef.current = enriched;
      setPlayTarget(enriched);
    },
    [sourcesRef],
  );
  const observedCatalog = useMemo(
    () => createObservedCatalog(catalog, playbackGuard, shell.syncSourcesAndBump),
    [catalog, playbackGuard, shell.syncSourcesAndBump],
  );
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
  });
  const selectTab = useCallback((tab: AppTab, focusContent = true) => {
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
    setDetailStack((prev) => pushDetailStack(prev, target));
    setHeroScrolled(false);
    setTopNavFocused(false);
  }, []);
  const popDetail = useCallback(() => {
    setDetailStack((prev) => prev.slice(0, -1));
    setHeroScrolled(false);
    setUserStateVersion((v) => v + 1);
  }, []);
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
  const handleExitNavFocus = useCallback(() => setTopNavFocused(false), []);
  const handleFocusTopNav = useCallback(() => setTopNavFocused(true), []);
  const handleNavBack = useCallback(
    () =>
      handleShellTopNavBack({
        activeTab,
        hasActiveDetail: activeDetail !== null,
        popDetail,
        exitNavFocus: handleExitNavFocus,
        selectHomeInTopNav: () => selectTab('home', false),
      }),
    [activeDetail, activeTab, handleExitNavFocus, popDetail, selectTab],
  );
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
          setLiveMemory(EMPTY_LIVE_MEMORY);
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
  const onPlayerTargetChange = (next: PlayTarget) => {
    const enriched = enrichPlayTargetAccountKey(next, sourcesRef.current);
    playTargetRef.current = enriched;
    setPlayTarget(enriched);
    if (enriched.kind === 'live')
      setLiveMemory((p) => ({ ...p, ...recordChannelTune(p, enriched.itemKey) }));
  };
  const onPlayerExit = () => {
    playTargetRef.current = null;
    setPlayTarget(null);
    setHeroScrolled(false);
    setUserStateVersion((v) => v + 1);
  };
  return (
    <RouteActiveProvider active={documentVisible && appForeground}>
      <CatalogUiCacheProvider cache={uiCache}>
        <BrowseFocusMemoryProvider memory={focusMemory}>
          {playTarget !== null ? (
            <CrashRecoveryBoundary resetKey={playTarget.itemKey} {...crashProps}>
              <PlayerScreen
                catalog={observedCatalog}
                videoHost={videoHost}
                target={playTarget}
                playbackGuard={playbackGuard}
                autoHideOsdMs={DEFAULT_AUTO_HIDE_OSD_MS}
                {...(appLifecycle !== undefined ? { appLifecycle } : {})}
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
              testID="app-shell"
            >
              <CrashRecoveryBoundary
                resetKey={`${activeTab}:${activeDetail?.itemKey ?? ''}`}
                {...crashProps}
              >
                {isResolvingInitialSources ? (
                  <View testID="app-shell-boot" style={styles.bootCanvas} />
                ) : activeDetail !== null ? (
                  <DetailScreen
                    key={activeDetail.itemKey}
                    target={activeDetail}
                    userStateVersion={userStateVersion}
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
                        externalRefreshToken={externalRefreshToken + refreshToken}
                        {...(readySourcesCount > 0 ? { onOpenMenu: () => selectTab('home') } : {})}
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
                    memory={catalogMemoryByTab[activeTab]}
                    onMemoryChange={
                      activeTab === 'movie' ? handleMovieMemoryChange : handleSeriesMemoryChange
                    }
                    onOpenDetail={openDetail}
                    onOpenSources={openSources}
                    {...stageProps}
                  />
                ) : (
                  <LiveScreen
                    sources={sources}
                    userStateVersion={userStateVersion}
                    memory={liveMemory}
                    onMemoryChange={setLiveMemory}
                    videoHost={videoHost}
                    playbackGuard={playbackGuard}
                    onPlay={handlePlay}
                    onOpenSources={openSources}
                    {...stageProps}
                  />
                )}
              </CrashRecoveryBoundary>
            </AdaptiveNavShell>
          )}
        </BrowseFocusMemoryProvider>
      </CatalogUiCacheProvider>
    </RouteActiveProvider>
  );
}

const styles = StyleSheet.create({ bootCanvas: { flex: 1 } });
