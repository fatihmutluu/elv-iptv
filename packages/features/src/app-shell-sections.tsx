import type { CatalogService, SearchScope, SourceRow } from '@elv/data';
import type { DownloadManagerPort, KeymapStore, ProfilePreferencesManager } from '@elv/domain';
import type { ConnectionTracker } from '@elv/playback';
import {
  TvFocusAnchor,
  useI18n,
  useTheme,
  useUiAdapters,
  useViewport,
  webBackdropBlur,
} from '@elv/ui-kit';
import {
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  type AppTab,
  type CatalogMemoryMap,
  createExitBackConfirmGuard,
  DEFAULT_EXIT_BACK_CONFIRM_MS,
  type ExitBackConfirmGuard,
} from './app-shell-state';
import type { WaveF9Controller } from './app-shell-wave-f9';
import { CatalogDiscoveryScreen, type CatalogTabMemory } from './catalog';
import { DetailScreen } from './detail';
import { HomeScreen } from './home';
import { LibraryScreen } from './library';
import { EMPTY_LIVE_MEMORY, LiveScreen, type LiveTabMemory } from './live';
import { ThirdPartyNoticesScreen } from './notices';
import type { AppLifecyclePort } from './ports/app-lifecycle';
import type { DesktopWindowPort } from './ports/desktop-window-host';
import type { LanPairingPort } from './ports/lan-pairing-host';
import type { PlayDeepLinkTarget } from './ports/play-deep-link';
import type { PlayTarget } from './ports/play-target';
import type { PlaybackGuard } from './ports/playback-guard';
import type { ReminderHostPort } from './ports/reminder-host';
import type { PickedPlaylistFile, SourceImportHost } from './ports/source-import-host';
import type { TrailerExternalPort } from './ports/trailer-port';
import type { TvHomeChannelsPort } from './ports/tv-home-channels';
import type { DesktopUpdaterPort } from './ports/updater-port';
import type { ThermalDevicePort, VideoHost } from './ports/video-host';
import type { DiagnosticsPort, ExternalPlayerPort } from './ports/wave-f7b-ports';
import type {
  FeedbackPort,
  QrScannerPort,
  SyncAccountPort,
  TelemetryPort,
} from './ports/wave-f9-ports';
import { ProfilesAndParentalPanel } from './profiles';
import { SearchScreen } from './search';
import { SettingsScreen, type SettingsSection } from './settings';
import { type DetailTarget, DownloadsProvider, isElvFeatureActive, useDownloads } from './shared';
import {
  type BrowseFocusMemory,
  BrowseFocusMemoryProvider,
  type CatalogUiCache,
  CatalogUiCacheProvider,
  type PreferencesContextValue,
  RouteActiveProvider,
} from './shell';
import { SourcesScreen } from './sources';

/** Props of `AppShell`. */
export interface AppShellProps {
  catalog: CatalogService;
  videoHost: VideoHost;
  appLifecycle?: AppLifecyclePort;
  /** Optional thermal and hardware Multi-View capability port (`#34`, `#232`). */
  thermalDevice?: ThermalDevicePort;
  /** Optional desktop tray and standalone popout window port (`#158`). */
  desktopWindow?: DesktopWindowPort;
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
  /** Optional OS notification host port for programme reminders (`#35`). */
  reminderHost?: ReminderHostPort;
  /** Optional incoming `elviptv://play?key=...` deep-link target (`#273`). */
  pendingDeepLink?: PlayDeepLinkTarget | null;
  /** Invoked once `pendingDeepLink` has been consumed by `AppShell` (`#273`). */
  onDeepLinkHandled?: () => void;
  /** Optional test/host hook notified with the active {@link PlaybackGuard}. */
  onPlaybackGuardReady?: (guard: PlaybackGuard) => void;
  /** Optional platform external player handoff port (`#406`). */
  externalPlayer?: ExternalPlayerPort;
  /** Optional platform opt-in redacted diagnostics port (`#226`). */
  diagnostics?: DiagnosticsPort;
  /** Optional E2EE sync account & bidirectional X25519 QR pairing port (`#26`, `#510`). */
  readonly syncAccount?: SyncAccountPort;
  /** Optional opt-in runtime performance & crash telemetry port (`#458`, `#509`). */
  readonly telemetry?: TelemetryPort;
  /** Optional Settings feedback & issue report submission port (`#458`). */
  readonly feedback?: FeedbackPort;
  /** Optional native camera QR scanner port for bidirectional pairing (`#510`). */
  readonly qrScanner?: QrScannerPort;
  /** Optional incoming `elviptv://pair?...` or Universal Link pairing URI (`#510`). */
  readonly pendingPairUri?: string | null;
  /** Invoked once `pendingPairUri` has been consumed by `AppShell` (`#510`). */
  readonly onPairUriHandled?: () => void;
  /** Optional cross-platform offline VOD download manager port (`Wave P5`). */
  readonly downloadManager?: DownloadManagerPort;
  /** Optional platform external YouTube trailer handoff port (`#512`). */
  readonly trailerExternal?: TrailerExternalPort;
  /** Optional store-gated desktop auto-updater port (`Wave Q7`). */
  readonly updater?: DesktopUpdaterPort;
}

