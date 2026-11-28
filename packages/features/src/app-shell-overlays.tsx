import type { CatalogService, SourceRow } from '@elv/data';
import {
  type MutableRefObject,
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createObservedCatalog } from './app-shell-state';
import { targetIdentityKey } from './player/live-timeshift-model';
import type { PlayTarget } from './ports/play-target';
import type { PlaybackGuard } from './ports/playback-guard';
import { PinEntryOverlay, ProfileAvatarBadge, ProfilePickerOverlay } from './profiles';
import {
  createProfileScopedCatalog,
  filterSourcesForProfile,
  type ProfileCatalogScope,
  type ProfileContextValue,
  useProfile,
} from './shared';
import { broadcastSessionGuardEvent } from './shared/session-guard-channel';
import type { CatalogUiCache, NavUtility } from './shell';

/** Props of {@link AppShellProfileOverlays}. */
export interface AppShellProfileOverlaysProps {
  readonly onOpenProfilesSettings: () => void;
  readonly startInAdd?: boolean;
  readonly onConsumeStartInAdd?: () => void;
}

/** Options extending {@link buildShellProfileUtility} with dropdown hover/click wiring. */
export interface ShellProfileUtilityOptions {
  readonly menuOpen?: boolean;
  readonly disableTooltip?: boolean;
  readonly triggerRef?: RefObject<unknown>;
  readonly onPointerEnter?: (event?: unknown) => void;
  readonly onPointerLeave?: (event?: unknown) => void;
  readonly onPress?: () => void;
}

/**
 * Switches to `targetId`, prompting the parental/guard PIN dialog first when switching out of
 * Kids Mode or while parental controls are locked (`#15`, `#31`).
 */
export function selectProfileWithPinGate(profile: ProfileContextValue, targetId: string): void {
  if (targetId === profile.activeProfileId || profile.parentalLoadError) {
    profile.closeProfilePicker();
    return;
  }
  const needsPinGate =
    (profile.activeProfile.isKids || profile.parentalSettings.enabled) &&
    profile.hasGuardPin &&
    !profile.parentalUnlocked;
  if (needsPinGate) {
    profile.closeProfilePicker();
    profile.openPinDialog({
      mode: 'verify',
      profileId: profile.guardPinProfileId ?? profile.activeProfileId,
      verifyOnly: true,
      onSuccess: () => {
        void profile.switchProfile(targetId);
      },
    });
    return;
  }
  void profile.switchProfile(targetId);
}

/**
 * Builds the quiet top-right profile avatar utility button opening the frosted Profile menu
 * (`UI_UX_PHILOSOPHY.md` §2.1, Wave R1).
 */
export function buildShellProfileUtility(
  profile: ProfileContextValue,
  options?: ShellProfileUtilityOptions,
): NavUtility | undefined {
  if (profile.profiles.length === 0) return undefined;
  const active = profile.activeProfile;
  return {
    id: 'profile',
    label: active.name,
    icon: 'profile',
    active: Boolean(options?.menuOpen) || profile.profilePickerOpen,
    showLabel: false,
    activateOnSelectOnly: true,
    testID: 'nav-utility-profile',
    ...(options?.disableTooltip !== undefined ? { disableTooltip: options.disableTooltip } : {}),
    ...(options?.triggerRef !== undefined ? { triggerRef: options.triggerRef } : {}),
    ...(options?.onPointerEnter !== undefined ? { onPointerEnter: options.onPointerEnter } : {}),
    ...(options?.onPointerLeave !== undefined ? { onPointerLeave: options.onPointerLeave } : {}),
    renderIcon: () => (
      <ProfileAvatarBadge
        name={active.name}
        avatarToken={active.avatarToken}
        size="sm"
        isKids={active.isKids}
        active={profile.parentalUnlocked}
        testID="nav-profile-avatar"
      />
    ),
    onPress: options?.onPress ?? profile.openProfilePicker,
  };
}

/**
 * Coordinates profile-switch cache/memory resets, active-playback safety checks on switch/relock,
 * and automatic parental re-lock on app background transitions (`#15`, `#31`).
 */
