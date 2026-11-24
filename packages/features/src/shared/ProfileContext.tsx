import type {
  CatalogService,
  CreateProfileInput,
  ParentalLockRecord,
  ParentalSettings,
  PinVerifyResult,
  ProfileRecord,
  SetParentalLockInput,
  UpdateParentalSettingsPatch,
  UpdateProfilePatch,
} from '@elv/data';
import { elvError, err, type ProfilePreferencesManager, type Result } from '@elv/domain';
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

const DEFAULT_PROFILE_ID = 'default';

/** Fallback default profile used before SQLite profiles resolve or on stub catalogs. */
export const DEFAULT_PROFILE_RECORD: ProfileRecord = {
  id: DEFAULT_PROFILE_ID,
  name: 'Default',
  avatarToken: 'crimson',
  isKids: false,
  isDefault: true,
  createdAt: 0,
  updatedAt: 0,
};

/** Fallback parental settings when no policy row has been persisted yet. */
export function defaultParentalSettings(profileId = DEFAULT_PROFILE_ID): ParentalSettings {
  return {
    profileId,
    enabled: false,
    blockAdultKeywords: true,
    maxRatingAge: null,
    unlockTimeoutMin: 30,
    updatedAt: 0,
  };
}

/** Active in-tree PIN dialog request rendered at root level inside `AppShell`. */
export type PinDialogMode = 'verify' | 'create' | 'change' | 'remove';

/** Descriptor for an active PIN entry overlay request. */
export interface PinDialogRequest {
  readonly mode: PinDialogMode;
  readonly title?: string;
  readonly profileId?: string;
  readonly onSuccess?: () => void;
  readonly onCancel?: () => void;
}

/** Reactive local-profile and parental-control state exposed via {@link useProfile} and {@link useParental}. */
export interface ProfileContextValue {
  readonly profiles: readonly ProfileRecord[];
  readonly activeProfile: ProfileRecord;
  readonly activeProfileId: string;
  readonly profilesReady: boolean;
  readonly profileRevision: number;
  readonly parentalSettings: ParentalSettings;
  readonly parentalLocks: readonly ParentalLockRecord[];
  readonly hasParentalPin: boolean;
  readonly parentalUnlocked: boolean;
  readonly parentalUnlockExpiresAt: number | null;
  readonly pinDialog: PinDialogRequest | null;
  readonly profilePickerOpen: boolean;
  switchProfile(profileId: string): Promise<void>;
  createProfile(input: CreateProfileInput): Promise<Result<ProfileRecord>>;
  updateProfile(id: string, patch: UpdateProfilePatch): Promise<Result<ProfileRecord>>;
  deleteProfile(id: string): Promise<Result<void>>;
  unlockParental(pin: string, profileId?: string): Promise<PinVerifyResult>;
  lockParentalNow(): void;
  updateParentalSettings(patch: UpdateParentalSettingsPatch): Promise<Result<ParentalSettings>>;
  setParentalLock(
    input: Omit<SetParentalLockInput, 'profileId'>,
    locked: boolean,
  ): Promise<Result<void>>;
  setParentalPin(pin: string, currentPin?: string, profileId?: string): Promise<Result<void>>;
  clearParentalPin(currentPin: string, profileId?: string): Promise<Result<void>>;
  refreshParental(): Promise<void>;
  refreshProfiles(): Promise<void>;
  requestParentalUnlock(onSuccess: () => void, options?: { readonly title?: string }): void;
  openPinDialog(request: PinDialogRequest): void;
  closePinDialog(cancelled?: boolean): void;
  openProfilePicker(): void;
  closeProfilePicker(): void;
}

const unsupported = () => Promise.resolve(err(elvError('storage', 'unsupported')));