/** Props of {@link AppShellStage}. */
export interface AppShellStageProps {
  readonly isTv: boolean;
  readonly topNavFocused: boolean;
  readonly isResolvingInitialSources: boolean;
  readonly activeTab: AppTab;
  readonly activeDetail: DetailTarget | null;
  readonly contentIsolationKey: string;
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly allSources?: readonly SourceRow[];
  readonly refreshToken: number;
  readonly externalRefreshToken: number;
  readonly effectiveRefreshToken: number;
  readonly effectiveUserStateVersion: number;
  readonly hasTransientOverlay: boolean;
  readonly isActiveScope: boolean;
  readonly preferences: PreferencesContextValue;
  readonly settingsSection: SettingsSection;
  readonly onSettingsSectionChange: (next: SettingsSection) => void;
  readonly playbackGuard: PlaybackGuard;
  readonly videoHost: VideoHost;
  readonly sourceImportHost?: SourceImportHost;
  readonly lanPairing?: LanPairingPort;
  readonly trailerExternal?: TrailerExternalPort;
  readonly incomingLocalPlaylist: PickedPlaylistFile | null;
  readonly onConsumeIncomingLocalPlaylist: () => void;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (q: string) => void;
  readonly searchScope: SearchScope;
  readonly onSearchScopeChange: (s: SearchScope) => void;
  readonly recentSearches: readonly string[];
  readonly onRecentSearchesChange: (next: readonly string[]) => void;
  readonly catalogMemoryByTab: CatalogMemoryMap;
  readonly onMovieMemoryChange: (next: CatalogTabMemory) => void;
  readonly onSeriesMemoryChange: (next: CatalogTabMemory) => void;
  readonly liveMemory: LiveTabMemory;
  readonly onLiveMemoryChange: (next: LiveTabMemory) => void;
  readonly onEmbeddedPlaybackActiveChange: (active: boolean) => void;
  readonly onSearchPerson: (name: string) => void;
  readonly onPopDetail: () => void;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onPlay: (target: PlayTarget) => void;
  readonly onOpenMultiView?: (target: PlayTarget) => void;
  readonly onOpenPopout?: (target: PlayTarget) => void;
  readonly onSelectTab: (tab: AppTab, focusContent?: boolean) => void;
  readonly onOpenSources: () => void;
  readonly onOpenGuideManagement: (sourceId: string) => void;
  readonly onRefreshCatalogNow?: () => Promise<void> | void;
  readonly onRefreshGuideNow?: () => Promise<void> | void;
  readonly onClearRecentChannels?: () => Promise<void> | void;
  readonly updater?: DesktopUpdaterPort;
  readonly onTelemetryOptInChange?: (enabled: boolean) => void;
  readonly onRegisterStopPreview?: (stop: (() => Promise<void>) | null) => void;
  readonly suppressEmbeddedPreview?: boolean;
  readonly onChannelsMutated: () => void;
  readonly onFavoritesMutated?: () => void;
  readonly reminderVersion?: number;
  readonly onReminderChanged?: () => void;
  readonly onScrollTopChange: (scrolled: boolean) => void;
  readonly onFocusTopNav: () => void;
  readonly waveF9?: WaveF9Controller;
}

