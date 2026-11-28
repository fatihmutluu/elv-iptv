import type { CatalogService } from '@elv/data';
import type { ElvModePreferences } from '@elv/domain';
import type { AppI18n } from '@elv/i18n';
import { type SafeHoverBridgeResult, useSafeHoverBridge, useViewport } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { usePlayDeepLinkHandler } from './app-shell-deep-link';
import { AppShellOnboardingOverlays, type useAppShellOnboarding } from './app-shell-onboarding';
import {
  buildShellProfileUtility,
  selectProfileWithPinGate,
  type useShellManagementOverlays,
} from './app-shell-overlays';
import { useProgrammeReminders } from './app-shell-reminders';
import {
  type AppTab,
  buildShellNavigation,
  type PrimaryNavTab,
  pushDetailStack,
} from './app-shell-state';
import { useTvHomeChannelsSync } from './app-shell-tv-channels';
import { AppShellRootOverlays, type useAppShellWaveF7b } from './app-shell-wave-f7b';
import type { WaveF9Controller } from './app-shell-wave-f9';
import type { AppShellDesktopErgonomics } from './app-shell-wave-q7';
import type { LiveTabMemory } from './live';
import type { LanPairingPort } from './ports/lan-pairing-host';
import type { PlayDeepLinkTarget } from './ports/play-deep-link';
import type { PlayTarget } from './ports/play-target';
import type { ReminderHostPort } from './ports/reminder-host';
import type { SourceImportHost } from './ports/source-import-host';
import type { TrailerExternalPort } from './ports/trailer-port';
import type { TvHomeChannelsPort } from './ports/tv-home-channels';
import type { DesktopUpdaterPort } from './ports/updater-port';
import { ProfileAvatarBadge } from './profiles';
import type { useOledScreensaver } from './screensaver';
import { SearchPopupOverlay } from './search';
import type { DetailTarget, ProfileContextValue } from './shared';
import {
  type NavDestination,
  type NavUtility,
  ProfileDropdownMenu,
  type useConnectionLimitGuard,
} from './shell';

/** Return value of {@link useShellTopOverlays}. */
export interface ShellTopOverlaysState {
  readonly searchPopupOpen: boolean;
  readonly profileMenuOpen: boolean;
  readonly profilePinnedOpen: boolean;
  readonly anyOverlayOpen: boolean;
  readonly profileStartInAdd: boolean;
  readonly consumeProfileStartInAdd: () => void;
  readonly openSearchPopup: () => void;
  readonly closeSearchPopup: () => void;
  readonly closeProfileMenu: () => void;
  readonly destinations: readonly NavDestination<PrimaryNavTab>[];
  readonly utilities: readonly NavUtility[];
  readonly hoverBridge: SafeHoverBridgeResult;
  readonly onSelectProfile: (targetId: string) => void;
  readonly onAddProfile: () => void;
  readonly onEditProfiles: () => void;
  readonly onOpenSettings: () => void;
  readonly onSignOut: () => void;
  readonly onViewAllSearch: (query: string) => void;
}

/**
 * Coordinates the Wave R1 4+3 navigation model and top navigation bar overlays
 * (`SearchPopupOverlay` and frosted `ProfileDropdownMenu`) including safe-hover desktop behavior.
 */
