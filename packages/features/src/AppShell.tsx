import type { CatalogService, SearchScope, SourceRow } from '@elv/data';
import { useI18n } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildShellDestinations,
  buildShellUtilities,
  type CatalogMemoryMap,
  clearSourceFromCatalogMemory,
  clearSourceFromLiveMemory,
  createObservedCatalog,
  INITIAL_CATALOG_MEMORY,
  type PrimaryNavTab,
  pushDetailStack,
} from './app-shell-state';
import { CatalogDiscoveryScreen, type CatalogTabMemory } from './catalog';
import { DetailScreen } from './detail';
import { HomeScreen } from './home';
import { EMPTY_LIVE_MEMORY, LiveScreen, type LiveTabMemory, recordChannelTune } from './live';
import { ThirdPartyNoticesScreen } from './notices';
import { PlayerScreen } from './player';
import type { AppLifecyclePort } from './ports/app-lifecycle';
import type { PlayTarget } from './ports/play-target';
import { createPlaybackGuard, type PlaybackGuard } from './ports/playback-guard';
import type { VideoHost } from './ports/video-host';
import { SearchScreen } from './search';
import { SettingsScreen, type SettingsSection } from './settings';
import type { DetailTarget } from './shared';
import { AdaptiveNavShell, CrashRecoveryBoundary, usePreferences } from './shell';
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

/**
 * Top-level Cinema Quietude shell (`Home`, `Live`, `Movies`, `Series` + `Search`, `Settings`
 * utilities, overlay `DetailScreen`, and full-screen `PlayerScreen`).
 */
