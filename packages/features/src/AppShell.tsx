import type { BrowseKind, CatalogService, SourceRow } from '@elv/data';
import { useI18n } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowseScreen, EMPTY_TAB_MEMORY, type TabBrowseMemory } from './browse';
import { ThirdPartyNoticesScreen } from './notices';
import { PlayerScreen } from './player';
import type { AppLifecyclePort } from './ports/app-lifecycle';
import type { PlayTarget } from './ports/play-target';
import { createPlaybackGuard, type PlaybackGuard } from './ports/playback-guard';
import type { VideoHost } from './ports/video-host';
import { SettingsScreen, type SettingsSection } from './settings';
import { AdaptiveNavShell, type NavDestination, type NavUtility, usePreferences } from './shell';
import { SourcesScreen } from './sources';

/** Top-level shell tab identifier. */
export type AppTab = 'live' | 'movie' | 'series' | 'settings';

/** Props of {@link AppShell}. */
export interface AppShellProps {
  catalog: CatalogService;
  videoHost: VideoHost;
  appLifecycle?: AppLifecyclePort;
  externalRefreshToken?: number;
  /** Optional test/host hook notified with the active {@link PlaybackGuard}. */
  onPlaybackGuardReady?: (guard: PlaybackGuard) => void;
}

type BrowseMemoryMap = Readonly<Record<BrowseKind, TabBrowseMemory>>;

const INITIAL_MEMORY_MAP: BrowseMemoryMap = {
  live: EMPTY_TAB_MEMORY,
  movie: EMPTY_TAB_MEMORY,
  series: EMPTY_TAB_MEMORY,
};

function clearSourceFromMemory(map: BrowseMemoryMap, sourceId: string): BrowseMemoryMap {
  const prefix = `${sourceId}|`;
  const cleanTab = (mem: TabBrowseMemory): TabBrowseMemory => {
    if (mem.categoryId?.startsWith(prefix) || mem.seriesDetail?.series.sourceId === sourceId) {
      return EMPTY_TAB_MEMORY;
    }
    return mem;
  };
  return {
    live: cleanTab(map.live),
    movie: cleanTab(map.movie),
    series: cleanTab(map.series),
  };
}

/**
 * Top-level Cinema Quietude application shell (`Live`, `Movies`, `Series`, consolidated `Settings`
 * utility hosting Appearance, Sources, and About & Licenses, plus full-screen `PlayerScreen`).
 * Defaults to `Settings -> Sources` when no source is configured yet, reconciles startup
 * `needsImport` sources in the background, wires `PlaybackGuard`, and preserves per-tab focus
 * memory.
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
  const [sources, setSources] = useState<readonly SourceRow[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [memoryByTab, setMemoryByTab] = useState<BrowseMemoryMap>(INITIAL_MEMORY_MAP);
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
    setMemoryByTab((prev) => clearSourceFromMemory(prev, sourceId));
  }, []);

  const playbackGuard = useMemo<PlaybackGuard>(
    () => createPlaybackGuard(stopForSource),
    [stopForSource],
  );

  useEffect(() => {
    onPlaybackGuardReady?.(playbackGuard);
  }, [onPlaybackGuardReady, playbackGuard]);

  const observedCatalog = useMemo<CatalogService>(
    () => ({
      addSource: async (input) => {
        const res = await catalog.addSource(input);
        if (res.ok) await syncSourcesAndBump();
        return res;
      },
      addSourceFromLink: async (input) => {
        const res = await catalog.addSourceFromLink(input);
        if (res.ok) await syncSourcesAndBump();
        return res;
      },
      removeSource: async (id) => {
        await playbackGuard.stopIfUsingSource(id);
        const res = await catalog.removeSource(id);
        if (res.ok) await syncSourcesAndBump();
        return res;
      },
      importSource: async (id, opts) => {
        const res = await catalog.importSource(id, opts);
        await syncSourcesAndBump();
        return res;
      },
      listSources: () => catalog.listSources(),
      categories: (sourceId, kind) => catalog.categories(sourceId, kind),
      items: (categoryId, offset, limit) => catalog.items(categoryId, offset, limit),
      seasons: (seriesId) => catalog.seasons(seriesId),
      episodes: (seriesId, season) => catalog.episodes(seriesId, season),
      resolveStream: (itemKey) => catalog.resolveStream(itemKey),
      close: () => catalog.close(),
    }),
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
          setActiveTab('live');
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

  const liveLabel = i18n.t('nav.live');
  const moviesLabel = i18n.t('nav.movies');
  const seriesLabel = i18n.t('nav.series');
  const settingsLabel = i18n.t('nav.settings');

  const destinations = useMemo<readonly NavDestination<BrowseKind>[]>(
    () => [
      { id: 'live', label: liveLabel, icon: 'tv', testID: 'nav-tab-live' },
      { id: 'movie', label: moviesLabel, icon: 'film', testID: 'nav-tab-movie' },
      { id: 'series', label: seriesLabel, icon: 'series', testID: 'nav-tab-series' },
    ],
    [liveLabel, moviesLabel, seriesLabel],
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
    (tab: BrowseKind) => {
      selectTab(tab, false);
    },
    [selectTab],
  );

  const handleExitNavFocus = useCallback(() => {
    setTopNavFocused(false);
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
        }}
      />
    );
  }

  const readySourcesCount = sources.filter((s) => !s.needsImport).length;

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
      frosted
      testID="app-shell"
    >
      {activeTab === 'settings' ? (
        <SettingsScreen
          section={settingsSection}
          onSectionChange={handleSettingsSectionChange}
          preferences={preferences}
          onFocusTopNav={() => setTopNavFocused(true)}
          isActiveScope={!topNavFocused}
          renderSources={(slot) => (
            <SourcesScreen
              catalog={observedCatalog}
              embedded
              playbackGuard={playbackGuard}
              externalRefreshToken={externalRefreshToken + refreshToken}
              {...(readySourcesCount > 0 ? { onOpenMenu: () => selectTab('live') } : {})}
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
      ) : (
        <BrowseScreen
          key={activeTab}
          kind={activeTab}
          catalog={observedCatalog}
          sources={sources}
          refreshToken={refreshToken}
          memory={memoryByTab[activeTab]}
          onMemoryChange={(next) =>
            setMemoryByTab((prev) => ({
              ...prev,
              [activeTab]: next,
            }))
          }
          onPlay={(target) => {
            playTargetRef.current = target;
            setPlayTarget(target);
          }}
          onOpenSources={openSources}
          onFocusTopNav={() => setTopNavFocused(true)}
          isActiveScope={!topNavFocused}
        />
      )}
    </AdaptiveNavShell>
  );
}