export function useShellTopOverlays(params: {
  readonly t: AppI18n['t'];
  readonly locale: string;
  readonly activeTab: AppTab;
  readonly hasActiveDetail: boolean;
  readonly isBrowsing: boolean;
  readonly profile: ProfileContextValue;
  readonly waveF9: Pick<WaveF9Controller, 'isAccountSignedIn' | 'signOutAccount'>;
  readonly onSelectTab: (tab: AppTab, focusContent?: boolean) => void;
  readonly onOpenProfilesSettings: () => void;
  readonly onOpenSettings: () => void;
  readonly onSearchQueryChange: (next: string) => void;
}): ShellTopOverlaysState {
  const {
    t,
    locale,
    activeTab,
    hasActiveDetail,
    isBrowsing,
    profile,
    waveF9,
    onSelectTab,
    onOpenProfilesSettings,
    onOpenSettings,
    onSearchQueryChange,
  } = params;
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';
  const isPortrait = !isTv && viewport.orientation === 'portrait';

  const [searchPopupOpen, setSearchPopupOpen] = useState(false);
  const [profilePinnedOpen, setProfilePinnedOpen] = useState(false);
  const [profileStartInAdd, setProfileStartInAdd] = useState(false);

  const hoverDisabled =
    isTv ||
    isPortrait ||
    !isBrowsing ||
    searchPopupOpen ||
    profile.profilePickerOpen ||
    profile.pinDialog !== null;

  const hoverBridge = useSafeHoverBridge({ disabled: hoverDisabled });
  const profileMenuOpen = profilePinnedOpen || hoverBridge.open;

  const closeProfileMenu = useCallback(() => {
    setProfilePinnedOpen(false);
    hoverBridge.setOpen(false);
  }, [hoverBridge]);

  const openSearchPopup = useCallback(() => {
    closeProfileMenu();
    setSearchPopupOpen(true);
  }, [closeProfileMenu]);

  const closeSearchPopup = useCallback(() => {
    setSearchPopupOpen(false);
  }, []);

  const toggleProfileMenuByClick = useCallback(() => {
    setSearchPopupOpen(false);
    if (isTv || isPortrait) {
      setProfilePinnedOpen((prev) => !prev);
      return;
    }
    if (profilePinnedOpen) {
      setProfilePinnedOpen(false);
      hoverBridge.setOpen(false);
    } else {
      setProfilePinnedOpen(true);
    }
  }, [hoverBridge, isPortrait, isTv, profilePinnedOpen]);

  useEffect(() => {
    if (!isBrowsing) {
      setSearchPopupOpen(false);
      closeProfileMenu();
    }
  }, [closeProfileMenu, isBrowsing]);

  useEffect(() => {
    if (profile.profilePickerOpen || profile.pinDialog !== null) {
      closeProfileMenu();
    }
  }, [closeProfileMenu, profile.pinDialog, profile.profilePickerOpen]);

  const consumeProfileStartInAdd = useCallback(() => setProfileStartInAdd(false), []);

  const onSelectProfile = useCallback(
    (targetId: string) => {
      closeProfileMenu();
      selectProfileWithPinGate(profile, targetId);
    },
    [closeProfileMenu, profile],
  );

  const onAddProfile = useCallback(() => {
    closeProfileMenu();
    setProfileStartInAdd(true);
    profile.openProfilePicker();
  }, [closeProfileMenu, profile]);

  const onEditProfiles = useCallback(() => {
    closeProfileMenu();
    onOpenProfilesSettings();
  }, [closeProfileMenu, onOpenProfilesSettings]);

  const onOpenSettingsFromMenu = useCallback(() => {
    closeProfileMenu();
    onOpenSettings();
  }, [closeProfileMenu, onOpenSettings]);

  const onSignOut = useCallback(() => {
    closeProfileMenu();
    if (waveF9.isAccountSignedIn) {
      void waveF9.signOutAccount();
      return;
    }
    profile.lockParentalNow();
    profile.openProfilePicker();
  }, [closeProfileMenu, profile, waveF9]);

  const onViewAllSearch = useCallback(
    (nextQuery: string) => {
      setSearchPopupOpen(false);
      onSearchQueryChange(nextQuery);
      onSelectTab('search', true);
    },
    [onSearchQueryChange, onSelectTab],
  );

  const profileUtility = useMemo(
    () =>
      buildShellProfileUtility(profile, {
        menuOpen: profileMenuOpen,
        disableTooltip: profileMenuOpen,
        triggerRef: hoverBridge.triggerRef,
        ...(hoverBridge.triggerProps.onPointerEnter !== undefined
          ? { onPointerEnter: hoverBridge.triggerProps.onPointerEnter }
          : {}),
        ...(hoverBridge.triggerProps.onPointerLeave !== undefined
          ? { onPointerLeave: hoverBridge.triggerProps.onPointerLeave }
          : {}),
        onPress: toggleProfileMenuByClick,
      }),
    [
      hoverBridge.triggerProps,
      hoverBridge.triggerRef,
      profile,
      profileMenuOpen,
      toggleProfileMenuByClick,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: locale invalidates translated labels on live language switch
  const { destinations, utilities } = useMemo(
    () =>
      buildShellNavigation({
        t,
        activeTab,
        hasActiveDetail,
        searchActive: searchPopupOpen,
        onOpenSearch: openSearchPopup,
        onOpenLibrary: () => onSelectTab('library', false),
        ...(profileUtility !== undefined ? { profileUtility } : {}),
      }),
    [
      t,
      locale,
      activeTab,
      hasActiveDetail,
      searchPopupOpen,
      openSearchPopup,
      onSelectTab,
      profileUtility,
    ],
  );

  return {
    searchPopupOpen,
    profileMenuOpen,
    profilePinnedOpen,
    anyOverlayOpen: searchPopupOpen || profileMenuOpen,
    profileStartInAdd,
    consumeProfileStartInAdd,
    openSearchPopup,
    closeSearchPopup,
    closeProfileMenu,
    destinations,
    utilities,
    hoverBridge,
    onSelectProfile,
    onAddProfile,
    onEditProfiles,
    onOpenSettings: onOpenSettingsFromMenu,
    onSignOut,
    onViewAllSearch,
  };
}

/** Root mount rendering `ProfileDropdownMenu` and `SearchPopupOverlay` over the active shell stage. */
function AppShellTopOverlays(props: {
  readonly isBrowsing: boolean;
  readonly topOverlays: ShellTopOverlaysState;
  readonly profile: ProfileContextValue;
  readonly syncAccountSignedIn: boolean;
  readonly catalog: CatalogService;
  readonly effectiveRefreshToken: number;
  readonly effectiveUserStateVersion: number;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (next: string) => void;
  readonly elvPreferences: ElvModePreferences;
  readonly onPlay: (target: PlayTarget) => void;
  readonly onOpenDetail: (target: DetailTarget) => void;
}): ReactElement | null {
  const {
    isBrowsing,
    topOverlays,
    profile,
    syncAccountSignedIn,
    catalog,
    effectiveRefreshToken,
    effectiveUserStateVersion,
    searchQuery,
    onSearchQueryChange,
    elvPreferences,
    onPlay,
    onOpenDetail,
  } = props;

  if (!isBrowsing) return null;

  return (
    <>
      <ProfileDropdownMenu
        visible={topOverlays.profileMenuOpen}
        profiles={profile.profiles}
        activeProfileId={profile.activeProfileId}
        hasGuardPin={profile.hasGuardPin}
        parentalControlsEnabled={profile.parentalSettings.enabled}
        parentalUnlocked={profile.parentalUnlocked}
        syncAccountSignedIn={syncAccountSignedIn}
        pinnedOpen={topOverlays.profilePinnedOpen}
        panelProps={topOverlays.hoverBridge.panelProps}
        panelRef={topOverlays.hoverBridge.panelRef}
        triggerRef={topOverlays.hoverBridge.triggerRef}
        renderProfileAvatar={(item, active) => (
          <ProfileAvatarBadge
            name={item.name}
            avatarToken={item.avatarToken}
            size="sm"
            isKids={item.isKids}
            active={active}
          />
        )}
        onSelectProfile={topOverlays.onSelectProfile}
        onAddProfile={topOverlays.onAddProfile}
        onEditProfiles={topOverlays.onEditProfiles}
        onOpenSettings={topOverlays.onOpenSettings}
        onSignOut={topOverlays.onSignOut}
        onClose={topOverlays.closeProfileMenu}
      />

      <SearchPopupOverlay
        visible={topOverlays.searchPopupOpen}
        catalog={catalog}
        refreshToken={effectiveRefreshToken}
        userStateVersion={effectiveUserStateVersion}
        query={searchQuery}
        onQueryChange={onSearchQueryChange}
        elvPreferences={elvPreferences}
        onPlay={onPlay}
        onOpenDetail={onOpenDetail}
        onViewAll={topOverlays.onViewAllSearch}
        onClose={topOverlays.closeSearchPopup}
      />
    </>
  );
}

/** Combined root & top-bar overlay stack rendered inside `AppShell` outside the stage `<AdaptiveNavShell>`. */
export function AppShellAllOverlays(props: {
  readonly isBrowsing: boolean;
  readonly exitToastVisible: boolean;
  readonly topOverlays: ShellTopOverlaysState;
  readonly profile: ProfileContextValue;
  readonly catalog: CatalogService;
  readonly effectiveRefreshToken: number;
  readonly effectiveUserStateVersion: number;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (next: string) => void;
  readonly elvPreferences: ElvModePreferences;
  readonly onPlay: (target: PlayTarget) => void;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly connectionGuard: ReturnType<typeof useConnectionLimitGuard>;
  readonly mgmtOverlays: ReturnType<typeof useShellManagementOverlays>;
  readonly onChannelsMutated: () => void;
  readonly onOpenProfilesSettings: () => void;
  readonly reminders: ReturnType<typeof useProgrammeReminders>;
  readonly oledScreensaver: ReturnType<typeof useOledScreensaver>;
  readonly wave: ReturnType<typeof useAppShellWaveF7b>;
  readonly waveF9: WaveF9Controller;
  readonly desktopErgonomics: AppShellDesktopErgonomics;
  readonly onboarding: ReturnType<typeof useAppShellOnboarding>;
}): ReactElement {
  return (
    <>
      <AppShellTopOverlays
        isBrowsing={props.isBrowsing}
        topOverlays={props.topOverlays}
        profile={props.profile}
        syncAccountSignedIn={props.waveF9.isAccountSignedIn}
        catalog={props.catalog}
        effectiveRefreshToken={props.effectiveRefreshToken}
        effectiveUserStateVersion={props.effectiveUserStateVersion}
        searchQuery={props.searchQuery}
        onSearchQueryChange={props.onSearchQueryChange}
        elvPreferences={props.elvPreferences}
        onPlay={props.onPlay}
        onOpenDetail={props.onOpenDetail}
      />
      <AppShellRootOverlays
        exitToastVisible={props.exitToastVisible && props.isBrowsing}
        connectionGuard={props.connectionGuard}
        mgmtOverlays={props.mgmtOverlays}
        catalog={props.catalog}
        onChannelsMutated={props.onChannelsMutated}
        onOpenProfilesSettings={props.onOpenProfilesSettings}
        profileStartInAdd={props.topOverlays.profileStartInAdd}
        onConsumeProfileStartInAdd={props.topOverlays.consumeProfileStartInAdd}
        reminders={props.reminders}
        oledScreensaver={props.oledScreensaver}
        wave={props.wave}
        waveF9={props.waveF9}
        desktopErgonomics={props.desktopErgonomics}
      />
      <AppShellOnboardingOverlays onboarding={props.onboarding} />
    </>
  );
}

/** Coordinates platform reminder timers, Android TV Home channels sync, and play deep links for `AppShell`. */
export function useShellPlatformBridges(params: {
  readonly t: AppI18n['t'];
  readonly locale: string;
  readonly catalog: CatalogService;
  readonly profile: ProfileContextValue;
  readonly catalogRevision: number;
  readonly userStateVersion: number;
  readonly reminderVersion: number;
  readonly visibleSourceIds: readonly string[];
  readonly onTuneReminder: (target: PlayTarget) => void;
  readonly onPlay: (target: PlayTarget) => void;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly reminderHost?: ReminderHostPort;
  readonly tvHomeChannels?: TvHomeChannelsPort;
  readonly pendingDeepLink?: PlayDeepLinkTarget | null;
  readonly onDeepLinkHandled?: () => void;
}) {
  const {
    t,
    locale,
    catalog,
    profile,
    catalogRevision,
    userStateVersion,
    reminderVersion,
    visibleSourceIds,
    onTuneReminder,
    onPlay,
    onOpenDetail,
    reminderHost,
    tvHomeChannels,
    pendingDeepLink,
    onDeepLinkHandled,
  } = params;

  // biome-ignore lint/correctness/useExhaustiveDependencies: locale updates translated reminder timing text on live language switch
  const formatReminderTimingText = useCallback(
    (m: number) =>
      m <= 0 ? t('epg.reminderStartingNow') : t('epg.reminderStartsIn', { minutes: m }),
    [t, locale],
  );
  const reminders = useProgrammeReminders({
    catalog,
    activeProfileId: profile.activeProfileId,
    parentalUnlocked: profile.parentalUnlocked,
    profileRevision: profile.profileRevision,
    catalogRevision,
    reminderVersion,
    onTuneChannel: onTuneReminder,
    formatTimingText: formatReminderTimingText,
    ...(reminderHost !== undefined ? { reminderHost } : {}),
  });

  const tvHomeChannelsSyncKey = `${profile.activeProfileId}:${profile.profileRevision}:${catalogRevision}:${userStateVersion}:${locale}:${visibleSourceIds.join(',')}`;
  useTvHomeChannelsSync({
    catalog,
    ...(tvHomeChannels !== undefined ? { tvHomeChannels } : {}),
    profilesReady: profile.profilesReady,
    syncKey: tvHomeChannelsSyncKey,
    continueWatchingLabel: t('tvHomeChannels.continueWatching'),
    favoritesLabel: t('tvHomeChannels.favorites'),
  });

  usePlayDeepLinkHandler({
    catalog,
    profile,
    pendingDeepLink: pendingDeepLink ?? null,
    onPlay,
    onOpenDetail,
    ...(onDeepLinkHandled !== undefined ? { onDeepLinkHandled } : {}),
  });

  return { reminders };
}

/** Builds optional platform/discovery props passed from `AppShell` to `AppShellStage`. */
export function buildShellStageOptionalProps(input: {
  readonly sourceImportHost?: SourceImportHost;
  readonly lanPairing?: LanPairingPort;
  readonly trailerExternal?: TrailerExternalPort;
  readonly updater?: DesktopUpdaterPort;
  readonly hasClearRecentChannels: boolean;
  readonly onClearRecentChannels: () => Promise<void>;
  readonly onTelemetryOptInChange: (enabled: boolean) => void;
}) {
  return {
    ...(input.sourceImportHost !== undefined ? { sourceImportHost: input.sourceImportHost } : {}),
    ...(input.lanPairing !== undefined ? { lanPairing: input.lanPairing } : {}),
    ...(input.trailerExternal !== undefined ? { trailerExternal: input.trailerExternal } : {}),
    ...(input.updater !== undefined ? { updater: input.updater } : {}),
    ...(input.hasClearRecentChannels ? { onClearRecentChannels: input.onClearRecentChannels } : {}),
    onTelemetryOptInChange: input.onTelemetryOptInChange,
  };
}

/** Creates stable shell navigation, detail-stack, and settings-section callbacks for `AppShell`. */
export function useShellStageNavHandlers(params: {
  readonly sourcesRef: { readonly current: readonly import('@elv/data').SourceRow[] };
  readonly resetExitGuardRef: { readonly current: () => void };
  readonly userPickedTabRef: { current: boolean };
  readonly userPickedSettingsSectionRef: { current: boolean };
  readonly playTargetRef: { current: PlayTarget | null };
  readonly releaseConnection: () => void;
  readonly setPlayTarget: (next: PlayTarget | null) => void;
  readonly setUserPickedTab: (next: boolean) => void;
  readonly setActiveTab: (next: AppTab) => void;
  readonly setSettingsSection: (next: import('./settings').SettingsSection) => void;
  readonly setDetailStack: (
    updater: readonly DetailTarget[] | ((prev: readonly DetailTarget[]) => readonly DetailTarget[]),
  ) => void;
  readonly setHeroScrolled: (next: boolean) => void;
  readonly setTopNavFocused: (next: boolean) => void;
  readonly setUserStateVersion: (updater: (prev: number) => number) => void;
  readonly setSearchQuery: (next: string) => void;
  readonly setSearchScope: (next: import('@elv/data').SearchScope) => void;
}) {
  const {
    sourcesRef,
    resetExitGuardRef,
    userPickedTabRef,
    userPickedSettingsSectionRef,
    playTargetRef,
    releaseConnection,
    setPlayTarget,
    setUserPickedTab,
    setActiveTab,
    setSettingsSection,
    setDetailStack,
    setHeroScrolled,
    setTopNavFocused,
    setUserStateVersion,
    setSearchQuery,
    setSearchScope,
  } = params;

  const selectTab = useCallback(
    (tab: AppTab, focusContent = true) => {
      resetExitGuardRef.current();
      userPickedTabRef.current = true;
      setUserPickedTab(true);
      setActiveTab(tab);
      setDetailStack([]);
      setHeroScrolled(false);
      if (focusContent) setTopNavFocused(false);
    },
    [
      resetExitGuardRef,
      setActiveTab,
      setDetailStack,
      setHeroScrolled,
      setTopNavFocused,
      setUserPickedTab,
      userPickedTabRef,
    ],
  );

  const handleSettingsSectionChange = useCallback(
    (next: import('./settings').SettingsSection) => {
      userPickedSettingsSectionRef.current = true;
      setSettingsSection(next);
    },
    [setSettingsSection, userPickedSettingsSectionRef],
  );

  const openSettings = useCallback(() => {
    if (sourcesRef.current.length > 0 && !userPickedSettingsSectionRef.current) {
      setSettingsSection('appearance');
    }
    selectTab('settings', true);
  }, [selectTab, setSettingsSection, sourcesRef, userPickedSettingsSectionRef]);

  const openSettingsSection = useCallback(
    (section: import('./settings').SettingsSection) => {
      userPickedSettingsSectionRef.current = true;
      setSettingsSection(section);
      selectTab('settings', true);
    },
    [selectTab, setSettingsSection, userPickedSettingsSectionRef],
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
      releaseConnection();
      playTargetRef.current = null;
      setPlayTarget(null);
    }
    openSources();
  }, [openSources, playTargetRef, releaseConnection, setPlayTarget]);

  const openDetail = useCallback(
    (target: DetailTarget) => {
      resetExitGuardRef.current();
      setDetailStack((prev) => pushDetailStack(prev, target));
      setHeroScrolled(false);
      setTopNavFocused(false);
    },
    [resetExitGuardRef, setDetailStack, setHeroScrolled, setTopNavFocused],
  );

  const popDetail = useCallback(() => {
    setDetailStack((prev) => prev.slice(0, -1));
    setHeroScrolled(false);
    setUserStateVersion((v) => v + 1);
  }, [setDetailStack, setHeroScrolled, setUserStateVersion]);

  const handleSearchPerson = useCallback(
    (personName: string) => {
      const trimmed = personName.trim();
      if (trimmed.length === 0) return;
      setSearchQuery(trimmed);
      setSearchScope('all');
      selectTab('search', true);
    },
    [selectTab, setSearchQuery, setSearchScope],
  );

  return {
    selectTab,
    handleSettingsSectionChange,
    openSettings,
    openSettingsSection,
    openSources,
    openProfilesSettings,
    openAccountSettings,
    handlePrepareIncomingLocalPlaylist,
    openDetail,
    popDetail,
    handleSearchPerson,
  };
}

