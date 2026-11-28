import type { SearchScope } from '@elv/data';
import { useI18n, useViewport } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { usePlayDeepLinkHandler } from './app-shell-deep-link';
import { useShellPlaybackModes } from './app-shell-desktop';
import { AppShellOnboardingOverlays, useAppShellOnboarding } from './app-shell-onboarding';
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
  useShellExitBackGuard,
  useShellIncomingLocalPlaylist,
  useShellLiveTabMemory,
} from './app-shell-sections';
import {
  type AppTab,
  buildShellNavigation,
  clearSourceFromCatalogMemory,
  clearSourceFromLiveMemory,
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
  const selectTab = useCallback((tab: AppTab, focusContent = true) => {
    resetExitGuardRef.current();
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
  const openSettingsSection = useCallback(
    (section: SettingsSection) => {
      userPickedSettingsSectionRef.current = true;
      setSettingsSection(section);
      selectTab('settings', true);
    },
    [selectTab],
  );
  const openSources = useCallback(() => openSettingsSection('sources'), [openSettingsSection]);
  const openProfilesSettings = useCallback(
    () => openSettingsSection('profiles'),
    [openSettingsSection],
  );
  const openAccountSettings = useCallback(
    () => openSettingsSection('account'),
    [openSettingsSection],
  );
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
    resetExitGuardRef.current();
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
  const { exitToastVisible, resetExitGuard, onRootHomeBack } = useShellExitBackGuard(
    preferences.preferences.confirmExitOnBack,
    !isFullPlayerActive && activeTab === 'home' && activeDetail === null,
  );
  const resetExitGuardRef = useRef(resetExitGuard);
  resetExitGuardRef.current = resetExitGuard;
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: locale updates translated reminder timing text on live language switch
  const formatReminderTimingText = useCallback(
    (m: number) =>
      m <= 0 ? i18n.t('epg.reminderStartingNow') : i18n.t('epg.reminderStartsIn', { minutes: m }),
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
  interceptOpenPlayTargetRef.current = waveF7b.externalHandoff.interceptPlayTarget;
  const hasOtherRootOverlay =
    hasProfileOverlay ||
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
    ...(props.updater !== undefined ? { updater: props.updater } : {}),
    ...(observedCatalog.clearRecentChannels !== undefined
      ? { onClearRecentChannels: desktopErgonomics.onClearRecentChannels }
      : {}),
    onTelemetryOptInChange: waveF9.onTelemetryOptInChange,
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
          onOpenDetail={(target) => {
            onPlayerExit();
            openDetail(target);
          }}
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
          desktopErgonomics={desktopErgonomics}
        />
        <AppShellOnboardingOverlays onboarding={onboarding} />
      </View>
    </AppShellContextProviders>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  cachedStripWrap: { paddingHorizontal: 16, paddingTop: 8 },
});