/** Active content stage inside {@link AppShell} (boot, Detail, Settings, Search, Downloads, Home, Movies/Series, Live). */
export function AppShellStage(p: AppShellStageProps): ReactElement {
  const downloads = useDownloads();
  const handleStagePlay = useCallback(
    (target: PlayTarget) => {
      if (target.kind === 'vod' && target.isLocalOffline !== true) {
        const localUri = downloads.getOfflineUri(target.itemKey);
        if (localUri !== null) {
          p.onPlay({ ...target, isLocalOffline: true, localFileUri: localUri });
          return;
        }
      }
      p.onPlay(target);
    },
    [downloads.getOfflineUri, p.onPlay],
  );
  const stageProps = {
    catalog: p.catalog,
    refreshToken: p.effectiveRefreshToken,
    onFocusTopNav: p.onFocusTopNav,
    isActiveScope: p.isActiveScope,
  };

  if (p.isResolvingInitialSources) {
    return (
      <View testID="app-shell-boot" style={styles.bootCanvas}>
        {p.isTv && !p.topNavFocused ? <TvFocusAnchor testID="app-shell-boot-focus-anchor" /> : null}
      </View>
    );
  }

  if (p.activeDetail !== null) {
    return (
      <DetailScreen
        key={`${p.activeDetail.itemKey}:${p.contentIsolationKey}`}
        target={p.activeDetail}
        videoHost={p.videoHost}
        {...(p.trailerExternal !== undefined ? { trailerExternal: p.trailerExternal } : {})}
        userStateVersion={p.effectiveUserStateVersion}
        preferredAudioLang={p.preferences.preferences.preferredAudioLang}
        preferredSubtitleLang={p.preferences.preferences.preferredSubtitleLang}
        vodEnrichmentEnabled={false}
        elvPreferences={p.preferences.preferences}
        onSearchPerson={p.onSearchPerson}
        onBack={p.onPopDetail}
        onPlay={handleStagePlay}
        onOpenDetail={p.onOpenDetail}
        onScrollTopChange={p.onScrollTopChange}
        {...stageProps}
      />
    );
  }

  if (p.activeTab === 'settings') {
    return (
      <SettingsScreen
        section={p.settingsSection}
        onSectionChange={p.onSettingsSectionChange}
        preferences={p.preferences}
        onFocusTopNav={p.onFocusTopNav}
        isActiveScope={p.isActiveScope}
        hasTransientOverlay={p.hasTransientOverlay}
        onOpenGuideManagement={p.onOpenGuideManagement}
        {...(p.onRefreshCatalogNow !== undefined
          ? { onRefreshCatalogNow: p.onRefreshCatalogNow }
          : {})}
        {...(p.onRefreshGuideNow !== undefined ? { onRefreshGuideNow: p.onRefreshGuideNow } : {})}
        {...(p.onClearRecentChannels !== undefined
          ? { onClearRecentChannels: p.onClearRecentChannels }
          : {})}
        {...(p.updater !== undefined ? { updater: p.updater } : {})}
        {...(p.onTelemetryOptInChange !== undefined
          ? { onTelemetryOptInChange: p.onTelemetryOptInChange }
          : {})}
        renderProfiles={(slot) => (
          <ProfilesAndParentalPanel
            catalog={p.catalog}
            sources={p.allSources ?? p.sources}
            {...slot}
          />
        )}
        renderSources={(slot) => (
          <SourcesScreen
            catalog={p.catalog}
            embedded
            playbackGuard={p.playbackGuard}
            {...(p.catalog.listGuideSources !== undefined
              ? { onOpenGuideManagement: p.onOpenGuideManagement }
              : {})}
            {...(p.sourceImportHost !== undefined ? { sourceImportHost: p.sourceImportHost } : {})}
            {...(p.lanPairing !== undefined ? { lanPairing: p.lanPairing } : {})}
            {...(p.incomingLocalPlaylist !== null
              ? {
                  incomingLocalPlaylist: p.incomingLocalPlaylist,
                  onConsumeIncomingLocalPlaylist: p.onConsumeIncomingLocalPlaylist,
                }
              : {})}
            externalRefreshToken={p.externalRefreshToken + p.refreshToken}
            {...slot}
          />
        )}
        {...(p.waveF9 !== undefined
          ? { renderAccount: p.waveF9.renderAccount, renderFeedback: p.waveF9.renderFeedback }
          : {})}
        renderLicenses={(slot) => <ThirdPartyNoticesScreen embedded {...slot} />}
      />
    );
  }

  if (p.activeTab === 'search') {
    return (
      <SearchScreen
        key={p.contentIsolationKey}
        userStateVersion={p.effectiveUserStateVersion}
        initialQuery={p.searchQuery}
        onQueryChange={p.onSearchQueryChange}
        initialScope={p.searchScope}
        onScopeChange={p.onSearchScopeChange}
        recentSearches={p.recentSearches}
        onRecentSearchesChange={p.onRecentSearchesChange}
        elvPreferences={p.preferences.preferences}
        onPlay={handleStagePlay}
        onOpenDetail={p.onOpenDetail}
        {...stageProps}
      />
    );
  }

  if (p.activeTab === 'library') {
    return (
      <LibraryScreen
        key={p.contentIsolationKey}
        sources={p.sources}
        userStateVersion={p.effectiveUserStateVersion}
        isPlaybackActive={p.suppressEmbeddedPreview === true}
        onPlay={handleStagePlay}
        onOpenDetail={p.onOpenDetail}
        {...(p.onOpenMultiView !== undefined ? { onOpenMultiView: p.onOpenMultiView } : {})}
        {...(p.onOpenPopout !== undefined ? { onOpenPopout: p.onOpenPopout } : {})}
        onOpenTab={p.onSelectTab}
        {...stageProps}
      />
    );
  }

  if (p.activeTab === 'home') {
    return (
      <HomeScreen
        key={p.contentIsolationKey}
        sources={p.sources}
        userStateVersion={p.effectiveUserStateVersion}
        homeLayout={p.preferences.preferences.homeLayout}
        elvPreferences={p.preferences.preferences}
        isPlaybackActive={p.suppressEmbeddedPreview === true}
        onPlay={handleStagePlay}
        {...(p.onOpenMultiView !== undefined ? { onOpenMultiView: p.onOpenMultiView } : {})}
        {...(p.onOpenPopout !== undefined ? { onOpenPopout: p.onOpenPopout } : {})}
        onOpenTab={p.onSelectTab}
        onOpenDetail={p.onOpenDetail}
        onOpenSources={p.onOpenSources}
        onScrollTopChange={p.onScrollTopChange}
        {...stageProps}
      />
    );
  }

  if (p.activeTab === 'movie' || p.activeTab === 'series') {
    return (
      <CatalogDiscoveryScreen
        key={`${p.activeTab}:${p.contentIsolationKey}`}
        kind={p.activeTab}
        sources={p.sources}
        userStateVersion={p.effectiveUserStateVersion}
        groupVersions={p.activeTab === 'movie' ? p.preferences.preferences.groupVodVersions : false}
        elvPreferences={p.preferences.preferences}
        memory={p.catalogMemoryByTab[p.activeTab]}
        onMemoryChange={p.activeTab === 'movie' ? p.onMovieMemoryChange : p.onSeriesMemoryChange}
        onPlay={handleStagePlay}
        onOpenDetail={p.onOpenDetail}
        onOpenSources={p.onOpenSources}
        {...stageProps}
      />
    );
  }

  const elvLiveActive = isElvFeatureActive(p.preferences.preferences, 'elvLiveEnhance');
  return (
    <LiveScreen
      key={p.contentIsolationKey}
      sources={p.sources}
      userStateVersion={p.effectiveUserStateVersion}
      memory={p.liveMemory}
      onMemoryChange={p.onLiveMemoryChange}
      videoHost={p.videoHost}
      playbackGuard={p.playbackGuard}
      defaultLiveMode={p.preferences.preferences.defaultLiveMode}
      epgTimeSpanHours={p.preferences.preferences.epgTimeSpanHours}
      epgRowDensity={p.preferences.preferences.epgRowDensity}
      epgGenreTints={false}
      epgShowClock={p.preferences.preferences.epgShowClock}
      logoBackdropMode="off"
      showSourceBadges={true}
      liveOkTwoStepPreview={false}
      cleanChannelTitles={elvLiveActive}
      collapseVariants={elvLiveActive}
      onEmbeddedPlaybackActiveChange={p.onEmbeddedPlaybackActiveChange}
      {...(p.onRegisterStopPreview !== undefined
        ? { onRegisterStopPreview: p.onRegisterStopPreview }
        : {})}
      {...(p.suppressEmbeddedPreview ? { suppressEmbeddedPreview: true } : {})}
      onPlay={p.onPlay}
      {...(p.onOpenMultiView !== undefined ? { onOpenMultiView: p.onOpenMultiView } : {})}
      {...(p.onOpenPopout !== undefined ? { onOpenPopout: p.onOpenPopout } : {})}
      onOpenSources={p.onOpenSources}
      onOpenSearch={() => p.onSelectTab('search', true)}
      onOpenHome={() => p.onSelectTab('home', true)}
      onChannelsMutated={p.onChannelsMutated}
      {...(p.onFavoritesMutated !== undefined ? { onFavoritesMutated: p.onFavoritesMutated } : {})}
      {...(p.reminderVersion !== undefined ? { reminderVersion: p.reminderVersion } : {})}
      {...(p.onReminderChanged !== undefined ? { onReminderChanged: p.onReminderChanged } : {})}
      {...stageProps}
    />
  );
}

