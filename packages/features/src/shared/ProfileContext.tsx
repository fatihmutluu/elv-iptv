import type {
  CreateProfileInput,
  ParentalLockRecord,
  ParentalSettings,
  PinVerifyResult,
  ProfileRecord,
  SetParentalLockInput,
  UpdateParentalSettingsPatch,
  UpdateProfilePatch,
} from '@elv/data';
import { elvError, err, type Result } from '@elv/domain';
import {
  createContext,
  type ReactElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  buildGuardPinCandidates,
  DEFAULT_PROFILE_CONTEXT,
  DEFAULT_PROFILE_ID,
  DEFAULT_PROFILE_RECORD,
  defaultParentalSettings,
  failClosedParentalSettings,
  type LoadedParentalSnapshot,
  type PinDialogMode,
  type PinDialogRequest,
  type ProfileContextValue,
  type ProfileProviderProps,
  parentalUnavailableError,
} from './profile-context-helpers';

export {
  DEFAULT_PROFILE_RECORD,
  defaultParentalSettings,
  type PinDialogMode,
  type PinDialogRequest,
  type ProfileContextValue,
  type ProfileProviderProps,
};

const ProfileContext = createContext<ProfileContextValue>(DEFAULT_PROFILE_CONTEXT);

/**
 * Manages local viewer profiles (`#15`) and temporary PIN-gated parental unlocks (`#31`)
 * without remounting the navigation shell or flashing blank screens. Enters strict fail-closed
 * withholding whenever storage reads reject so transient faults never disable Kids Mode.
 */