/** Handles `onPlayerExit` live-channel memory preservation and state reset cleanly outside `AppShell.tsx`. */
export function createShellPlayerExitHandler(params: {
  readonly playTargetRef: { current: PlayTarget | null };
  readonly setPlayTarget: (next: PlayTarget | null) => void;
  readonly setLiveMemory: (updater: (prev: LiveTabMemory) => LiveTabMemory) => void;
  readonly recordTune: (prev: LiveTabMemory, key: string) => Partial<LiveTabMemory>;
  readonly releaseConnection: () => void;
  readonly resetToFullMode: (clearAdoption?: boolean) => void;
  readonly setHeroScrolled: (next: boolean) => void;
  readonly bumpUserState: () => void;
  readonly notifyPlaybackExitOrSwitch: () => void;
}): () => void {
  return () => {
    const exiting = params.playTargetRef.current;
    if (exiting?.kind === 'live') {
      params.setLiveMemory((p) => ({
        ...p,
        ...params.recordTune(p, exiting.itemKey),
        ...(exiting.previousChannel ? { previousChannelKey: exiting.previousChannel.itemKey } : {}),
      }));
    }
    params.releaseConnection();
    params.playTargetRef.current = null;
    params.setPlayTarget(null);
    params.resetToFullMode(true);
    params.setHeroScrolled(false);
    params.bumpUserState();
    params.notifyPlaybackExitOrSwitch();
  };
}