export function AppShell({
  catalog,
  videoHost,
  appLifecycle,
  externalRefreshToken = 0,
  onPlaybackGuardReady,
}: AppShellProps): ReactElement {
  const i18n = useI18n();
  const preferences = usePreferences();

  const [activeTab, setActiveTab] = useState<AppTab>('settings');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('sources');
  const [topNavFocused, setTopNavFocused] = useState(false);
  const [heroScrolled, setHeroScrolled] = useState(false);
  const [sources, setSources] = useState<readonly SourceRow[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [userStateVersion, setUserStateVersion] = useState(0);
  const [liveMemory, setLiveMemory] = useState<LiveTabMemory>(EMPTY_LIVE_MEMORY);
  const [catalogMemoryByTab, setCatalogMemoryByTab] =
    useState<CatalogMemoryMap>(INITIAL_CATALOG_MEMORY);
  const [detailStack, setDetailStack] = useState<readonly DetailTarget[]>([]);
  const [recentSearches, setRecentSearches] = useState<readonly string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<SearchScope>('all');
  const [playTarget, setPlayTarget] = useState<PlayTarget | null>(null);
  const [stageKey, setStageKey] = useState(0);

  const mountedRef = useRef(true);
  const userPickedTabRef = useRef(false);
  const userPickedSettingsSectionRef = useRef(false);
  const sourcesCountRef = useRef(0);
  sourcesCountRef.current = sources.length;
  const autoImportedIdsRef = useRef(new Set<string>());
  const playTargetRef = useRef<PlayTarget | null>(playTarget);
  playTargetRef.current = playTarget;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearSearchSession = useCallback(() => {
    setRecentSearches([]);
    setSearchQuery('');
    setSearchScope('all');
  }, []);

  const syncSourcesAndBump = useCallback(async () => {
    try {
      const rows = await catalog.listSources();
      if (!mountedRef.current) return;
      setSources(rows);
      if (rows.length === 0) clearSearchSession();
      setRefreshToken((n) => n + 1);
    } catch {
      // Ignore transient catalog open errors in shell background refresh.
    }
  }, [catalog, clearSearchSession]);

  const stopForSource = useCallback((sourceId: string): void => {
    if (playTargetRef.current?.sourceId === sourceId) {
      playTargetRef.current = null;
      setPlayTarget(null);
    }
    setLiveMemory((prev) => clearSourceFromLiveMemory(prev, sourceId));
    setCatalogMemoryByTab((prev) => clearSourceFromCatalogMemory(prev, sourceId));
    setDetailStack((prev) => prev.filter((entry) => entry.sourceId !== sourceId));
  }, []);

  const playbackGuard = useMemo(() => createPlaybackGuard(stopForSource), [stopForSource]);
  useEffect(() => {
    onPlaybackGuardReady?.(playbackGuard);
  }, [onPlaybackGuardReady, playbackGuard]);
  const handlePlay = useCallback((target: PlayTarget) => {
    setHeroScrolled(false);
    playTargetRef.current = target;
    setPlayTarget(target);
  }, []);
  const observedCatalog = useMemo(
    () => createObservedCatalog(catalog, playbackGuard, syncSourcesAndBump),
    [catalog, playbackGuard, syncSourcesAndBump],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: externalRefreshToken re-triggers source reconciliation
  useEffect(() => {
    let cancelled = false;
    void catalog
      .listSources()
      .then((initial) => {
        if (cancelled) return;
        setSources(initial);
        if (initial.length === 0) clearSearchSession();
        setRefreshToken((n) => n + 1);
        if (initial.length > 0 && !userPickedTabRef.current) {
          setActiveTab('home');
          if (!userPickedSettingsSectionRef.current) setSettingsSection('appearance');
        }
        for (const source of initial) {
          if (!source.needsImport || autoImportedIdsRef.current.has(source.id)) continue;
          autoImportedIdsRef.current.add(source.id);
          void catalog
            .importSource(source.id)
            .then((res) => (cancelled || !res.ok ? null : catalog.listSources()))
            .then((updated) => {
              if (cancelled || !updated) return;
              setSources(updated);
              setRefreshToken((n) => n + 1);
            })
            .catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [catalog, externalRefreshToken]);

  const selectTab = useCallback((tab: AppTab, focusContent = true) => {
    userPickedTabRef.current = true;
    setActiveTab(tab);
    setDetailStack([]);
    setHeroScrolled(false);
    if (focusContent) setTopNavFocused(false);
  }, []);
  const handleSettingsSectionChange = useCallback((next: SettingsSection) => {
    userPickedSettingsSectionRef.current = true;
    setSettingsSection(next);
  }, []);
  const openSearch = useCallback(() => selectTab('search', false), [selectTab]);
  const openSettings = useCallback(() => {
    if (sourcesCountRef.current > 0 && !userPickedSettingsSectionRef.current) {
      setSettingsSection('appearance');
    }
    selectTab('settings', false);
  }, [selectTab]);
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
  const home = i18n.t('nav.home');
  const live = i18n.t('nav.live');
  const movies = i18n.t('nav.movies');
  const series = i18n.t('nav.series');
  const searchLabel = i18n.t('nav.search');
  const settingsLabel = i18n.t('nav.settings');
  const destinations = useMemo(
    () => buildShellDestinations({ home, live, movies, series }),
    [home, live, movies, series],
  );
  const utilities = useMemo(
    () =>
      buildShellUtilities({
        searchLabel,
        settingsLabel,
        activeTab,
        hasActiveDetail: activeDetail !== null,
        onOpenSearch: openSearch,
        onOpenSettings: openSettings,
      }),
    [searchLabel, settingsLabel, activeTab, activeDetail, openSearch, openSettings],
  );

  const handleSelectDestination = useCallback(
    (t: PrimaryNavTab) => selectTab(t, false),
    [selectTab],
  );
  const handleExitNavFocus = useCallback(() => setTopNavFocused(false), []);
  const handleFocusTopNav = useCallback(() => setTopNavFocused(true), []);
  const handleMovieMemoryChange = useCallback(
    (next: CatalogTabMemory) => setCatalogMemoryByTab((p) => ({ ...p, movie: next })),
    [],
  );
  const handleSeriesMemoryChange = useCallback(
    (next: CatalogTabMemory) => setCatalogMemoryByTab((p) => ({ ...p, series: next })),
    [],
  );
  const crashProps = useMemo(
    () => ({
      remountKey: stageKey,
      onReload: () => setStageKey((k) => k + 1),
      onClearUiCache: () => {
        setLiveMemory(EMPTY_LIVE_MEMORY);
        setCatalogMemoryByTab(INITIAL_CATALOG_MEMORY);
        setDetailStack([]);
        clearSearchSession();
        setHeroScrolled(false);
        setStageKey((k) => k + 1);
      },
      onSwitchSource: () => {
        playTargetRef.current = null;
        setPlayTarget(null);
        openSources();
        setStageKey((k) => k + 1);
      },
    }),
    [stageKey, clearSearchSession, openSources],
  );

  if (playTarget !== null) {
    return (
      <CrashRecoveryBoundary resetKey={playTarget.itemKey} {...crashProps}>
        <PlayerScreen
          catalog={observedCatalog}
          videoHost={videoHost}
          target={playTarget}
          playbackGuard={playbackGuard}
          {...(appLifecycle !== undefined ? { appLifecycle } : {})}
          onTargetChange={(next) => {
            playTargetRef.current = next;
            setPlayTarget(next);
            if (next.kind === 'live') {
              setLiveMemory((prev) => ({ ...prev, ...recordChannelTune(prev, next.itemKey) }));
            }
          }}
          onExit={() => {
            playTargetRef.current = null;
            setPlayTarget(null);
            setHeroScrolled(false);
            setUserStateVersion((v) => v + 1);
          }}
        />
      </CrashRecoveryBoundary>
    );
  }

  const readySourcesCount = sources.filter((s) => !s.needsImport).length;
  const hasHeroOverlay = activeDetail !== null || activeTab === 'home';
  const stageProps = {
    catalog: observedCatalog,
    refreshToken,
    onFocusTopNav: handleFocusTopNav,
    isActiveScope: !topNavFocused,
  };

  return (
    <AdaptiveNavShell
      brandTitle={i18n.t('app.title')}
      showBrand
      destinations={destinations}
      utilities={utilities}
      activeId={activeTab}
      onSelectDestination={handleSelectDestination}
      navFocused={topNavFocused}
      onExitNavFocus={handleExitNavFocus}
      overlay={hasHeroOverlay}
      frosted={hasHeroOverlay ? heroScrolled : true}
      testID="app-shell"
    >
      <CrashRecoveryBoundary
        resetKey={`${activeTab}:${activeDetail?.itemKey ?? ''}`}
        {...crashProps}
      >
        {activeDetail !== null ? (
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
            memory={liveMemory}
            onMemoryChange={setLiveMemory}
            onPlay={handlePlay}
            onOpenSources={openSources}
            {...stageProps}
          />
        )}
      </CrashRecoveryBoundary>
    </AdaptiveNavShell>
  );
}
