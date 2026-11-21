import type { BrowseKind, CatalogService, SourceRow } from '@elv/data';
import { useI18n } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type CatalogMemoryMap,
  clearSourceFromCatalogMemory,
  clearSourceFromLiveMemory,
  createObservedCatalog,
  INITIAL_CATALOG_MEMORY,
  pushDetailStack,
} from './app-shell-state';
import { BrowseScreen, EMPTY_TAB_MEMORY, type TabBrowseMemory } from './browse';
import { CatalogDiscoveryScreen, type CatalogTabMemory } from './catalog';
import { DetailScreen } from './detail';
import { HomeScreen } from './home';
import { ThirdPartyNoticesScreen } from './notices';
import { PlayerScreen } from './player';
import type { AppLifecyclePort } from './ports/app-lifecycle';
import type { PlayTarget } from './ports/play-target';
import { createPlaybackGuard, type PlaybackGuard } from './ports/playback-guard';
import type { VideoHost } from './ports/video-host';
import { SettingsScreen, type SettingsSection } from './settings';
import type { DetailTarget } from './shared';
import { AdaptiveNavShell, type NavDestination, type NavUtility, usePreferences } from './shell';
import { SourcesScreen } from './sources';

/** Top-level shell tab identifier. */
export type AppTab = 'home' | 'live' | 'movie' | 'series' | 'settings';

