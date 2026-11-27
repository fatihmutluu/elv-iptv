import type { SearchScope } from '@elv/data';
import { useI18n, useViewport } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { usePlayDeepLinkHandler } from './app-shell-deep-link';
import { useShellPlaybackModes } from './app-shell-desktop';
import {
  buildShellProfileUtility,
  useShellManagementOverlays,
  useShellObservedCatalog,
  useShellProfileEffects,
  useShellSourceControls,
} from './app-shell-overlays';
import { AppShellPlayerHost } from './app-shell-player';
import { useProgrammeReminders } from './app-shell-reminders';
import {
  AppShellContextProviders,
  type AppShellProps,
  AppShellStage,
  useShellArtworkCacheLimit,
  useShellIncomingLocalPlaylist,
} from './app-shell-sections';
import {
  type AppTab,
  buildShellNavigation,
  clearSourceFromCatalogMemory,
  clearSourceFromLiveMemory,
  createExitBackConfirmGuard,
  DEFAULT_EXIT_BACK_CONFIRM_MS,
  type ExitBackConfirmGuard,
  enrichPlayTargetAccountKey,
  handleShellTopNavBack,
  INITIAL_CATALOG_MEMORY,
  type PrimaryNavTab,
  pushDetailStack,
} from './app-shell-state';
import { useSyncDirtyCatalog } from './app-shell-sync-hooks';
import { useTvHomeChannelsSync } from './app-shell-tv-channels';
import { AppShellRootOverlays, useAppShellWaveF7b } from './app-shell-wave-f7b';
import { useWaveF9Controller } from './app-shell-wave-f9';
import type { CatalogTabMemory } from './catalog';
import { EMPTY_LIVE_MEMORY, type LiveTabMemory, recordChannelTune } from './live';
import type { PlayTarget } from './ports/play-target';
import { createPlaybackGuard } from './ports/playback-guard';
import { useOledScreensaver } from './screensaver';
import type { SettingsSection } from './settings';
import {
  buildElvCacheFingerprint,
  type DetailTarget,
  isElvFeatureActive,
  KeymapProvider,
  ProfileProvider,
  useElvBackgroundMatcher,
  useProfile,
} from './shared';
import {
  AdaptiveNavShell,
  CrashRecoveryBoundary,
  createBrowseFocusMemory,
  createCatalogUiCache,
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

export type { AppShellProps, AppTab };

/** Top-level Cinema Quietude shell (`Home`, `Live`, `Movies`, `Series` + `Search`, `Settings`, `DetailScreen`, `PlayerScreen`). */
export function AppShell(props: AppShellProps): ReactElement {
  const preferences = usePreferences();
  const syncCatalog = useSyncDirtyCatalog(props.catalog, props.syncAccount);
  const effectiveProfilePreferences = props.profilePreferences ?? preferences.profilePreferences;
  const effectiveKeymapStore = props.keymapStore ?? preferences.keymapStore;
  const externalRefreshToken = props.externalRefreshToken;
  return (
    <ProfileProvider
      catalog={syncCatalog}
      {...(externalRefreshToken !== undefined ? { externalRefreshToken } : {})}
      {...(effectiveProfilePreferences !== undefined
        ? { profilePreferences: effectiveProfilePreferences }
        : {})}
      {...(effectiveKeymapStore !== undefined ? { keymapStore: effectiveKeymapStore } : {})}
    >
      <AppShellWithKeymap {...props} catalog={syncCatalog} />
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
  const stopEmbeddedPreviewRef = useRef<(() => Promise<void>) | null>(null);
  const handleRegisterStopPreview = useCallback((stop: (() => Promise<void>) | null) => {
    stopEmbeddedPreviewRef.current = stop;
  }, []);
  const stopActivePlayerRef = useRef<(() => Promise<void>) | null>(null);
  const handleRegisterStopActivePlayer = useCallback((stop: (() => Promise<void>) | null) => {
    stopActivePlayerRef.current = stop;
  }, []);
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
  useShellArtworkCacheLimit(preferences.preferences.artworkCacheLimitMb);
  const [activeTab, setActiveTab] = useState<AppTab>('settings');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('sources');
  const [topNavFocused, setTopNavFocused] = useState(false);
  const [heroScrolled, setHeroScrolled] = useState(false);
  const [userPickedTab, setUserPickedTab] = useState(false);
  const [userStateVersion, setUserStateVersion] = useState(0);
  const [reminderVersion, setReminderVersion] = useState(0);
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
  const resetToFullModeRef = useRef<(clearAdoption?: boolean) => void>(() => undefined);
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
  const profileScopeKey = `${profile.activeProfileId}:${profile.parentalUnlocked ? '1' : '0'}:${profile.profileRevision}`;
  const elvCacheKey = buildElvCacheFingerprint(preferences.preferences);
  uiCache.setRevision(catalogRevision, locale, profileScopeKey, elvCacheKey);
  const openPlayTarget = useCallback((enriched: PlayTarget) => {
    exitBackGuardRef.current?.reset();
    resetToFullModeRef.current();
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
  const interceptOpenPlayTargetRef = useRef<(enriched: PlayTarget) => void>(openPlayTarget);
  const connectionGuard = useConnectionLimitGuard({
    sourcesRef,
    enrichTarget: enrichPlayTargetAccountKey,
    ...(props.connectionTracker !== undefined
      ? { connectionTracker: props.connectionTracker }
      : {}),
    onOpenTarget: useCallback((enriched: PlayTarget) => {
      interceptOpenPlayTargetRef.current(enriched);
    }, []),
    onAdoptTarget: openPlayTarget,
    onReplaceTarget: replacePlayTarget,
  });
  const stopForSource = useCallback(
    (sourceId: string): void => {
      if (playTargetRef.current?.sourceId === sourceId) {
        playTargetRef.current = null;
        setPlayTarget(null);
        resetToFullModeRef.current(true);
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
  const handleGuideRefreshed = useCallback(
    () => void shell.syncSourcesAndBump(),
    [shell.syncSourcesAndBump],
  );
  useGuideAutoRefresh({
    catalog,
    sources,
    catalogRefreshHours: preferences.preferences.catalogRefreshHours,
    guideRefreshHours: preferences.preferences.guideRefreshHours,
    sessionImportedIdsRef: shell.autoImportedIdsRef,
    enabled:
      documentVisible &&
      appForeground &&
      isBrowsing &&
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
    if (!confirmExitOnBack || isFullPlayerActive || activeTab !== 'home' || activeDetail !== null) {
      exitBackGuardRef.current?.reset();
    }
  }, [activeDetail, activeTab, confirmExitOnBack, isFullPlayerActive]);
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
  const handleFavoritesMutated = useCallback(() => {
    uiCache.clearHome?.();
    setUserStateVersion((v) => v + 1);
  }, [uiCache]);
  const handleReminderChanged = useCallback(() => setReminderVersion((v) => v + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: locale updates translated reminder timing text on live language switch
  const formatReminderTimingText = useCallback(
    (startsInMinutes: number) =>
      startsInMinutes <= 0
        ? i18n.t('epg.reminderStartingNow')
        : i18n.t('epg.reminderStartsIn', { minutes: startsInMinutes }),
    [i18n, locale],
  );
  const reminders = useProgrammeReminders({
    catalog: observedCatalog,
    activeProfileId: profile.activeProfileId,
    parentalUnlocked: profile.parentalUnlocked,
    profileRevision: profile.profileRevision,
    catalogRevision,
    reminderVersion,
    onTuneChannel: modes.tuneFromReminder,
    formatTimingText: formatReminderTimingText,
    ...(props.reminderHost !== undefined ? { reminderHost: props.reminderHost } : {}),
  });
  const bumpStageKey = useCallback(() => setStageKey((k) => k + 1), []);
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
  const openAccountSettings = useCallback(() => {
    userPickedSettingsSectionRef.current = true;
    setSettingsSection('account');
    selectTab('settings', true);
  }, [selectTab]);
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
    bumpStageKey,
    clearCaches: clearAllCaches,
    switchSource: switchSourceOnCrash,
  });
  const waveF9 = useWaveF9Controller({
    preferences,
    activeTab,
    ports: props,
    isViewingActive: playerPlaybackActive || liveEmbeddedPlaybackActive,
    hasPlayerTarget: playTarget !== null,
    onOpenAccountSettings: openAccountSettings,
  });
  interceptOpenPlayTargetRef.current = waveF7b.externalHandoff.interceptPlayTarget;
  const hasRootOverlay =
    hasProfileOverlay ||
    mgmtOverlays.anyOpen ||
    waveF7b.anyOverlayOpen ||
    waveF9.hasOverlay ||
    (isTv && reminders.activeBanner !== null);
  const crashProps = waveF7b.crashProps;
  const isResolvingInitialSources =
    !profile.profilesReady || (!sourcesResolved && !userPickedTab && activeDetail === null);
  const hasHeroOverlay =
    activeDetail !== null || (sourcesResolved && profile.profilesReady && activeTab === 'home');
  const contentIsolationKey = `${profile.activeProfileId}:${profile.parentalUnlocked ? 'u' : 'l'}`;
  const effectiveRefreshToken = refreshToken + profile.profileRevision;
  const effectiveUserStateVersion = userStateVersion + profile.profileRevision;

  const tvHomeChannelsSyncKey = `${profile.activeProfileId}:${profile.profileRevision}:${catalogRevision}:${userStateVersion}:${locale}:${visibleSources.map((s) => s.id).join(',')}`;

  useTvHomeChannelsSync({
    catalog: observedCatalog,
    ...(props.tvHomeChannels !== undefined ? { tvHomeChannels: props.tvHomeChannels } : {}),
    profilesReady: profile.profilesReady,
    syncKey: tvHomeChannelsSyncKey,
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
  const onPlayerTargetChange = useCallback(
    (next: PlayTarget) => {
      connectionGuard.replaceActiveTarget(next);
      waveF9.notifyPlaybackExitOrSwitch();
    },
    [connectionGuard, waveF9],
  );
  const onPlayerExit = () => {
    const exiting = playTargetRef.current;
    if (exiting?.kind === 'live') {
      setLiveMemory((p) => ({
        ...p,
        activeChannelKey: exiting.itemKey,
        ...(exiting.previousChannel ? { previousChannelKey: exiting.previousChannel.itemKey } : {}),
      }));
    }
    connectionGuard.releaseActive();
    playTargetRef.current = null;
    setPlayTarget(null);
    modes.resetToFullMode(true);
    setHeroScrolled(false);
    setUserStateVersion((v) => v + 1);
    waveF9.notifyPlaybackExitOrSwitch();
  };
  const showCachedStrip =
    !isResolvingInitialSources &&
    activeDetail === null &&
    activeTab !== 'settings' &&
    importHealth.health.length > 0;
  const stageOptionalProps = {
    ...(props.sourceImportHost !== undefined ? { sourceImportHost: props.sourceImportHost } : {}),
    ...(props.lanPairing !== undefined ? { lanPairing: props.lanPairing } : {}),
    ...(props.trailerExternal !== undefined ? { trailerExternal: props.trailerExternal } : {}),
    onTelemetryOptInChange: waveF9.onTelemetryOptInChange,
  };
  const onOpenDetailFromPlayer = (target: DetailTarget) => {
    onPlayerExit();
    openDetail(target);
  };

  return (
    <AppShellContextProviders
      routeActive={documentVisible && appForeground}
      uiCache={uiCache}
      focusMemory={focusMemory}
      {...(props.downloadManager !== undefined ? { downloadManager: props.downloadManager } : {})}
      catalog={observedCatalog}
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
          onOpenDetail={onOpenDetailFromPlayer}
          onExit={onPlayerExit}
        />
        <AppShellRootOverlays
          exitToastVisible={exitToastVisible && isBrowsing}
          connectionGuard={connectionGuard}
          mgmtOverlays={mgmtOverlays}
          catalog={observedCatalog}
          onChannelsMutated={handleChannelsMutated}
          onOpenProfilesSettings={openProfilesSettings}
          reminders={reminders}
          oledScreensaver={oledScreensaver}
          wave={waveF7b}
          waveF9={waveF9}
        />
      </View>
    </AppShellContextProviders>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  cachedStripWrap: { paddingHorizontal: 16, paddingTop: 8 },
});