/** Manages the 2-step root Back-to-exit confirmation guard and toast visibility (`#55`). */
export function useShellExitBackGuard(
  confirmExitOnBack: boolean,
  active: boolean,
): {
  readonly exitToastVisible: boolean;
  readonly resetExitGuard: () => void;
  readonly onRootHomeBack: () => boolean;
} {
  const confirmRef = useRef(confirmExitOnBack);
  confirmRef.current = confirmExitOnBack;
  const [exitToastVisible, setExitToastVisible] = useState(false);
  const guardRef = useRef<ExitBackConfirmGuard | null>(null);
  guardRef.current ??= createExitBackConfirmGuard(DEFAULT_EXIT_BACK_CONFIRM_MS, {
    onVisibleChange: setExitToastVisible,
  });
  useEffect(() => () => guardRef.current?.dispose(), []);
  useEffect(() => {
    if (!confirmExitOnBack || !active) guardRef.current?.reset();
  }, [active, confirmExitOnBack]);
  const resetExitGuard = useCallback(() => {
    guardRef.current?.reset();
  }, []);
  const onRootHomeBack = useCallback(
    () => guardRef.current?.onRootBack(confirmRef.current) ?? false,
    [],
  );
  return { exitToastVisible, resetExitGuard, onRootHomeBack };
}