export function ProfileProvider({
  catalog,
  externalRefreshToken,
  profilePreferences,
  keymapStore,
  suppressAutoProfilePicker = false,
  onProfileDeleted,
  onProfileOrLockChange,
  children,
}: ProfileProviderProps): ReactElement {
  const hasAsyncHydration =
    catalog.listProfiles !== undefined ||
    profilePreferences !== undefined ||
    catalog.getParentalSettings !== undefined ||
    catalog.listParentalLocks !== undefined ||
    catalog.hasParentalPin !== undefined;

  const [profiles, setProfiles] = useState<readonly ProfileRecord[]>([DEFAULT_PROFILE_RECORD]);
  const [activeProfileId, setActiveProfileId] = useState<string>(
    () => profilePreferences?.getActiveProfileId() ?? DEFAULT_PROFILE_ID,
  );
  const [profilesReady, setProfilesReady] = useState(() => !hasAsyncHydration);
  const [profileRevision, setProfileRevision] = useState(0);

  const [parentalSettings, setParentalSettings] = useState<ParentalSettings>(() => {
    const pid = profilePreferences?.getActiveProfileId() ?? DEFAULT_PROFILE_ID;
    return hasAsyncHydration ? failClosedParentalSettings(pid) : defaultParentalSettings(pid);
  });
  const [parentalLocks, setParentalLocks] = useState<readonly ParentalLockRecord[]>([]);
  const [hasParentalPin, setHasParentalPin] = useState(false);
  const [guardPinProfileId, setGuardPinProfileId] = useState<string | null>(null);
  const [parentalUnlocked, setParentalUnlocked] = useState(false);
  const [parentalUnlockExpiresAt, setParentalUnlockExpiresAt] = useState<number | null>(null);
  const [parentalLoadError, setParentalLoadError] = useState(false);
  const [pinDialog, setPinDialog] = useState<PinDialogRequest | null>(null);
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);

  const mountedRef = useRef(true);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  const activeProfileIdRef = useRef(activeProfileId);
  activeProfileIdRef.current = activeProfileId;
  const parentalSettingsRef = useRef(parentalSettings);
  parentalSettingsRef.current = parentalSettings;
  const parentalUnlockedRef = useRef(parentalUnlocked);
  parentalUnlockedRef.current = parentalUnlocked;
  const parentalLoadErrorRef = useRef(parentalLoadError);
  parentalLoadErrorRef.current = parentalLoadError;
  const guardPinProfileIdRef = useRef<string | null>(guardPinProfileId);
  guardPinProfileIdRef.current = guardPinProfileId;
  const switchSeqRef = useRef(0);
  const autoPickerEvaluatedRef = useRef(false);
  const relockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onProfileOrLockChange);
  onChangeRef.current = onProfileOrLockChange;
  const onProfileDeletedRef = useRef(onProfileDeleted);
  onProfileDeletedRef.current = onProfileDeleted;

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

  const enterFailClosedState = useCallback(
    (profileId: string) => {
      clearRelockTimer();
      const wasUnlocked = parentalUnlockedRef.current;
      const wasError = parentalLoadErrorRef.current;
      const profileChanged = activeProfileIdRef.current !== profileId;
      const closedSettings = failClosedParentalSettings(profileId);
      activeProfileIdRef.current = profileId;
      parentalLoadErrorRef.current = true;
      parentalUnlockedRef.current = false;
      parentalSettingsRef.current = closedSettings;
      setActiveProfileId(profileId);
      setParentalLoadError(true);
      setParentalSettings(closedSettings);
      setParentalLocks([]);
      setParentalUnlocked(false);
      setParentalUnlockExpiresAt(null);
      setProfilesReady(true);
      if (!wasError || wasUnlocked || profileChanged) {
        setProfileRevision((r) => r + 1);
        onChangeRef.current?.({
          activeProfileId: profileId,
          parentalUnlocked: false,
          reason: profileChanged ? 'profile-switch' : 'parental-change',
        });
      }
    },
    [clearRelockTimer],
  );

  const fetchParentalSnapshot = useCallback(
    async (
      profileId: string,
      profileList: readonly ProfileRecord[],
    ): Promise<LoadedParentalSnapshot> => {
      const candidates = buildGuardPinCandidates(profileId, profileList);
      const hasPinFn = catalog.hasParentalPin;
      const [settings, locks, pinFlags] = await Promise.all([
        catalog.getParentalSettings
          ? catalog.getParentalSettings(profileId)
          : Promise.resolve(defaultParentalSettings(profileId)),
        catalog.listParentalLocks
          ? catalog.listParentalLocks(profileId)
          : Promise.resolve([] as ParentalLockRecord[]),
        hasPinFn
          ? Promise.all(candidates.map((id) => hasPinFn(id)))
          : Promise.resolve(candidates.map(() => false)),
      ]);
      const hasPin = pinFlags[0] === true;
      const guardIdx = pinFlags.indexOf(true);
      const nextGuardId = guardIdx >= 0 ? (candidates[guardIdx] ?? null) : null;
      return { settings, locks, hasPin, guardPinProfileId: nextGuardId };
    },
    [catalog],
  );

  const loadParentalStateFor = useCallback(
    async (
      profileId: string,
      overrideList?: readonly ProfileRecord[],
      existingSeq?: number,
    ): Promise<void> => {
      const seq = existingSeq ?? ++switchSeqRef.current;
      try {
        const snapshot = await fetchParentalSnapshot(
          profileId,
          overrideList ?? profilesRef.current,
        );
        if (
          !mountedRef.current ||
          switchSeqRef.current !== seq ||
          activeProfileIdRef.current !== profileId
        ) {
          return;
        }
        const wasError = parentalLoadErrorRef.current;
        parentalLoadErrorRef.current = false;
        parentalSettingsRef.current = snapshot.settings;
        guardPinProfileIdRef.current = snapshot.guardPinProfileId;
        setParentalLoadError(false);
        setParentalSettings(snapshot.settings);
        setParentalLocks(snapshot.locks);
        setHasParentalPin(snapshot.hasPin);
        setGuardPinProfileId(snapshot.guardPinProfileId);
        if (wasError) {
          setProfileRevision((r) => r + 1);
          onChangeRef.current?.({
            activeProfileId: profileId,
            parentalUnlocked: parentalUnlockedRef.current,
            reason: 'parental-change',
          });
        }
      } catch {
        if (
          !mountedRef.current ||
          switchSeqRef.current !== seq ||
          activeProfileIdRef.current !== profileId
        ) {
          return;
        }
        enterFailClosedState(profileId);
      }
    },
    [enterFailClosedState, fetchParentalSnapshot],
  );

  const switchProfileInternal = useCallback(
    async (nextProfileId: string, overrideList?: readonly ProfileRecord[]): Promise<void> => {
      const targetId = nextProfileId.trim() || DEFAULT_PROFILE_ID;
      const seq = ++switchSeqRef.current;
      setProfilePickerOpen(false);

      if (profilePreferences) {
        await profilePreferences.switchProfile(targetId).catch(() => undefined);
        if (!mountedRef.current || switchSeqRef.current !== seq) return;
        await profilePreferences.saveActiveProfileId(targetId).catch(() => undefined);
        if (!mountedRef.current || switchSeqRef.current !== seq) return;
      }

      let snapshot: LoadedParentalSnapshot;
      try {
        snapshot = await fetchParentalSnapshot(targetId, overrideList ?? profilesRef.current);
      } catch {
        if (!mountedRef.current || switchSeqRef.current !== seq) return;
        enterFailClosedState(targetId);
        return;
      }
      if (!mountedRef.current || switchSeqRef.current !== seq) return;

      // Atomic batched commit: zero double cache clear, zero double prewarm, zero stale window.
      clearRelockTimer();
      parentalLoadErrorRef.current = false;
      activeProfileIdRef.current = targetId;
      parentalSettingsRef.current = snapshot.settings;
      parentalUnlockedRef.current = false;
      guardPinProfileIdRef.current = snapshot.guardPinProfileId;
      setActiveProfileId(targetId);
      setParentalLoadError(false);
      setParentalSettings(snapshot.settings);
      setParentalLocks(snapshot.locks);
      setHasParentalPin(snapshot.hasPin);
      setGuardPinProfileId(snapshot.guardPinProfileId);
      setParentalUnlocked(false);
      setParentalUnlockExpiresAt(null);
      setProfileRevision((r) => r + 1);
      onChangeRef.current?.({
        activeProfileId: targetId,
        parentalUnlocked: false,
        reason: 'profile-switch',
      });
    },
    [clearRelockTimer, enterFailClosedState, fetchParentalSnapshot, profilePreferences],
  );

  const refreshProfiles = useCallback(async (): Promise<void> => {
    const seq = ++switchSeqRef.current;
    let loaded: readonly ProfileRecord[];
    try {
      loaded = catalog.listProfiles ? await catalog.listProfiles() : [DEFAULT_PROFILE_RECORD];
    } catch {
      if (!mountedRef.current || switchSeqRef.current !== seq) return;
      enterFailClosedState(activeProfileIdRef.current);
      return;
    }
    if (!mountedRef.current || switchSeqRef.current !== seq) return;
    const safeList = loaded.length > 0 ? loaded : [DEFAULT_PROFILE_RECORD];
    profilesRef.current = safeList;
    setProfiles(safeList);
    const currentActiveId = activeProfileIdRef.current;
    if (!safeList.some((p) => p.id === currentActiveId)) {
      const defaultProfile =
        safeList.find((p) => p.isDefault || p.id === DEFAULT_PROFILE_ID) ?? safeList[0];
      await switchProfileInternal(defaultProfile?.id ?? DEFAULT_PROFILE_ID, safeList);
      if (!mountedRef.current) return;
      setProfilesReady(true);
      return;
    }
    await loadParentalStateFor(currentActiveId, safeList, seq);
    if (!mountedRef.current || switchSeqRef.current !== seq) return;
    setProfilesReady(true);
  }, [catalog, enterFailClosedState, loadParentalStateFor, switchProfileInternal]);

  const prevExternalRefreshTokenRef = useRef<number>(externalRefreshToken ?? 0);
  useEffect(() => {
    const nextToken = externalRefreshToken ?? 0;
    if (nextToken <= 0 || nextToken === prevExternalRefreshTokenRef.current) return;
    prevExternalRefreshTokenRef.current = nextToken;
    void refreshProfiles();
  }, [externalRefreshToken, refreshProfiles]);

  // Initial hydration: resolve profiles, persisted active profile ID, preferences, and parental
  // state BEFORE committing `profilesReady = true` so frame 1 never leaks Adult content for Kids.
  useEffect(() => {
    if (!hasAsyncHydration) {
      setProfilesReady(true);
      return undefined;
    }
    let cancelled = false;
    const initSeq = ++switchSeqRef.current;
    void (async () => {
      try {
        const [loadedProfiles, savedId] = await Promise.all([
          catalog.listProfiles ? catalog.listProfiles() : Promise.resolve([DEFAULT_PROFILE_RECORD]),
          profilePreferences
            ? profilePreferences.loadActiveProfileId()
            : Promise.resolve(DEFAULT_PROFILE_ID),
        ]);
        if (cancelled || !mountedRef.current || switchSeqRef.current !== initSeq) return;
        const safeList = loadedProfiles.length > 0 ? loadedProfiles : [DEFAULT_PROFILE_RECORD];
        const validTarget = safeList.some((p) => p.id === savedId)
          ? savedId
          : (safeList[0]?.id ?? DEFAULT_PROFILE_ID);

        if (profilePreferences && profilePreferences.getActiveProfileId() !== validTarget) {
          await profilePreferences.switchProfile(validTarget).catch(() => undefined);
        }
        if (cancelled || !mountedRef.current || switchSeqRef.current !== initSeq) return;

        const snapshot = await fetchParentalSnapshot(validTarget, safeList);
        if (cancelled || !mountedRef.current || switchSeqRef.current !== initSeq) return;

        const profileChanged = validTarget !== activeProfileIdRef.current;
        profilesRef.current = safeList;
        activeProfileIdRef.current = validTarget;
        parentalLoadErrorRef.current = false;
        parentalSettingsRef.current = snapshot.settings;
        guardPinProfileIdRef.current = snapshot.guardPinProfileId;
        setProfiles(safeList);
        setActiveProfileId(validTarget);
        setParentalLoadError(false);
        setParentalSettings(snapshot.settings);
        setParentalLocks(snapshot.locks);
        setHasParentalPin(snapshot.hasPin);
        setGuardPinProfileId(snapshot.guardPinProfileId);
        setProfilesReady(true);
        if (profileChanged) {
          setProfileRevision((r) => r + 1);
          onChangeRef.current?.({
            activeProfileId: validTarget,
            parentalUnlocked: false,
            reason: 'profile-switch',
          });
        }
      } catch {
        if (cancelled || !mountedRef.current || switchSeqRef.current !== initSeq) return;
        enterFailClosedState(activeProfileIdRef.current);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [catalog, enterFailClosedState, fetchParentalSnapshot, hasAsyncHydration, profilePreferences]);

  useEffect(() => {
    if (
      !profilesReady ||
      parentalLoadError ||
      suppressAutoProfilePicker ||
      autoPickerEvaluatedRef.current
    ) {
      return;
    }
    autoPickerEvaluatedRef.current = true;
    if (profiles.length >= 2) setProfilePickerOpen(true);
  }, [parentalLoadError, profiles.length, profilesReady, suppressAutoProfilePicker]);

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
    async (nextProfileId: string): Promise<void> => switchProfileInternal(nextProfileId),
    [switchProfileInternal],
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

      await Promise.all([
        profilePreferences?.deleteProfilePreferences(id).catch(() => undefined),
        keymapStore?.deleteProfileKeymap(id).catch(() => undefined),
        Promise.resolve(onProfileDeletedRef.current?.(id)).catch(() => undefined),
      ]);
      if (!mountedRef.current) return res;

      let loaded: readonly ProfileRecord[];
      try {
        loaded = catalog.listProfiles ? await catalog.listProfiles() : [DEFAULT_PROFILE_RECORD];
      } catch {
        if (mountedRef.current) enterFailClosedState(activeProfileIdRef.current);
        return res;
      }
      if (!mountedRef.current) return res;
      const safeList = loaded.length > 0 ? loaded : [DEFAULT_PROFILE_RECORD];
      profilesRef.current = safeList;
      setProfiles(safeList);
      if (activeProfileIdRef.current === id) {
        const fallbackId = safeList[0]?.id ?? DEFAULT_PROFILE_ID;
        await switchProfileInternal(fallbackId, safeList);
      } else {
        await loadParentalStateFor(activeProfileIdRef.current, safeList);
      }
      return res;
    },
    [
      catalog,
      enterFailClosedState,
      keymapStore,
      loadParentalStateFor,
      profilePreferences,
      switchProfileInternal,
    ],
  );

  const verifyParentalPin = useCallback(
    async (pin: string, targetProfileId?: string): Promise<PinVerifyResult> => {
      const pid = targetProfileId ?? guardPinProfileIdRef.current ?? activeProfileIdRef.current;
      if (!catalog.verifyParentalPin) {
        return { ok: false, remainingAttempts: 0 };
      }
      return catalog.verifyParentalPin(pin, pid);
    },
    [catalog],
  );

  const startParentalUnlockSession = useCallback(() => {
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
      activeProfileId: activeProfileIdRef.current,
      parentalUnlocked: true,
      reason: 'parental-change',
    });
  }, [clearRelockTimer, lockParentalNow]);

  const unlockParental = useCallback(
    async (pin: string, targetProfileId?: string): Promise<PinVerifyResult> => {
      const pid = targetProfileId ?? guardPinProfileIdRef.current ?? activeProfileIdRef.current;
      if (parentalLoadErrorRef.current || !catalog.verifyParentalPin) {
        return { ok: false, remainingAttempts: 0 };
      }
      const res = await catalog.verifyParentalPin(pin, pid);
      if (!mountedRef.current || parentalLoadErrorRef.current) {
        return { ok: false, remainingAttempts: 0 };
      }
      if (res.ok && (pid === activeProfileIdRef.current || pid === guardPinProfileIdRef.current)) {
        startParentalUnlockSession();
      }
      return res;
    },
    [catalog, startParentalUnlockSession],
  );

  const updateParentalSettingsAction = useCallback(
    async (patch: UpdateParentalSettingsPatch): Promise<Result<ParentalSettings>> => {
      if (parentalLoadErrorRef.current) return parentalUnavailableError();
      if (!catalog.updateParentalSettings) return err(elvError('storage', 'unsupported'));
      const pid = activeProfileIdRef.current;
      const res = await catalog.updateParentalSettings(patch, pid);
      if (res.ok && mountedRef.current && activeProfileIdRef.current === pid) {
        parentalSettingsRef.current = res.value;
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
      if (parentalLoadErrorRef.current) return parentalUnavailableError();
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
      if (parentalLoadErrorRef.current) return parentalUnavailableError();
      if (!catalog.setParentalPin) return err(elvError('storage', 'unsupported'));
      const pid = targetProfileId ?? activeProfileIdRef.current;
      const isCreate = currentPin === undefined;
      const res = await catalog.setParentalPin(pin, pid, currentPin);
      if (res.ok && mountedRef.current) {
        await loadParentalStateFor(activeProfileIdRef.current);
        if (
          mountedRef.current &&
          !parentalLoadErrorRef.current &&
          isCreate &&
          (pid === activeProfileIdRef.current || pid === guardPinProfileIdRef.current)
        ) {
          startParentalUnlockSession();
        }
      }
      return res;
    },
    [catalog, loadParentalStateFor, startParentalUnlockSession],
  );

  const hasProfilePinAction = useCallback(
    async (profileId: string): Promise<boolean> => {
      if (!catalog.hasParentalPin) return false;
      try {
        return await catalog.hasParentalPin(profileId);
      } catch {
        return true;
      }
    },
    [catalog],
  );

  const clearParentalPinAction = useCallback(
    async (currentPin: string, targetProfileId?: string): Promise<Result<void>> => {
      if (parentalLoadErrorRef.current) return parentalUnavailableError();
      if (!catalog.clearParentalPin) return err(elvError('storage', 'unsupported'));
      const pid = targetProfileId ?? activeProfileIdRef.current;
      const res = await catalog.clearParentalPin(currentPin, pid);
      if (res.ok && mountedRef.current) {
        await loadParentalStateFor(activeProfileIdRef.current);
        if (activeProfileIdRef.current === pid) {
          lockParentalNow();
        }
      }
      return res;
    },
    [catalog, loadParentalStateFor, lockParentalNow],
  );

  const refreshParental = useCallback(async (): Promise<void> => {
    await loadParentalStateFor(activeProfileIdRef.current);
  }, [loadParentalStateFor]);

  const retryParentalLoad = useCallback(async (): Promise<void> => {
    await refreshProfiles();
  }, [refreshProfiles]);

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
      if (parentalLoadErrorRef.current) return;
      if (parentalUnlockedRef.current) {
        onSuccess();
        return;
      }
      setPinDialog({
        mode: 'verify',
        ...(options?.title !== undefined ? { title: options.title } : {}),
        profileId: guardPinProfileIdRef.current ?? activeProfileIdRef.current,
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

  const hasGuardPin = guardPinProfileId !== null;

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
      hasGuardPin,
      guardPinProfileId,
      parentalUnlocked,
      parentalUnlockExpiresAt,
      parentalLoadError,
      pinDialog,
      profilePickerOpen,
      switchProfile,
      createProfile: createProfileAction,
      updateProfile: updateProfileAction,
      deleteProfile: deleteProfileAction,
      verifyParentalPin,
      unlockParental,
      lockParentalNow,
      updateParentalSettings: updateParentalSettingsAction,
      setParentalLock: setParentalLockAction,
      setParentalPin: setParentalPinAction,
      clearParentalPin: clearParentalPinAction,
      hasProfilePin: hasProfilePinAction,
      refreshParental,
      refreshProfiles,
      retryParentalLoad,
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
      hasGuardPin,
      guardPinProfileId,
      parentalUnlocked,
      parentalUnlockExpiresAt,
      parentalLoadError,
      pinDialog,
      profilePickerOpen,
      switchProfile,
      createProfileAction,
      updateProfileAction,
      deleteProfileAction,
      verifyParentalPin,
      unlockParental,
      lockParentalNow,
      updateParentalSettingsAction,
      setParentalLockAction,
      setParentalPinAction,
      clearParentalPinAction,
      hasProfilePinAction,
      refreshParental,
      refreshProfiles,
      retryParentalLoad,
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