export function useShellProfileEffects(params: {
  readonly profile: ProfileContextValue;
  readonly catalog: CatalogService;
  readonly appForeground: boolean;
  readonly playTargetRef: MutableRefObject<PlayTarget | null>;
  readonly multiViewSeedRef?: MutableRefObject<PlayTarget | null>;
  readonly onResetTransientMemory: () => void;
  readonly onStopPlayback: () => void;
  readonly onCloseMultiView?: () => void;
  readonly onClosePopout?: () => void;
}): void {
  const {
    profile,
    catalog,
    appForeground,
    playTargetRef,
    multiViewSeedRef,
    onResetTransientMemory,
    onStopPlayback,
    onCloseMultiView,
    onClosePopout,
  } = params;
  const prevProfileIdRef = useRef(profile.activeProfileId);
  const prevUnlockedRef = useRef(profile.parentalUnlocked);
  const prevLoadErrorRef = useRef(profile.parentalLoadError);
  const prevForegroundRef = useRef(appForeground);
  const callbacksRef = useRef({
    onResetTransientMemory,
    onStopPlayback,
    onCloseMultiView,
    onClosePopout,
  });
  callbacksRef.current = {
    onResetTransientMemory,
    onStopPlayback,
    onCloseMultiView,
    onClosePopout,
  };

  useEffect(() => {
    const prevId = prevProfileIdRef.current;
    const prevUnlocked = prevUnlockedRef.current;
    const prevLoadError = prevLoadErrorRef.current;
    prevProfileIdRef.current = profile.activeProfileId;
    prevUnlockedRef.current = profile.parentalUnlocked;
    prevLoadErrorRef.current = profile.parentalLoadError;

    if (prevId !== profile.activeProfileId) {
      callbacksRef.current.onResetTransientMemory();
      if (playTargetRef.current !== null) {
        callbacksRef.current.onStopPlayback();
      }
      if (multiViewSeedRef?.current !== null) {
        callbacksRef.current.onCloseMultiView?.();
      }
      callbacksRef.current.onClosePopout?.();
      broadcastSessionGuardEvent({ type: 'profile-switch', profileId: profile.activeProfileId });
      return;
    }

    if (!prevLoadError && profile.parentalLoadError) {
      if (playTargetRef.current !== null) {
        callbacksRef.current.onStopPlayback();
      }
      if (multiViewSeedRef?.current !== null) {
        callbacksRef.current.onCloseMultiView?.();
      }
      callbacksRef.current.onClosePopout?.();
      broadcastSessionGuardEvent({ type: 'parental-relock', profileId: profile.activeProfileId });
      return;
    }

    if (prevUnlocked && !profile.parentalUnlocked) {
      broadcastSessionGuardEvent({ type: 'parental-relock', profileId: profile.activeProfileId });
      if (profile.parentalLoadError) {
        if (playTargetRef.current !== null) callbacksRef.current.onStopPlayback();
        if (multiViewSeedRef?.current !== null) callbacksRef.current.onCloseMultiView?.();
        callbacksRef.current.onClosePopout?.();
        return;
      }
      if (
        multiViewSeedRef?.current !== null &&
        (profile.parentalSettings?.enabled ||
          (profile.parentalLocks?.length ?? 0) > 0 ||
          profile.activeProfile?.isKids)
      ) {
        callbacksRef.current.onCloseMultiView?.();
      }
      if (playTargetRef.current !== null) {
        const playing = playTargetRef.current;
        const playingIdentity = targetIdentityKey(playing);
        const checkPromise =
          playing.catchup !== undefined && catalog.resolveCatchupStream !== undefined
            ? catalog.resolveCatchupStream(playing.itemKey, {
                startMs: playing.catchup.startMs,
                stopMs: playing.catchup.stopMs,
                ...(playing.catchup.hasArchive !== undefined
                  ? { hasArchive: playing.catchup.hasArchive }
                  : {}),
                title: playing.catchup.programmeTitle,
              })
            : catalog.resolveStream(playing.itemKey);
        void checkPromise
          .then((res) => {
            if (
              !res.ok &&
              (res.error.code === 'parental-locked' ||
                res.error.code === 'source-excluded' ||
                res.error.code === 'parental-state-unavailable') &&
              playTargetRef.current !== null &&
              targetIdentityKey(playTargetRef.current) === playingIdentity
            ) {
              callbacksRef.current.onStopPlayback();
            }
          })
          .catch(() => {
            if (
              playTargetRef.current !== null &&
              targetIdentityKey(playTargetRef.current) === playingIdentity
            ) {
              callbacksRef.current.onStopPlayback();
            }
          });
      }
    }
  }, [
    catalog,
    multiViewSeedRef,
    playTargetRef,
    profile.activeProfile?.isKids,
    profile.activeProfileId,
    profile.parentalLoadError,
    profile.parentalLocks?.length,
    profile.parentalSettings?.enabled,
    profile.parentalUnlocked,
  ]);

  useEffect(() => {
    const wasForeground = prevForegroundRef.current;
    prevForegroundRef.current = appForeground;
    if (wasForeground && !appForeground) {
      profile.lockParentalNow();
    }
  }, [appForeground, profile]);
}