const DEFAULT_PROFILE_CONTEXT: ProfileContextValue = {
  profiles: [DEFAULT_PROFILE_RECORD],
  activeProfile: DEFAULT_PROFILE_RECORD,
  activeProfileId: DEFAULT_PROFILE_ID,
  profilesReady: false,
  profileRevision: 0,
  parentalSettings: defaultParentalSettings(),
  parentalLocks: [],
  hasParentalPin: false,
  parentalUnlocked: false,
  parentalUnlockExpiresAt: null,
  pinDialog: null,
  profilePickerOpen: false,
  switchProfile: async () => undefined,
  createProfile: unsupported,
  updateProfile: unsupported,
  deleteProfile: unsupported,
  unlockParental: async () => ({ ok: false, remainingAttempts: 0 }),
  lockParentalNow: () => undefined,
  updateParentalSettings: unsupported,
  setParentalLock: unsupported,
  setParentalPin: unsupported,
  clearParentalPin: unsupported,
  refreshParental: async () => undefined,
  refreshProfiles: async () => undefined,
  requestParentalUnlock: () => undefined,
  openPinDialog: () => undefined,
  closePinDialog: () => undefined,
  openProfilePicker: () => undefined,
  closeProfilePicker: () => undefined,
};

const ProfileContext = createContext<ProfileContextValue>(DEFAULT_PROFILE_CONTEXT);

/** Props of {@link ProfileProvider}. */
export interface ProfileProviderProps {
  readonly catalog: CatalogService;
  readonly profilePreferences?: ProfilePreferencesManager;
  readonly onProfileOrLockChange?: (next: {
    readonly activeProfileId: string;
    readonly parentalUnlocked: boolean;
    readonly reason: 'profile-switch' | 'parental-change';
  }) => void;
  readonly children: ReactNode;
}

/**
 * Manages local viewer profiles (`#15`) and temporary PIN-gated parental unlocks (`#31`)
 * without remounting the navigation shell or flashing blank screens.
 */