type PrimaryNavTab = 'home' | BrowseKind;

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
 * Top-level Cinema Quietude application shell (`Home`, `Live`, `Movies`, `Series`, consolidated
 * `Settings` utility hosting Appearance, Sources, and About & Licenses, plus full-screen
 * `PlayerScreen`). Defaults to `Home` when sources are configured or `Settings -> Sources` when
 * empty, reconciles startup `needsImport` sources in the background, wires `PlaybackGuard`, and
 * preserves per-tab focus memory.
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
  const [liveMemory, setLiveMemory] = useState<TabBrowseMemory>(EMPTY_TAB_MEMORY);
  const [catalogMemoryByTab, setCatalogMemoryByTab] =
    useState<CatalogMemoryMap>(INITIAL_CATALOG_MEMORY);
  const [detailStack, setDetailStack] = useState<readonly DetailTarget[]>([]);
  const [playTarget, setPlayTarget] = useState<PlayTarget | null>(null);

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

  const syncSourcesAndBump = useCallback(async () => {
    try {
      const rows = await catalog.listSources();
      if (!mountedRef.current) return;
      setSources(rows);
      setRefreshToken((n) => n + 1);
    } catch {
      // Ignore transient catalog open errors in shell background refresh.
    }
  }, [catalog]);

  const stopForSource = useCallback((sourceId: string): void => {
    if (playTargetRef.current?.sourceId === sourceId) {
      playTargetRef.current = null;
      setPlayTarget(null);
    }
    setLiveMemory((prev) => clearSourceFromLiveMemory(prev, sourceId));
    setCatalogMemoryByTab((prev) => clearSourceFromCatalogMemory(prev, sourceId));
    setDetailStack((prev) => prev.filter((entry) => entry.sourceId !== sourceId));
  }, []);

  const playbackGuard = useMemo<PlaybackGuard>(
    () => createPlaybackGuard(stopForSource),
    [stopForSource],
  );

  useEffect(() => {
    onPlaybackGuardReady?.(playbackGuard);
  }, [onPlaybackGuardReady, playbackGuard]);

  const handlePlay = useCallback((target: PlayTarget) => {
    setHeroScrolled(false);
    playTargetRef.current = target;
    setPlayTarget(target);
  }, []);

  const observedCatalog = useMemo<CatalogService>(
    () => createObservedCatalog(catalog, playbackGuard, syncSourcesAndBump),
    [catalog, playbackGuard, syncSourcesAndBump],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: externalRefreshToken re-triggers source reconciliation
  useEffect(() => {
    let cancelled = false;
    catalog
      .listSources()
      .then((initial) => {
        if (cancelled) return;
        setSources(initial);
        setRefreshToken((n) => n + 1);
        if (initial.length > 0 && !userPickedTabRef.current) {
          setActiveTab('home');
          if (!userPickedSettingsSectionRef.current) {
            setSettingsSection('appearance');
          }
        }
        for (const source of initial) {
          if (source.needsImport && !autoImportedIdsRef.current.has(source.id)) {
            autoImportedIdsRef.current.add(source.id);
            void catalog
              .importSource(source.id)
              .then(async (res) => {
                if (cancelled || !res.ok) return;
                const updated = await catalog.listSources();
                if (cancelled) return;
                setSources(updated);
                setRefreshToken((n) => n + 1);
              })
              .catch(() => undefined);
          }
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

  const homeLabel = i18n.t('nav.home');
  const liveLabel = i18n.t('nav.live');
  const moviesLabel = i18n.t('nav.movies');
  const seriesLabel = i18n.t('nav.series');
  const settingsLabel = i18n.t('nav.settings');

  const destinations = useMemo<readonly NavDestination<PrimaryNavTab>[]>(
    () => [
      { id: 'home', label: homeLabel, icon: 'home', testID: 'nav-tab-home' },
      { id: 'live', label: liveLabel, icon: 'tv', testID: 'nav-tab-live' },
      { id: 'movie', label: moviesLabel, icon: 'film', testID: 'nav-tab-movie' },
      { id: 'series', label: seriesLabel, icon: 'series', testID: 'nav-tab-series' },
    ],
    [homeLabel, liveLabel, moviesLabel, seriesLabel],
  );

  const utilities = useMemo<readonly NavUtility<'settings'>[]>(
    () => [
      {
        id: 'settings',
        label: settingsLabel,
        icon: 'settings',
        active: activeTab === 'settings',
        showLabel: false,
        testID: 'nav-tab-settings',
        onPress: openSettings,
      },
    ],
    [settingsLabel, activeTab, openSettings],
  );

  const handleSelectDestination = useCallback(
    (tab: PrimaryNavTab) => {
      selectTab(tab, false);
    },
    [selectTab],
  );

  const handleExitNavFocus = useCallback(() => {
    setTopNavFocused(false);
  }, []);

  const handleFocusTopNav = useCallback(() => {
    setTopNavFocused(true);
  }, []);

  const handleMovieMemoryChange = useCallback((next: CatalogTabMemory) => {
    setCatalogMemoryByTab((prev) => ({ ...prev, movie: next }));
  }, []);

  const handleSeriesMemoryChange = useCallback((next: CatalogTabMemory) => {
    setCatalogMemoryByTab((prev) => ({ ...prev, series: next }));
  }, []);

  if (playTarget !== null) {
    return (
      <PlayerScreen
        catalog={observedCatalog}
        videoHost={videoHost}
        target={playTarget}
        playbackGuard={playbackGuard}
        {...(appLifecycle !== undefined ? { appLifecycle } : {})}
        onTargetChange={(next) => {
          playTargetRef.current = next;
          setPlayTarget(next);
        }}
        onExit={() => {
          playTargetRef.current = null;
          setPlayTarget(null);
          setHeroScrolled(false);
          setUserStateVersion((v) => v + 1);
        }}
      />
    );
  }

  const readySourcesCount = sources.filter((s) => !s.needsImport).length;
  const activeDetail = detailStack[detailStack.length - 1] ?? null;
  const hasHeroOverlay = activeDetail !== null || activeTab === 'home';

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
      {activeDetail !== null ? (
        <DetailScreen
          key={activeDetail.itemKey}
          target={activeDetail}
          catalog={observedCatalog}
          refreshToken={refreshToken}
          userStateVersion={userStateVersion}
          onBack={popDetail}
          onPlay={handlePlay}
          onOpenDetail={openDetail}
          onScrollTopChange={setHeroScrolled}
          onFocusTopNav={handleFocusTopNav}
          isActiveScope={!topNavFocused}
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
              onBack={slot.onBack}
              {...(slot.onFocusTopNav !== undefined ? { onFocusTopNav: slot.onFocusTopNav } : {})}
              isActiveScope={slot.isActiveScope}
            />
          )}
          renderLicenses={(slot) => (
            <ThirdPartyNoticesScreen
              embedded
              onBack={slot.onBack}
              {...(slot.onFocusTopNav !== undefined ? { onFocusTopNav: slot.onFocusTopNav } : {})}
              isActiveScope={slot.isActiveScope}
            />
          )}
        />
      ) : activeTab === 'home' ? (
        <HomeScreen
          catalog={observedCatalog}
          sources={sources}
          refreshToken={refreshToken}
          userStateVersion={userStateVersion}
          onPlay={handlePlay}
          onOpenTab={selectTab}
          onOpenDetail={openDetail}
          onOpenSources={openSources}
          onScrollTopChange={setHeroScrolled}
          onFocusTopNav={handleFocusTopNav}
          isActiveScope={!topNavFocused}
        />
      ) : activeTab === 'movie' || activeTab === 'series' ? (
        <CatalogDiscoveryScreen
          key={activeTab}
          kind={activeTab}
          catalog={observedCatalog}
          sources={sources}
          refreshToken={refreshToken}
          userStateVersion={userStateVersion}
          memory={catalogMemoryByTab[activeTab]}
          onMemoryChange={
            activeTab === 'movie' ? handleMovieMemoryChange : handleSeriesMemoryChange
          }
          onOpenDetail={openDetail}
          onOpenSources={openSources}
          onFocusTopNav={handleFocusTopNav}
          isActiveScope={!topNavFocused}
        />
      ) : (
        <BrowseScreen
          key="live"
          kind="live"
          catalog={observedCatalog}
          sources={sources}
          refreshToken={refreshToken}
          memory={liveMemory}
          onMemoryChange={setLiveMemory}
          onPlay={handlePlay}
          onOpenSources={openSources}
          onFocusTopNav={handleFocusTopNav}
          isActiveScope={!topNavFocused}
        />
      )}
    </AdaptiveNavShell>
  );
}
