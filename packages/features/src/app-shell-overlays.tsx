import type { CatalogService } from '@elv/data';
import { type MutableRefObject, type ReactElement, useEffect, useRef } from 'react';
import type { PlayTarget } from './ports/play-target';
import { PinEntryOverlay, ProfileAvatarBadge, ProfilePickerOverlay } from './profiles';
import { type ProfileContextValue, useProfile } from './shared';
import type { NavUtility } from './shell';

/** Props of {@link AppShellProfileOverlays}. */
export interface AppShellProfileOverlaysProps {
  readonly onOpenProfilesSettings: () => void;
}

/**
 * Builds the quiet top-right profile monogram utility button when multiple profiles exist or
 * parental controls are active/unlocked (`UI_UX_PHILOSOPHY.md` §2.1).
 */
export function buildShellProfileUtility(profile: ProfileContextValue): NavUtility | undefined {
  const showUtility =
    profile.profiles.length > 1 || profile.parentalSettings.enabled || profile.parentalUnlocked;
  if (!showUtility) return undefined;
  const active = profile.activeProfile;
  return {
    id: 'profile',
    label: active.name,
    icon: 'profile',
    active: profile.profilePickerOpen,
    showLabel: false,
    testID: 'nav-tab-profile',
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
    onPress: profile.openProfilePicker,
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
  readonly onResetTransientMemory: () => void;
  readonly onStopPlayback: () => void;
}): void {
  const { profile, catalog, appForeground, playTargetRef, onResetTransientMemory, onStopPlayback } =
    params;
  const prevProfileIdRef = useRef(profile.activeProfileId);
  const prevUnlockedRef = useRef(profile.parentalUnlocked);
  const prevForegroundRef = useRef(appForeground);
  const callbacksRef = useRef({ onResetTransientMemory, onStopPlayback });
  callbacksRef.current = { onResetTransientMemory, onStopPlayback };

  useEffect(() => {
    const prevId = prevProfileIdRef.current;
    const prevUnlocked = prevUnlockedRef.current;
    prevProfileIdRef.current = profile.activeProfileId;
    prevUnlockedRef.current = profile.parentalUnlocked;

    if (prevId !== profile.activeProfileId) {
      callbacksRef.current.onResetTransientMemory();
      if (playTargetRef.current !== null) {
        callbacksRef.current.onStopPlayback();
      }
      return;
    }

    if (prevUnlocked && !profile.parentalUnlocked && playTargetRef.current !== null) {
      const playingKey = playTargetRef.current.itemKey;
      void catalog
        .resolveStream(playingKey)
        .then((res) => {
          if (
            !res.ok &&
            res.error.code === 'parental-locked' &&
            playTargetRef.current?.itemKey === playingKey
          ) {
            callbacksRef.current.onStopPlayback();
          }
        })
        .catch(() => undefined);
    }
  }, [catalog, playTargetRef, profile.activeProfileId, profile.parentalUnlocked]);

  useEffect(() => {
    const wasForeground = prevForegroundRef.current;
    prevForegroundRef.current = appForeground;
    if (wasForeground && !appForeground) {
      profile.lockParentalNow();
    }
  }, [appForeground, profile]);
}

/**
 * Root in-tree overlays rendered by `AppShell` for viewer profile switching (`#15`) and
 * PIN verification/management (`#31`). Uses zero React Native `<Modal>` instances.
 */
export function AppShellProfileOverlays({
  onOpenProfilesSettings,
}: AppShellProfileOverlaysProps): ReactElement | null {
  const {
    profiles,
    activeProfile,
    activeProfileId,
    parentalSettings,
    hasParentalPin,
    parentalUnlocked,
    profilePickerOpen,
    pinDialog,
    switchProfile,
    unlockParental,
    setParentalPin,
    clearParentalPin,
    requestParentalUnlock,
    closePinDialog,
    closeProfilePicker,
  } = useProfile();

  const handleSelectProfile = (targetId: string) => {
    if (targetId === activeProfileId) {
      closeProfilePicker();
      return;
    }
    const needsPinGate =
      (activeProfile.isKids || parentalSettings.enabled) && hasParentalPin && !parentalUnlocked;
    if (needsPinGate) {
      closeProfilePicker();
      requestParentalUnlock(() => {
        void switchProfile(targetId);
      });
      return;
    }
    void switchProfile(targetId);
  };

  if (!profilePickerOpen && pinDialog === null) return null;

  return (
    <>
      {profilePickerOpen ? (
        <ProfilePickerOverlay
          profiles={profiles}
          activeProfileId={activeProfileId}
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
          onVerify={(pin) => unlockParental(pin, pinDialog.profileId)}
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