/**
 * Computes profile-visible sources (`excludedProfileIds` filtered), the excluded-source ID set
 * for `ProfileCatalogScope`, and manual "Refresh now" catalog/guide callbacks for Settings -> Live TV.
 */
export function useShellSourceControls(params: {
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly sourcesRef: { readonly current: readonly SourceRow[] };
  readonly profile: ProfileContextValue;
  readonly uiCache: CatalogUiCache;
  readonly syncSourcesAndBump: () => Promise<void>;
}) {
  const { catalog, sources, sourcesRef, profile, uiCache, syncSourcesAndBump } = params;
  const visibleSources = useMemo(
    () => filterSourcesForProfile(sources, profile.activeProfileId),
    [profile.activeProfileId, sources],
  );
  const excludedSourceIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of sources) {
      if (s.excludedProfileIds?.includes(profile.activeProfileId)) set.add(s.id);
    }
    return set;
  }, [profile.activeProfileId, sources]);
  const profileScopeRef = useRef<ProfileCatalogScope>({
    profileId: profile.activeProfileId,
    parentalUnlocked: profile.parentalUnlocked,
    excludedSourceIds,
    parentalLoadError: profile.parentalLoadError,
  });
  profileScopeRef.current = {
    profileId: profile.activeProfileId,
    parentalUnlocked: profile.parentalUnlocked,
    excludedSourceIds,
    parentalLoadError: profile.parentalLoadError,
  };
  const onRefreshCatalogNow = useCallback(async () => {
    for (const s of sourcesRef.current) {
      await catalog.importSource(s.id).catch(() => undefined);
    }
    uiCache.clear();
    await syncSourcesAndBump();
  }, [catalog, sourcesRef, syncSourcesAndBump, uiCache]);
  const onRefreshGuideNow = useCallback(async () => {
    const importGuide = catalog.importGuide;
    if (importGuide === undefined) return;
    for (const s of sourcesRef.current) {
      await importGuide(s.id).catch(() => undefined);
    }
    await syncSourcesAndBump();
  }, [catalog, sourcesRef, syncSourcesAndBump]);

  return {
    visibleSources,
    profileScopeRef,
    onRefreshCatalogNow,
    onRefreshGuideNow,
  };
}

/** Composes the observed and profile-scoped `CatalogService` used across `AppShell`. */
export function useShellObservedCatalog(
  catalog: CatalogService,
  playbackGuard: PlaybackGuard,
  syncSourcesAndBump: () => Promise<void>,
  onUserStateMutated: () => void,
  profileScopeRef: { readonly current: ProfileCatalogScope },
): CatalogService {
  return useMemo(
    () =>
      createProfileScopedCatalog(
        createObservedCatalog(
          catalog,
          playbackGuard,
          syncSourcesAndBump,
          onUserStateMutated,
          () => profileScopeRef.current.profileId,
        ),
        () => profileScopeRef.current,
      ),
    [catalog, onUserStateMutated, playbackGuard, profileScopeRef, syncSourcesAndBump],
  );
}