/** Keeps the Live tab's default view mode synchronized with preferences until overridden by the user. */
export function useShellLiveTabMemory(
  defaultLiveMode: LiveTabMemory['mode'],
  activeTab: AppTab,
): {
  readonly liveMemory: LiveTabMemory;
  readonly setLiveMemory: Dispatch<SetStateAction<LiveTabMemory>>;
  readonly handleLiveMemoryChange: (next: LiveTabMemory) => void;
  readonly resetLiveMemory: () => void;
} {
  const userPickedRef = useRef(false);
  const prevDefaultRef = useRef(defaultLiveMode);
  const defaultRef = useRef(defaultLiveMode);
  defaultRef.current = defaultLiveMode;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const [liveMemory, setLiveMemory] = useState<LiveTabMemory>(() => ({
    ...EMPTY_LIVE_MEMORY,
    mode: defaultLiveMode,
  }));
  useEffect(() => {
    if (prevDefaultRef.current === defaultLiveMode) return;
    prevDefaultRef.current = defaultLiveMode;
    if (!userPickedRef.current || activeTabRef.current !== 'live') {
      userPickedRef.current = false;
      setLiveMemory((prev) =>
        prev.mode === defaultLiveMode ? prev : { ...prev, mode: defaultLiveMode },
      );
    }
  }, [defaultLiveMode]);
  const handleLiveMemoryChange = useCallback((next: LiveTabMemory) => {
    setLiveMemory((prev) => {
      if (next.mode !== prev.mode) userPickedRef.current = true;
      return next;
    });
  }, []);
  const resetLiveMemory = useCallback(() => {
    userPickedRef.current = false;
    setLiveMemory({ ...EMPTY_LIVE_MEMORY, mode: defaultRef.current });
  }, []);
  return { liveMemory, setLiveMemory, handleLiveMemoryChange, resetLiveMemory };
}

/** Syncs the persisted artwork cache byte cap preference into the active platform UI adapter (`#405`). */
export function useShellArtworkCacheLimit(artworkCacheLimitMb: number): void {
  const uiAdapters = useUiAdapters();
  useEffect(() => {
    const setLimitBytes = uiAdapters.artworkCache?.setLimitBytes;
    if (setLimitBytes === undefined) return;
    void Promise.resolve(setLimitBytes(artworkCacheLimitMb * 1024 * 1024)).catch(() => undefined);
  }, [artworkCacheLimitMb, uiAdapters.artworkCache]);
}