export function ProfileProvider({
  catalog,
  profilePreferences,
  onProfileOrLockChange,
  children,
}: ProfileProviderProps): ReactElement {
  const [profiles, setProfiles] = useState<readonly ProfileRecord[]>([DEFAULT_PROFILE_RECORD]);
  const [activeProfileId, setActiveProfileId] = useState<string>(
    () => profilePreferences?.getActiveProfileId() ?? DEFAULT_PROFILE_ID,
  );
  const [profilesReady, setProfilesReady] = useState(false);
  const [profileRevision, setProfileRevision] = useState(0);

  const [parentalSettings, setParentalSettings] = useState<ParentalSettings>(() =>
    defaultParentalSettings(profilePreferences?.getActiveProfileId() ?? DEFAULT_PROFILE_ID),
  );
  const [parentalLocks, setParentalLocks] = useState<readonly ParentalLockRecord[]>([]);
  const [hasParentalPin, setHasParentalPin] = useState(false);
  const [parentalUnlocked, setParentalUnlocked] = useState(false);
  const [parentalUnlockExpiresAt, setParentalUnlockExpiresAt] = useState<number | null>(null);
  const [pinDialog, setPinDialog] = useState<PinDialogRequest | null>(null);
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);

  const mountedRef = useRef(true);
  const activeProfileIdRef = useRef(activeProfileId);
  activeProfileIdRef.current = activeProfileId;
  const parentalSettingsRef = useRef(parentalSettings);
  parentalSettingsRef.current = parentalSettings;
  const parentalUnlockedRef = useRef(parentalUnlocked);
  parentalUnlockedRef.current = parentalUnlocked;
  const relockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onProfileOrLockChange);
  onChangeRef.current = onProfileOrLockChange;

  const clearRelockTimer = useCallback(() => {
    if (relockTimerRef.current !== null) {
      clearTimeout(relockTimerRef.current);
      relockTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearRelockTimer();
    };
  }, [clearRelockTimer]);

  const loadParentalStateFor = useCallback(
    async (profileId: string): Promise<void> => {
      const [settings, locks, hasPin] = await Promise.all([
        catalog.getParentalSettings
          ? catalog.getParentalSettings(profileId).catch(() => defaultParentalSettings(profileId))
          : Promise.resolve(defaultParentalSettings(profileId)),
        catalog.listParentalLocks
          ? catalog.listParentalLocks(profileId).catch(() => [] as ParentalLockRecord[])
          : Promise.resolve([] as ParentalLockRecord[]),
        catalog.hasParentalPin
          ? catalog.hasParentalPin(profileId).catch(() => false)
          : Promise.resolve(false),
      ]);
      if (!mountedRef.current || activeProfileIdRef.current !== profileId) return;
      setParentalSettings(settings);
      setParentalLocks(locks);
      setHasParentalPin(hasPin);
    },
    [catalog],
  );

  const refreshProfiles = useCallback(async (): Promise<void> => {
    const loaded = catalog.listProfiles
      ? await catalog.listProfiles().catch(() => [DEFAULT_PROFILE_RECORD])
      : [DEFAULT_PROFILE_RECORD];
    if (!mountedRef.current) return;
    const safeList = loaded.length > 0 ? loaded : [DEFAULT_PROFILE_RECORD];
    setProfiles(safeList);
    setProfilesReady(true);
  }, [catalog]);

  // Initial hydration: load profiles + persisted active profile ID and sync preferences manager.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [loadedProfiles, savedId] = await Promise.all([
        catalog.listProfiles
          ? catalog.listProfiles().catch(() => [DEFAULT_PROFILE_RECORD])
          : Promise.resolve([DEFAULT_PROFILE_RECORD]),
        profilePreferences
          ? profilePreferences.loadActiveProfileId().catch(() => DEFAULT_PROFILE_ID)
          : Promise.resolve(DEFAULT_PROFILE_ID),
      ]);
      if (cancelled || !mountedRef.current) return;
      const safeList = loadedProfiles.length > 0 ? loadedProfiles : [DEFAULT_PROFILE_RECORD];
      setProfiles(safeList);
      const validTarget = safeList.some((p) => p.id === savedId)
        ? savedId
        : (safeList[0]?.id ?? DEFAULT_PROFILE_ID);
      if (validTarget !== activeProfileIdRef.current) {
        activeProfileIdRef.current = validTarget;
        setActiveProfileId(validTarget);
        if (profilePreferences) {
          await profilePreferences.switchProfile(validTarget).catch(() => undefined);
        }
        onChangeRef.current?.({
          activeProfileId: validTarget,
          parentalUnlocked: false,
          reason: 'profile-switch',
        });
        setProfileRevision((r) => r + 1);
      } else if (profilePreferences && profilePreferences.getActiveProfileId() !== validTarget) {
        await profilePreferences.switchProfile(validTarget).catch(() => undefined);
      }
      if (cancelled || !mountedRef.current) return;
      setProfilesReady(true);
      await loadParentalStateFor(validTarget);
    })();
    return () => {
      cancelled = true;
    };
  }, [catalog, loadParentalStateFor, profilePreferences]);

  const lockParentalNow = useCallback(() => {
    clearRelockTimer();
    const wasUnlocked = parentalUnlockedRef.current;
    parentalUnlockedRef.current = false;
    setParentalUnlocked(false);
    setParentalUnlockExpiresAt(null);
    if (wasUnlocked) {
      setProfileRevision((r) => r + 1);
      onChangeRef.current?.({
        activeProfileId: activeProfileIdRef.current,
        parentalUnlocked: false,
        reason: 'parental-change',
      });
    }
  }, [clearRelockTimer]);

  const switchProfile = useCallback(
    async (nextProfileId: string): Promise<void> => {
      const targetId = nextProfileId.trim() || DEFAULT_PROFILE_ID;
      clearRelockTimer();
      parentalUnlockedRef.current = false;
      setParentalUnlocked(false);
      setParentalUnlockExpiresAt(null);
      setProfilePickerOpen(false);
      activeProfileIdRef.current = targetId;
      setActiveProfileId(targetId);

      if (profilePreferences) {
        await profilePreferences.switchProfile(targetId).catch(() => undefined);
        await profilePreferences.saveActiveProfileId(targetId).catch(() => undefined);
      }
      if (!mountedRef.current) return;
      setProfileRevision((r) => r + 1);
      onChangeRef.current?.({
        activeProfileId: targetId,
        parentalUnlocked: false,
        reason: 'profile-switch',
      });
      await loadParentalStateFor(targetId);
    },
    [clearRelockTimer, loadParentalStateFor, profilePreferences],
  );

  const createProfileAction = useCallback(
    async (input: CreateProfileInput): Promise<Result<ProfileRecord>> => {
      if (!catalog.createProfile) return err(elvError('storage', 'unsupported'));
      const res = await catalog.createProfile(input);
      if (res.ok && mountedRef.current) {
        await refreshProfiles();
      }
      return res;
    },
    [catalog, refreshProfiles],
  );

  const updateProfileAction = useCallback(
    async (id: string, patch: UpdateProfilePatch): Promise<Result<ProfileRecord>> => {
      if (!catalog.updateProfile) return err(elvError('storage', 'unsupported'));
      const res = await catalog.updateProfile(id, patch);
      if (res.ok && mountedRef.current) {
        await refreshProfiles();
      }
      return res;
    },
    [catalog, refreshProfiles],
  );

  const deleteProfileAction = useCallback(
    async (id: string): Promise<Result<void>> => {
      if (!catalog.deleteProfile) return err(elvError('storage', 'unsupported'));
      const res = await catalog.deleteProfile(id);
      if (!res.ok) return res;

      await profilePreferences?.deleteProfilePreferences(id).catch(() => undefined);
      if (!mountedRef.current) return res;

      const loaded = catalog.listProfiles
        ? await catalog.listProfiles().catch(() => [DEFAULT_PROFILE_RECORD])
        : [DEFAULT_PROFILE_RECORD];
      if (!mountedRef.current) return res;
      const safeList = loaded.length > 0 ? loaded : [DEFAULT_PROFILE_RECORD];
      setProfiles(safeList);
      if (activeProfileIdRef.current === id) {
        const fallbackId = safeList[0]?.id ?? DEFAULT_PROFILE_ID;
        await switchProfile(fallbackId);
      }
      return res;
    },
    [catalog, profilePreferences, switchProfile],
  );

  const unlockParental = useCallback(
    async (pin: string, targetProfileId?: string): Promise<PinVerifyResult> => {
      const pid = targetProfileId ?? activeProfileIdRef.current;
      if (!catalog.verifyParentalPin) {
        return { ok: false, remainingAttempts: 0 };
      }
      const res = await catalog.verifyParentalPin(pin, pid);
      if (!mountedRef.current) return res;
      if (res.ok && pid === activeProfileIdRef.current) {
        clearRelockTimer();
        parentalUnlockedRef.current = true;
        setParentalUnlocked(true);
        const timeoutMin = parentalSettingsRef.current.unlockTimeoutMin;
        if (timeoutMin > 0) {
          const durationMs = timeoutMin * 60_000;
          setParentalUnlockExpiresAt(Date.now() + durationMs);
          relockTimerRef.current = setTimeout(() => {
            relockTimerRef.current = null;
            if (mountedRef.current) lockParentalNow();
          }, durationMs);
        } else {
          setParentalUnlockExpiresAt(null);
        }
        setProfileRevision((r) => r + 1);
        onChangeRef.current?.({
          activeProfileId: pid,
          parentalUnlocked: true,
          reason: 'parental-change',
        });
      }
      return res;
    },
    [catalog, clearRelockTimer, lockParentalNow],
  );

  const updateParentalSettingsAction = useCallback(
    async (patch: UpdateParentalSettingsPatch): Promise<Result<ParentalSettings>> => {
      if (!catalog.updateParentalSettings) return err(elvError('storage', 'unsupported'));
      const pid = activeProfileIdRef.current;
      const res = await catalog.updateParentalSettings(patch, pid);
      if (res.ok && mountedRef.current && activeProfileIdRef.current === pid) {
        setParentalSettings(res.value);
        setProfileRevision((r) => r + 1);
        onChangeRef.current?.({
          activeProfileId: pid,
          parentalUnlocked: parentalUnlockedRef.current,
          reason: 'parental-change',
        });
      }
      return res;
    },
    [catalog],
  );

  const setParentalLockAction = useCallback(
    async (
      input: Omit<SetParentalLockInput, 'profileId'>,
      locked: boolean,
    ): Promise<Result<void>> => {
      if (!catalog.setParentalLock) return err(elvError('storage', 'unsupported'));
      const pid = activeProfileIdRef.current;
      const res = await catalog.setParentalLock({ ...input, profileId: pid }, locked);
      if (res.ok && mountedRef.current && activeProfileIdRef.current === pid) {
        await loadParentalStateFor(pid);
        setProfileRevision((r) => r + 1);
        onChangeRef.current?.({
          activeProfileId: pid,
          parentalUnlocked: parentalUnlockedRef.current,
          reason: 'parental-change',
        });
      }
      return res;
    },
    [catalog, loadParentalStateFor],
  );

  const setParentalPinAction = useCallback(
    async (pin: string, currentPin?: string, targetProfileId?: string): Promise<Result<void>> => {
      if (!catalog.setParentalPin) return err(elvError('storage', 'unsupported'));
      const pid = targetProfileId ?? activeProfileIdRef.current;
      const res = await catalog.setParentalPin(pin, pid, currentPin);
      if (res.ok && mountedRef.current && activeProfileIdRef.current === pid) {
        setHasParentalPin(true);
      }
      return res;
    },
    [catalog],
  );

  const clearParentalPinAction = useCallback(
    async (currentPin: string, targetProfileId?: string): Promise<Result<void>> => {
      if (!catalog.clearParentalPin) return err(elvError('storage', 'unsupported'));
      const pid = targetProfileId ?? activeProfileIdRef.current;
      const res = await catalog.clearParentalPin(currentPin, pid);
      if (res.ok && mountedRef.current && activeProfileIdRef.current === pid) {
        setHasParentalPin(false);
        lockParentalNow();
      }
      return res;
    },
    [catalog, lockParentalNow],
  );

  const refreshParental = useCallback(async (): Promise<void> => {
    await loadParentalStateFor(activeProfileIdRef.current);
  }, [loadParentalStateFor]);

  const openPinDialog = useCallback((request: PinDialogRequest) => {
    setPinDialog(request);
  }, []);

  const closePinDialog = useCallback((cancelled = true) => {
    setPinDialog((prev) => {
      if (cancelled) prev?.onCancel?.();
      return null;
    });
  }, []);

  const requestParentalUnlock = useCallback(
    (onSuccess: () => void, options?: { readonly title?: string }) => {
      if (parentalUnlockedRef.current) {
        onSuccess();
        return;
      }
      setPinDialog({
        mode: 'verify',
        ...(options?.title !== undefined ? { title: options.title } : {}),
        profileId: activeProfileIdRef.current,
        onSuccess,
      });
    },
    [],
  );

  const openProfilePicker = useCallback(() => setProfilePickerOpen(true), []);
  const closeProfilePicker = useCallback(() => setProfilePickerOpen(false), []);

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId) ?? profiles[0] ?? DEFAULT_PROFILE_RECORD,
    [activeProfileId, profiles],
  );

  const value = useMemo<ProfileContextValue>(
    () => ({
      profiles,
      activeProfile,
      activeProfileId,
      profilesReady,
      profileRevision,
      parentalSettings,
      parentalLocks,
      hasParentalPin,
      parentalUnlocked,
      parentalUnlockExpiresAt,
      pinDialog,
      profilePickerOpen,
      switchProfile,
      createProfile: createProfileAction,
      updateProfile: updateProfileAction,
      deleteProfile: deleteProfileAction,
      unlockParental,
      lockParentalNow,
      updateParentalSettings: updateParentalSettingsAction,
      setParentalLock: setParentalLockAction,
      setParentalPin: setParentalPinAction,
      clearParentalPin: clearParentalPinAction,
      refreshParental,
      refreshProfiles,
      requestParentalUnlock,
      openPinDialog,
      closePinDialog,
      openProfilePicker,
      closeProfilePicker,
    }),
    [
      profiles,
      activeProfile,
      activeProfileId,
      profilesReady,
      profileRevision,
      parentalSettings,
      parentalLocks,
      hasParentalPin,
      parentalUnlocked,
      parentalUnlockExpiresAt,
      pinDialog,
      profilePickerOpen,
      switchProfile,
      createProfileAction,
      updateProfileAction,
      deleteProfileAction,
      unlockParental,
      lockParentalNow,
      updateParentalSettingsAction,
      setParentalLockAction,
      setParentalPinAction,
      clearParentalPinAction,
      refreshParental,
      refreshProfiles,
      requestParentalUnlock,
      openPinDialog,
      closePinDialog,
      openProfilePicker,
      closeProfilePicker,
    ],
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

/** Reads and mutates local viewer profile state provided by {@link ProfileProvider}. */
export function useProfile(): ProfileContextValue {
  return useContext(ProfileContext);
}

/** Reads and mutates parental-control and PIN unlock state provided by {@link ProfileProvider}. */
export function useParental(): ProfileContextValue {
  return useContext(ProfileContext);
}