/**
 * Coordinates root-level `GuideManagementOverlay` (`#30`) visibility with parental PIN gating (`#31`)
 * and automatic close on profile switch or relock.
 */
export function useShellManagementOverlays(
  profile: ProfileContextValue,
  sources: readonly SourceRow[],
) {
  const [guideManagerSourceId, setGuideManagerSourceId] = useState<string | null>(null);
  const prevProfileIdRef = useRef(profile.activeProfileId);

  const openGuideManager = useCallback(
    (sourceId: string) => {
      if (profile.hasGuardPin && !profile.parentalUnlocked) {
        profile.requestParentalUnlock(() => setGuideManagerSourceId(sourceId));
        return;
      }
      setGuideManagerSourceId(sourceId);
    },
    [profile],
  );

  const closeGuideManager = useCallback(() => setGuideManagerSourceId(null), []);

  useEffect(() => {
    const profileChanged = prevProfileIdRef.current !== profile.activeProfileId;
    prevProfileIdRef.current = profile.activeProfileId;
    const locked = profile.hasGuardPin && !profile.parentalUnlocked;
    if (profileChanged || locked) {
      setGuideManagerSourceId(null);
    }
  }, [profile.activeProfileId, profile.hasGuardPin, profile.parentalUnlocked]);

  const guideSource = useMemo(
    () =>
      guideManagerSourceId !== null
        ? (sources.find((s) => s.id === guideManagerSourceId) ?? null)
        : null,
    [guideManagerSourceId, sources],
  );

  return {
    guideSource,
    anyOpen: guideSource !== null,
    openGuideManager,
    closeGuideManager,
  };
}

/**
 * Root in-tree overlays rendered by `AppShell` for viewer profile switching (`#15`) and
 * PIN verification/management (`#31`). Uses zero React Native `<Modal>` instances.
 */
export function AppShellProfileOverlays({
  onOpenProfilesSettings,
  startInAdd = false,
  onConsumeStartInAdd,
}: AppShellProfileOverlaysProps): ReactElement | null {
  const profile = useProfile();
  const {
    profiles,
    activeProfileId,
    profilePickerOpen,
    pinDialog,
    verifyParentalPin,
    unlockParental,
    setParentalPin,
    clearParentalPin,
    closePinDialog,
    closeProfilePicker,
  } = profile;

  const handleSelectProfile = (targetId: string) => {
    selectProfileWithPinGate(profile, targetId);
  };

  if (!profilePickerOpen && pinDialog === null) return null;

  return (
    <>
      {profilePickerOpen ? (
        <ProfilePickerOverlay
          profiles={profiles}
          activeProfileId={activeProfileId}
          startInAdd={startInAdd}
          {...(onConsumeStartInAdd !== undefined ? { onConsumeStartInAdd } : {})}
          onSelectProfile={handleSelectProfile}
          onManageInSettings={() => {
            closeProfilePicker();
            onOpenProfilesSettings();
          }}
          onClose={closeProfilePicker}
        />
      ) : null}

      {pinDialog !== null ? (
        <PinEntryOverlay
          mode={pinDialog.mode}
          {...(pinDialog.title !== undefined ? { title: pinDialog.title } : {})}
          {...(pinDialog.verifyOnly ? { verifyOnly: true } : {})}
          onVerify={(pin) =>
            pinDialog.verifyOnly
              ? verifyParentalPin(pin, pinDialog.profileId)
              : unlockParental(pin, pinDialog.profileId)
          }
          onVerifyCurrentPin={(pin) => verifyParentalPin(pin, pinDialog.profileId)}
          onSetPin={(pin, currentPin) => setParentalPin(pin, currentPin, pinDialog.profileId)}
          onClearPin={(currentPin) => clearParentalPin(currentPin, pinDialog.profileId)}
          onSuccess={() => {
            const cb = pinDialog.onSuccess;
            closePinDialog(false);
            cb?.();
          }}
          onCancel={() => closePinDialog(true)}
        />
      ) : null}
    </>
  );
}
