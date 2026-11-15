import type { BrowseKind, CatalogService, SourceRow } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import type { MessageId } from '@elv/i18n';
import { useFormFactor, useI18n, useKeyInterpreter } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BrowseScreen, EMPTY_TAB_MEMORY, type TabBrowseMemory } from './browse';
import { PlayerScreen } from './player';
import type { AppLifecyclePort } from './ports/app-lifecycle';
import type { PlayTarget } from './ports/play-target';
import type { PlaybackGuard } from './ports/playback-guard';
import type { VideoHost } from './ports/video-host';
import { SourcesScreen } from './sources';

/** Top-level shell tab identifier. */
export type AppTab = 'live' | 'movie' | 'series' | 'sources';

const APP_TABS: readonly AppTab[] = ['live', 'movie', 'series', 'sources'];

const TAB_LABEL_IDS: Readonly<Record<AppTab, MessageId>> = {
  live: 'nav.live',
  movie: 'nav.movies',
  series: 'nav.series',
  sources: 'nav.sources',
};

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

function TopNavTvBridge({ onEvent }: { onEvent: (event: KeyEvent) => void }): ReactElement {
  useKeyInterpreter(onEvent);
  return (
    <View testID="nav-tv-focus-anchor" focusable hasTVPreferredFocus style={styles.tvFocusAnchor} />
  );
}

/**
 * Top-level browse-and-play application shell (`Live`, `Movies`, `Series`, `Sources`, and full-screen
 * `PlayerScreen`). Defaults to `Sources` when no source is configured yet, reconciles startup
 * `needsImport` sources in the background, wires `PlaybackGuard`, and preserves per-tab focus memory.
 */
export function AppShell({
  catalog,
  videoHost,
  appLifecycle,
  externalRefreshToken = 0,
  onPlaybackGuardReady,
}: AppShellProps): ReactElement {
  const formFactor = useFormFactor();
  const i18n = useI18n();
  const isTv = formFactor === 'tv';

  const [activeTab, setActiveTab] = useState<AppTab>('sources');
  const [topNavFocused, setTopNavFocused] = useState(false);
  const [sources, setSources] = useState<readonly SourceRow[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [memoryByTab, setMemoryByTab] = useState<BrowseMemoryMap>(INITIAL_MEMORY_MAP);
  const [playTarget, setPlayTarget] = useState<PlayTarget | null>(null);

  const mountedRef = useRef(true);
  const userPickedTabRef = useRef(false);
  const autoImportedIdsRef = useRef(new Set<string>());
  const activeTabRef = useRef<AppTab>(activeTab);
  activeTabRef.current = activeTab;
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
    () => ({
      stopIfUsingSource(sourceId: string) {
        stopForSource(sourceId);
      },
    }),
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
        stopForSource(id);
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
    [catalog, stopForSource, syncSourcesAndBump],
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

  const handleTopNavTvKey = useCallback((event: KeyEvent) => {
    if (event.kind !== 'press' && event.kind !== 'repeat') return;
    if (event.key === 'left' || event.key === 'right') {
      const idx = APP_TABS.indexOf(activeTabRef.current);
      const delta = event.key === 'right' ? 1 : -1;
      const nextTab = APP_TABS[(idx + delta + APP_TABS.length) % APP_TABS.length] as AppTab;
      userPickedTabRef.current = true;
      setActiveTab(nextTab);
    } else if (event.key === 'down' || event.key === 'select') {
      setTopNavFocused(false);
    }
  }, []);

  if (playTarget !== null) {
    return (
      <PlayerScreen
        catalog={observedCatalog}
        videoHost={videoHost}
        target={playTarget}
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
    <View style={styles.root} testID="app-shell">
      {isTv && topNavFocused ? <TopNavTvBridge onEvent={handleTopNavTvKey} /> : null}
      <View style={[styles.navBar, isTv ? styles.navBarTv : null]} testID="app-top-nav">
        {activeTab !== 'sources' ? (
          <Text style={[styles.brand, isTv ? styles.brandTv : null]}>{i18n.t('app.title')}</Text>
        ) : null}
        <View style={styles.tabsRow}>
          {APP_TABS.map((tab) => {
            const selected = activeTab === tab;
            const tvHighlighted = isTv && topNavFocused && selected;
            return (
              <Pressable
                key={tab}
                testID={`nav-tab-${tab}`}
                accessibilityRole="tab"
                accessibilityLabel={i18n.t(TAB_LABEL_IDS[tab])}
                accessibilityState={{ selected }}
                {...(isTv ? { focusable: false } : {})}
                onPress={() => selectTab(tab)}
                style={[
                  styles.tabButton,
                  selected ? styles.tabButtonSelected : null,
                  tvHighlighted ? styles.tabButtonTvFocused : null,
                ]}
              >
                <Text
                  style={[
                    styles.tabText,
                    isTv ? styles.tabTextTv : null,
                    selected ? styles.tabTextSelected : null,
                  ]}
                >
                  {i18n.t(TAB_LABEL_IDS[tab])}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.body}>
        {activeTab === 'sources' ? (
          <SourcesScreen
            catalog={observedCatalog}
            playbackGuard={playbackGuard}
            externalRefreshToken={externalRefreshToken + refreshToken}
            {...(readySourcesCount > 0 ? { onOpenMenu: () => selectTab('live') } : {})}
            onBack={() => setTopNavFocused(true)}
            onFocusTopNav={() => setTopNavFocused(true)}
            isActiveScope={!topNavFocused}
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
            onOpenSources={() => selectTab('sources')}
            onFocusTopNav={() => setTopNavFocused(true)}
            isActiveScope={!topNavFocused}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  tvFocusAnchor: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#111111',
    borderBottomWidth: 1,
    borderBottomColor: '#262626',
  },
  navBarTv: { paddingHorizontal: 48, paddingVertical: 14 },
  brand: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  brandTv: { fontSize: 20 },
  tabsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  tabButton: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#333333',
    backgroundColor: '#171717',
  },
  tabButtonSelected: { borderColor: '#a3a3a3', backgroundColor: '#262626' },
  tabButtonTvFocused: { borderColor: '#ffffff', backgroundColor: '#333333' },
  tabText: { color: '#b5b5b5', fontSize: 14, fontWeight: '600' },
  tabTextTv: { fontSize: 18 },
  tabTextSelected: { color: '#ffffff' },
  body: { flex: 1 },
});
