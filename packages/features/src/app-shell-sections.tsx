import type { CatalogService, SearchScope, SourceRow } from '@elv/data';
import {
  TvFocusAnchor,
  useI18n,
  useTheme,
  useUiAdapters,
  useViewport,
  webBackdropBlur,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { AppTab, CatalogMemoryMap } from './app-shell-state';
import type { WaveF9Controller } from './app-shell-wave-f9';
import { CatalogDiscoveryScreen, type CatalogTabMemory } from './catalog';
import { DetailScreen } from './detail';
import { HomeScreen } from './home';
import { LiveScreen, type LiveTabMemory } from './live';
import { ThirdPartyNoticesScreen } from './notices';
import type { LanPairingPort } from './ports/lan-pairing-host';
import type { PlayTarget } from './ports/play-target';
import type { PlaybackGuard } from './ports/playback-guard';
import type { PickedPlaylistFile, SourceImportHost } from './ports/source-import-host';
import type { VideoHost } from './ports/video-host';
import { ProfilesAndParentalPanel } from './profiles';
import { SearchScreen } from './search';
import { SettingsScreen, type SettingsSection } from './settings';
import type { DetailTarget } from './shared';
import type { PreferencesContextValue } from './shell';
import { SourcesScreen } from './sources';

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
  readonly readySourcesCount: number;
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
  readonly onSelectTab: (tab: AppTab, focusContent?: boolean) => void;
  readonly onOpenSources: () => void;
  readonly onOpenChannelManagement: () => void;
  readonly onOpenGuideManagement: (sourceId: string) => void;
  readonly onPreviewDiagnostics?: () => void;
  readonly onRegisterStopPreview?: (stop: (() => Promise<void>) | null) => void;
  readonly suppressEmbeddedPreview?: boolean;
  readonly onChannelsMutated: () => void;
  readonly reminderVersion?: number;
  readonly onReminderChanged?: () => void;
  readonly onScrollTopChange: (scrolled: boolean) => void;
  readonly onFocusTopNav: () => void;
  readonly waveF9?: WaveF9Controller;
}

/** Active content stage inside {@link AppShell} (boot, Detail, Settings, Search, Home, Movies/Series, Live). */
export function AppShellStage(p: AppShellStageProps): ReactElement {
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
        userStateVersion={p.effectiveUserStateVersion}
        preferredAudioLang={p.preferences.preferences.preferredAudioLang}
        preferredSubtitleLang={p.preferences.preferences.preferredSubtitleLang}
        vodEnrichmentEnabled={p.preferences.preferences.vodEnrichmentEnabled}
        onSearchPerson={p.onSearchPerson}
        onBack={p.onPopDetail}
        onPlay={p.onPlay}
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
        onOpenChannelManagement={p.onOpenChannelManagement}
        onOpenGuideManagement={p.onOpenGuideManagement}
        {...(p.onPreviewDiagnostics !== undefined
          ? { onPreviewDiagnostics: p.onPreviewDiagnostics }
          : {})}
        renderProfiles={(slot) => (
          <ProfilesAndParentalPanel catalog={p.catalog} sources={p.sources} {...slot} />
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
            {...(p.readySourcesCount > 0 ? { onOpenMenu: () => p.onSelectTab('home') } : {})}
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
        onPlay={p.onPlay}
        onOpenDetail={p.onOpenDetail}
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
        onPlay={p.onPlay}
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
        memory={p.catalogMemoryByTab[p.activeTab]}
        onMemoryChange={p.activeTab === 'movie' ? p.onMovieMemoryChange : p.onSeriesMemoryChange}
        onPlay={p.onPlay}
        onOpenDetail={p.onOpenDetail}
        onOpenSources={p.onOpenSources}
        {...stageProps}
      />
    );
  }

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
      epgGenreTints={p.preferences.preferences.epgGenreTints}
      epgShowClock={p.preferences.preferences.epgShowClock}
      logoBackdropMode={p.preferences.preferences.logoBackdropMode}
      showSourceBadges={p.preferences.preferences.showSourceBadges}
      liveOkTwoStepPreview={p.preferences.preferences.liveOkTwoStepPreview}
      cleanChannelTitles={p.preferences.preferences.cleanChannelTitles}
      collapseVariants={p.preferences.preferences.collapseLiveVariants}
      onEmbeddedPlaybackActiveChange={p.onEmbeddedPlaybackActiveChange}
      {...(p.onRegisterStopPreview !== undefined
        ? { onRegisterStopPreview: p.onRegisterStopPreview }
        : {})}
      {...(p.suppressEmbeddedPreview ? { suppressEmbeddedPreview: true } : {})}
      onPlay={p.onPlay}
      onOpenSources={p.onOpenSources}
      onOpenSearch={() => p.onSelectTab('search', true)}
      onOpenHome={() => p.onSelectTab('home', true)}
      onChannelsMutated={p.onChannelsMutated}
      {...(p.reminderVersion !== undefined ? { reminderVersion: p.reminderVersion } : {})}
      {...(p.onReminderChanged !== undefined ? { onReminderChanged: p.onReminderChanged } : {})}
      {...stageProps}
    />
  );
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

  const consumeIncomingLocalPlaylist = useCallback(() => {
    setIncomingLocalPlaylist(null);
  }, []);

  const handleFile = useCallback((file: PickedPlaylistFile) => {
    onIncomingRef.current();
    setIncomingLocalPlaylist(file);
  }, []);

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
          const latest = pending[pending.length - 1];
          if (latest !== undefined) handleFile(latest);
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [handleFile, sourceImportHost]);

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