/** Subscribes to OS-launched local `.m3u`/`.m3u8` playlist files and stages them into Sources (`#259`). */
export function useShellIncomingLocalPlaylist(params: {
  readonly sourceImportHost?: SourceImportHost;
  readonly onIncomingFile: () => void;
}): {
  readonly incomingLocalPlaylist: PickedPlaylistFile | null;
  readonly consumeIncomingLocalPlaylist: () => void;
} {
  const { sourceImportHost, onIncomingFile } = params;
  const [incomingLocalPlaylist, setIncomingLocalPlaylist] = useState<PickedPlaylistFile | null>(
    null,
  );
  const onIncomingRef = useRef(onIncomingFile);
  onIncomingRef.current = onIncomingFile;
  const incomingRef = useRef<PickedPlaylistFile | null>(null);
  incomingRef.current = incomingLocalPlaylist;
  const ackRef = useRef(sourceImportHost?.ackPlaylistFile);
  ackRef.current = sourceImportHost?.ackPlaylistFile;

  const ackDelivery = useCallback((file: PickedPlaylistFile | null | undefined) => {
    const id = file?.deliveryId;
    if (typeof id === 'string' && id.length > 0) {
      void Promise.resolve(ackRef.current?.(id)).catch(() => undefined);
    }
  }, []);

  const consumeIncomingLocalPlaylist = useCallback(() => {
    const current = incomingRef.current;
    incomingRef.current = null;
    setIncomingLocalPlaylist(null);
    ackDelivery(current);
  }, [ackDelivery]);

  const handleFile = useCallback(
    (file: PickedPlaylistFile) => {
      if (incomingRef.current && incomingRef.current.deliveryId !== file.deliveryId) {
        ackDelivery(incomingRef.current);
      }
      onIncomingRef.current();
      incomingRef.current = file;
      setIncomingLocalPlaylist(file);
    },
    [ackDelivery],
  );

  useEffect(() => {
    let active = true;
    const unsubscribe = sourceImportHost?.onOpenPlaylistFile?.((file) => {
      if (active) handleFile(file);
    });
    const consumePending = sourceImportHost?.consumePendingPlaylistFiles;
    if (consumePending !== undefined) {
      void Promise.resolve(consumePending())
        .then((pending) => {
          if (!active || pending.length === 0) return;
          for (let i = 0; i < pending.length - 1; i += 1) {
            ackDelivery(pending[i]);
          }
          const latest = pending[pending.length - 1];
          if (latest !== undefined) handleFile(latest);
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [ackDelivery, handleFile, sourceImportHost]);

  return { incomingLocalPlaylist, consumeIncomingLocalPlaylist };
}

/** Cinema Quietude 2-step Back-to-exit toast pill (`#55`). */
export function AppShellExitToast({ visible }: { readonly visible: boolean }): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  if (!visible) return null;

  return (
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
  );
}

/** Composes the shell-level reactive providers (`RouteActive`, UI cache, focus memory, downloads). */
export function AppShellContextProviders({
  routeActive,
  uiCache,
  focusMemory,
  downloadManager,
  catalog,
  profileId,
  children,
}: {
  readonly routeActive: boolean;
  readonly uiCache: CatalogUiCache;
  readonly focusMemory: BrowseFocusMemory;
  readonly downloadManager?: DownloadManagerPort;
  readonly catalog: CatalogService;
  readonly profileId: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <RouteActiveProvider active={routeActive}>
      <CatalogUiCacheProvider cache={uiCache}>
        <BrowseFocusMemoryProvider memory={focusMemory}>
          <DownloadsProvider
            {...(downloadManager !== undefined ? { manager: downloadManager } : {})}
            catalog={catalog}
            profileId={profileId}
          >
            {children}
          </DownloadsProvider>
        </BrowseFocusMemoryProvider>
      </CatalogUiCacheProvider>
    </RouteActiveProvider>
  );
}

const styles = StyleSheet.create({
  bootCanvas: { flex: 1 },
  exitToastWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  exitToastPill: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderWidth: 1,
  },
});
